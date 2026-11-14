import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cfg } from '../lib/config.js';
import { one, q } from '../lib/db.js';
import { deny, isAdmin } from '../lib/http.js';
import { maybeHeartbeat } from '../lib/heartbeat.js';
import { log } from '../lib/log.js';
import { alertOwnerError, checkSource, pickSources, processCandidate, recheckRecent, releaseCandidates, retryUnsent, syncSources, type SourceRow } from '../lib/pipeline.js';
import type { Candidate } from '../lib/detect.js';

export const config = { maxDuration: 60 };

/** Called by the scheduler (Vercel cron or an external pinger). One call = one batch of sources. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdmin(req)) return deny(res);
  const started = Date.now();
  const budgetMs = 48_000;
  const left = () => budgetMs - (Date.now() - started);
  const run = await one<{ id: number }>('INSERT INTO runs DEFAULT VALUES RETURNING id');
  const stats = { checked: 0, failed: 0, baselined: 0, candidates: 0, alerted: 0, updated: 0, duplicate: 0, filtered: 0, failedItems: 0, unsent: 0, retried: 0, rechecked: 0 };
  let fatal = '';

  try {
    await syncSources();
    stats.retried = await retryUnsent();

    const sources = await pickSources(cfg.sourcesPerRun());
    const queue: { s: SourceRow; c: Candidate }[] = [];
    let i = 0;
    const worker = async () => {
      while (i < sources.length && left() > 12_000) {
        const s = sources[i++];
        try {
          const r = await checkSource(s);
          stats.checked++;
          if (!r.ok) stats.failed++;
          if (r.baseline) stats.baselined++;
          r.candidates.forEach((c) => queue.push({ s, c }));
        } catch (e) {
          stats.failed++;
          await log('error', 'monitor', `source ${s.id} crashed`, { error: String(e) });
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    stats.candidates = queue.length;

    let done = 0;
    const limit = cfg.maxCandidates();
    while (done < queue.length && done < limit && left() >= 8_000) {
      const { s, c } = queue[done++];
      try {
        const o = await processCandidate(s, c);
        if (o === 'alerted') stats.alerted++;
        else if (o === 'updated') stats.updated++;
        else if (o === 'duplicate') stats.duplicate++;
        else if (o === 'filtered') stats.filtered++;
        else if (o === 'unsent') stats.unsent++;
        else stats.failedItems++;
      } catch (e) {
        stats.failedItems++;
        await log('error', 'monitor', 'candidate crashed', { url: c.link.href, error: String(e) });
      }
    }
    // anything not processed (time / per-run limit) must be found again next time, never silently dropped
    const leftover = queue.slice(done);
    if (leftover.length) {
      await releaseCandidates(leftover);
      await log('info', 'monitor', `${leftover.length} link(s) postponed to the next run`);
    }
    if (left() > 10_000) stats.rechecked = await recheckRecent(2);
    await maybeHeartbeat().catch((e) => log('warn', 'heartbeat', String(e)));

    if (stats.checked > 0 && stats.failed / stats.checked > 0.5) {
      await alertOwnerError(`${stats.failed} of ${stats.checked} websites could not be opened in this run. Check /api/health.`);
    }
  } catch (e) {
    fatal = e instanceof Error ? e.message : String(e);
    await alertOwnerError('Monitor run crashed: ' + fatal.slice(0, 300));
  }

  await q('UPDATE runs SET finished_at=now(), sources_checked=$2, sources_failed=$3, candidates=$4, alerts_sent=$5, error=$6 WHERE id=$1', [
    run?.id, stats.checked, stats.failed, stats.candidates, stats.alerted + stats.updated, fatal || null,
  ]);
  res.status(fatal ? 500 : 200).json({ ok: !fatal, ms: Date.now() - started, ...stats, error: fatal || undefined });
}

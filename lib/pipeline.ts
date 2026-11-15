import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, env, NOT_MENTIONED } from './config.js';
import { one, q } from './db.js';
import { findNewCandidates, type Candidate } from './detect.js';
import { extractNotification, type FieldName } from './extract.js';
import { fetchPage } from './fetcher.js';
import { log } from './log.js';
import { deptTag, fullAlertText, type NotificationRow } from './messages.js';
import { decide, type Decision } from './policy.js';
import { ensureSchema } from './schema.js';
import { getSetting, setSetting } from './settings.js';
import { telegramChatId } from './channel.js';
import { tgRemoveKeyboard } from './telegram.js';
import { changedFields, contentHash, fingerprintTitle, fingerprintUrl, verifyExtraction } from './verify.js';
import { activeChannel, sendOwnerAlert, sendOwnerText } from './channel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface SourceRow {
  id: string;
  government: string;
  department: string;
  name: string;
  url: string;
  priority: number;
  baselined: boolean;
}

/** Make the database match config/sources.json (adds new sites, never deletes history). */
export async function syncSources(): Promise<number> {
  const file = JSON.parse(readFileSync(path.join(ROOT, 'config', 'sources.json'), 'utf8'));
  for (const s of file.sources) {
    await q(
      `INSERT INTO sources(id, government, department, name, url, priority, active) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET government=$2, department=$3, name=$4, url=$5, priority=$6, active=$7`,
      [s.id, s.government, s.department, s.name, s.url, s.priority ?? 2, s.active !== false],
    );
  }
  return file.sources.length;
}

/** Sources to check in this run: never-checked first, then priority, then oldest check. */
export async function pickSources(limit: number): Promise<SourceRow[]> {
  return q<SourceRow>(
    `SELECT id, government, department, name, url, priority, baselined FROM sources
     WHERE active
     ORDER BY (last_checked_at IS NULL) DESC,
              COALESCE(last_checked_at, 'epoch') + (priority * interval '3 hours') ASC
     LIMIT $1`,
    [limit],
  );
}

/** Links that were detected but not processed (time or per-run limit) are forgotten again, so the next run picks them up. */
export async function releaseCandidates(items: { s: { id: string }; c: Candidate }[]): Promise<number> {
  await ensureSchema();
  for (const { s, c } of items) await q('UPDATE seen_links SET retry=true WHERE source_id=$1 AND link_hash=$2', [s.id, c.hash]);
  return items.length;
}

export type Outcome = 'alerted' | 'updated' | 'duplicate' | 'filtered' | 'failed' | 'unsent';

interface Analysis {
  ok: boolean;
  error?: string;
  report?: ReturnType<typeof verifyExtraction>['report'];
  extracted?: ReturnType<typeof verifyExtraction>['extracted'];
  excerpt?: string;
}

/** Firecrawl (paid credits) is used only for the few sources listed in FIRECRAWL_SOURCES, e.g. tg-tgpsc-main. */
const useFirecrawl = (source: { id: string }) => env('FIRECRAWL_SOURCES').split(',').map((x) => x.trim()).filter(Boolean).includes(source.id);

async function analyze(url: string, source: SourceRow, linkText: string): Promise<Analysis> {
  const page = await fetchPage(url, { firecrawl: useFirecrawl(source) });
  if (!page.ok) return { ok: false, error: `Could not open official page: ${page.error}` };
  let extracted;
  try {
    extracted = await extractNotification({ sourceName: source.name, department: source.department, linkText, pageUrl: url, text: page.text, links: page.links });
  } catch (e) {
    return { ok: false, error: `AI extraction failed: ${e instanceof Error ? e.message : e}` };
  }
  const v = verifyExtraction({ extracted, officialUrl: url, sourceUrl: source.url, fetchedVia: page.via, pageText: page.text, pageLinks: page.links, linkText });
  return { ok: true, report: v.report, extracted: v.extracted, excerpt: page.text.slice(0, 4000) };
}

type SendDecision = Extract<Decision, { send: true }>;

async function saveNotification(source: SourceRow, url: string, a: Analysis, dec: SendDecision, existing?: NotificationRow & { content_hash: string }) {
  const ex = a.extracted!;
  const f = ex.fields;
  const hash = contentHash(f);
  const fp = fingerprintUrl(url);
  const fp2 = fingerprintTitle(f.department !== NOT_MENTIONED ? f.department : source.department, f.title);
  const data = {
    fields: f,
    headline_te: ex.headline_te,
    short_summary_en: ex.short_summary_en,
    category: ex.category,
    changed: [] as string[],
    event: dec.event,
    kind: dec.kind,
    topic_title_te: dec.topicTitleTe,
    old_last_date: dec.oldLastDate,
    tag: deptTag(source.id, source.department),
  };
  const isUpdate = dec.event === 'extension';

  if (!existing) {
    const r = await q<{ id: number }>(
      `INSERT INTO notifications(fingerprint, fingerprint2, source_id, title, department, official_url, content_hash, status, is_update, data, verification, source_excerpt, verified_at, topic_id, event)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'verified',$8,$9,$10,$11,now(),$12,$13) ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
      [fp, fp2, source.id, f.title, f.department !== NOT_MENTIONED ? f.department : source.department, url, hash, isUpdate, JSON.stringify(data), JSON.stringify(a.report), a.excerpt ?? '', dec.topicId, dec.event],
    );
    return r[0]?.id;
  }
  const convert = ['filtered', 'failed'].includes(existing.status);
  if (!convert) data.changed = changedFields(existing.data?.fields, f);
  await q(
    `UPDATE notifications SET version=${convert ? '1' : 'version+1'}, is_update=$2, content_hash=$3, status='verified', data=$4, verification=$5,
            source_excerpt=$6, verified_at=now(), updated_at=now(), title=$7, topic_id=$8, event=$9 WHERE id=$1`,
    [existing.id, convert ? false : isUpdate, hash, JSON.stringify(data), JSON.stringify(a.report), a.excerpt ?? '', f.title, dec.topicId, dec.event],
  );
  return existing.id;
}

async function findExisting(url: string) {
  return one<NotificationRow & { content_hash: string }>('SELECT * FROM notifications WHERE fingerprint=$1 LIMIT 1', [fingerprintUrl(url)]);
}

async function recordFailedPermanently(source: SourceRow, url: string, title: string, reason: string) {
  await q(
    `INSERT INTO notifications(fingerprint, source_id, title, department, official_url, status, data, verified_at)
     VALUES ($1,$2,$3,$4,$5,'filtered',$6,now()) ON CONFLICT (fingerprint) DO NOTHING`,
    [fingerprintUrl(url), source.id, title.slice(0, 300), source.department, url, JSON.stringify({ fields: {}, reason })],
  ).catch(() => undefined);
}

async function recordFiltered(source: SourceRow, url: string, a: Analysis, reason: string) {
  await q(
    `INSERT INTO notifications(fingerprint, fingerprint2, source_id, title, department, official_url, status, data, verification, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,'filtered',$7,$8,now()) ON CONFLICT (fingerprint) DO NOTHING`,
    [fingerprintUrl(url), null, source.id, a.extracted!.fields.title, source.department, url, JSON.stringify({ fields: a.extracted!.fields, reason, event_type: a.extracted!.event_type }), JSON.stringify(a.report)],
  ).catch(() => undefined);
}

export async function processCandidate(source: SourceRow, cand: Candidate): Promise<Outcome> {
  await ensureSchema();
  const url = cand.link.href;
  await q('UPDATE seen_links SET retry=false WHERE source_id=$1 AND link_hash=$2', [source.id, cand.hash]);
  const a = await analyze(url, source, cand.link.text);
  if (!a.ok) {
    // scanned PDFs without text can never be read: give up at once. Other failures are retried up to 5 times.
    const permanent = /no text layer/i.test(a.error ?? '');
    if (permanent) {
      await recordFailedPermanently(source, url, cand.link.text, a.error ?? '');
    } else {
      await q('UPDATE seen_links SET retry=true, attempts=attempts+1 WHERE source_id=$1 AND link_hash=$2', [source.id, cand.hash]);
    }
    await log('warn', 'pipeline', (a.error ?? 'analysis failed') + (permanent ? ' (given up)' : ''), { url, source: source.id });
    return 'failed';
  }
  const existing = await findExisting(url);

  if (a.report!.verdict === 'fail') {
    if (!existing) await recordFiltered(source, url, a, a.report!.reasons.join('; '));
    return 'filtered';
  }

  const dec = await decide(a.extracted!, source);
  if (!dec.send) {
    if (!existing) await recordFiltered(source, url, a, dec.reason);
    return dec.duplicate ? 'duplicate' : 'filtered';
  }

  const id = await saveNotification(source, url, a, dec, existing);
  if (!id) return 'duplicate';
  const sent = await sendAlert(id);
  if (!sent) return 'unsent';
  return dec.event === 'extension' ? 'updated' : 'alerted';
}

/** Re-open recent notifications: only a LATER last date (extension) is worth a new alert. */
export async function recheckRecent(limit = 3): Promise<number> {
  await ensureSchema();
  const rows = await q<NotificationRow & { source_id: string }>(
    `SELECT * FROM notifications
     WHERE status IN ('alerted','accepted','poster_ready','saved') AND event IN ('new','extension')
       AND created_at > now() - interval '45 days' AND verified_at < now() - interval '6 hours'
     ORDER BY verified_at ASC LIMIT $1`,
    [limit],
  );
  let updated = 0;
  for (const n of rows) {
    const source = await one<SourceRow>('SELECT id, government, department, name, url, priority, baselined FROM sources WHERE id=$1', [n.source_id]);
    if (!source) continue;
    const a = await analyze(n.official_url, source, n.title);
    if (!a.ok || a.report!.verdict === 'fail') {
      await q('UPDATE notifications SET verified_at=now() WHERE id=$1', [n.id]);
      continue;
    }
    const dec = await decide(a.extracted!, source);
    if (!dec.send) {
      await q('UPDATE notifications SET verified_at=now() WHERE id=$1', [n.id]);
      continue;
    }
    const id = await saveNotification(source, n.official_url, a, dec, n as any);
    if (id && (await sendAlert(id))) updated++;
  }
  return updated;
}

/**
 * One-time clean-up when the new "one short alert per recruitment" format starts:
 * old long alerts that are still waiting for a decision are archived and their buttons removed.
 */
export async function archiveOldFormat(): Promise<number> {
  await ensureSchema();
  if (await getSetting('policy_v2_archived')) return 0;
  await setSetting('policy_v2_archived', new Date().toISOString());
  const rows = await q<{ id: number; alert_message_id: string | null }>(
    `UPDATE notifications SET status='archived', updated_at=now() WHERE status IN ('alerted','verified','alert_failed') AND event IS NULL RETURNING id, alert_message_id`,
  );
  if (!rows.length) return 0;
  const chat = await telegramChatId().catch(() => '');
  if (chat) {
    for (const r of rows) {
      const m = r.alert_message_id?.match(/^tg:(\d+)$/);
      if (m) await tgRemoveKeyboard(chat, parseInt(m[1], 10)).catch(() => undefined);
    }
  }
  await sendOwnerText(null, 'menu', `🗄 పాత ఫార్మాట్‌లో వేచి ఉన్న ${rows.length} అలర్ట్‌లను ఆర్కైవ్ చేశాను. ఇకపై ప్రతి ఉద్యోగానికి చిన్న తెలుగు అలర్ట్ ఒక్కటే వస్తుంది (కొత్త ప్రకటన, గడువు పొడిగింపు, హాల్ టికెట్ మాత్రమే).`).catch(() => undefined);
  return rows.length;
}

export async function checkSource(source: SourceRow): Promise<{ ok: boolean; candidates: Candidate[]; baseline: boolean; flood?: number }> {
  const page = await fetchPage(source.url, { firecrawl: useFirecrawl(source) });
  if (!page.ok) {
    await q(
      `UPDATE sources SET last_checked_at=now(), last_status='error', last_error=$2, consecutive_failures=consecutive_failures+1 WHERE id=$1`,
      [source.id, (page.error ?? 'unknown').slice(0, 300)],
    );
    return { ok: false, candidates: [], baseline: false };
  }
  const { candidates, baselineJustDone, flood } = await findNewCandidates(source.id, page.links, source.baselined);
  await q(
    `UPDATE sources SET last_checked_at=now(), last_ok_at=now(), last_status='ok', last_error=NULL, consecutive_failures=0, baselined=true WHERE id=$1`,
    [source.id],
  );
  if (flood > 0) {
    await alertOwnerError(`${source.name}: ${flood} new links appeared at once. Treated as a website layout change and skipped (nothing was missed silently - tell me if this site really published that many notifications).`);
  }
  return { ok: true, candidates, baseline: baselineJustDone, flood };
}

/* ------------------------------ alerts ------------------------------ */

export async function sendAlert(id: number): Promise<boolean> {
  const n = await one<NotificationRow>('SELECT * FROM notifications WHERE id=$1', [id]);
  if (!n) return false;
  if ((await activeChannel()) === 'none') {
    await q(`UPDATE notifications SET status='verified', updated_at=now() WHERE id=$1`, [id]);
    await log('warn', 'alert', 'Alert not sent: no notification channel (Telegram / WhatsApp) is set up yet', { id });
    return false;
  }
  const r = await sendOwnerAlert(n);
  if (r.ok) {
    await q(`UPDATE notifications SET status='alerted', alert_message_id=$2, updated_at=now() WHERE id=$1`, [id, r.messageId ?? null]);
    return true;
  }
  await q(`UPDATE notifications SET status='alert_failed', updated_at=now() WHERE id=$1`, [id]);
  return false;
}

/** Retry alerts that failed or were waiting for WhatsApp configuration. */
export async function retryUnsent(): Promise<number> {
  const rows = await q<{ id: number }>(
    `SELECT n.id FROM notifications n
     WHERE n.status IN ('verified','alert_failed')
       AND (SELECT count(*) FROM deliveries d WHERE d.notification_id=n.id AND d.kind='alert') < 5
     ORDER BY n.id LIMIT 5`,
  );
  let sent = 0;
  for (const r of rows) if (await sendAlert(r.id)) sent++;
  return sent;
}

/** Error alerts to the owner (always logged). */
export async function alertOwnerError(message: string): Promise<void> {
  await log('error', 'health', message);
  await sendOwnerText(null, 'error', `⚠️ PDS monitor alert\n${message}`).catch(() => undefined);
}

export { fullAlertText };

/**
 * Works through the queue of postponed / back-filled links without re-checking any website.
 * Each link is claimed first (so a parallel monitor run never handles the same link twice).
 */
export async function drainBacklog(budgetMs = 45_000, maxItems = 8): Promise<{ processed: number; left: number; outcomes: Record<string, number> }> {
  await ensureSchema();
  const started = Date.now();
  const outcomes: Record<string, number> = {};
  let processed = 0;
  while (processed < maxItems && Date.now() - started < budgetMs - 14_000) {
    const row = await one<{ source_id: string; link_hash: string; title: string; url: string }>(
      `SELECT sl.source_id, sl.link_hash, sl.title, sl.url FROM seen_links sl JOIN sources s ON s.id = sl.source_id
       WHERE sl.retry AND sl.attempts < 5 AND s.active ORDER BY s.priority, sl.first_seen_at LIMIT 1`,
    );
    if (!row) break;
    const claimed = await q('UPDATE seen_links SET retry=false WHERE source_id=$1 AND link_hash=$2 AND retry=true RETURNING 1', [row.source_id, row.link_hash]);
    if (!claimed.length) continue;
    const source = await one<SourceRow>('SELECT id, government, department, name, url, priority, baselined FROM sources WHERE id=$1', [row.source_id]);
    if (!source) continue;
    let outcome: string;
    try {
      outcome = await processCandidate(source, { link: { text: row.title ?? '', href: row.url }, hash: row.link_hash });
    } catch (e) {
      outcome = 'crashed';
      await q('UPDATE seen_links SET retry=true, attempts=attempts+1 WHERE source_id=$1 AND link_hash=$2', [row.source_id, row.link_hash]);
      await log('error', 'drain', 'candidate crashed', { url: row.url, error: String(e) });
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    processed++;
  }
  const left = (await one<{ c: number }>(`SELECT count(*)::int c FROM seen_links sl JOIN sources s ON s.id=sl.source_id WHERE sl.retry AND sl.attempts<5 AND s.active`))?.c ?? 0;
  return { processed, left, outcomes };
}

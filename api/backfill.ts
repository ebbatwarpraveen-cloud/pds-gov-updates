import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../lib/config.js';
import { q } from '../lib/db.js';
import { markForBackfill, pickBackfillLinks } from '../lib/detect.js';
import { fetchPage } from '../lib/fetcher.js';
import { deny, isAdmin, qs } from '../lib/http.js';
import { log } from '../lib/log.js';
import { ensureSchema } from '../lib/schema.js';
import { getSetting, setSetting } from '../lib/settings.js';

export const config = { maxDuration: 60 };

/**
 * One-time back-fill. Open  /api/backfill?key=<CRON_SECRET>  again and again until "remaining" is 0.
 * Each call re-reads about 10 websites and marks their current-year job / scheme links so the normal
 * monitor runs them through AI + the 3-event policy: only applications that are STILL OPEN produce an alert.
 * Options: &reset=1 starts again, &only=<source id> handles a single site.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdmin(req)) return deny(res);
  await ensureSchema();
  const started = Date.now();
  if (qs(req, 'reset') === '1') await setSetting('backfill_done', '[]');
  const done: string[] = JSON.parse((await getSetting('backfill_done')) || '[]');
  const only = qs(req, 'only');
  const sources = await q<{ id: string; url: string; name: string }>(
    `SELECT id, url, name FROM sources WHERE active ${only ? 'AND id=$1' : ''} ORDER BY priority, id`,
    only ? [only] : [],
  );
  const todo = sources.filter((s) => only || !done.includes(s.id)).slice(0, 10);
  const fc = env('FIRECRAWL_SOURCES').split(',').map((x) => x.trim());
  let marked = 0;
  const report: { id: string; links: number; marked: number; ok: boolean }[] = [];
  let i = 0;
  const worker = async () => {
    while (i < todo.length && Date.now() - started < 38_000) {
      const s = todo[i++];
      const page = await fetchPage(s.url, { firecrawl: fc.includes(s.id) }).catch(() => null);
      if (!page || !page.ok) {
        report.push({ id: s.id, links: 0, marked: 0, ok: false });
      } else {
        const picked = pickBackfillLinks(page.links, 10);
        const m = await markForBackfill(s.id, picked);
        marked += m;
        report.push({ id: s.id, links: picked.length, marked: m, ok: true });
      }
      if (!only) done.push(s.id);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (!only) await setSetting('backfill_done', JSON.stringify([...new Set(done)]));
  const remaining = sources.filter((s) => !done.includes(s.id)).length;
  await log('info', 'backfill', `marked ${marked} link(s), ${remaining} site(s) remaining`);
  res.status(200).json({ ok: true, marked, remaining, report });
}

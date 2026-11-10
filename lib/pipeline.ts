import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, NOT_MENTIONED } from './config.js';
import { one, q } from './db.js';
import { findNewCandidates, type Candidate } from './detect.js';
import { extractNotification, type FieldName } from './extract.js';
import { fetchPage } from './fetcher.js';
import { log } from './log.js';
import { fullAlertText, type NotificationRow } from './messages.js';
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
      `INSERT INTO sources(id, government, department, name, url, priority) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET government=$2, department=$3, name=$4, url=$5, priority=$6`,
      [s.id, s.government, s.department, s.name, s.url, s.priority ?? 2],
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

export type Outcome = 'alerted' | 'updated' | 'duplicate' | 'filtered' | 'failed' | 'unsent';

interface Analysis {
  ok: boolean;
  error?: string;
  report?: ReturnType<typeof verifyExtraction>['report'];
  extracted?: ReturnType<typeof verifyExtraction>['extracted'];
  excerpt?: string;
}

async function analyze(url: string, source: SourceRow, linkText: string): Promise<Analysis> {
  const page = await fetchPage(url);
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

async function saveNotification(source: SourceRow, url: string, a: Analysis, existing?: NotificationRow & { content_hash: string }) {
  const ex = a.extracted!;
  const f = ex.fields;
  const hash = contentHash(f);
  const fp = fingerprintUrl(url);
  const fp2 = fingerprintTitle(f.department !== NOT_MENTIONED ? f.department : source.department, f.title);
  const data = { fields: f, headline_te: ex.headline_te, short_summary_en: ex.short_summary_en, category: ex.category, changed: [] as string[] };

  if (!existing) {
    const r = await q<{ id: number }>(
      `INSERT INTO notifications(fingerprint, fingerprint2, source_id, title, department, official_url, content_hash, status, data, verification, source_excerpt, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'verified',$8,$9,$10,now()) ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
      [fp, fp2, source.id, f.title, f.department !== NOT_MENTIONED ? f.department : source.department, url, hash, JSON.stringify(data), JSON.stringify(a.report), a.excerpt ?? ''],
    );
    return r[0]?.id;
  }
  const changed = changedFields(existing.data?.fields, f);
  data.changed = changed;
  await q(
    `UPDATE notifications SET version=version+1, is_update=true, content_hash=$2, status='verified', data=$3, verification=$4,
            source_excerpt=$5, verified_at=now(), updated_at=now(), title=$6 WHERE id=$1`,
    [existing.id, hash, JSON.stringify(data), JSON.stringify(a.report), a.excerpt ?? '', f.title],
  );
  return existing.id;
}

async function findExisting(url: string, a: Analysis, source: SourceRow) {
  const f = a.extracted!.fields;
  const fp = fingerprintUrl(url);
  const fp2 = fingerprintTitle(f.department !== NOT_MENTIONED ? f.department : source.department, f.title);
  return one<NotificationRow & { content_hash: string }>('SELECT * FROM notifications WHERE fingerprint=$1 OR fingerprint2=$2 ORDER BY id LIMIT 1', [fp, fp2]);
}

export async function processCandidate(source: SourceRow, cand: Candidate): Promise<Outcome> {
  const url = cand.link.href;
  const a = await analyze(url, source, cand.link.text);
  if (!a.ok) {
    // let it be retried in a later run
    await q('DELETE FROM seen_links WHERE source_id=$1 AND link_hash=$2', [source.id, cand.hash]);
    await log('warn', 'pipeline', a.error ?? 'analysis failed', { url, source: source.id });
    return 'failed';
  }
  const existing = await findExisting(url, a, source);

  if (a.report!.verdict === 'fail') {
    if (!existing) {
      await q(
        `INSERT INTO notifications(fingerprint, fingerprint2, source_id, title, department, official_url, status, data, verification, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,'filtered',$7,$8,now()) ON CONFLICT (fingerprint) DO NOTHING`,
        [fingerprintUrl(url), null, source.id, a.extracted!.fields.title, source.department, url, JSON.stringify({ fields: a.extracted!.fields }), JSON.stringify(a.report)],
      ).catch(() => undefined);
    }
    return 'filtered';
  }

  if (existing) {
    const changed = changedFields(existing.data?.fields, a.extracted!.fields);
    if (existing.status === 'filtered' || existing.status === 'failed') {
      const id = await saveNotification(source, url, a, { ...existing, is_update: false } as any);
      await q('UPDATE notifications SET is_update=false, version=1 WHERE id=$1', [id]);
      return (await sendAlert(id!)) ? 'alerted' : 'unsent';
    }
    if (changed.length === 0) return 'duplicate';
    const id = await saveNotification(source, url, a, existing);
    return (await sendAlert(id!)) ? 'updated' : 'unsent';
  }

  const id = await saveNotification(source, url, a);
  if (!id) return 'duplicate';
  return (await sendAlert(id)) ? 'alerted' : 'unsent';
}

/** Re-open recent notifications to catch changed dates / extensions on the same official page. */
export async function recheckRecent(limit = 3): Promise<number> {
  const rows = await q<NotificationRow & { source_id: string }>(
    `SELECT * FROM notifications
     WHERE status IN ('alerted','accepted','poster_ready','saved')
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
    const changed = changedFields(n.data?.fields, a.extracted!.fields);
    if (changed.length === 0) {
      await q('UPDATE notifications SET verified_at=now() WHERE id=$1', [n.id]);
      continue;
    }
    const id = await saveNotification(source, n.official_url, a, n as any);
    if (await sendAlert(id!)) updated++;
  }
  return updated;
}

export async function checkSource(source: SourceRow): Promise<{ ok: boolean; candidates: Candidate[]; baseline: boolean }> {
  const page = await fetchPage(source.url);
  if (!page.ok) {
    await q(
      `UPDATE sources SET last_checked_at=now(), last_status='error', last_error=$2, consecutive_failures=consecutive_failures+1 WHERE id=$1`,
      [source.id, (page.error ?? 'unknown').slice(0, 300)],
    );
    return { ok: false, candidates: [], baseline: false };
  }
  const { candidates, baselineJustDone } = await findNewCandidates(source.id, page.links, source.baselined);
  await q(
    `UPDATE sources SET last_checked_at=now(), last_ok_at=now(), last_status='ok', last_error=NULL, consecutive_failures=0, baselined=true WHERE id=$1`,
    [source.id],
  );
  return { ok: true, candidates, baseline: baselineJustDone };
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

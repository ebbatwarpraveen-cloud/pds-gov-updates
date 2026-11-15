import { NOT_MENTIONED } from './config.js';
import { one, q } from './db.js';
import { normText } from './text.js';

export interface Topic {
  id: number;
  source_id: string;
  kind: string;
  notification_no: string | null;
  name: string | null;
  title_te: string | null;
  last_date_iso: string | null;
  last_date_text: string | null;
  new_alerted_at: string | null;
  hall_ticket_at: string | null;
  extensions: number;
}

const STOP = new Set(['the', 'and', 'for', 'post', 'posts', 'recruitment', 'notification', 'telangana', 'state', 'govt', 'government', 'department', 'of', 'in', 'to', 'with', 'by', '2026', '2027', '2025', 'online', 'applications', 'application']);

export const normNo = (s: string): string => {
  const n = s.toLowerCase().replace(/\s+/g, '');
  return n.length >= 3 && n !== NOT_MENTIONED.toLowerCase() ? n : '';
};

const tokens = (s: string): Set<string> => new Set(normText(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));

export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  x.forEach((w) => y.has(w) && inter++);
  return inter / (x.size + y.size - inter);
}

/** Finds the recruitment / scheme this document belongs to: same notification number, otherwise a very similar name from the same website. */
export async function findTopic(sourceId: string, kind: string, notificationNo: string, name: string): Promise<Topic | undefined> {
  const no = normNo(notificationNo);
  if (no) {
    const byNo = await one<Topic>('SELECT * FROM topics WHERE source_id=$1 AND kind=$2 AND notification_no=$3 ORDER BY id DESC LIMIT 1', [sourceId, kind, no]);
    if (byNo) return byNo;
  }
  if (!name) return undefined;
  const rows = await q<Topic>('SELECT * FROM topics WHERE source_id=$1 AND kind=$2 ORDER BY id DESC LIMIT 400', [sourceId, kind]);
  let best: Topic | undefined;
  let bestScore = 0;
  for (const t of rows) {
    const s = t.name ? similarity(name, t.name) : 0;
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

export async function createTopic(t: { source_id: string; kind: string; notification_no: string; name: string; title_te: string; last_date_iso: string; last_date_text: string; new_alerted: boolean; hall_ticket: boolean; extensions?: number }): Promise<Topic> {
  const r = await q<Topic>(
    `INSERT INTO topics(source_id, kind, notification_no, name, title_te, last_date_iso, last_date_text, new_alerted_at, hall_ticket_at, extensions)
     VALUES ($1,$2,$3,$4,$5,$6,$7, ${t.new_alerted ? 'now()' : 'NULL'}, ${t.hall_ticket ? 'now()' : 'NULL'}, $8) RETURNING *`,
    [t.source_id, t.kind, normNo(t.notification_no) || null, t.name || null, t.title_te || null, t.last_date_iso || null, t.last_date_text || null, t.extensions ?? 0],
  );
  return r[0];
}

export async function updateTopic(id: number, patch: { last_date_iso?: string; last_date_text?: string; extension?: boolean; hall_ticket?: boolean; new_alerted?: boolean; title_te?: string }): Promise<void> {
  await q(
    `UPDATE topics SET
       last_date_iso = COALESCE($2, last_date_iso),
       last_date_text = COALESCE($3, last_date_text),
       extensions = extensions + $4,
       hall_ticket_at = CASE WHEN $5 THEN now() ELSE hall_ticket_at END,
       new_alerted_at = CASE WHEN $6 THEN COALESCE(new_alerted_at, now()) ELSE new_alerted_at END,
       title_te = COALESCE(title_te, $7),
       updated_at = now()
     WHERE id=$1`,
    [id, patch.last_date_iso || null, patch.last_date_text || null, patch.extension ? 1 : 0, !!patch.hall_ticket, !!patch.new_alerted, patch.title_te || null],
  );
}

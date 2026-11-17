import { env, NOT_MENTIONED } from './config.js';
import type { Extracted } from './extract.js';
import { createTopic, findTopic, updateTopic, type Topic } from './topics.js';

export type AlertEvent = 'new' | 'extension' | 'hall_ticket';

export type Decision =
  | { send: false; reason: string; duplicate?: boolean }
  | { send: true; event: AlertEvent; kind: 'job' | 'scheme' | 'exam'; topicId: number; topicTitleTe: string; oldLastDate: string };

/** Today's date in India (YYYY-MM-DD). POLICY_TODAY is only for tests. */
export function todayIst(now = new Date()): string {
  return env('POLICY_TODAY') || new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

const has = (v: string) => !!v && v !== NOT_MENTIONED;

/**
 * Only three kinds of alert are ever sent for one recruitment / scheme:
 *   1. NEW        – the main notification, only while applications are still open
 *   2. EXTENSION  – the last date was extended (a later date than the one we already know)
 *   3. HALL TICKET – hall tickets released (once)
 * Everything else (checklists, forms, results, keys, schedules ...) is ignored.
 */
export async function decide(ex: Extracted, source: { id: string }, today = todayIst()): Promise<Decision> {
  const et = ex.event_type;
  if (et === 'other') return { send: false, reason: 'Not a new notification, extension or hall ticket' };
  const asked: 'job' | 'scheme' | 'exam' = et === 'scheme_new' || et === 'scheme_extension' ? 'scheme' : et === 'exam_new' ? 'exam' : 'job';
  if (asked === 'scheme' && env('SCHEMES_ENABLED') === 'false') return { send: false, reason: 'Scheme alerts are switched off' };

  const f = ex.fields;
  const name = ex.topic_name || (has(f.title) ? f.title : '');
  const lastIso = ex.last_date_iso;
  const closed = !!lastIso && lastIso < today;
  const topic = await findTopic(source.id, asked, ex.notification_no, name);
  const kind = (topic?.kind as 'job' | 'scheme' | 'exam' | undefined) ?? asked; // follow the kind of the recruitment / exam we already know
  const titleTe = ex.headline_te || '';

  // ---------- hall ticket ----------
  if (et === 'hall_ticket') {
    if (topic?.hall_ticket_at) return { send: false, reason: 'Hall ticket alert already sent', duplicate: true };
    let t: Topic;
    if (topic) {
      await updateTopic(topic.id, { hall_ticket: true, title_te: titleTe });
      t = topic;
    } else {
      t = await createTopic({ source_id: source.id, kind, notification_no: ex.notification_no, name, title_te: titleTe, last_date_iso: '', last_date_text: '', new_alerted: false, hall_ticket: true });
    }
    return { send: true, event: 'hall_ticket', kind, topicId: t.id, topicTitleTe: t.title_te || titleTe, oldLastDate: '' };
  }

  // ---------- extension (also: a "new" document that carries a later last date for a recruitment we already know) ----------
  const looksLikeExtension = et === 'deadline_extension' || et === 'scheme_extension' || (!!topic && !!lastIso && !!topic.last_date_iso && lastIso > topic.last_date_iso);
  if (looksLikeExtension) {
    if (closed) return { send: false, reason: 'Extended date is already over' };
    if (!lastIso && !has(f.last_date) && !has(f.deadline_extension) && !has(f.revised_dates)) return { send: false, reason: 'Extension without a new date' };
    if (topic) {
      const newer = lastIso ? !topic.last_date_iso || lastIso > topic.last_date_iso : has(f.last_date) && f.last_date !== topic.last_date_text;
      if (!newer) return { send: false, reason: 'No later date than the one already alerted', duplicate: true };
      const old = topic.last_date_text || topic.last_date_iso || '';
      await updateTopic(topic.id, { last_date_iso: lastIso, last_date_text: has(f.last_date) ? f.last_date : lastIso, extension: true, title_te: titleTe });
      return { send: true, event: 'extension', kind, topicId: topic.id, topicTitleTe: topic.title_te || titleTe, oldLastDate: old };
    }
    const t = await createTopic({ source_id: source.id, kind, notification_no: ex.notification_no, name, title_te: titleTe, last_date_iso: lastIso, last_date_text: has(f.last_date) ? f.last_date : lastIso, new_alerted: true, hall_ticket: false, extensions: 1 });
    return { send: true, event: 'extension', kind, topicId: t.id, topicTitleTe: titleTe, oldLastDate: '' };
  }

  // ---------- new notification ----------
  if (topic) return { send: false, reason: 'This recruitment was already alerted', duplicate: true };
  if (closed) return { send: false, reason: 'Application period is already over' };
  const t = await createTopic({ source_id: source.id, kind, notification_no: ex.notification_no, name, title_te: titleTe, last_date_iso: lastIso, last_date_text: has(f.last_date) ? f.last_date : '', new_alerted: true, hall_ticket: false });
  return { send: true, event: 'new', kind, topicId: t.id, topicTitleTe: titleTe, oldLastDate: '' };
}

import { q } from './db.js';

let done = false;

/** Adds the tables / columns needed by the "one alert per recruitment" logic. Safe to run many times, runs once per server instance. */
export async function ensureSchema(): Promise<void> {
  if (done) return;
  await q(`CREATE TABLE IF NOT EXISTS topics (
    id               bigserial PRIMARY KEY,
    source_id        text,
    kind             text NOT NULL DEFAULT 'job',
    notification_no  text,
    name             text,
    title_te         text,
    last_date_iso    text,
    last_date_text   text,
    new_alerted_at   timestamptz,
    hall_ticket_at   timestamptz,
    extensions       int NOT NULL DEFAULT 0,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS topics_source_idx ON topics(source_id)');
  await q('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS topic_id bigint');
  await q('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event text');
  done = true;
}

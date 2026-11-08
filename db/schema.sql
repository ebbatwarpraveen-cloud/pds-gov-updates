-- PDS Government Updates – database schema (PostgreSQL). Safe to run many times.

CREATE TABLE IF NOT EXISTS sources (
  id              text PRIMARY KEY,
  government      text NOT NULL,            -- 'Telangana' | 'Central'
  department      text NOT NULL,
  name            text NOT NULL,
  url             text NOT NULL,
  priority        int  NOT NULL DEFAULT 2,  -- 1 = check most often
  active          boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz,
  last_ok_at      timestamptz,
  last_status     text,
  last_error      text,
  consecutive_failures int NOT NULL DEFAULT 0,
  baselined       boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS seen_links (
  source_id   text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  link_hash   text NOT NULL,
  title       text,
  url         text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, link_hash)
);

CREATE TABLE IF NOT EXISTS notifications (
  id            bigserial PRIMARY KEY,
  fingerprint   text NOT NULL UNIQUE,       -- from official URL
  fingerprint2  text,                       -- from department + title
  source_id     text REFERENCES sources(id),
  title         text,
  department    text,
  official_url  text NOT NULL,
  content_hash  text,                       -- hash of extracted key fields
  version       int NOT NULL DEFAULT 1,
  is_update     boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'detected',
  data          jsonb,                      -- AI extracted + verified fields
  verification  jsonb,                      -- checks performed
  source_excerpt text,
  verified_at   timestamptz,
  alert_message_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications(status);
CREATE INDEX IF NOT EXISTS notifications_fp2_idx ON notifications(fingerprint2);

CREATE TABLE IF NOT EXISTS deliveries (
  id            bigserial PRIMARY KEY,
  notification_id bigint REFERENCES notifications(id) ON DELETE CASCADE,
  kind          text NOT NULL,              -- alert | verify | poster | caption | menu | group | error
  to_number     text,
  provider_message_id text,
  status        text NOT NULL DEFAULT 'pending',  -- pending | sent | delivered | read | failed
  attempts      int NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_msg_idx ON deliveries(provider_message_id);

CREATE TABLE IF NOT EXISTS posters (
  id            bigserial PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  version       int NOT NULL DEFAULT 1,
  png           bytea NOT NULL,
  caption       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posters_notif_idx ON posters(notification_id);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id            bigserial PRIMARY KEY,
  provider_message_id text UNIQUE,
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id            bigserial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  sources_checked int NOT NULL DEFAULT 0,
  sources_failed  int NOT NULL DEFAULT 0,
  candidates    int NOT NULL DEFAULT 0,
  alerts_sent   int NOT NULL DEFAULT 0,
  error         text
);

CREATE TABLE IF NOT EXISTS logs (
  id            bigserial PRIMARY KEY,
  level         text NOT NULL,
  scope         text NOT NULL,
  message       text NOT NULL,
  meta          jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logs_created_idx ON logs(created_at DESC);

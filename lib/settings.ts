import { one, q } from './db.js';

let ready = false;
async function ensure() {
  if (ready) return;
  await q(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text, updated_at timestamptz NOT NULL DEFAULT now())`);
  ready = true;
}

export async function getSetting(key: string): Promise<string> {
  await ensure();
  return (await one<{ value: string }>('SELECT value FROM settings WHERE key=$1', [key]))?.value ?? '';
}

export async function setSetting(key: string, value: string): Promise<void> {
  await ensure();
  await q(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [key, value]);
}

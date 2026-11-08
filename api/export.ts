import type { VercelRequest, VercelResponse } from '@vercel/node';
import { q } from '../lib/db.js';
import { deny, isAdmin } from '../lib/http.js';

/** Backup: JSON download of all notifications, sources and delivery history (posters can be regenerated). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdmin(req)) return deny(res);
  const dump = {
    exported_at: new Date().toISOString(),
    sources: await q('SELECT * FROM sources'),
    notifications: await q('SELECT * FROM notifications ORDER BY id'),
    deliveries: await q('SELECT * FROM deliveries ORDER BY id'),
    runs: await q('SELECT * FROM runs ORDER BY id DESC LIMIT 500'),
  };
  res.setHeader('content-disposition', `attachment; filename="pds-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.status(200).json(dump);
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { one } from '../lib/db.js';
import { deny, qs } from '../lib/http.js';
import { verifySig } from '../lib/text.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = parseInt(qs(req, 'id'), 10);
  if (!id || !verifySig('p:' + id, qs(req, 't'))) return deny(res, 404);
  const p = await one<{ png: Buffer; notification_id: number }>('SELECT png, notification_id FROM posters WHERE id=$1', [id]);
  if (!p) return deny(res, 404);
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'private, max-age=3600');
  if (qs(req, 'dl')) res.setHeader('content-disposition', `attachment; filename="PDS-poster-${p.notification_id}.png"`);
  res.status(200).send(p.png);
}

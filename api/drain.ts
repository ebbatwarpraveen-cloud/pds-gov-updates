import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deny, isAdmin } from '../lib/http.js';
import { drainBacklog } from '../lib/pipeline.js';

export const config = { maxDuration: 60 };

/** Processes the queue of back-filled / postponed links. Open  /api/drain?key=<CRON_SECRET>  until "left" is 0. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdmin(req)) return deny(res);
  const r = await drainBacklog(50_000, 10);
  res.status(200).json({ ok: true, ...r });
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parseAction, performAction, type Action } from '../lib/actions.js';
import { deny } from '../lib/http.js';
import { verifySig } from '../lib/text.js';

export const config = { maxDuration: 60 };

/** Used by the buttons on the private detail page (backup to WhatsApp buttons). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return deny(res, 404);
  const body = (typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : req.body) ?? {};
  const id = parseInt(String(body.id ?? ''), 10);
  const t = String(body.t ?? '');
  if (!id || !verifySig('n:' + id, t)) return deny(res);
  const a = parseAction(String(body.action ?? '')).action as Action | null;
  if (!a) return deny(res, 404);
  const r = await performAction(id, a, 'web');
  res.redirect(303, `/api/n?id=${id}&t=${encodeURIComponent(t)}&msg=${encodeURIComponent(r.message)}`);
}

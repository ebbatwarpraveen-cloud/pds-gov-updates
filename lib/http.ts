import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from './config.js';
import { safeEqual } from './text.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const qs = (req: VercelRequest, k: string): string => {
  const v = req.query?.[k];
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
};

/** Accepts `Authorization: Bearer <CRON_SECRET>` (Vercel cron) or `?key=<CRON_SECRET>`. */
export function isAdmin(req: VercelRequest): boolean {
  const secret = env('CRON_SECRET');
  if (!secret) return false;
  const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return safeEqual(auth, secret) || safeEqual(qs(req, 'key'), secret);
}

export function deny(res: VercelResponse, code = 401) {
  res.status(code).setHeader('content-type', 'text/plain; charset=utf-8').send(code === 401 ? 'Unauthorized' : 'Not found');
}

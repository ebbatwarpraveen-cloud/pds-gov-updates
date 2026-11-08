import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid'];
    drop.forEach((k) => u.searchParams.delete(k));
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export const normText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\u0C00-\u0C7F]+/g, ' ')
    .trim();

export const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

const URL_RE = /(https?:\/\/[^\s)]+|www\.[^\s)]+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(gov|nic|ac|org|co|com|net)\.in\b[^\s)]*|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(gov\.in|nic\.in|ac\.in|org\.in|co\.in|in|com|org|net)\/[^\s)]*)/gi;

/** Remove anything that looks like a web link. Used for public poster / caption text. */
export function stripLinks(s: string): string {
  return collapse(s.replace(URL_RE, '').replace(/\(\s*\)/g, '').replace(/\s+([,.;:])/g, '$1'));
}

export function containsLink(s: string): boolean {
  URL_RE.lastIndex = 0;
  return URL_RE.test(s);
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/* ---- signed private links ---- */
function secret(): string {
  const s = process.env.LINK_SECRET || '';
  if (!s) throw new Error('LINK_SECRET is not set');
  return s;
}

export function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);
}

export function verifySig(payload: string, sig: string): boolean {
  try {
    const a = Buffer.from(sign(payload));
    const b = Buffer.from(String(sig || ''));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

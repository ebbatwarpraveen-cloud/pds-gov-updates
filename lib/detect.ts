import { q } from './db.js';
import { ensureSchema } from './schema.js';

export const MAX_ATTEMPTS = 5;
import type { PageLink } from './fetcher.js';
import { canonicalUrl, normText, sha1 } from './text.js';

const KEYWORDS = [
  'recruit', 'notification', 'vacanc', 'posts', 'jobs', 'career', 'advertisement', 'walk-in', 'walk in', 'apply', 'application',
  'last date', 'extension', 'extended', 'revised', 'corrigendum', 'schedule', 'exam', 'hall ticket', 'admit card', 'result',
  'g.o', 'g.o.', 'go ms', 'go rt', 'government order', 'circular', 'scheme', 'yojana', 'scholarship', 'registration', 'engagement',
  'apprentice', 'notice', 'press note', 'online application', 'merit list', 'final key', 'answer key', 'counselling', 'counseling',
  'ఉద్యోగ', 'నోటిఫికేషన్', 'దరఖాస్తు', 'ఖాళీ', 'పరీక్ష', 'ఫలితాలు', 'జీవో', 'పథకం',
];
const NOISE = [
  'privacy', 'terms', 'sitemap', 'accessibility', 'contact us', 'about us', 'feedback', 'screen reader', 'skip to', 'login', 'sign in',
  'facebook', 'twitter', 'instagram', 'youtube', 'whatsapp', 'copyright', 'disclaimer', 'help', 'faq', 'home', 'back to top',
];

export function isCandidateLink(l: PageLink): boolean {
  const t = l.text.toLowerCase();
  if (t.length < 8 || t.length > 400) return false;
  if (NOISE.some((n) => t === n || t.startsWith(n + ' '))) return false;
  const hay = t + ' ' + l.href.toLowerCase();
  return KEYWORDS.some((k) => hay.includes(k));
}

export const linkHash = (l: PageLink) => sha1(canonicalUrl(l.href) + '|' + normText(l.text));

export interface Candidate {
  link: PageLink;
  hash: string;
}

/**
 * Compare links on a source page with what we have seen before.
 * First time a source is checked => "baseline": remember everything, alert nothing
 * (otherwise the owner would receive hundreds of old notifications).
 */
export const floodLimit = () => parseInt(process.env.NEW_LINKS_FLOOD_LIMIT || '', 10) || 30;

export async function findNewCandidates(
  sourceId: string,
  links: PageLink[],
  baselined: boolean,
): Promise<{ candidates: Candidate[]; baselineJustDone: boolean; flood: number }> {
  await ensureSchema();
  const relevant = links.filter(isCandidateLink);
  const withHash = relevant.map((l) => ({ link: l, hash: linkHash(l) }));
  const uniq = new Map<string, Candidate>();
  withHash.forEach((c) => uniq.set(c.hash, c));
  const all = [...uniq.values()];
  if (all.length === 0) return { candidates: [], baselineJustDone: false, flood: 0 };

  const existing = await q<{ link_hash: string; retry: boolean; attempts: number }>('SELECT link_hash, retry, attempts FROM seen_links WHERE source_id=$1 AND link_hash = ANY($2)', [
    sourceId,
    all.map((c) => c.hash),
  ]);
  const have = new Set(existing.map((e) => e.link_hash));
  const retryHashes = new Set(existing.filter((e) => e.retry && e.attempts < MAX_ATTEMPTS).map((e) => e.link_hash));
  const fresh = all.filter((c) => !have.has(c.hash));
  const retries = all.filter((c) => retryHashes.has(c.hash));

  for (const c of fresh) {
    await q('INSERT INTO seen_links(source_id, link_hash, title, url) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
      sourceId,
      c.hash,
      c.link.text.slice(0, 500),
      c.link.href,
    ]);
  }
  if (!baselined) return { candidates: [], baselineJustDone: true, flood: 0 };
  // Dozens of "new" links at once almost always means the site changed its layout or uses changing URLs.
  // They are remembered silently (no spam, no wasted AI calls) and the owner gets one warning.
  if (fresh.length > floodLimit()) return { candidates: retries, baselineJustDone: false, flood: fresh.length };
  return { candidates: [...retries, ...fresh], baselineJustDone: false, flood: 0 };
}

/* ------------------------------------------------------------------ */
/* One-time back-fill: notifications published BEFORE monitoring started but still open            */
/* ------------------------------------------------------------------ */

const YEAR_RE = /2026|2025-26|2026-27|2025-2026|2026-2027/;
const JOB_SCHEME_RE = /recruit|notification|vacanc|advertis|apply|application|posts|walk-in|walk in|engagement|apprentice|scholarship|yojana|scheme|registration|ఉద్యోగ|నోటిఫికేషన్|దరఖాస్తు/;
const NOT_WANTED_RE = /result|answer key|final key|response sheet|merit list|selection list|cut[- ]?off|syllabus|tender|quotation|auction|corrigendum|hall ticket|admit card|call letter|exam schedule|time table|timetable|check ?list|declaration|undertaking/;

/** Links on a page that could be a currently running application: this year, job / scheme wording, no results or keys. */
export function pickBackfillLinks(links: PageLink[], max = 10): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (out.length >= max) break;
    if (!isCandidateLink(l)) continue;
    const hay = (l.text + ' ' + decodeURIComponentSafe(l.href)).toLowerCase();
    if (!YEAR_RE.test(hay) || !JOB_SCHEME_RE.test(hay) || NOT_WANTED_RE.test(hay)) continue;
    const h = linkHash(l);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(l);
  }
  return out;
}

const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Marks already-remembered links so that the normal monitor processes them again (AI + 3-event policy decides). */
export async function markForBackfill(sourceId: string, links: PageLink[]): Promise<number> {
  await ensureSchema();
  let n = 0;
  for (const l of links) {
    const r = await q(`UPDATE seen_links SET retry=true, attempts=0 WHERE source_id=$1 AND link_hash=$2 AND retry=false RETURNING 1`, [sourceId, linkHash(l)]);
    n += r.length;
  }
  return n;
}

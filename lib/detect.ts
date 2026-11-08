import { q } from './db.js';
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
export async function findNewCandidates(
  sourceId: string,
  links: PageLink[],
  baselined: boolean,
): Promise<{ candidates: Candidate[]; baselineJustDone: boolean }> {
  const relevant = links.filter(isCandidateLink);
  const withHash = relevant.map((l) => ({ link: l, hash: linkHash(l) }));
  const uniq = new Map<string, Candidate>();
  withHash.forEach((c) => uniq.set(c.hash, c));
  const all = [...uniq.values()];
  if (all.length === 0) return { candidates: [], baselineJustDone: false };

  const existing = await q<{ link_hash: string }>('SELECT link_hash FROM seen_links WHERE source_id=$1 AND link_hash = ANY($2)', [
    sourceId,
    all.map((c) => c.hash),
  ]);
  const have = new Set(existing.map((e) => e.link_hash));
  const fresh = all.filter((c) => !have.has(c.hash));

  for (const c of fresh) {
    await q('INSERT INTO seen_links(source_id, link_hash, title, url) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
      sourceId,
      c.hash,
      c.link.text.slice(0, 500),
      c.link.href,
    ]);
  }
  if (!baselined) return { candidates: [], baselineJustDone: true };
  return { candidates: fresh, baselineJustDone: false };
}

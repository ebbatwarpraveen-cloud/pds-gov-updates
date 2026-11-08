import { NOT_MENTIONED } from './config.js';
import type { Extracted, FieldName } from './extract.js';
import type { PageLink } from './fetcher.js';
import { canonicalUrl, normText, sha1 } from './text.js';

/** Suffixes that count as official government / public-institution domains. */
const OFFICIAL_SUFFIXES = ['.gov.in', '.nic.in', '.gov', '.ac.in', '.res.in', '.edu.in'];
/** Official bodies that use their own domain (exact host match, subdomains allowed). */
const OFFICIAL_HOSTS = [
  'ibps.in', 'rbi.org.in', 'sbi.co.in', 'licindia.in', 'tspsc.gov.in', 'tgprb.in', 'scclmines.com', 'tgnpdcl.com',
  'tgsouthernpower.org', 'aicte-india.org', 'cgg.gov.in', 'aptonline.in',
];

const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function isOfficialHost(url: string, sourceUrl?: string): boolean {
  const h = host(url);
  if (!h) return false;
  if (OFFICIAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (OFFICIAL_HOSTS.some((o) => h === o || h.endsWith('.' + o))) return true;
  if (sourceUrl) {
    const sh = host(sourceUrl);
    // same site as the registered official source
    if (sh && (h === sh || h.endsWith('.' + sh) || sh.endsWith('.' + h))) return true;
  }
  return false;
}

const NUMERIC_FIELDS: FieldName[] = ['vacancies', 'age_limit', 'application_start', 'last_date', 'exam_date', 'application_fee', 'category_fee', 'revised_dates', 'deadline_extension'];

const numTokens = (s: string) => (s.replace(/(\d),(\d)/g, '$1$2').match(/\d+/g) ?? []).map((x) => x.replace(/^0+(?=\d)/, ''));

function numbersInText(text: string): Set<string> {
  return new Set(numTokens(text));
}

export interface VerificationReport {
  verified_at: string;
  official_url: string;
  official_host: string;
  official_host_ok: boolean;
  fetched_via: string;
  https: boolean;
  is_official_notification: boolean;
  is_relevant: boolean;
  title_grounded: boolean;
  ungrounded_fields: string[];
  dropped_links: string[];
  verdict: 'pass' | 'fail';
  reasons: string[];
}

export function verifyExtraction(args: {
  extracted: Extracted;
  officialUrl: string;
  sourceUrl: string;
  fetchedVia: string;
  pageText: string;
  pageLinks: PageLink[];
  linkText: string;
}): { extracted: Extracted; report: VerificationReport } {
  const { officialUrl, sourceUrl, pageText } = args;
  const ex: Extracted = { ...args.extracted, fields: { ...args.extracted.fields } };
  const reasons: string[] = [];
  const numbers = numbersInText(pageText + ' ' + args.linkText);

  // 1. numbers / dates / fees must literally appear in the source text
  const ungrounded: string[] = [];
  for (const f of NUMERIC_FIELDS) {
    const v = ex.fields[f];
    if (v === NOT_MENTIONED) continue;
    const toks = numTokens(v);
    if (toks.length === 0) continue;
    if (!toks.every((t) => numbers.has(t))) {
      ungrounded.push(f);
      ex.fields[f] = NOT_MENTIONED;
    }
  }

  // 2. links must exist on the page / in the text and be official
  const known = new Set(args.pageLinks.map((l) => canonicalUrl(l.href)));
  const textLc = pageText.toLowerCase();
  const dropped: string[] = [];
  for (const f of ['application_url', 'notification_url'] as FieldName[]) {
    const v = ex.fields[f];
    if (v === NOT_MENTIONED) continue;
    const m = v.match(/https?:\/\/[^\s)]+/i);
    const url = m ? m[0] : '';
    const ok = !!url && (known.has(canonicalUrl(url)) || textLc.includes(url.toLowerCase().replace(/\/$/, ''))) && isOfficialHost(url, sourceUrl);
    if (!ok) {
      dropped.push(f);
      ex.fields[f] = NOT_MENTIONED;
    } else {
      ex.fields[f] = url;
    }
  }
  // the page we actually fetched is the verified official source
  if (ex.fields.notification_url === NOT_MENTIONED && isOfficialHost(officialUrl, sourceUrl)) {
    ex.fields.notification_url = officialUrl;
  }

  // 3. title appears in the source (loose check)
  const titleWords = normText(ex.fields.title).split(' ').filter((w) => w.length > 3);
  const hay = normText(pageText + ' ' + args.linkText);
  const hit = titleWords.filter((w) => hay.includes(w)).length;
  const titleGrounded = titleWords.length === 0 ? false : hit / titleWords.length >= 0.6;

  const officialHostOk = isOfficialHost(officialUrl, sourceUrl);
  if (!officialHostOk) reasons.push('Official link is not on a recognised government domain');
  if (!ex.is_official_notification) reasons.push('Text is not an official notification');
  if (!ex.is_relevant) reasons.push('Not a relevant update category');
  if (!titleGrounded) reasons.push('Title could not be matched with the source text');
  if (ex.fields.title === NOT_MENTIONED) reasons.push('No title found');

  const verdict = officialHostOk && ex.is_official_notification && ex.is_relevant && titleGrounded && ex.fields.title !== NOT_MENTIONED ? 'pass' : 'fail';
  return {
    extracted: ex,
    report: {
      verified_at: new Date().toISOString(),
      official_url: officialUrl,
      official_host: host(officialUrl),
      official_host_ok: officialHostOk,
      fetched_via: args.fetchedVia,
      https: officialUrl.startsWith('https://'),
      is_official_notification: ex.is_official_notification,
      is_relevant: ex.is_relevant,
      title_grounded: titleGrounded,
      ungrounded_fields: ungrounded,
      dropped_links: dropped,
      verdict,
      reasons,
    },
  };
}

/** Fields whose change means the notification was materially updated. */
export const MATERIAL_FIELDS: FieldName[] = ['title', 'vacancies', 'application_start', 'last_date', 'exam_date', 'application_fee', 'revised_dates', 'deadline_extension', 'eligibility', 'age_limit'];

export function contentHash(fields: Record<FieldName, string>): string {
  return sha1(JSON.stringify(MATERIAL_FIELDS.map((f) => normText(fields[f] ?? ''))));
}

export function changedFields(prev: Record<FieldName, string> | undefined, next: Record<FieldName, string>): FieldName[] {
  if (!prev) return [];
  return MATERIAL_FIELDS.filter((f) => normText(prev[f] ?? '') !== normText(next[f] ?? '') && next[f] !== NOT_MENTIONED);
}

export const fingerprintUrl = (u: string) => sha1(canonicalUrl(u));
export const fingerprintTitle = (dept: string, title: string) => sha1(normText(dept) + '|' + normText(title));

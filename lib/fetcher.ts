import * as cheerio from 'cheerio';
import { Agent, fetch as undiciFetch } from 'undici';
import { extractText, getDocumentProxy } from 'unpdf';
import { env } from './config.js';
import { collapse } from './text.js';
import { isOfficialHost } from './verify.js';

export interface PageLink {
  text: string;
  href: string;
}
export interface Page {
  ok: boolean;
  url: string;
  status: number;
  via: 'direct' | 'direct-relaxed-tls' | 'firecrawl' | 'jina';
  contentType: string;
  isPdf: boolean;
  text: string;
  links: PageLink[];
  error?: string;
}

const UA =
  'Mozilla/5.0 (compatible; PDS-GovUpdates/1.0; +official-government-notification-monitor) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Many Indian government sites send an incomplete certificate chain. Used only for read-only fetches on official domains. */
const relaxedAgent = new Agent({ connect: { rejectUnauthorized: false } });
const CERT_ERRORS = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME|DEPTH_ZERO_SELF_SIGNED|CERT_UNTRUSTED|certificate/i;

const explain = (e: unknown): string => {
  const err = e as any;
  const c = err?.cause;
  const detail = c ? ` (${c.code ?? c.message ?? c})` : '';
  return (err?.message ?? String(e)) + detail;
};

export async function fetchWithRetry(url: string, tries = 2, timeoutMs = 15_000, relaxed = false): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      // undici's own fetch must be used together with its own Agent (mixing with Node's built-in fetch breaks)
      const doFetch: any = relaxed ? undiciFetch : fetch;
      const res: Response = await doFetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/pdf,*/*;q=0.8', 'accept-language': 'en-IN,en;q=0.9' },
        redirect: 'follow',
        signal: ctl.signal,
        ...(relaxed ? { dispatcher: relaxedAgent } : {}),
      });
      clearTimeout(t);
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (CERT_ERRORS.test(explain(e)) && !relaxed) break; // certificate problems never fix themselves by retrying
      if (i < tries - 1) await sleep(800 * 2 ** i);
    }
  }
  throw new Error(explain(lastErr));
}

export function parseHtml(html: string, baseUrl: string): { text: string; links: PageLink[] } {
  const $ = cheerio.load(html);
  const links: PageLink[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    const text = collapse($(el).text() || $(el).attr('title') || $(el).attr('aria-label') || '');
    const key = abs + '|' + text;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ text, href: abs });
  });
  $('script,style,noscript,svg,iframe,header nav,footer').remove();
  const text = collapse($('body').text() || $.root().text());
  return { text, links };
}

async function pdfToText(buf: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return collapse(Array.isArray(text) ? text.join(' ') : text);
}

async function viaFirecrawl(url: string): Promise<Page> {
  const key = env('FIRECRAWL_API_KEY');
  if (!key) throw new Error('FIRECRAWL_API_KEY not set');
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, formats: ['markdown', 'links'], maxAge: 0, onlyMainContent: false, parsers: ['pdf'], timeout: 45000 }),
  });
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const j: any = await res.json();
  const d = j?.data ?? j;
  const text = collapse(String(d?.markdown ?? ''));
  const rawLinks: any[] = Array.isArray(d?.links) ? d.links : [];
  const links: PageLink[] = rawLinks
    .map((l) => (typeof l === 'string' ? { text: '', href: l } : { text: collapse(String(l.text ?? l.title ?? '')), href: String(l.url ?? l.href ?? '') }))
    .filter((l) => /^https?:/i.test(l.href));
  // markdown links give us anchor text
  for (const m of text.matchAll(/\[([^\]]{3,200})\]\((https?:[^)\s]+)\)/g)) {
    links.push({ text: collapse(m[1]), href: m[2] });
  }
  return {
    ok: text.length > 0 || links.length > 0,
    url,
    status: d?.metadata?.statusCode ?? 200,
    via: 'firecrawl',
    contentType: String(d?.metadata?.contentType ?? ''),
    isPdf: /\.pdf(\?|$)/i.test(url),
    text,
    links,
  };
}

/** Free JavaScript-rendering fallback (r.jina.ai reader). Only used when a page is empty without JavaScript. */
async function viaJina(url: string): Promise<Page> {
  const headers: Record<string, string> = { accept: 'text/plain', 'x-timeout': '20' };
  if (env('JINA_API_KEY')) headers.authorization = `Bearer ${env('JINA_API_KEY')}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(28_000) });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  const text = collapse(await res.text());
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[([^\]]{3,300})\]\((https?:[^)\s]+)\)/g)) {
    const key = m[2] + '|' + m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text: collapse(m[1]), href: m[2] });
  }
  return { ok: links.length >= 3 || text.length > 400, url, status: 200, via: 'jina', contentType: '', isPdf: false, text, links };
}

/** Fetch a page or PDF. Direct first (free), relaxed TLS for official sites with broken certificates, Firecrawl as last fallback. */
export async function fetchPage(url: string, opts: { firecrawl?: boolean } = {}): Promise<Page> {
  let directErr = '';
  let relaxed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithRetry(url, 2, 15_000, relaxed);
      const ct = res.headers.get('content-type') || '';
      const isPdf = /pdf/i.test(ct) || /\.pdf(\?|$)/i.test(url);
      const via = relaxed ? 'direct-relaxed-tls' : 'direct';
      if (res.ok) {
        if (isPdf) {
          const text = await pdfToText(await res.arrayBuffer());
          if (text.length > 80) return { ok: true, url, status: res.status, via, contentType: ct, isPdf: true, text, links: [] };
          directErr = 'PDF has no text layer';
        } else {
          const html = await res.text();
          const { text, links } = parseHtml(html, res.url || url);
          if (links.length >= 3 || text.length > 400) {
            return { ok: true, url, status: res.status, via, contentType: ct, isPdf: false, text, links };
          }
          directErr = `Page looks empty (JavaScript-only?) [${html.length} bytes, ${links.length} links]`;
        }
      } else {
        directErr = `HTTP ${res.status}`;
      }
      break;
    } catch (e) {
      directErr = e instanceof Error ? e.message : String(e);
      if (!relaxed && CERT_ERRORS.test(directErr) && isOfficialHost(url)) {
        relaxed = true; // retry once, official government domains only
        continue;
      }
      break;
    }
  }
  if (/looks empty/i.test(directErr) && env('JINA_FALLBACK') !== 'off') {
    try {
      const p = await viaJina(url);
      if (p.ok) return p;
      directErr += ' | Jina returned empty content';
    } catch (e) {
      directErr += ' | ' + (e instanceof Error ? e.message : String(e));
    }
  }
  if (opts.firecrawl && env('FIRECRAWL_API_KEY')) {
    try {
      const p = await viaFirecrawl(url);
      if (p.ok) return p;
      directErr += ' | Firecrawl returned empty content';
    } catch (e) {
      directErr += ' | ' + (e instanceof Error ? e.message : String(e));
    }
  }
  return { ok: false, url, status: 0, via: 'direct', contentType: '', isPdf: false, text: '', links: [], error: directErr };
}

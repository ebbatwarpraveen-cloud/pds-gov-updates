import Anthropic from '@anthropic-ai/sdk';
import { cfg, env, NOT_MENTIONED } from './config.js';
import type { PageLink } from './fetcher.js';

export const FIELDS = [
  'title', 'department', 'post_names', 'vacancies', 'eligibility', 'age_limit', 'qualification', 'required_documents',
  'application_start', 'last_date', 'exam_date', 'application_fee', 'category_fee', 'selection_process', 'revised_dates',
  'deadline_extension', 'important_instructions', 'application_process', 'application_url', 'notification_url',
] as const;
export type FieldName = (typeof FIELDS)[number];

export interface Extracted {
  is_official_notification: boolean;
  is_relevant: boolean;
  relevance_reason: string;
  category: string;
  fields: Record<FieldName, string>;
  headline_te: string;
  short_summary_en: string;
}

const SYSTEM = `You extract facts from OFFICIAL Indian government notifications (Telangana State and Central Government) for a citizen-services business.

STRICT RULES
1. Use ONLY the text provided. Never use outside knowledge. Never guess or invent dates, vacancies, eligibility, fees or links.
2. If a detail is not clearly present in the provided text, write exactly: "${NOT_MENTIONED}".
3. Copy numbers, dates and fees exactly as written in the text.
4. application_url and notification_url must be copied from the "LINKS ON PAGE" list or from the text. Otherwise "${NOT_MENTIONED}".
5. is_official_notification = true only if the text itself is an official notice/advertisement/order/circular/result/schedule from a government body. News articles, blogs, or generic pages are false.
6. is_relevant = true only for: recruitment/vacancies, new schemes, Government Orders (GOs), department announcements, citizen service updates, application opening, last dates, deadline extensions, revised dates, exam dates, hall tickets/admit cards, results, important circulars. Navigation pages, old archives, tenders, routine tender/procurement notices, holiday lists and unrelated pages are NOT relevant.
7. Keep each field concise (max ~300 characters; lists separated by "; ").
8. headline_te: a short natural Telugu headline (max 70 characters) describing the notification. short_summary_en: one plain English sentence.
Return the result only through the provided tool.`;

const stringProp = { type: 'string' };
const tool: Anthropic.Tool = {
  name: 'record_notification',
  description: 'Record the extracted notification details.',
  input_schema: {
    type: 'object',
    properties: {
      is_official_notification: { type: 'boolean' },
      is_relevant: { type: 'boolean' },
      relevance_reason: stringProp,
      category: {
        type: 'string',
        enum: ['recruitment', 'scheme', 'government_order', 'announcement', 'citizen_service', 'application', 'deadline_extension', 'exam', 'hall_ticket', 'result', 'circular', 'other'],
      },
      headline_te: stringProp,
      short_summary_en: stringProp,
      ...Object.fromEntries(FIELDS.map((f) => [f, stringProp])),
    },
    required: ['is_official_notification', 'is_relevant', 'relevance_reason', 'category', 'headline_te', 'short_summary_en', ...FIELDS],
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which AI service is configured. Gemini (free tier) is used when only a Gemini key exists. */
export function aiProvider(): 'gemini' | 'anthropic' | 'none' {
  const forced = env('AI_PROVIDER').toLowerCase();
  if (forced === 'gemini' && env('GEMINI_API_KEY')) return 'gemini';
  if (forced === 'anthropic' && env('ANTHROPIC_API_KEY')) return 'anthropic';
  if (env('GEMINI_API_KEY')) return 'gemini';
  if (env('ANTHROPIC_API_KEY')) return 'anthropic';
  return 'none';
}

const geminiModel = () => env('GEMINI_MODEL', 'gemini-2.5-flash');

// Gemini's free tier allows only a few requests per minute: keep a gap between calls.
let lastGeminiCall = 0;

function geminiSchema() {
  const props: Record<string, unknown> = {
    is_official_notification: { type: 'BOOLEAN' },
    is_relevant: { type: 'BOOLEAN' },
    relevance_reason: { type: 'STRING' },
    category: {
      type: 'STRING',
      enum: ['recruitment', 'scheme', 'government_order', 'announcement', 'citizen_service', 'application', 'deadline_extension', 'exam', 'hall_ticket', 'result', 'circular', 'other'],
    },
    headline_te: { type: 'STRING' },
    short_summary_en: { type: 'STRING' },
  };
  for (const f of FIELDS) props[f] = { type: 'STRING' };
  return {
    type: 'OBJECT',
    properties: props,
    required: ['is_official_notification', 'is_relevant', 'relevance_reason', 'category', 'headline_te', 'short_summary_en', ...FIELDS],
  };
}

async function callGemini(system: string, user: string, maxOutputTokens = 3000): Promise<unknown> {
  const key = env('GEMINI_API_KEY');
  const model = geminiModel();
  const gap = parseInt(env('AI_MIN_INTERVAL_MS', '6500'), 10) || 0;
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: geminiSchema(),
  };
  if (/gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastGeminiCall + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastGeminiCall = Date.now();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig,
      }),
    });
    const body = await res.text();
    if (res.ok) {
      let j: any;
      try {
        j = JSON.parse(body);
      } catch {
        throw new Error('Gemini returned an unreadable response');
      }
      const text = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error('Gemini returned no content' + (j?.promptFeedback?.blockReason ? ` (blocked: ${j.promptFeedback.blockReason})` : ''));
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Gemini returned invalid JSON');
      }
    }
    lastErr = `Gemini HTTP ${res.status}: ${body.slice(0, 200)}`;
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(20_000, 4000 * 2 ** attempt)); // free-tier rate limit: wait, then retry
      continue;
    }
    break; // 400/401/403/404 – retrying will not help
  }
  throw new Error(lastErr || 'Gemini request failed');
}

/** Tiny test call used by /api/health?ai=1 to confirm the key and model work. */
export async function pingAI(): Promise<{ ok: boolean; provider: string; note: string }> {
  const provider = aiProvider();
  if (provider === 'none') return { ok: false, provider, note: 'No AI key set (GEMINI_API_KEY or ANTHROPIC_API_KEY)' };
  try {
    if (provider === 'gemini') {
      const key = env('GEMINI_API_KEY');
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }], generationConfig: { maxOutputTokens: 20 } }),
      });
      return { ok: res.ok, provider, note: res.ok ? `model ${geminiModel()} reachable` : `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
    await client.messages.create({ model: cfg.model(), max_tokens: 10, messages: [{ role: 'user', content: 'ok' }] });
    return { ok: true, provider, note: `model ${cfg.model()} reachable` };
  } catch (e) {
    return { ok: false, provider, note: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

export async function extractNotification(input: {
  sourceName: string;
  department: string;
  linkText: string;
  pageUrl: string;
  text: string;
  links: PageLink[];
}): Promise<Extracted> {
  const provider = aiProvider();
  if (provider === 'none') throw new Error('No AI key is set (GEMINI_API_KEY or ANTHROPIC_API_KEY)');

  const linkList = input.links
    .filter((l) => l.text.length > 2)
    .slice(0, 80)
    .map((l) => `- ${l.text.slice(0, 120)} => ${l.href}`)
    .join('\n');

  const user = `SOURCE: ${input.sourceName} (${input.department})
PAGE URL: ${input.pageUrl}
LINK TEXT THAT LED HERE: ${input.linkText}

TEXT OF THE PAGE / DOCUMENT:
"""
${input.text.slice(0, provider === 'gemini' ? 40_000 : 60_000)}
"""

LINKS ON PAGE:
${linkList || '(none)'}`;

  if (provider === 'gemini') return normalizeExtraction(await callGemini(SYSTEM, user));

  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
  const res = await client.messages.create({
    model: cfg.model(),
    max_tokens: 2500,
    system: SYSTEM,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'record_notification' },
    messages: [{ role: 'user', content: user }],
  });
  const block = res.content.find((b) => b.type === 'tool_use') as any;
  if (!block) throw new Error('AI returned no structured result');
  return normalizeExtraction(block.input);
}

export function normalizeExtraction(raw: any): Extracted {
  const fields = {} as Record<FieldName, string>;
  for (const f of FIELDS) {
    const v = raw?.[f];
    const s = typeof v === 'string' ? v.trim() : '';
    fields[f] = !s || /^(n\/?a|none|not (available|specified|mentioned|found)|nil|-+)$/i.test(s) ? NOT_MENTIONED : s;
  }
  return {
    is_official_notification: raw?.is_official_notification === true,
    is_relevant: raw?.is_relevant === true,
    relevance_reason: String(raw?.relevance_reason ?? '').slice(0, 300),
    category: String(raw?.category ?? 'other'),
    fields,
    headline_te: String(raw?.headline_te ?? '').trim().slice(0, 120),
    short_summary_en: String(raw?.short_summary_en ?? '').trim().slice(0, 300),
  };
}

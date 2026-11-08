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

export async function extractNotification(input: {
  sourceName: string;
  department: string;
  linkText: string;
  pageUrl: string;
  text: string;
  links: PageLink[];
}): Promise<Extracted> {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey: key });

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
${input.text.slice(0, 60_000)}
"""

LINKS ON PAGE:
${linkList || '(none)'}`;

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

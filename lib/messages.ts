import { BRAND, cfg, NOT_MENTIONED } from './config.js';
import type { FieldName } from './extract.js';
import { stripLinks, sign, truncate } from './text.js';

export interface NotificationRow {
  id: number;
  source_id?: string | null;
  event?: string | null;
  topic_id?: number | null;
  title: string;
  department: string;
  official_url: string;
  version: number;
  is_update: boolean;
  status: string;
  data: {
    fields: Record<FieldName, string>;
    headline_te?: string;
    short_summary_en?: string;
    category?: string;
    changed?: string[];
    event?: 'new' | 'extension' | 'hall_ticket';
    kind?: 'job' | 'scheme';
    topic_title_te?: string;
    old_last_date?: string;
    tag?: string;
  };
  verification: any;
  verified_at: string | null;
  created_at: string;
}

const has = (v?: string) => !!v && v !== NOT_MENTIONED;

export const privateLink = (id: number) => `${cfg.baseUrl()}/api/n?id=${id}&t=${sign('n:' + id)}`;
export const posterLink = (posterId: number) => `${cfg.baseUrl()}/api/poster?id=${posterId}&t=${sign('p:' + posterId)}`;

/** Complete private alert (owner only – contains the official application links). Missing details are listed in ONE line. */
export function fullAlertText(n: NotificationRow): string {
  const f = n.data.fields;
  const head = n.is_update ? '🔄 *UPDATED GOVERNMENT NOTIFICATION*' : '🔔 *NEW GOVERNMENT UPDATE*';
  const changed = n.is_update && n.data.changed?.length ? `\n_Changed: ${n.data.changed.join(', ')}_\n` : '';
  const items: [string, string][] = [
    ['Department', f.department],
    ['Notification', f.title],
    ['Posts', f.post_names],
    ['Vacancies', f.vacancies],
    ['Eligibility', f.eligibility],
    ['Age Limit', f.age_limit],
    ['Qualification', f.qualification],
    ['Required Documents', f.required_documents],
    ['Application Start', f.application_start],
    ['Last Date', f.last_date],
    ['Exam Date', f.exam_date],
    ['Fee', f.application_fee],
    ['Category-wise Fee', f.category_fee],
    ['Selection Process', f.selection_process],
    ['Revised Dates', f.revised_dates],
    ['Deadline Extension', f.deadline_extension],
    ['Important Notes', f.important_instructions],
    ['Official Application Process', f.application_process],
    ['Official Application URL', f.application_url],
  ];
  const present = items.filter(([, v]) => has(v)).map(([l, v]) => `*${l}:*\n${v}\n`);
  const missing = items.filter(([, v]) => !has(v)).map(([l]) => l);
  const notifLink = f.notification_url !== NOT_MENTIONED ? f.notification_url : n.official_url;
  return [
    head,
    changed,
    ...present,
    `*Official Notification:*\n${notifLink}\n`,
    missing.length ? `_${NOT_MENTIONED}:_\n${missing.join(', ')}\n` : '',
    `_Verified: ${n.verified_at ? new Date(n.verified_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'n/a'} • ID #${n.id}_`,
  ]
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function verifyText(n: NotificationRow): string {
  const v = n.verification ?? {};
  return [
    `🔎 *VERIFY – Notification #${n.id}*`,
    '',
    `Official page opened by the system:\n${n.official_url}`,
    `Domain: ${v.official_host ?? '-'} (${v.official_host_ok ? 'recognised government domain ✅' : 'NOT recognised ⚠️'})`,
    `Checked at: ${v.verified_at ?? '-'}`,
    `Fetched via: ${v.fetched_via ?? '-'}`,
    v.ungrounded_fields?.length ? `Not confirmed in source text (shown as "not mentioned"): ${v.ungrounded_fields.join(', ')}` : 'All dates / numbers / fees were found in the source text ✅',
    '',
    `Official notification: ${n.data.fields.notification_url}`,
    `Application link: ${n.data.fields.application_url}`,
    '',
    'Please open the official page and confirm, then reply ACCEPT or REJECT.',
  ].join('\n');
}

/** Params for the approved WhatsApp template (no line breaks allowed in template variables). */
export function templateParams(n: NotificationRow): string[] {
  const f = n.data.fields;
  const one = (s: string, max: number) => truncate(s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim() || '-', max);
  const posts = [has(f.post_names) ? f.post_names : '', has(f.vacancies) ? `Vacancies: ${f.vacancies}` : ''].filter(Boolean).join(' - ') || NOT_MENTIONED;
  const dates = [
    has(f.application_start) ? `Start ${f.application_start}` : '',
    has(f.last_date) ? `Last date ${f.last_date}` : '',
    has(f.exam_date) ? `Exam ${f.exam_date}` : '',
  ]
    .filter(Boolean)
    .join(' | ') || NOT_MENTIONED;
  return [
    one(f.department, 120),
    one((n.is_update ? 'UPDATED: ' : '') + f.title, 200),
    one(posts, 160),
    one(dates, 160),
    privateLink(n.id),
  ];
}

/** Public WhatsApp caption – never contains any web link. */
export function buildCaption(n: NotificationRow): string {
  const f = n.data.fields;
  const c = (v: string, max = 160) => truncate(stripLinks(v), max);
  const lines: string[] = [];
  lines.push(`📢 *${c(n.data.headline_te || f.title, 110)}*`);
  if (n.data.headline_te) lines.push(c(f.title, 140));
  if (has(f.department)) lines.push(`🏛 ${c(f.department, 110)}`);
  lines.push('');
  if (has(f.vacancies)) lines.push(`👥 ఖాళీలు / Vacancies: ${c(f.vacancies, 60)}`);
  if (has(f.qualification)) lines.push(`🎓 అర్హత / Qualification: ${c(f.qualification, 110)}`);
  if (has(f.age_limit)) lines.push(`🎂 వయో పరిమితి / Age: ${c(f.age_limit, 80)}`);
  if (has(f.application_start)) lines.push(`🟢 ప్రారంభం / Start: ${c(f.application_start, 50)}`);
  if (has(f.last_date)) lines.push(`⏰ చివరి తేదీ / Last Date: *${c(f.last_date, 50)}*`);
  if (has(f.exam_date)) lines.push(`📝 పరీక్ష / Exam: ${c(f.exam_date, 60)}`);
  if (has(f.application_fee)) lines.push(`💰 ఫీజు / Fee: ${c(f.application_fee, 80)}`);
  lines.push('');
  lines.push('✅ దరఖాస్తు సహాయం కోసం సంప్రదించండి');
  lines.push(`*${BRAND.full}*`);
  lines.push(`📞 ${BRAND.phones.join(' | ')}`);
  lines.push(`_${BRAND.tagline}_`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export const POSTER_MENU =
  'ఏం చేయాలి? / What next?\n\n1️⃣ SEND TO GROUP\n2️⃣ SAVE\n3️⃣ CANCEL\n4️⃣ REGENERATE\n\nReply with the word (or number).';

/* ------------------------- short Telugu alert ------------------------- */

const TAGS: [RegExp, string][] = [
  [/^tg-tgpsc/, '🏛 TGPSC'],
  [/^tg-tgprb/, '👮 TG పోలీస్'],
  [/^tg-mhsrb/, '🏥 TG వైద్య ఆరోగ్యం'],
  [/^tg-highcourt/, '⚖️ హైకోర్టు'],
  [/^tg-tgsrtc/, '🚌 TGSRTC'],
  [/^tg-sccl/, '⛏ సింగరేణి'],
  [/^tg-(tgsouthern|tgnorthern)/, '⚡ విద్యుత్'],
  [/^c-rrb/, '🚆 RRB'],
  [/^c-railways/, '🚆 రైల్వే'],
  [/^c-(ibps|rbi|nabard)/, '🏦 బ్యాంకింగ్'],
  [/^c-ssc/, '🧑‍💼 SSC'],
  [/^c-upsc/, '🏛 UPSC'],
  [/^c-(army|navy|iaf|coastguard|bsf|crpf|cisf)/, '🪖 రక్షణ / భద్రత'],
  [/^c-(indiapost|gds)/, '✉️ పోస్టల్'],
  [/^c-(nta|neet|jee|cuet|ugcnet)/, '🎓 NTA పరీక్షలు'],
  [/^c-aiims/, '🏥 AIIMS'],
  [/^tg-/, '🏛 తెలంగాణ'],
  [/^c-/, '🇮🇳 కేంద్రం'],
];

/** Department label shown on the first line, e.g. "🚆 RRB" or "🏦 బ్యాంకింగ్". */
export function deptTag(sourceId: string | null | undefined, department?: string): string {
  for (const [re, tag] of TAGS) if (sourceId && re.test(sourceId)) return tag;
  if (department && department !== NOT_MENTIONED) return '🏛 ' + truncate(department, 28);
  return '🏛';
}

const HEADER: Record<string, string> = {
  new_job: '🆕 కొత్త ఉద్యోగ ప్రకటన',
  new_scheme: '🆕 కొత్త పథకం / స్కాలర్‌షిప్',
  extension: '🔄 గడువు పొడిగింపు',
  hall_ticket: '🎫 హాల్ టికెట్లు విడుదల',
};

/** Very short, clear Telugu alert (5-6 lines). Full details are behind the "వివరాలు" button. */
export function shortAlertText(n: NotificationRow): string {
  const d = n.data;
  const f = d.fields;
  const ev = d.event ?? (n.is_update ? 'extension' : 'new');
  const kind = d.kind ?? 'job';
  const header = ev === 'new' ? (kind === 'scheme' ? HEADER.new_scheme : HEADER.new_job) : ev === 'extension' ? HEADER.extension : HEADER.hall_ticket;
  const tag = d.tag || deptTag(n.source_id, f.department);
  const title = truncate(d.topic_title_te || d.headline_te || f.title, 90);
  const lines = [`${header} · ${tag}`, title];
  if (ev === 'new') {
    if (has(f.vacancies)) lines.push(`👥 ఖాళీలు: ${truncate(f.vacancies, 40)}`);
    if (has(f.application_start) && has(f.last_date)) lines.push(`📅 దరఖాస్తు: ${truncate(f.application_start, 30)} → ${truncate(f.last_date, 30)}`);
    else if (has(f.last_date)) lines.push(`📅 చివరి తేదీ: ${truncate(f.last_date, 40)}`);
    else if (has(f.application_start)) lines.push(`📅 ప్రారంభం: ${truncate(f.application_start, 40)}`);
  } else if (ev === 'extension') {
    const newDate = has(f.last_date) ? f.last_date : has(f.deadline_extension) ? f.deadline_extension : has(f.revised_dates) ? f.revised_dates : '';
    if (newDate) lines.push(`📅 కొత్త చివరి తేదీ: ${truncate(newDate, 40)}${d.old_last_date ? ` (పాతది: ${truncate(d.old_last_date, 30)})` : ''}`);
  } else if (has(f.exam_date)) {
    lines.push(`📝 పరీక్ష: ${truncate(f.exam_date, 50)}`);
  }
  lines.push(`#${n.id}`);
  return lines.join('\n');
}

/** The official page / notification (private chat only – never on the public poster). */
export const officialLink = (n: NotificationRow): string => (n.data.fields.notification_url && n.data.fields.notification_url !== NOT_MENTIONED ? n.data.fields.notification_url : n.official_url);

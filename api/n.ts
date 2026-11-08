import type { VercelRequest, VercelResponse } from '@vercel/node';
import { NOT_MENTIONED } from '../lib/config.js';
import { one } from '../lib/db.js';
import { deny, esc, qs } from '../lib/http.js';
import { posterLink, type NotificationRow } from '../lib/messages.js';
import { verifySig } from '../lib/text.js';

const LABELS: [string, string][] = [
  ['department', 'Department'], ['title', 'Notification'], ['post_names', 'Posts'], ['vacancies', 'Vacancies'], ['eligibility', 'Eligibility'],
  ['age_limit', 'Age Limit'], ['qualification', 'Qualification'], ['required_documents', 'Required Documents'], ['application_start', 'Application Start'],
  ['last_date', 'Last Date'], ['exam_date', 'Exam Date'], ['application_fee', 'Fee'], ['category_fee', 'Category-wise Fee'], ['selection_process', 'Selection Process'],
  ['revised_dates', 'Revised Dates'], ['deadline_extension', 'Deadline Extension'], ['important_instructions', 'Important Instructions'],
  ['application_process', 'Official Application Process'],
];

const linkify = (v: string) => (/^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v));

/** Private detail page for the owner (signed link). Contains official links – never public. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = parseInt(qs(req, 'id'), 10);
  const t = qs(req, 't');
  if (!id || !verifySig('n:' + id, t)) return deny(res, 404);
  const n = await one<NotificationRow>('SELECT * FROM notifications WHERE id=$1', [id]);
  if (!n) return deny(res, 404);
  const poster = await one<{ id: number; caption: string }>('SELECT id, caption FROM posters WHERE notification_id=$1 ORDER BY id DESC LIMIT 1', [id]);
  const f = n.data.fields;
  const msg = qs(req, 'msg');
  const v = n.verification ?? {};

  const rows = LABELS.map(([k, l]) => {
    const val = (f as any)[k] as string;
    return `<tr><th>${l}</th><td class="${val === NOT_MENTIONED ? 'nm' : ''}">${esc(val)}</td></tr>`;
  }).join('');

  const btn = (a: string, label: string, cls = '') =>
    `<form method="post" action="/api/action"><input type="hidden" name="id" value="${id}"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="action" value="${a}"><button class="${cls}">${label}</button></form>`;
  const decision = ['alerted', 'verified', 'alert_failed'].includes(n.status);
  const posterStage = n.status === 'poster_ready' || n.status === 'saved';
  const pUrl = poster ? posterLink(poster.id) : '';

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.status(200).send(`<!doctype html><html lang="te"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>PDS Update #${id}</title>
<style>
:root{--bg:#fff8ec;--fg:#1c1c1c;--card:#fff;--navy:#0b2a5b;--or:#f28c28;--line:#ead9b8}
@media(prefers-color-scheme:dark){:root{--bg:#10151f;--fg:#f1f1f1;--card:#18202e;--line:#2b3547}}
body{margin:0;font-family:system-ui,'Noto Sans Telugu',sans-serif;background:var(--bg);color:var(--fg)}
header{background:var(--navy);color:#fff;padding:14px 16px}header b{font-size:18px}header div{color:#ffd9a0;font-size:13px}
main{padding:14px;max-width:760px;margin:auto}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}th{text-align:left;vertical-align:top;width:38%;font-size:13px;color:#14439a;padding:6px 8px 6px 0}td{padding:6px 0;word-break:break-word}
.nm{opacity:.55}.msg{background:#dff5e1;color:#14532d;padding:10px;border-radius:10px;margin-bottom:12px}
.btns{display:flex;flex-wrap:wrap;gap:8px}.btns form{flex:1 1 30%}button,.btn{width:100%;padding:14px 8px;border:0;border-radius:12px;font-size:16px;font-weight:700;background:var(--navy);color:#fff;text-align:center;display:block;text-decoration:none;box-sizing:border-box}
.ok{background:#1b8f3a}.no{background:#c62828}.vf{background:#6b4eff}.or{background:var(--or);color:#1c1c1c}
img{width:100%;border-radius:12px}textarea{width:100%;height:190px;border-radius:10px;border:1px solid var(--line);padding:8px;box-sizing:border-box;background:var(--card);color:var(--fg)}
small{opacity:.7}a{color:#14439a;word-break:break-all}
</style></head><body>
<header><b>PDS • Government Update #${id}</b><div>${n.is_update ? '🔄 UPDATED' : '🔔 NEW'} • status: ${esc(n.status)} • v${n.version}</div></header>
<main>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
<div class="card"><table>${rows}
<tr><th>Official Application URL</th><td>${linkify(f.application_url)}</td></tr>
<tr><th>Official Notification</th><td>${linkify(f.notification_url !== NOT_MENTIONED ? f.notification_url : n.official_url)}</td></tr>
<tr><th>Source page</th><td>${linkify(n.official_url)}</td></tr></table></div>
<div class="card"><b>Verification</b><br><small>Domain: ${esc(v.official_host)} ${v.official_host_ok ? '✅ recognised government domain' : '⚠️ not recognised'}<br>
Checked: ${esc(v.verified_at)} • via ${esc(v.fetched_via)}<br>
${v.ungrounded_fields?.length ? 'Not confirmed in source (hidden): ' + esc(v.ungrounded_fields.join(', ')) : 'All dates / numbers / fees found in the source text ✅'}</small></div>
${decision ? `<div class="btns">${btn('ACCEPT', '✅ ACCEPT', 'ok')}${btn('REJECT', '❌ REJECT', 'no')}${btn('VERIFY', '🔎 VERIFY', 'vf')}</div>` : ''}
${posterStage && poster ? `
<div class="card"><b>Poster</b> <small>(no application link on it)</small><br><br><img src="${esc(pUrl)}" alt="poster">
<br><br><textarea id="cap" readonly>${esc(poster.caption)}</textarea>
<div class="btns" style="margin-top:8px">
<button class="or" id="share" type="button">📤 Share Poster (to WhatsApp group)</button>
<a class="btn" href="${esc(pUrl)}&dl=1">💾 Download</a>
<button type="button" id="copy">📋 Copy caption</button></div></div>
<div class="btns">${btn('SAVE', '💾 SAVE', 'ok')}${btn('REGENERATE', '🔁 REGENERATE', 'or')}${btn('CANCEL', '🚫 CANCEL', 'no')}</div>
<script>
const cap=document.getElementById('cap').value;
document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(cap);alert('Caption copied')}catch(e){document.getElementById('cap').select()}};
document.getElementById('share').onclick=async()=>{
 try{const r=await fetch(${JSON.stringify(pUrl)});const b=await r.blob();const file=new File([b],'PDS-poster-${id}.png',{type:'image/png'});
  if(navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({files:[file],text:cap});}
  else{alert('Your browser cannot share directly. Please use Download, then share the image in WhatsApp.')}}
 catch(e){if(e.name!=='AbortError')alert('Share failed. Use Download instead.')}};
</script>` : ''}
</main></body></html>`);
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cfg, env } from '../lib/config.js';
import { activeChannel, telegramChatId } from '../lib/channel.js';
import { aiProvider, pingAI } from '../lib/extract.js';
import { telegramTokenSet } from '../lib/telegram.js';
import { one, q } from '../lib/db.js';
import { deny, esc, isAdmin, qs } from '../lib/http.js';
import { whatsappConfigured } from '../lib/whatsapp.js';

/** Health status. Open: /api/health?key=<CRON_SECRET>   (add &format=json for machines) */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdmin(req)) return deny(res);
  const checks: Record<string, { ok: boolean; note: string }> = {};
  let dbOk = true;
  try {
    await q('SELECT 1');
  } catch (e) {
    dbOk = false;
    checks.database = { ok: false, note: String(e).slice(0, 120) };
  }
  const out: any = { time: new Date().toISOString() };
  if (dbOk) {
    checks.database = { ok: true, note: 'connected' };
    const run = await one<any>('SELECT started_at, finished_at, sources_checked, sources_failed, candidates, alerts_sent, error FROM runs ORDER BY id DESC LIMIT 1');
    const ageMin = run ? Math.round((Date.now() - new Date(run.started_at).getTime()) / 60000) : null;
    const stale = ageMin === null || ageMin > cfg.healthMaxAgeMin();
    checks.monitoring = { ok: !stale && !run?.error, note: run ? `last run ${ageMin} min ago${run.error ? ' (error: ' + run.error + ')' : ''}` : 'never ran' };
    const src = await one<any>(`SELECT count(*)::int total, count(*) FILTER (WHERE active)::int active,
      count(*) FILTER (WHERE last_status='ok')::int ok, count(*) FILTER (WHERE consecutive_failures>=3)::int failing,
      count(*) FILTER (WHERE last_checked_at IS NULL)::int never FROM sources`);
    checks.sources = { ok: src.total > 0 && src.failing <= Math.ceil(src.total * 0.3), note: `${src.ok}/${src.total} OK, ${src.failing} failing, ${src.never} not checked yet` };
    const st = await q<{ status: string; c: number }>('SELECT status, count(*)::int c FROM notifications GROUP BY status');
    const del = await one<any>(`SELECT count(*) FILTER (WHERE status='failed' AND created_at>now()-interval '2 days')::int failed, count(*) FILTER (WHERE kind='alert' AND created_at>now()-interval '2 days')::int alerts FROM deliveries`);
    const ch = await activeChannel();
    checks.alerts = { ok: ch !== 'none' && del.failed === 0, note: ch === 'none' ? 'No channel set up: pair Telegram (/api/telegram-setup) or configure WhatsApp' : `via ${ch}; ${del.alerts} alerts in 2 days, ${del.failed} failed sends` };
    checks.telegram = { ok: true, note: telegramTokenSet() ? ((await telegramChatId()) ? 'paired' : 'bot token set, not paired yet') : 'not used' };
    checks.whatsapp = { ok: true, note: whatsappConfigured() ? 'Gupshup configured (backup channel)' : 'not used' };
    const pending = st.filter((x) => ['alerted', 'poster_ready', 'verified', 'alert_failed'].includes(x.status)).reduce((a, b) => a + b.c, 0);
    out.notifications = Object.fromEntries(st.map((x) => [x.status, x.c]));
    out.waiting_for_you = pending;
    out.failing_sources = await q('SELECT id, name, last_error, consecutive_failures FROM sources WHERE consecutive_failures>=3 ORDER BY consecutive_failures DESC LIMIT 10');
    out.sources_with_errors = await q(`SELECT id, name, left(last_error, 120) AS last_error, consecutive_failures FROM sources WHERE last_status='error' ORDER BY consecutive_failures DESC, name LIMIT 40`);
    out.recent_failed_sends = await q(`SELECT kind, notification_id, left(error, 160) AS error, created_at FROM deliveries WHERE status='failed' ORDER BY id DESC LIMIT 5`);
    out.last_run = run;
  }
  if (qs(req, 'ai') === '1') {
    const p = await pingAI();
    checks.ai = { ok: p.ok, note: `${p.provider}: ${p.note}` };
  } else {
    checks.ai = { ok: aiProvider() !== 'none', note: aiProvider() === 'none' ? 'No AI key (set GEMINI_API_KEY – free)' : `${aiProvider()} key set (add &ai=1 to test it)` };
  }
  checks.firecrawl = { ok: true, note: env('FIRECRAWL_API_KEY') ? 'fallback enabled' : 'not set (direct fetch only)' };
  checks.secrets = { ok: !!(env('LINK_SECRET') && env('WEBHOOK_SECRET') && env('PUBLIC_BASE_URL')), note: 'LINK_SECRET / WEBHOOK_SECRET / PUBLIC_BASE_URL' };
  checks.group_sending = { ok: true, note: cfg.groupSendEnabled() ? 'Groups API enabled' : 'manual share (default)' };

  const critical = ['database', 'monitoring', 'ai'] as const;
  const status = critical.some((k) => !checks[k]?.ok) ? 'DOWN' : Object.values(checks).some((c) => !c.ok) ? 'WARNING' : 'OK';
  out.status = status;
  out.checks = checks;

  if (qs(req, 'format') === 'json') return res.status(200).json(out);
  const color = status === 'OK' ? '#1b8f3a' : status === 'WARNING' ? '#e0a100' : '#c62828';
  const te = status === 'OK' ? 'అన్నీ బాగా పనిచేస్తున్నాయి ✅' : status === 'WARNING' ? 'కొన్ని సమస్యలు ఉన్నాయి ⚠️' : 'సిస్టమ్ ఆగిపోయింది ❌';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(200).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDS Health</title>
<body style="font-family:system-ui,'Noto Sans Telugu';margin:0;background:#fff8ec"><div style="background:${color};color:#fff;padding:18px"><h2 style="margin:0">PDS Monitoring: ${status}</h2><div>${te}</div></div>
<div style="padding:14px"><p><b>మీ నిర్ణయం కోసం వేచి ఉన్నవి:</b> ${out.waiting_for_you ?? '-'}</p>
${Object.entries(checks).map(([k, c]) => `<p>${c.ok ? '✅' : '❌'} <b>${esc(k)}</b> — ${esc(c.note)}</p>`).join('')}
${(out.recent_failed_sends ?? []).length ? '<h3>Failed sends</h3>' + out.recent_failed_sends.map((s: any) => `<p>${esc(s.kind)} #${esc(s.notification_id)}: ${esc(s.error)}</p>`).join('') : ''}
${(out.sources_with_errors ?? []).length ? `<h3>Websites not opening now (${out.sources_with_errors.length})</h3>` + out.sources_with_errors.map((s: any) => `<p>${esc(s.name)}: ${esc(s.last_error)}</p>`).join('') : ''}
<small>${esc(out.time)}</small></div></body>`);
}

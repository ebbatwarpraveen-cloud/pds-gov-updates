import type { VercelRequest, VercelResponse } from '@vercel/node';
import { telegramChatId } from '../lib/channel.js';
import { cfg, env } from '../lib/config.js';
import { deny, esc, isAdmin, qs } from '../lib/http.js';
import { sign } from '../lib/text.js';
import { tgGetMe, tgSendMessage, tgSetWebhook, telegramTokenSet } from '../lib/telegram.js';

/** One-time setup page. Open: /api/telegram-setup?key=<CRON_SECRET> */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdmin(req)) return deny(res);
  const page = (body: string) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.status(200).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDS Telegram setup</title>
<body style="font-family:system-ui,'Noto Sans Telugu',sans-serif;max-width:640px;margin:20px auto;padding:0 14px;line-height:1.6">${body}</body>`);
  };

  if (!telegramTokenSet()) {
    return page(`<h2>❌ TELEGRAM_BOT_TOKEN లేదు</h2><p>Vercel → Settings → Environment Variables లో <b>TELEGRAM_BOT_TOKEN</b> (BotFather ఇచ్చిన టోకెన్) పెట్టి, Redeploy చేయండి. తర్వాత ఈ పేజీని మళ్ళీ తెరవండి.</p>`);
  }
  if (!cfg.baseUrl() || !env('WEBHOOK_SECRET') || !env('LINK_SECRET')) {
    return page(`<h2>❌ PUBLIC_BASE_URL / WEBHOOK_SECRET / LINK_SECRET సెట్టింగ్లు లేవు</h2>`);
  }
  const me = await tgGetMe();
  if (!me.ok) return page(`<h2>❌ టోకెన్ తప్పు</h2><p>${esc(me.error)}</p><p>BotFather నుంచి టోకెన్ మళ్ళీ కాపీ చేసి Vercel లో సరిచేయండి.</p>`);
  const hook = await tgSetWebhook(`${cfg.baseUrl()}/api/telegram`, env('WEBHOOK_SECRET'));
  if (!hook.ok) return page(`<h2>❌ Webhook సెట్ కాలేదు</h2><p>${esc(hook.error)}</p>`);

  const username = String(me.result?.username ?? '');
  const link = `https://t.me/${username}?start=${sign('pair')}`;
  const chat = await telegramChatId();
  if (chat && qs(req, 'test') === '1') await tgSendMessage(chat, '🔔 PDS టెస్ట్ మెసేజ్: Telegram కనెక్షన్ పనిచేస్తోంది ✅');

  page(`<h2>✅ Telegram బాట్ సిద్ధం (@${esc(username)})</h2>
<p>Webhook సెట్ అయింది.</p>
${chat ? `<p>✅ మీ ఖాతా ఇప్పటికే కనెక్ట్ అయింది. టెస్ట్ మెసేజ్ పంపాలంటే URL చివర <code>&amp;test=1</code> చేర్చండి.</p>` : ''}
<p><b>${chat ? 'వేరే ఫోన్/ఖాతా కనెక్ట్ చేయాలంటే' : 'చివరి అడుగు'}:</b> మీ ఫోన్‌లో ఈ లింక్ తెరిచి, Telegram లో <b>START</b> నొక్కండి:</p>
<p style="font-size:18px"><a href="${esc(link)}">👉 ${esc(link)}</a></p>
<p style="color:#b00"><small>ఈ లింక్ రహస్యమైనది. ఇతరులకు పంపకండి (దీన్ని ఉపయోగించినవారు మీ అలర్ట్‌లు పొందగలరు).</small></p>`);
}

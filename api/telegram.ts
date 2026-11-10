import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parseAction, performAction, resolveNotification, type Action } from '../lib/actions.js';
import { sendOwnerText, telegramChatId } from '../lib/channel.js';
import { env } from '../lib/config.js';
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { setSetting } from '../lib/settings.js';
import { parseTelegramUpdate, tgAnswerCallback, tgRemoveKeyboard, tgSendMessage } from '../lib/telegram.js';
import { safeEqual, verifySig } from '../lib/text.js';

export const config = { maxDuration: 60 };

const ACTIONS: Action[] = ['ACCEPT', 'REJECT', 'VERIFY', 'SEND_TO_GROUP', 'SAVE', 'CANCEL', 'REGENERATE'];

/** Telegram webhook. Telegram sends our WEBHOOK_SECRET in the X-Telegram-Bot-Api-Secret-Token header. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).send('ok');
  const secret = env('WEBHOOK_SECRET');
  if (!secret || !safeEqual(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''), secret)) return res.status(401).send('Unauthorized');
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;

  try {
    const u = parseTelegramUpdate(body);
    if (!u || !u.chatId) return res.status(200).send('ok');

    const fresh = await q(`INSERT INTO inbound_messages(provider_message_id, raw) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [`tg:${u.updateId}`, JSON.stringify(body).slice(0, 4000)]);
    if (fresh.length === 0) return res.status(200).send('duplicate');

    const owner = await telegramChatId();

    // --- pairing: the owner presses Start on the private link from /api/telegram-setup ---
    if (u.text.startsWith('/start')) {
      const code = u.text.split(/\s+/)[1] ?? '';
      if (code && verifySig('pair', code)) {
        await setSetting('telegram_owner_chat', u.chatId);
        await log('info', 'telegram', 'owner paired');
        await tgSendMessage(u.chatId, '✅ కనెక్ట్ అయింది! / Connected.\nఇకపై ప్రభుత్వ నోటిఫికేషన్ అలర్ట్‌లు ఇక్కడికే వస్తాయి. ACCEPT / REJECT / VERIFY బటన్లు నొక్కండి.');
      } else if (owner && owner === u.chatId) {
        await tgSendMessage(u.chatId, 'PDS Government Updates బాట్ పనిచేస్తోంది ✅');
      } else {
        await tgSendMessage(u.chatId, 'This is a private bot.');
      }
      return res.status(200).send('ok');
    }

    if (!owner || owner !== u.chatId) {
      await log('warn', 'telegram', 'ignored message from another chat');
      return res.status(200).send('ignored');
    }

    // --- button taps ---
    if (u.callbackId) {
      const m = u.callbackData.match(/^ACT:([A-Z_]+):(\d+)$/);
      const action = m && (ACTIONS as string[]).includes(m[1]) ? (m[1] as Action) : null;
      if (!m || !action) {
        await tgAnswerCallback(u.callbackId);
        return res.status(200).send('ok');
      }
      await tgAnswerCallback(u.callbackId, '⏳ ' + action.replace('_', ' '));
      const id = parseInt(m[2], 10);
      const r = await performAction(id, action, 'telegram');
      await log('info', 'telegram', `${action} #${id}`, { ok: r.ok });
      if (r.ok && action !== 'VERIFY' && action !== 'SEND_TO_GROUP' && u.messageId) await tgRemoveKeyboard(u.chatId, u.messageId);
      return res.status(200).send('ok');
    }

    // --- typed replies (ACCEPT, REJECT, ... or "ACCEPT 12") ---
    const { action, id } = parseAction(u.text);
    if (!action) {
      await sendOwnerText(null, 'menu', 'ACCEPT / REJECT / VERIFY (లేదా SEND TO GROUP / SAVE / CANCEL / REGENERATE) బటన్లు నొక్కండి లేదా అలా టైప్ చేయండి.');
      return res.status(200).send('ok');
    }
    const nid = await resolveNotification('', id);
    if (!nid) {
      await sendOwnerText(null, 'menu', 'No pending notification found.');
      return res.status(200).send('ok');
    }
    await performAction(nid, action, 'telegram');
    return res.status(200).send('ok');
  } catch (e) {
    await log('error', 'telegram', 'handler crashed', { error: String(e) });
    return res.status(200).send('error logged'); // always 200 so Telegram does not keep retrying
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

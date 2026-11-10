import { cfg, env } from './config.js';
import { q } from './db.js';
import { getSetting } from './settings.js';
import { log } from './log.js';
import { buildCaption, fullAlertText, POSTER_MENU, posterLink, privateLink, templateParams, type NotificationRow } from './messages.js';
import { tgSendMessage, tgSendPhoto, telegramTokenSet, type TgButton } from './telegram.js';
import { sendImage, sendTemplate, sendText, tracked, whatsappConfigured, type SendResult } from './whatsapp.js';

export type Channel = 'telegram' | 'whatsapp' | 'none';

/** Owner's Telegram chat: fixed by env, or learned when the owner pressed Start with the pairing link. */
export async function telegramChatId(): Promise<string> {
  return env('TELEGRAM_CHAT_ID') || (await getSetting('telegram_owner_chat').catch(() => ''));
}

/** Telegram is preferred (free, no 24-hour limit). WhatsApp (Gupshup) is used only when Telegram is not paired. */
export async function activeChannel(): Promise<Channel> {
  if (telegramTokenSet() && (await telegramChatId())) return 'telegram';
  if (whatsappConfigured() && env('GUPSHUP_ALERT_TEMPLATE_ID')) return 'whatsapp';
  return 'none';
}

/** WhatsApp-style *bold* / _italic_ marks look wrong in Telegram plain text. */
export const toPlain = (s: string) => s.replace(/\*([^*\n]+)\*/g, '$1').replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2');

async function trackedTg(notificationId: number | null, kind: string, chatId: string, fn: () => Promise<{ ok: boolean; result?: any; error?: string; skipped?: boolean }>): Promise<SendResult> {
  const row = await q<{ id: number }>('INSERT INTO deliveries(notification_id, kind, to_number) VALUES ($1,$2,$3) RETURNING id', [notificationId, kind, 'tg:' + chatId]);
  const r = await fn();
  const messageId = r.result?.message_id !== undefined ? 'tg:' + r.result.message_id : undefined;
  await q('UPDATE deliveries SET status=$2, provider_message_id=$3, error=$4, attempts=attempts+1, updated_at=now() WHERE id=$1', [row[0].id, r.ok ? 'delivered' : 'failed', messageId ?? null, r.error ?? null]);
  if (!r.ok && !r.skipped) await log('error', 'telegram', `${kind} send failed`, { error: r.error, notificationId });
  return { ok: r.ok, messageId, error: r.error, skipped: r.skipped };
}

/** Plain message to the owner on whichever channel is active. */
export async function sendOwnerText(notificationId: number | null, kind: string, text: string, rows?: TgButton[][]): Promise<SendResult> {
  const ch = await activeChannel();
  if (ch === 'telegram') {
    const chat = await telegramChatId();
    return trackedTg(notificationId, kind, chat, () => tgSendMessage(chat, toPlain(text), rows));
  }
  if (ch === 'whatsapp') {
    const owner = cfg.owner();
    return tracked(notificationId, kind, owner, () => sendText(owner, text));
  }
  return { ok: false, skipped: true, error: 'No notification channel is configured' };
}

/** First message about a new / updated notification (with ACCEPT / REJECT / VERIFY). */
export async function sendOwnerAlert(n: NotificationRow): Promise<SendResult> {
  const ch = await activeChannel();
  if (ch === 'telegram') {
    const chat = await telegramChatId();
    const rows: TgButton[][] = [
      [
        { text: '✅ ACCEPT', data: `ACT:ACCEPT:${n.id}` },
        { text: '❌ REJECT', data: `ACT:REJECT:${n.id}` },
        { text: '🔎 VERIFY', data: `ACT:VERIFY:${n.id}` },
      ],
      [{ text: '📄 Open details page', url: privateLink(n.id) }],
    ];
    return trackedTg(n.id, 'alert', chat, () => tgSendMessage(chat, toPlain(fullAlertText(n)), rows));
  }
  if (ch === 'whatsapp') {
    const owner = cfg.owner();
    const tpl = env('GUPSHUP_ALERT_TEMPLATE_ID');
    return tracked(n.id, 'alert', owner, () => sendTemplate(owner, tpl, templateParams(n)));
  }
  return { ok: false, skipped: true, error: 'No notification channel is configured' };
}

export async function sendOwnerPoster(n: NotificationRow, posterId: number, png: Buffer): Promise<SendResult> {
  const ch = await activeChannel();
  if (ch === 'telegram') {
    const chat = await telegramChatId();
    return trackedTg(n.id, 'poster', chat, () => tgSendPhoto(chat, png, `PDS Poster #${n.id}`));
  }
  const owner = cfg.owner();
  return tracked(n.id, 'poster', owner, () => sendImage(owner, posterLink(posterId), 'PDS Poster #' + n.id));
}

/** SEND TO GROUP / SAVE / CANCEL / REGENERATE options. */
export async function sendOwnerPosterMenu(n: NotificationRow): Promise<SendResult> {
  const ch = await activeChannel();
  if (ch === 'telegram') {
    const chat = await telegramChatId();
    const rows: TgButton[][] = [
      [
        { text: '📤 SEND TO GROUP', data: `ACT:SEND_TO_GROUP:${n.id}` },
        { text: '💾 SAVE', data: `ACT:SAVE:${n.id}` },
      ],
      [
        { text: '🚫 CANCEL', data: `ACT:CANCEL:${n.id}` },
        { text: '🔁 REGENERATE', data: `ACT:REGENERATE:${n.id}` },
      ],
      [{ text: '📱 Share Poster (to WhatsApp group)', url: privateLink(n.id) }],
    ];
    return trackedTg(n.id, 'menu', chat, () => tgSendMessage(chat, 'ఏం చేయాలి? / What next?\n(Tip: press and hold the poster above → Forward / Share → WhatsApp group)', rows));
  }
  return sendOwnerText(n.id, 'menu', POSTER_MENU + `\n\n(ID #${n.id}) Web: ${privateLink(n.id)}`);
}

export { buildCaption };

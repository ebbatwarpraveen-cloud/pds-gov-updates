import { env } from './config.js';

export interface TgResult {
  ok: boolean;
  result?: any;
  error?: string;
  skipped?: boolean;
}
export type TgButton = { text: string; data?: string; url?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const telegramTokenSet = () => !!env('TELEGRAM_BOT_TOKEN');

async function call(method: string, body: Record<string, unknown> | FormData, tries = 3): Promise<TgResult> {
  const token = env('TELEGRAM_BOT_TOKEN');
  if (!token) return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN is not set' };
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const isForm = body instanceof FormData;
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (res.ok && j.ok) return { ok: true, result: j.result };
      last = `HTTP ${res.status}: ${String(j.description ?? '').slice(0, 200)}`;
      if (res.status === 429) {
        await sleep(Math.min(10_000, (j.parameters?.retry_after ?? 2) * 1000));
        continue;
      }
      if (res.status >= 400 && res.status < 500) break; // client error: retrying will not help
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000 * 2 ** i);
  }
  return { ok: false, error: last.replace(token, '***') };
}

const keyboard = (rows?: TgButton[][]) =>
  rows?.length
    ? { inline_keyboard: rows.map((r) => r.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? b.text }))) }
    : undefined;

/** Splits long text (Telegram limit is 4096 characters); buttons go on the last part. */
export async function tgSendMessage(chatId: string, text: string, rows?: TgButton[][]): Promise<TgResult> {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 3900) {
    let cut = rest.lastIndexOf('\n\n', 3900);
    if (cut < 1500) cut = rest.lastIndexOf('\n', 3900);
    if (cut < 1500) cut = 3900;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  let r: TgResult = { ok: false };
  for (let i = 0; i < parts.length; i++) {
    r = await call('sendMessage', { chat_id: chatId, text: parts[i], disable_web_page_preview: true, reply_markup: i === parts.length - 1 ? keyboard(rows) : undefined });
    if (!r.ok) return r;
  }
  return r;
}

export async function tgSendPhoto(chatId: string, png: Buffer, caption?: string): Promise<TgResult> {
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption.slice(0, 1000));
  form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'pds-poster.png');
  return call('sendPhoto', form);
}

export const tgAnswerCallback = (id: string, text?: string) => call('answerCallbackQuery', { callback_query_id: id, text: text?.slice(0, 190) }, 1);
export const tgRemoveKeyboard = (chatId: string, messageId: number) => call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, 1);
export const tgGetMe = () => call('getMe', {}, 2);
export const tgSetWebhook = (url: string, secret: string) =>
  call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }, 2);

export interface TgUpdate {
  updateId: number;
  chatId: string;
  text: string;
  callbackId: string;
  callbackData: string;
  messageId: number;
}

export function parseTelegramUpdate(body: any): TgUpdate | null {
  if (!body || typeof body !== 'object') return null;
  if (body.callback_query) {
    const c = body.callback_query;
    return { updateId: Number(body.update_id), chatId: String(c.message?.chat?.id ?? c.from?.id ?? ''), text: '', callbackId: String(c.id ?? ''), callbackData: String(c.data ?? ''), messageId: Number(c.message?.message_id ?? 0) };
  }
  const m = body.message;
  if (m && typeof m.text === 'string') {
    return { updateId: Number(body.update_id), chatId: String(m.chat?.id ?? ''), text: m.text.trim(), callbackId: '', callbackData: '', messageId: Number(m.message_id ?? 0) };
  }
  return null;
}

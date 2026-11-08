import { cfg, env } from './config.js';
import { q } from './db.js';
import { log } from './log.js';

const API = 'https://api.gupshup.io';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  skipped?: boolean;
}

export function whatsappConfigured(): boolean {
  return !!(env('GUPSHUP_API_KEY') && env('GUPSHUP_APP_NAME') && env('GUPSHUP_SOURCE_NUMBER') && cfg.owner());
}

async function post(path: string, form: Record<string, string>, tries = 3): Promise<SendResult> {
  if (!whatsappConfigured()) return { ok: false, skipped: true, error: 'WhatsApp (Gupshup) is not configured' };
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { apikey: env('GUPSHUP_API_KEY'), 'content-type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
        body: new URLSearchParams(form).toString(),
      });
      const text = await res.text();
      let j: any = {};
      try {
        j = JSON.parse(text);
      } catch {
        /* non-json */
      }
      if (res.ok && (j.status === 'submitted' || j.messageId || j.messages)) {
        return { ok: true, messageId: j.messageId ?? j.messages?.[0]?.id };
      }
      last = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // do not retry client errors
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000 * 2 ** i);
  }
  return { ok: false, error: last };
}

const base = (to: string) => ({
  channel: 'whatsapp',
  source: env('GUPSHUP_SOURCE_NUMBER').replace(/\D/g, ''),
  destination: to.replace(/\D/g, ''),
  'src.name': env('GUPSHUP_APP_NAME'),
});

/** Free-form messages only work inside the 24-hour window after the owner last wrote to us. */
export const sendText = (to: string, text: string) =>
  post('/wa/api/v1/msg', { ...base(to), message: JSON.stringify({ type: 'text', text: text.slice(0, 4000) }) });

export const sendImage = (to: string, url: string, caption: string) =>
  post('/wa/api/v1/msg', { ...base(to), message: JSON.stringify({ type: 'image', originalUrl: url, previewUrl: url, caption: caption.slice(0, 1000) }) });

/** Business-initiated message: needs a template approved by WhatsApp. */
export const sendTemplate = (to: string, templateId: string, params: string[]) =>
  post('/wa/api/v1/template/msg', { ...base(to), template: JSON.stringify({ id: templateId, params }) });

/**
 * Posting into a WhatsApp group is only possible through the Groups API (beta, request-only at Gupshup),
 * only for groups created by the business number, and the documented endpoint supports text only.
 */
export async function sendGroupText(text: string): Promise<SendResult> {
  if (!cfg.groupSendEnabled()) return { ok: false, skipped: true, error: 'Group sending is not enabled' };
  const appId = env('GUPSHUP_APP_ID');
  const groupId = env('GUPSHUP_GROUP_ID');
  if (!appId || !groupId || !env('GUPSHUP_API_KEY')) return { ok: false, skipped: true, error: 'Group API settings missing' };
  try {
    const res = await fetch(`${API}/wa/app/${appId}/v3/msg`, {
      method: 'POST',
      headers: { apikey: env('GUPSHUP_API_KEY'), 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'group', to: groupId, type: 'text', text: { body: text.slice(0, 4000) } }),
    });
    const t = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${t.slice(0, 300)}` };
    let j: any = {};
    try {
      j = JSON.parse(t);
    } catch {
      /* ignore */
    }
    return { ok: true, messageId: j.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Send + record delivery tracking row. */
export async function tracked(
  notificationId: number | null,
  kind: string,
  to: string,
  fn: () => Promise<SendResult>,
): Promise<SendResult> {
  const row = await q<{ id: number }>('INSERT INTO deliveries(notification_id, kind, to_number) VALUES ($1,$2,$3) RETURNING id', [notificationId, kind, to]);
  const r = await fn();
  await q('UPDATE deliveries SET status=$2, provider_message_id=$3, error=$4, attempts=attempts+1, updated_at=now() WHERE id=$1', [
    row[0].id,
    r.ok ? 'sent' : 'failed',
    r.messageId ?? null,
    r.error ?? null,
  ]);
  if (!r.ok && !r.skipped) await log('error', 'whatsapp', `${kind} send failed`, { error: r.error, notificationId });
  return r;
}

/* ---- inbound webhook parsing (tolerant: Gupshup v2 and Meta-style v3 payloads) ---- */
export interface Inbound {
  messageId: string;
  from: string;
  text: string;
  contextId: string;
}

export function parseInbound(body: any): Inbound | null {
  if (!body || typeof body !== 'object') return null;
  // Gupshup v2: { type:'message', payload:{ id, source, type, payload:{ text | title | postbackText }, sender:{phone}, context:{id,gsId} } }
  const p = body.payload;
  if (body.type === 'message' && p) {
    const inner = p.payload ?? {};
    const text = String(inner.text ?? inner.title ?? inner.postbackText ?? inner.id ?? (typeof inner === 'string' ? inner : '') ?? '').trim();
    const from = String(p.source ?? p.sender?.phone ?? '').replace(/\D/g, '');
    if (text && from) return { messageId: String(p.id ?? p.gsId ?? ''), from, text, contextId: String(p.context?.gsId ?? p.context?.id ?? '') };
  }
  // Meta / Gupshup v3: entry[0].changes[0].value.messages[0]
  const m = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (m) {
    const text = String(m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '').trim();
    if (text) return { messageId: String(m.id ?? ''), from: String(m.from ?? '').replace(/\D/g, ''), text, contextId: String(m.context?.id ?? '') };
  }
  return null;
}

/** Delivery receipts: Gupshup v2 `message-event` payloads. */
export function parseStatus(body: any): { messageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; error?: string } | null {
  if (body?.type === 'message-event' && body.payload) {
    const p = body.payload;
    const t = String(p.type ?? '').toLowerCase();
    const id = String(p.id ?? p.gsId ?? '');
    if (!id) return null;
    if (t === 'delivered') return { messageId: id, status: 'delivered' };
    if (t === 'read') return { messageId: id, status: 'read' };
    if (t === 'failed') return { messageId: id, status: 'failed', error: JSON.stringify(p.payload ?? p).slice(0, 300) };
    if (t === 'sent' || t === 'enqueued') return { messageId: id, status: 'sent' };
  }
  const st = body?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
  if (st?.id) return { messageId: String(st.id), status: (['sent', 'delivered', 'read', 'failed'].includes(st.status) ? st.status : 'sent') as any, error: st.errors?.[0]?.title };
  return null;
}

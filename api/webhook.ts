import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env, cfg } from '../lib/config.js';
import { parseAction, performAction, resolveNotification } from '../lib/actions.js';
import { one, q } from '../lib/db.js';
import { qs } from '../lib/http.js';
import { log } from '../lib/log.js';
import { safeEqual } from '../lib/text.js';
import { parseInbound, parseStatus, sendText, tracked } from '../lib/whatsapp.js';

export const config = { maxDuration: 60 };

/** Gupshup callback URL:  https://<site>/api/webhook?key=<WEBHOOK_SECRET> */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = env('WEBHOOK_SECRET');
  if (!secret || !safeEqual(qs(req, 'key'), secret)) return res.status(401).send('Unauthorized');
  if (req.method !== 'POST') return res.status(200).send('ok');
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;

  try {
    // delivery receipts
    const st = parseStatus(body);
    if (st) {
      await q(`UPDATE deliveries SET status=$2, error=COALESCE($3,error), updated_at=now() WHERE provider_message_id=$1`, [st.messageId, st.status, st.error ?? null]);
      return res.status(200).send('ok');
    }

    const inc = parseInbound(body);
    if (!inc) {
      await log('info', 'webhook', 'unrecognised payload', body);
      return res.status(200).send('ok');
    }
    if (inc.messageId) {
      const fresh = await q(`INSERT INTO inbound_messages(provider_message_id, raw) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [inc.messageId, JSON.stringify(body).slice(0, 8000)]);
      if (fresh.length === 0) return res.status(200).send('duplicate'); // already processed
    }
    const owner = cfg.owner();
    if (inc.from !== owner) {
      await log('warn', 'webhook', 'ignored message from non-owner number', { from: inc.from.slice(-4) });
      return res.status(200).send('ignored');
    }

    const { action, id } = parseAction(inc.text);
    if (!action) {
      await tracked(null, 'menu', owner, () => sendText(owner, 'ACCEPT / REJECT / VERIFY (లేదా SEND TO GROUP / SAVE / CANCEL / REGENERATE) అని reply చేయండి.'));
      return res.status(200).send('ok');
    }
    const nid = await resolveNotification(inc.contextId, id);
    if (!nid) {
      await tracked(null, 'menu', owner, () => sendText(owner, 'No pending notification found.'));
      return res.status(200).send('ok');
    }
    const r = await performAction(nid, action, 'whatsapp');
    await log('info', 'webhook', `${action} #${nid}`, { ok: r.ok });
    return res.status(200).send('ok');
  } catch (e) {
    await log('error', 'webhook', 'handler crashed', { error: String(e) });
    return res.status(200).send('error logged'); // always 200 so the provider does not hammer retries
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
void one;

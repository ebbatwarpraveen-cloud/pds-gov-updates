import { cfg, NOT_MENTIONED } from './config.js';
import { one, q } from './db.js';
import type { FieldName } from './extract.js';
import { log } from './log.js';
import { sendOwnerPoster, sendOwnerPosterMenu, sendOwnerText } from './channel.js';
import { buildCaption, fullAlertText, posterLink, privateLink, verifyText, type NotificationRow } from './messages.js';
import { renderPoster } from './poster.js';
import { sendGroupText, tracked } from './whatsapp.js';

export type Action = 'ACCEPT' | 'REJECT' | 'VERIFY' | 'SEND_TO_GROUP' | 'SAVE' | 'CANCEL' | 'REGENERATE';

export function parseAction(text: string): { action: Action | null; id?: number } {
  const t = text.toUpperCase().replace(/[^A-Z0-9 #]/g, ' ').replace(/\s+/g, ' ').trim();
  const idm = t.match(/#?(\d{1,9})\b/);
  const id = idm ? parseInt(idm[1], 10) : undefined;
  const word = t.replace(/#?\d+/g, '').trim();
  const map: [RegExp, Action][] = [
    [/^(ACCEPT|APPROVE|YES|OK)$/, 'ACCEPT'],
    [/^(REJECT|NO|DECLINE)$/, 'REJECT'],
    [/^VERIFY$/, 'VERIFY'],
    [/^(SEND TO GROUP|SEND|GROUP|SHARE)$/, 'SEND_TO_GROUP'],
    [/^(SAVE|DOWNLOAD|SAVE DOWNLOAD)$/, 'SAVE'],
    [/^CANCEL$/, 'CANCEL'],
    [/^(REGENERATE|REGEN|AGAIN)$/, 'REGENERATE'],
  ];
  for (const [re, a] of map) if (re.test(word)) return { action: a, id: undefined === id ? undefined : id };
  // numbered poster menu (1-4) only when the message is just the digit
  if (/^[1-4]$/.test(t)) return { action: (['SEND_TO_GROUP', 'SAVE', 'CANCEL', 'REGENERATE'] as Action[])[parseInt(t, 10) - 1] };
  return { action: null };
}

export interface ActionResult {
  ok: boolean;
  message: string;
  posterId?: number;
}

async function latestPoster(notificationId: number) {
  return one<{ id: number; caption: string; version: number }>('SELECT id, caption, version FROM posters WHERE notification_id=$1 ORDER BY id DESC LIMIT 1', [notificationId]);
}

export async function makePoster(n: NotificationRow): Promise<{ id: number; caption: string; png: Buffer }> {
  const png = await renderPoster({ headline_te: n.data.headline_te ?? '', fields: n.data.fields as Record<FieldName, string>, isUpdate: n.is_update, changed: n.data.changed });
  const caption = buildCaption(n);
  const prev = await latestPoster(n.id);
  const r = await q<{ id: number }>('INSERT INTO posters(notification_id, version, png, caption) VALUES ($1,$2,$3,$4) RETURNING id', [n.id, (prev?.version ?? 0) + 1, png, caption]);
  return { id: r[0].id, caption, png };
}

async function deliverPoster(n: NotificationRow, posterId: number, caption: string, png: Buffer) {
  await sendOwnerPoster(n, posterId, png);
  await sendOwnerText(n.id, 'caption', caption);
  await sendOwnerPosterMenu(n);
}

/** The single place where ACCEPT / REJECT / VERIFY and poster options are applied (WhatsApp or web page). */
export async function performAction(id: number, action: Action, via: 'whatsapp' | 'telegram' | 'web'): Promise<ActionResult> {
  const n = await one<NotificationRow>('SELECT * FROM notifications WHERE id=$1', [id]);
  if (!n) return { ok: false, message: `Notification #${id} not found.` };
  const st = n.status;
  const reply = async (text: string) => {
    if (via !== 'web') await sendOwnerText(id, 'menu', text);
  };

  // --- decision stage ---
  if (['alerted', 'verified', 'alert_failed'].includes(st)) {
    if (action === 'ACCEPT') {
      await q(`UPDATE notifications SET status='accepted', updated_at=now() WHERE id=$1`, [id]);
      try {
        const { id: pid, caption, png } = await makePoster(n);
        await q(`UPDATE notifications SET status='poster_ready', updated_at=now() WHERE id=$1`, [id]);
        await deliverPoster(n, pid, caption, png);
        return { ok: true, message: 'Accepted. Poster and caption created.', posterId: pid };
      } catch (e) {
        await q(`UPDATE notifications SET status='alerted', updated_at=now() WHERE id=$1`, [id]);
        await log('error', 'poster', 'poster generation failed', { id, error: String(e) });
        await reply('⚠️ Poster generation failed. Reply ACCEPT again to retry.');
        return { ok: false, message: 'Poster generation failed. Try ACCEPT again.' };
      }
    }
    if (action === 'REJECT') {
      await q(`UPDATE notifications SET status='rejected', updated_at=now() WHERE id=$1`, [id]);
      await reply(`❌ Notification #${id} rejected. No poster will be made.`);
      return { ok: true, message: 'Rejected. No poster will be generated.' };
    }
    if (action === 'VERIFY') {
      await reply(verifyText(n) + '\n\n' + fullAlertText(n));
      return { ok: true, message: 'Verification details sent.' };
    }
    await reply(`Notification #${id} is waiting for ACCEPT / REJECT / VERIFY.`);
    return { ok: false, message: 'Please choose ACCEPT, REJECT or VERIFY first.' };
  }

  // --- poster stage ---
  if (st === 'poster_ready' || st === 'saved') {
    const p = await latestPoster(id);
    if (action === 'REGENERATE') {
      const { id: pid, caption, png } = await makePoster(n);
      await deliverPoster(n, pid, caption, png);
      return { ok: true, message: 'New poster created.', posterId: pid };
    }
    if (action === 'SAVE') {
      await q(`UPDATE notifications SET status='saved', updated_at=now() WHERE id=$1`, [id]);
      const link = p ? posterLink(p.id) : '';
      await reply(`💾 Saved. Download poster:\n${link}`);
      return { ok: true, message: 'Saved. Use the download button.', posterId: p?.id };
    }
    if (action === 'CANCEL') {
      await q(`UPDATE notifications SET status='cancelled', updated_at=now() WHERE id=$1`, [id]);
      await reply('🚫 Cancelled. Nothing was shared.');
      return { ok: true, message: 'Cancelled.' };
    }
    if (action === 'SEND_TO_GROUP') {
      const g = cfg.groupSendEnabled() && p ? await tracked(id, 'group', 'group', () => sendGroupText(p.caption)) : null;
      if (g?.ok) {
        await q(`UPDATE notifications SET status='saved', updated_at=now() WHERE id=$1`, [id]);
        await reply('✅ Caption sent to the WhatsApp group. (The official Groups API sends text only – please also share the poster image manually.)');
        return { ok: true, message: 'Caption sent to group.', posterId: p?.id };
      }
      await reply(
        `📤 WhatsApp does not allow this system to post into your existing groups.\nShare manually in 2 taps:\n${privateLink(id)}\n(Open → "Share Poster" → choose your group). Or press and hold the poster here → Forward / Share → WhatsApp.`,
      );
      return { ok: true, message: 'Direct group posting is unavailable. Use "Share Poster" to send it to your group from your phone.', posterId: p?.id };
    }
    await reply(`Poster ready. Reply SEND TO GROUP / SAVE / CANCEL / REGENERATE.`);
    return { ok: false, message: 'Choose a poster option.' };
  }

  const msg = `Notification #${id} is already ${st}. No action taken (duplicate processing prevented).`;
  await reply(msg);
  return { ok: false, message: msg };
}

/** Which notification is the owner answering? context message → explicit #id → newest open one. */
export async function resolveNotification(contextId: string, explicitId?: number): Promise<number | undefined> {
  if (explicitId) {
    const e = await one<{ id: number }>('SELECT id FROM notifications WHERE id=$1', [explicitId]);
    if (e) return e.id;
  }
  if (contextId) {
    const d = await one<{ notification_id: number }>('SELECT notification_id FROM deliveries WHERE provider_message_id=$1 AND notification_id IS NOT NULL LIMIT 1', [contextId]);
    if (d) return d.notification_id;
    const n = await one<{ id: number }>('SELECT id FROM notifications WHERE alert_message_id=$1', [contextId]);
    if (n) return n.id;
  }
  const latest = await one<{ id: number }>(`SELECT id FROM notifications WHERE status IN ('alerted','poster_ready') ORDER BY updated_at DESC LIMIT 1`);
  return latest?.id;
}

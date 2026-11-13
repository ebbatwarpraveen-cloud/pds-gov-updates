import { sendOwnerText } from './channel.js';
import { one, q } from './db.js';
import { getSetting, setSetting } from './settings.js';

/** India time (UTC+5:30) as { date: 'YYYY-MM-DD', hour }. */
export function istNow(now = new Date()): { date: string; hour: number } {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  return { date: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

/**
 * Once a day (after 8 AM IST) the owner gets a short status message.
 * If one morning this message does not arrive, monitoring has stopped.
 */
export async function maybeHeartbeat(now = new Date(), hourFrom = 8): Promise<boolean> {
  const { date, hour } = istNow(now);
  if (hour < hourFrom) return false;
  if ((await getSetting('last_heartbeat_date')) === date) return false;
  // claim the day first so two parallel runs never send it twice
  await setSetting('last_heartbeat_date', date);

  const src = await one<any>(`SELECT count(*)::int total, count(*) FILTER (WHERE last_status='ok')::int ok FROM sources WHERE active`);
  const failing = await q<{ name: string }>(`SELECT name FROM sources WHERE active AND consecutive_failures>=3 ORDER BY consecutive_failures DESC LIMIT 5`);
  const day = await one<any>(`SELECT count(*) FILTER (WHERE kind='alert' AND status<>'failed')::int alerts FROM deliveries WHERE created_at > now() - interval '24 hours'`);
  const wait = await one<any>(`SELECT count(*)::int c FROM notifications WHERE status IN ('alerted','poster_ready','verified','alert_failed')`);
  const filtered = await one<any>(`SELECT count(*)::int c FROM notifications WHERE status='filtered' AND created_at > now() - interval '24 hours'`);
  const runs = await one<any>(`SELECT count(*)::int c FROM runs WHERE started_at > now() - interval '24 hours'`);

  const lines = [
    '🟢 PDS రోజువారీ నివేదిక / Daily status',
    `• మానిటరింగ్ రన్‌లు (24 గం.): ${runs?.c ?? 0}`,
    `• పనిచేస్తున్న సైట్లు: ${src?.ok ?? 0} / ${src?.total ?? 0}`,
    `• కొత్త అలర్ట్‌లు (24 గం.): ${day?.alerts ?? 0}`,
    `• వడపోతలో ఆగినవి: ${filtered?.c ?? 0}`,
    `• మీ నిర్ణయం కోసం వేచి ఉన్నవి: ${wait?.c ?? 0}`,
  ];
  if (failing.length) lines.push(`• తెరుచుకోని సైట్లు: ${failing.map((f) => f.name).join(', ')}`);
  if ((runs?.c ?? 0) < 20) lines.push('⚠️ రన్‌లు తక్కువగా ఉన్నాయి: షెడ్యూలర్ (cron-job.org) తనిఖీ చేయండి.');
  await sendOwnerText(null, 'heartbeat', lines.join('\n'));
  return true;
}

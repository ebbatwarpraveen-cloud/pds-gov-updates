import type { VercelRequest, VercelResponse } from '@vercel/node';
import { NOT_MENTIONED } from '../lib/config.js';
import { FIELDS } from '../lib/extract.js';
import { deny, isAdmin } from '../lib/http.js';
import { one, q } from '../lib/db.js';
import { sendAlert } from '../lib/pipeline.js';

export const config = { maxDuration: 60 };

/**
 * Sends a clearly-marked [TEST] notification through the real alert → ACCEPT → poster flow,
 * so the owner can check Telegram end to end. Open: /api/demo?key=<CRON_SECRET>
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdmin(req)) return deny(res);
  const fields: Record<string, string> = Object.fromEntries(FIELDS.map((f) => [f, NOT_MENTIONED]));
  Object.assign(fields, {
    title: '[TEST] Recruitment of Junior Assistants and Staff Nurses 2026',
    department: 'Sample Department (test only – not a real notification)',
    post_names: 'Junior Assistant; Staff Nurse; Lab Technician',
    vacancies: '1,284',
    eligibility: 'Indian citizen; local candidates of Telangana as per rules',
    age_limit: '18 to 44 years',
    qualification: 'Intermediate / B.Sc Nursing / DMLT as per post',
    application_start: '10 Nov 2026',
    last_date: '30 Nov 2026',
    exam_date: 'Dec 2026 (to be announced)',
    application_fee: 'Rs. 500 (SC/ST/PH: Rs. 250)',
    selection_process: 'Written exam followed by certificate verification',
    important_instructions: 'This is only a TEST. Apply online only. Keep scanned photo and signature ready.',
    application_url: 'https://www.telangana.gov.in/',
    notification_url: 'https://www.telangana.gov.in/',
  });
  const stamp = Date.now();
  const row = await one<{ id: number }>(
    `INSERT INTO notifications(fingerprint, fingerprint2, source_id, title, department, official_url, status, data, verification, verified_at)
     VALUES ($1,$2,NULL,$3,$4,$5,'verified',$6,$7,now()) RETURNING id`,
    [
      'demo-' + stamp, 'demo2-' + stamp, fields.title, fields.department, 'https://www.telangana.gov.in/',
      JSON.stringify({ fields, headline_te: 'తెలంగాణ వైద్య ఆరోగ్య శాఖలో 1,284 పోస్టుల భర్తీ (టెస్ట్)', short_summary_en: 'Test notification', category: 'recruitment', changed: [] }),
      JSON.stringify({ official_host: 'www.telangana.gov.in', official_host_ok: true, verified_at: new Date().toISOString(), fetched_via: 'demo', ungrounded_fields: [], verdict: 'pass', reasons: [] }),
    ],
  );
  const sent = await sendAlert(row!.id);
  await q('SELECT 1');
  res.status(200).json({ ok: sent, notification_id: row!.id, note: sent ? 'Test alert sent. Check Telegram and press ACCEPT.' : 'Alert not sent – check /api/health (channel not ready).' });
}

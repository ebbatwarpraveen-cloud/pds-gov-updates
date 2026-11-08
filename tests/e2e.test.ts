import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://pds:pds@localhost/pdstest',
  LINK_SECRET: 'lk', WEBHOOK_SECRET: 'wh', CRON_SECRET: 'cr', PUBLIC_BASE_URL: 'https://pds.test',
  ANTHROPIC_API_KEY: 'sk-test', GUPSHUP_API_KEY: 'g', GUPSHUP_APP_NAME: 'PDSApp', GUPSHUP_SOURCE_NUMBER: '919000000000',
  GUPSHUP_ALERT_TEMPLATE_ID: 'tpl-1', OWNER_WHATSAPP: '916305478376',
});

const { q, db } = await import('../lib/db.js');
const P = await import('../lib/pipeline.js');
const A = await import('../lib/actions.js');
const { containsLink } = await import('../lib/text.js');
const webhook = (await import('../api/webhook.js')).default;
const monitor = (await import('../api/monitor.js')).default;
const health = (await import('../api/health.js')).default;
const detail = (await import('../api/n.js')).default;

const SOURCE = 'https://mhsrb.telangana.gov.in/';
const NOTIF = 'https://mhsrb.telangana.gov.in/notifications/staff-nurse-2026.html';
let notifLastDate = '30-11-2026';
let sourceHasNew = false;
const sent: { url: string; body: URLSearchParams }[] = [];
let aiCalls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === SOURCE) {
    const extra = sourceHasNew ? `<a href="${NOTIF}">Notification for recruitment of Staff Nurses 2026 – apply online</a>` : '';
    return new Response(`<html><body><a href="/about">About Us</a><a href="/old.pdf">Old recruitment notification 2023 vacancies</a>${extra}<a href="/x1">xx</a><a href="/x2">yy</a></body></html>`, { headers: { 'content-type': 'text/html' } });
  }
  if (url === NOTIF) {
    return new Response(`<html><body><h1>Notification for recruitment of Staff Nurses 2026</h1><p>Total vacancies: 120. Last date for online application ${notifLastDate}. Age limit 18 to 44 years. Qualification: B.Sc Nursing. Fee Rs. 500.</p><a href="https://apply.telangana.gov.in/nurse">Apply Online</a>${'<p>filler</p>'.repeat(60)}</body></html>`, { headers: { 'content-type': 'text/html' } });
  }
  if (url.includes('api.anthropic.com')) {
    aiCalls++;
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'record_notification', input: {
        is_official_notification: true, is_relevant: true, relevance_reason: 'recruitment', category: 'recruitment',
        headline_te: 'స్టాఫ్ నర్స్ పోస్టుల భర్తీ', short_summary_en: 'Staff nurse recruitment',
        title: 'Recruitment of Staff Nurses 2026', department: 'Medical & Health Services Recruitment Board', post_names: 'Staff Nurse',
        vacancies: '120', eligibility: 'Not mentioned in the official notification', age_limit: '18 to 44 years', qualification: 'B.Sc Nursing',
        required_documents: '', application_start: '', last_date: notifLastDate, exam_date: '', application_fee: 'Rs. 500 (SC/ST Rs. 999 invented)',
        category_fee: '', selection_process: '', revised_dates: '', deadline_extension: '', important_instructions: 'Apply online at https://apply.telangana.gov.in/nurse only',
        application_process: 'Online', application_url: 'https://apply.telangana.gov.in/nurse', notification_url: '',
      } }],
    }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('api.gupshup.io')) {
    sent.push({ url, body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ status: 'submitted', messageId: 'gs-' + sent.length }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const fakeRes = () => {
  const r: any = { code: 0, body: undefined, headers: {} };
  r.status = (c: number) => ((r.code = c), r);
  r.send = (b: any) => ((r.body = b), r);
  r.json = (b: any) => ((r.body = b), r);
  r.setHeader = (k: string, v: string) => ((r.headers[k] = v), r);
  r.redirect = (c: number, u: string) => ((r.code = c), (r.location = u), r);
  return r;
};

before(async () => {
  await q('TRUNCATE notifications, seen_links, deliveries, posters, inbound_messages, runs, logs RESTART IDENTITY CASCADE');
  await q('UPDATE sources SET baselined=false, last_checked_at=NULL');
  await P.syncSources();
});
after(async () => {
  globalThis.fetch = realFetch;
  await db().end();
});

const src = async () => (await q<any>(`SELECT * FROM sources WHERE id='tg-mhsrb'`))[0];

test('1. first visit only learns existing links (no flood of old alerts)', async () => {
  const r = await P.checkSource(await src());
  assert.equal(r.ok, true);
  assert.equal(r.baseline, true);
  assert.equal(r.candidates.length, 0);
  assert.equal(sent.length, 0);
});

test('2. a new notification is detected, verified, extracted, and a private WhatsApp alert is sent', async () => {
  sourceHasNew = true;
  const r = await P.checkSource(await src());
  assert.equal(r.candidates.length, 1);
  const outcome = await P.processCandidate(await src(), r.candidates[0]);
  assert.equal(outcome, 'alerted');
  const n = (await q<any>('SELECT * FROM notifications'))[0];
  assert.equal(n.status, 'alerted');
  assert.equal(n.data.fields.vacancies, '120');
  assert.equal(n.data.fields.application_fee, 'Not mentioned in the official notification', 'invented fee 999 must be dropped');
  assert.equal(n.data.fields.application_url, 'https://apply.telangana.gov.in/nurse');
  assert.ok(n.verified_at && n.official_url === NOTIF);
  const tpl = sent.find((s) => s.url.endsWith('/template/msg'))!;
  assert.equal(tpl.body.get('destination'), '916305478376');
  const params = JSON.parse(tpl.body.get('template')!).params as string[];
  assert.equal(params.length, 5);
  assert.ok(params.every((p) => !/[\n\t]/.test(p)));
  assert.ok(params[4].startsWith('https://pds.test/api/n?id=1&t='));
  const d = (await q<any>(`SELECT * FROM deliveries WHERE kind='alert'`))[0];
  assert.equal(d.status, 'sent');
});

test('3. same notification again is a duplicate (no second alert, no second AI-driven alert)', async () => {
  const before = sent.length;
  sourceHasNew = true;
  const link = { link: { text: 'Notification for recruitment of Staff Nurses 2026 – apply online', href: NOTIF }, hash: 'zzz' };
  assert.equal(await P.processCandidate(await src(), link), 'duplicate');
  assert.equal(sent.length, before);
});

test('4. private detail page is signed and shows application link; bad signature is refused', async () => {
  const { sign } = await import('../lib/text.js');
  const res = fakeRes();
  await detail({ query: { id: '1', t: sign('n:1') } } as any, res);
  assert.equal(res.code, 200);
  assert.ok(res.body.includes('apply.telangana.gov.in/nurse') && res.body.includes('ACCEPT'));
  const bad = fakeRes();
  await detail({ query: { id: '1', t: 'nope' } } as any, bad);
  assert.equal(bad.code, 404);
});

test('5. webhook: ignores strangers, handles VERIFY, then ACCEPT builds poster + caption without links', async () => {
  const call = async (from: string, text: string, id: string, ctx = '') => {
    const res = fakeRes();
    await webhook({ method: 'POST', query: { key: 'wh' }, body: { type: 'message', payload: { id, source: from, type: 'quick_reply', payload: { text }, context: { gsId: ctx } } } } as any, res);
    return res;
  };
  const alertId = (await q<any>(`SELECT provider_message_id FROM deliveries WHERE kind='alert'`))[0].provider_message_id;

  const before = sent.length;
  await call('919999999999', 'ACCEPT', 'm0', alertId);
  assert.equal(sent.length, before, 'stranger must be ignored');
  assert.equal((await q<any>('SELECT status FROM notifications'))[0].status, 'alerted');

  await call('916305478376', 'VERIFY', 'm1', alertId);
  assert.equal((await q<any>('SELECT status FROM notifications'))[0].status, 'alerted', 'VERIFY keeps it waiting');
  assert.ok(sent.some((s) => s.body.get('message')?.includes('VERIFY')));

  await call('916305478376', 'ACCEPT', 'm2', alertId);
  const n = (await q<any>('SELECT status FROM notifications'))[0];
  assert.equal(n.status, 'poster_ready');
  const poster = (await q<any>('SELECT * FROM posters'))[0];
  assert.equal(poster.png.subarray(1, 4).toString(), 'PNG');
  assert.ok(!containsLink(poster.caption));
  assert.ok(poster.caption.includes('6305478376'));
  const img = sent.find((s) => s.body.get('message')?.includes('"type":"image"'))!;
  assert.ok(JSON.parse(img.body.get('message')!).originalUrl.startsWith('https://pds.test/api/poster?id=1&t='));

  // same WhatsApp message delivered twice => processed once
  const posters = (await q<any>('SELECT count(*)::int c FROM posters'))[0].c;
  await call('916305478376', 'ACCEPT', 'm2', alertId);
  assert.equal((await q<any>('SELECT count(*)::int c FROM posters'))[0].c, posters);
  // ACCEPT again by a new message: no second poster
  await call('916305478376', 'ACCEPT', 'm3', alertId);
  assert.equal((await q<any>('SELECT count(*)::int c FROM posters'))[0].c, posters, 'repeat ACCEPT must not regenerate');
});

test('6. poster options: REGENERATE, SEND TO GROUP (manual share fallback), SAVE', async () => {
  const r1 = await A.performAction(1, 'REGENERATE', 'whatsapp');
  assert.ok(r1.ok && r1.posterId);
  assert.equal((await q<any>('SELECT count(*)::int c FROM posters'))[0].c, 2);
  const before = sent.length;
  const r2 = await A.performAction(1, 'SEND_TO_GROUP', 'whatsapp');
  assert.ok(r2.message.includes('unavailable'));
  assert.ok(sent.slice(before).some((s) => s.body.get('message')?.includes('does not allow')));
  assert.ok(!sent.slice(before).some((s) => s.url.includes('/v3/msg')), 'must not call group API unless enabled');
  const r3 = await A.performAction(1, 'SAVE', 'web');
  assert.ok(r3.ok);
  assert.equal((await q<any>('SELECT status FROM notifications'))[0].status, 'saved');
});

test('7. an official date change creates an UPDATED alert (version 2)', async () => {
  notifLastDate = '15-12-2026';
  const link = { link: { text: 'Notification for recruitment of Staff Nurses 2026 – apply online', href: NOTIF }, hash: 'yyy' };
  const out = await P.processCandidate(await src(), link);
  assert.equal(out, 'updated');
  const n = (await q<any>('SELECT * FROM notifications'))[0];
  assert.equal(n.version, 2);
  assert.equal(n.is_update, true);
  assert.deepEqual(n.data.changed, ['last_date']);
  assert.equal(n.status, 'alerted');
  const lastTpl = JSON.parse([...sent].reverse().find((s) => s.url.endsWith('/template/msg'))!.body.get('template')!).params;
  assert.ok(lastTpl[1].startsWith('UPDATED:'));
});

test('8. REJECT never makes a poster', async () => {
  await q(`UPDATE notifications SET status='alerted'`);
  const posters = (await q<any>('SELECT count(*)::int c FROM posters'))[0].c;
  const r = await A.performAction(1, 'REJECT', 'whatsapp');
  assert.ok(r.ok);
  assert.equal((await q<any>('SELECT status FROM notifications'))[0].status, 'rejected');
  assert.equal((await q<any>('SELECT count(*)::int c FROM posters'))[0].c, posters);
  const again = await A.performAction(1, 'ACCEPT', 'whatsapp');
  assert.equal(again.ok, false, 'rejected notification cannot be processed again');
});

test('9. a non-official third-party page is filtered, never alerted', async () => {
  const before = sent.length;
  const s = { ...(await src()), url: 'https://example-news.com/' };
  const r = await P.processCandidate(s, { link: { text: 'Recruitment news staff nurse', href: 'https://example-news.com/post' }, hash: 'ttt' });
  assert.ok(['failed', 'filtered'].includes(r));
  assert.equal(sent.length, before);
});

test('10. monitor endpoint runs a batch, records a run, and rejects unauthenticated calls', async () => {
  const bad = fakeRes();
  await monitor({ headers: {}, query: {} } as any, bad);
  assert.equal(bad.code, 401);
  const res = fakeRes();
  await monitor({ headers: { authorization: 'Bearer cr' }, query: {} } as any, res);
  assert.equal(res.code, 200);
  assert.ok(res.body.ok);
  assert.ok(res.body.checked > 0);
  assert.ok((await q<any>('SELECT count(*)::int c FROM runs'))[0].c >= 1);
});

test('11. health endpoint reports status', async () => {
  const res = fakeRes();
  await health({ headers: { authorization: 'Bearer cr' }, query: { format: 'json' } } as any, res);
  assert.equal(res.code, 200);
  assert.ok(['OK', 'WARNING'].includes(res.body.status), JSON.stringify(res.body.checks));
  assert.equal(res.body.checks.database.ok, true);
  assert.equal(res.body.checks.monitoring.ok, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.LINK_SECRET = 'test-secret';
import { NOT_MENTIONED } from '../lib/config.js';
import { normalizeExtraction, FIELDS } from '../lib/extract.js';
import { verifyExtraction, isOfficialHost, changedFields } from '../lib/verify.js';
import { containsLink, stripLinks, sign, verifySig } from '../lib/text.js';
import { assertNoLinks, renderPosterWithText } from '../lib/poster.js';
import { parseAction } from '../lib/actions.js';
import { parseInbound, parseStatus } from '../lib/whatsapp.js';
import { isCandidateLink } from '../lib/detect.js';
import { buildCaption } from '../lib/messages.js';

const raw = (over: Record<string, string> = {}) =>
  normalizeExtraction({
    is_official_notification: true, is_relevant: true, relevance_reason: 'x', category: 'recruitment', headline_te: 'తెలంగాణ ఉద్యోగాలు',
    ...Object.fromEntries(FIELDS.map((f) => [f, ''])), title: 'Recruitment of Staff Nurses 2026', ...over,
  });

test('missing fields become the exact "not mentioned" phrase', () => {
  const e = raw();
  assert.equal(e.fields.vacancies, NOT_MENTIONED);
  assert.equal(normalizeExtraction({ vacancies: 'N/A' }).fields.vacancies, NOT_MENTIONED);
});

test('invented numbers/dates are removed by verification', () => {
  const text = 'Recruitment of Staff Nurses 2026. Total vacancies 120. Last date for online application 30-11-2026.';
  const { extracted, report } = verifyExtraction({
    extracted: raw({ vacancies: '999', last_date: '30-11-2026', application_fee: 'Rs. 700' }),
    officialUrl: 'https://mhsrb.telangana.gov.in/n1.pdf', sourceUrl: 'https://mhsrb.telangana.gov.in/', fetchedVia: 'direct',
    pageText: text, pageLinks: [], linkText: 'Recruitment of Staff Nurses 2026',
  });
  assert.equal(extracted.fields.vacancies, NOT_MENTIONED);
  assert.equal(extracted.fields.application_fee, NOT_MENTIONED);
  assert.equal(extracted.fields.last_date, '30-11-2026');
  assert.deepEqual(report.ungrounded_fields.sort(), ['application_fee', 'vacancies']);
  assert.equal(report.verdict, 'pass');
});

test('links not present on the page are dropped; third-party domains fail verification', () => {
  const ok = verifyExtraction({
    extracted: raw({ application_url: 'https://made-up.example.com/apply' }),
    officialUrl: 'https://mhsrb.telangana.gov.in/n1', sourceUrl: 'https://mhsrb.telangana.gov.in/', fetchedVia: 'direct',
    pageText: 'Recruitment of Staff Nurses 2026', pageLinks: [], linkText: '',
  });
  assert.equal(ok.extracted.fields.application_url, NOT_MENTIONED);
  const bad = verifyExtraction({
    extracted: raw(), officialUrl: 'https://jobs-news-blog.com/post', sourceUrl: 'https://mhsrb.telangana.gov.in/', fetchedVia: 'direct',
    pageText: 'Recruitment of Staff Nurses 2026', pageLinks: [], linkText: '',
  });
  assert.equal(bad.report.verdict, 'fail');
  assert.equal(isOfficialHost('https://upsc.gov.in/x'), true);
  assert.equal(isOfficialHost('https://sarkari-result.com/x'), false);
});

test('changedFields only flags material changes', () => {
  const a = raw({ last_date: '10 Nov 2026' }).fields;
  const b = raw({ last_date: '20 Nov 2026' }).fields;
  assert.deepEqual(changedFields(a, b), ['last_date']);
  assert.deepEqual(changedFields(a, { ...a, important_instructions: 'changed' }), []);
});

test('links are detected and stripped; phone numbers are not links', () => {
  assert.equal(containsLink('Apply at https://x.gov.in/apply'), true);
  assert.equal(containsLink('visit www.tspsc.gov.in now'), true);
  assert.equal(containsLink('tgprb.gov.in/apply'), true);
  assert.equal(containsLink('Contact: 6305478376 | 9948485930'), false);
  assert.equal(containsLink('Your Work • Our Support • Easy & Fast'), false);
  assert.ok(!containsLink(stripLinks('Apply online at https://x.gov.in/apply before date')));
});

test('POSTER NEVER contains application / official links', async () => {
  const e = raw({
    application_url: 'https://apply.gov.in/form', notification_url: 'https://x.gov.in/n.pdf', vacancies: '120',
    important_instructions: 'Apply online at https://apply.gov.in/form or www.tspsc.gov.in before the last date',
    application_process: 'Go to https://apply.gov.in',
  });
  const { png, publicText } = await renderPosterWithText({ headline_te: 'తెలంగాణ ఉద్యోగాలు', fields: e.fields });
  assert.ok(!publicText.includes('apply.gov.in') && !publicText.includes('tspsc.gov.in') && !publicText.includes('x.gov.in'));
  assert.doesNotThrow(() => assertNoLinks(publicText));
  assert.throws(() => assertNoLinks('see https://a.gov.in'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.length > 20_000);
});

test('caption has contacts and no links', () => {
  const e = raw({ vacancies: '120', last_date: '30 Nov 2026', application_url: 'https://apply.gov.in', important_instructions: 'see https://a.gov.in' });
  const cap = buildCaption({ id: 1, title: '', department: '', official_url: '', version: 1, is_update: false, status: '', verified_at: null, created_at: '', verification: {}, data: { fields: e.fields, headline_te: 'తెలంగాణ' } });
  assert.ok(cap.includes('6305478376') && cap.includes('9948485930'));
  assert.ok(!containsLink(cap));
});

test('owner replies are parsed', () => {
  assert.equal(parseAction('ACCEPT').action, 'ACCEPT');
  assert.equal(parseAction(' accept 12 ').id, 12);
  assert.equal(parseAction('Reject').action, 'REJECT');
  assert.equal(parseAction('verify #7').id, 7);
  assert.equal(parseAction('send to group').action, 'SEND_TO_GROUP');
  assert.equal(parseAction('2').action, 'SAVE');
  assert.equal(parseAction('hello').action, null);
});

test('Gupshup / Meta inbound + status payloads are parsed', () => {
  const v2 = { app: 'a', type: 'message', payload: { id: 'm1', source: '916305478376', type: 'quick_reply', payload: { text: 'ACCEPT' }, context: { gsId: 'g1' } } };
  assert.deepEqual(parseInbound(v2), { messageId: 'm1', from: '916305478376', text: 'ACCEPT', contextId: 'g1' });
  const meta = { entry: [{ changes: [{ value: { messages: [{ id: 'w1', from: '916305478376', context: { id: 'c1' }, button: { text: 'REJECT' } }] } }] }] };
  assert.equal(parseInbound(meta)?.text, 'REJECT');
  assert.equal(parseStatus({ type: 'message-event', payload: { id: 'x', type: 'delivered' } })?.status, 'delivered');
  assert.equal(parseInbound({ type: 'message-event' }), null);
});

test('link candidate filter keeps jobs/GOs and drops navigation', () => {
  assert.equal(isCandidateLink({ text: 'Notification for recruitment of Junior Assistants', href: 'https://a.gov.in/1.pdf' }), true);
  assert.equal(isCandidateLink({ text: 'G.O.Ms.No.45 – Revised pay scales', href: 'https://a.gov.in/2.pdf' }), true);
  assert.equal(isCandidateLink({ text: 'Privacy Policy', href: 'https://a.gov.in/privacy' }), false);
  assert.equal(isCandidateLink({ text: 'Home', href: 'https://a.gov.in/' }), false);
});

test('signed links verify and reject tampering', () => {
  const s = sign('n:5');
  assert.equal(verifySig('n:5', s), true);
  assert.equal(verifySig('n:6', s), false);
  assert.equal(verifySig('n:5', 'bad'), false);
});

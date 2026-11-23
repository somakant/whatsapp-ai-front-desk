import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { parseFaqs, buildIndex, search, tokenize } from '../src/retrieve.js';
import { answer, needsHuman } from '../src/brain.js';
import { verifySignature, parseIncoming, whatsappClient } from '../src/adapters.js';

const faqs = parseFaqs(readFileSync(new URL('../data/faqs.md', import.meta.url), 'utf8'));
const index = buildIndex(faqs);
const business = { name: 'Northwind Fitness Studio' };

test('parses every FAQ heading', () => {
  assert.equal(faqs.length, 10);
  assert.match(faqs[0].question, /opening hours/);
});

test('tokenizer drops stop words and stems', () => {
  assert.deepEqual(tokenize('What are the bookings?'), ['booking']);
});

test('search finds the right FAQ for natural questions', () => {
  assert.match(search(index, 'what time do you open on saturday')[0].faq.question, /opening hours/);
  assert.match(search(index, 'how much is the membership per month')[0].faq.question, /membership cost/);
  assert.match(search(index, 'can my friend come with me')[0].faq.question, /bring a friend/);
});

test('hand-off rules', () => {
  assert.ok(needsHuman('can I talk to a real person'));
  assert.ok(needsHuman('I want a refund now'));
  assert.equal(needsHuman('what classes do you run'), null);
});

test('FAQ-only mode answers or hands off', async () => {
  const ok = await answer('Do you have showers and lockers?', { index, business });
  assert.equal(ok.mode, 'faq');
  const no = await answer('Do you sell protein shakes in bulk wholesale?', { index, business });
  assert.equal(no.mode, 'handoff');
});

test('AI mode is grounded and can hand off', async () => {
  let seenSystem = '';
  const ai = async ({ system }) => { seenSystem = system; return 'We open at 7 am on weekends.'; };
  const r = await answer('weekend opening time?', { index, ai, business });
  assert.equal(r.mode, 'ai');
  assert.match(seenSystem, /Answer ONLY from the FAQ extracts/);
  assert.match(seenSystem, /opening hours/);
  const h = await answer('do you do physio?', { index, ai: async () => 'HANDOFF', business });
  assert.equal(h.mode, 'handoff');
});

test('signature verification', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature(body, sig, 's3cret'), true);
  assert.equal(verifySignature(body, 'sha256=00', 's3cret'), false);
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
});

test('parses WhatsApp webhook payloads', () => {
  const payload = { entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '123' },
    contacts: [{ wa_id: '919900000000', profile: { name: 'Asha' } }],
    messages: [{ id: 'wamid.1', from: '919900000000', type: 'text', text: { body: 'Hi, are you open today?' } }],
  } }] }] };
  assert.deepEqual(parseIncoming(payload)[0], { id: 'wamid.1', from: '919900000000', name: 'Asha', type: 'text', text: 'Hi, are you open today?', phoneNumberId: '123' });
});

test('sends WhatsApp text through the Graph API', async () => {
  let call;
  const client = whatsappClient({ token: 't', phoneNumberId: '123', fetchImpl: async (url, opts) => { call = { url, opts }; return { ok: true, json: async () => ({}) }; } });
  await client.sendText('919900000000', 'Hello');
  assert.match(call.url, /graph\.facebook\.com\/v21\.0\/123\/messages/);
  assert.equal(JSON.parse(call.opts.body).text.body, 'Hello');
});

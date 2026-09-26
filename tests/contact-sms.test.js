// tests/contact-sms.test.js — cases stage 4 §3.3 (SMS and voice through the relay).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter } = require('../src/cases/contact');
const { TelephonyChannel } = require('../src/channels/telephony-channel');
const { ContactRelayClient } = require('../src/channels/relay-client');
const { GATE_PASSED } = require('../src/channels/channel-plugin');
const { startFakeRelay } = require('./helpers/fake-contact-relay');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function world() {
  const relay = await startFakeRelay();
  const clock = () => new Date('2026-09-25T14:00:00Z');
  const runtime = new CaseRuntime({ root: tmp('kl-sms-cases-'), now: clock });
  const state = new ContactState({ dir: path.join(tmp('kl-sms-data-'), 'contact'), clock });
  const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
  const sms = new TelephonyChannel({ kind: 'sms', relay: client, getConfig: () => ({ owner: '+1 555 010 0', from: '+15550199', maxChars: 1200 }) });
  const voice = new TelephonyChannel({ kind: 'voice', relay: client, getConfig: () => ({ owner: '+15550100', from: '+15550199', language: 'en-US' }) });
  const adapters = new Map([['sms', sms], ['voice', voice]]);
  const router = new ContactRouter({ state, runtime, adapters, clock });
  sms.onContactReply((cid, answer, meta) => router.handleReply('sms', cid, answer, meta));
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const q = runtime.questions(lot.id).create({ kind: 'question', urgency: 'high', text: 'Accept the 41k offer?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] });
  const entry = { caseId: lot.id, caseTitle: lot.title, token: state.newToken(), record: q };
  return { relay, runtime, state, router, sms, voice, lot, q, entry };
}

const inbound = (from, text, id) => ({ id, type: 'inbound', channel: 'sms', from, to: '+15550199', text, at: '2026-09-25T14:05:00Z' });

describe('SMS', () => {
  it('sends the batch text to the owner number with the delivery id as Idempotency-Key', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('sms', [w.entry]);
      const req = w.relay.sent()[0];
      assert.strictEqual(req.headers['idempotency-key'], out.deliveryId);
      assert.strictEqual(req.body.channel, 'sms');
      assert.strictEqual(req.body.to, '+15550100');
      assert.strictEqual(req.body.from, '+15550199');
      assert.match(req.body.text, new RegExp(`Reply "#${out.batchToken} a"`));
      assert.deepStrictEqual(req.body.correlation, { deliveryId: out.deliveryId, tokens: [w.entry.token], batchToken: out.batchToken });
      assert.strictEqual(w.state.deliveries()[out.deliveryId].relayId, 'msg-1');
    } finally {
      await w.relay.close();
    }
  });

  it('SMS token required: a tokenless reply is not applied and the hint goes to the owner number only', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('sms', [w.entry]);
      await w.router.ingestRelayEvents('main', [inbound('(555) 010-0', 'a', 'ev-1')]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null, 'a bare number without country code is not the owner');
      await w.router.ingestRelayEvents('main', [inbound('+1 (555) 010-0', 'a', 'ev-2')]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null);
      const acks = w.relay.sent().slice(1);
      assert.strictEqual(acks.length, 1);
      assert.strictEqual(acks[0].body.to, '+15550100');
      assert.strictEqual(acks[0].body.text, `Add the code from the message, e.g. "#${out.batchToken} 1 a".`);

      await w.router.ingestRelayEvents('main', [inbound('+15550100', `#${out.batchToken} a`, 'ev-3')]);
      const rec = w.runtime.questions(w.lot.id).get(w.q.id);
      assert.strictEqual(rec.answer.optionId, 'a');
      assert.strictEqual(rec.answer.channel, 'sms');
      assert.strictEqual(w.relay.sent().pop().body.text, 'Recorded for Lakeside lot.');
    } finally {
      await w.relay.close();
    }
  });

  it('a spoofed number with a token is refused and nobody gets an ack', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('sms', [w.entry]);
      const before = w.relay.sent().length;
      await w.router.ingestRelayEvents('main', [inbound('+15550177', `#${out.batchToken} a`, 'ev-1')]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null);
      assert.strictEqual(w.relay.sent().length, before);
    } finally {
      await w.relay.close();
    }
  });

  it('refuses a plain send to anyone but the owner without the gate symbol', async () => {
    const w = await world();
    try {
      await assert.rejects(w.sms.send('+15550177', 'hello'), /not the owner and not through the outbound gate/);
      await w.sms.send('+15550177', 'hello', { [GATE_PASSED]: true });
      assert.strictEqual(w.relay.sent().pop().body.to, '+15550177');
    } finally {
      await w.relay.close();
    }
  });
});

describe('voice', () => {
  it('reads each item with its options and applies a gathered digit', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('voice', [w.entry]);
      const body = w.relay.sent()[0].body;
      assert.strictEqual(body.channel, 'voice');
      assert.strictEqual(body.voice.language, 'en-US');
      assert.deepStrictEqual(body.voice.prompts, [{ n: 1, say: 'Question 1 from Lakeside lot. Accept the 41k offer? Press 1 for Yes, Press 2 for No.', gather: { digits: { 1: 'a', 2: 'b' } } }]);
      await w.router.ingestRelayEvents('main', [{ id: 'ev-g', type: 'gathered', messageId: w.state.deliveries()[out.deliveryId].relayId, results: [{ n: 1, digits: '2' }], at: '2026-09-25T14:06:00Z' }]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer.optionId, 'b');
    } finally {
      await w.relay.close();
    }
  });

  it('an item without options asks for an answer in King Louie or by text', async () => {
    const w = await world();
    try {
      const q = w.runtime.questions(w.lot.id).create({ kind: 'question', urgency: 'high', text: 'What is the lowest price?' });
      await w.router.deliver('voice', [{ caseId: w.lot.id, caseTitle: 'Lakeside lot', token: w.state.newToken(), record: q }]);
      assert.deepStrictEqual(w.relay.sent()[0].body.voice.prompts, [{ n: 1, say: 'Question 1 from Lakeside lot. What is the lowest price? Answer this one in King Louie or by text.' }]);
    } finally {
      await w.relay.close();
    }
  });
});

describe('relay scoping, notices and voice relayId (carries)', () => {
  it('an SMS inbound event reaches the adapter only from the relay that serves it', async () => {
    const w = await world();
    try {
      assert.strictEqual(w.sms.relay.name, 'main');
      const out = await w.router.deliver('sms', [w.entry]);
      const other = await w.router.ingestRelayEvents('backup', [inbound('+15550100', `#${out.batchToken} a`, 'ev-x')]);
      assert.deepStrictEqual(other, { applied: 0, skipped: 1 });
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null, 'another relay cannot answer for sms');
      const mine = await w.router.ingestRelayEvents('main', [inbound('+15550100', `#${out.batchToken} a`, 'ev-x')]);
      assert.deepStrictEqual(mine, { applied: 1, skipped: 0 });
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer.optionId, 'a');
    } finally {
      await w.relay.close();
    }
  });

  it('an app-only notice has no options, reply hint or DTMF menu on SMS or voice', async () => {
    const w = await world();
    try {
      const q = w.runtime.questions(w.lot.id).create({
        kind: 'question', urgency: 'high', text: 'Grant 20 dollars more today?',
        options: [{ id: 'yes', label: 'Grant' }, { id: 'no', label: 'Refuse' }], payload: { mcpAnswerable: false }
      });
      const entry = { caseId: w.lot.id, caseTitle: 'Lakeside lot', token: w.state.newToken(), record: q };
      await w.router.deliver('sms', [entry]);
      const text = w.relay.sent()[0].body.text;
      assert.match(text, /Answer this in the app: Grant 20 dollars more today\? \(Lakeside lot\)/);
      assert.doesNotMatch(text, /yes\) Grant|Reply|Press/);
      await w.router.deliver('voice', [entry]);
      const prompts = w.relay.sent()[1].body.voice.prompts;
      assert.deepStrictEqual(prompts, [{ n: 1, say: 'Answer this in the app: Grant 20 dollars more today? (Lakeside lot)' }]);
    } finally {
      await w.relay.close();
    }
  });

  it('records the relay message id as relayId on a voice delivery; digits for another call answer nothing', async () => {
    const w = await world();
    try {
      const out = await w.router.deliver('voice', [w.entry]);
      assert.strictEqual(w.state.deliveries()[out.deliveryId].relayId, 'msg-1');
      await w.router.ingestRelayEvents('main', [{ id: 'ev-g2', type: 'gathered', messageId: 'msg-99', results: [{ n: 1, digits: '1' }] }]);
      assert.strictEqual(w.runtime.questions(w.lot.id).get(w.q.id).answer, null);
    } finally {
      await w.relay.close();
    }
  });
});

describe('SMS ack budget (final review I4)', () => {
  it('a storm of spoofed owner-number SMS makes at most one outbound hint', async () => {
    const w = await world();
    try {
      await w.router.deliver('sms', [w.entry]);
      const before = w.relay.sent().length;
      const storm = Array.from({ length: 60 }, (_, i) => inbound('+15550100', `spam ${i}`, `ev-storm-${i}`));
      await w.router.ingestRelayEvents('main', storm);
      assert.strictEqual(w.relay.sent().length - before, 1, 'one hint for 60 tokenless messages');
      await w.router.ingestRelayEvents('main', Array.from({ length: 20 }, (_, i) => inbound('+15550100', `#ZZZZZZ ${i}`, `ev-tok-${i}`)));
      assert.strictEqual(w.relay.sent().length - before, 1, 'made-up tokens add nothing inside the window');
    } finally {
      await w.relay.close();
    }
  });
});

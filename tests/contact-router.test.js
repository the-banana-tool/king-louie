// tests/contact-router.test.js — cases stage 4 §3.5 (ContactRouter).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter } = require('../src/cases/contact');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function world({ getGate = () => null, host = null } = {}) {
  let now = new Date('2026-09-25T14:00:00Z');
  const clock = () => now;
  const runtime = new CaseRuntime({ root: tmp('kl-contact-cases-'), now: clock, host });
  const state = new ContactState({ dir: path.join(tmp('kl-contact-data-'), 'contact'), clock });
  const noted = [];
  const notedAt = [];
  const presence = { noteInbound: (c, at) => { noted.push(c); notedAt.push(at); } };
  const adapters = new Map([
    ['telegram', new LoopbackChannel({ id: 'telegram', owner: '111' })],
    ['discord', new LoopbackChannel({ id: 'discord', owner: '222' })],
    ['email', new LoopbackChannel({ id: 'email', owner: 'owner@example.com', caps: { authenticatedReplies: false, interrupts: false } })],
    ['sms', new LoopbackChannel({ id: 'sms', owner: '+15550100', caps: { authenticatedReplies: false, requiresToken: true, maxChars: 1200 } })],
    ['ntfy', new LoopbackChannel({ id: 'ntfy', owner: 'kl-topic', caps: { expectsReplies: false, authenticatedReplies: false, deliveryOnly: true } })]
  ]);
  adapters.get('sms').relayName = 'main';
  const router = new ContactRouter({ state, runtime, adapters, presence, getGate, clock, getTimeZone: () => 'UTC' });
  for (const [id, a] of adapters) a.onContactReply((cid, answer, meta) => router.handleReply(id, cid, answer, meta));
  // The two channels ruling T5-m22 lets answer approvals and app-only questions.
  const addChannel = (id, { relayName, ...opts } = {}) => {
    const a = new LoopbackChannel({ id, ...opts });
    if (relayName) a.relayName = relayName;
    adapters.set(id, a);
    a.onContactReply((cid, answer, meta) => router.handleReply(id, cid, answer, meta));
    return a;
  };
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const kitchen = await runtime.createCase({ title: 'Kitchen quotes', objective: 'Pick a builder' });
  const ask = (caseId, record) => runtime.questions(caseId).create({ kind: 'question', urgency: 'normal', options: [], ...record });
  const entry = (caseInfo, record) => ({ caseId: caseInfo.id, caseTitle: caseInfo.title, token: state.newToken(), record });
  return { runtime, state, router, adapters, addChannel, noted, notedAt, lot, kitchen, ask, entry, clock, advance: (ms) => { now = new Date(now.getTime() + ms); } };
}

const facts = (runtime, caseId) => [...runtime.ledger(caseId).view().facts.values()];

describe('ContactRouter.deliver', () => {
  it('sends one message per channel for items from several cases, and records the delivery', async () => {
    const w = await world();
    const q1 = w.ask(w.lot.id, { text: 'Is seller financing ever acceptable?', urgency: 'high', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] });
    const q2 = w.ask(w.kitchen.id, { text: 'Which week suits the site visit?', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] });
    const out = await w.router.deliver('telegram', [w.entry(w.kitchen, q2), w.entry(w.lot, q1)]);
    const tg = w.adapters.get('telegram');
    assert.strictEqual(tg.sent.length, 1);
    assert.strictEqual(tg.last().message.subject, 'King Louie: 2 questions (1 high)');
    assert.strictEqual(tg.last().meta.deliveryId, out.deliveryId);
    assert.strictEqual(tg.last().meta.urgency, 'high');
    const d = w.state.deliveries()[out.deliveryId];
    assert.strictEqual(d.channel, 'telegram');
    assert.strictEqual(d.externalRef, 'telegram-msg-1');
    assert.deepStrictEqual(d.items.map((i) => [i.n, i.questionId]), [[1, q1.id], [2, q2.id]]);
  });

  it('a channel without an owner target is not-configured', async () => {
    const w = await world();
    w.adapters.get('telegram').configured = false;
    const q = w.ask(w.lot.id, { text: 'Any update?' });
    await assert.rejects(w.router.deliver('telegram', [w.entry(w.lot, q)]), (err) => err.code === 'not-configured');
  });
});

describe('ContactRouter.handleReply', () => {
  it('loopback round trip: a button answer becomes a user fact with source.kind question', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Is seller financing ever acceptable?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    const tg = w.adapters.get('telegram');
    assert.strictEqual(w.router.knows('telegram', e.token), true);
    assert.strictEqual(w.router.knows('telegram', 'telegram-msg-1'), true, 'the channel message reference');
    assert.strictEqual(w.router.knows('telegram', 'ZZZZZZ'), false);
    const r = await tg.reply(e.token, { optionIndex: 1 });
    assert.deepStrictEqual(r, { ok: true, outcome: 'recorded', ackText: 'Recorded for Lakeside lot.' });
    const answered = w.runtime.questions(w.lot.id).get(q.id);
    assert.strictEqual(answered.answer.channel, 'telegram');
    assert.strictEqual(answered.answer.optionId, 'b');
    const fact = facts(w.runtime, w.lot.id).find((f) => f.id === answered.answer.factId);
    assert.strictEqual(fact.provenance, 'user');
    assert.strictEqual(fact.source.kind, 'question');
    assert.strictEqual(fact.source.ref, q.id);
    assert.deepStrictEqual(tg.plain, [{ target: '111', text: 'Recorded for Lakeside lot.' }]);
    assert.deepStrictEqual(w.noted, ['telegram']);
  });

  it('a batch reply answers several items; unparsed text asks which question', async () => {
    const w = await world();
    const q1 = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const q2 = w.ask(w.kitchen.id, { text: 'Which week?', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] });
    const out = await w.router.deliver('telegram', [w.entry(w.lot, q1), w.entry(w.kitchen, q2)]);
    const which = await w.router.handleReply('telegram', out.deliveryId, { text: 'sure' }, { ownerProven: true, senderId: '111' });
    assert.strictEqual(which.outcome, 'unparsed');
    assert.strictEqual(which.ackText, `Which question? Reply "#${out.batchToken} <n> <answer>".`);
    const r = await w.router.handleReply('telegram', out.deliveryId, { text: `#${out.batchToken} 1 a\n#${out.batchToken} 2 Oct 12` }, { ownerProven: true, senderId: '111' });
    assert.strictEqual(r.outcome, 'recorded, recorded');
    assert.strictEqual(w.runtime.questions(w.kitchen.id).get(q2.id).answer.optionId, 'b');
  });

  it('refuses a reply that is not owner-proven: no answer, no ack', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?' });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    const r = await w.adapters.get('telegram').reply(e.token, { text: 'yes' }, { senderId: '999', ownerProven: false });
    assert.deepStrictEqual(r, { ok: false, outcome: 'refused: not-owner', ackText: null });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
    assert.deepStrictEqual(w.adapters.get('telegram').plain, []);
    assert.deepStrictEqual(w.noted, []);
  });

  it('an approval cannot be answered on a channel without authenticated replies', async () => {
    const w = await world();
    const q = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('sms', [e]);
    assert.strictEqual(w.adapters.get('sms').last().message.items[0].answerable, false);
    const r = await w.router.handleReply('sms', null, { text: `#${e.token} approve` }, { ownerProven: true, senderId: '+15550100' });
    assert.strictEqual(r.outcome, 'refused: approval');
    assert.strictEqual(r.ackText, `Answer this in the app: ${q.id} in Lakeside lot can't be answered by sms.`);
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('SMS without a token is not applied and gets the hint', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const out = await w.router.deliver('sms', [w.entry(w.lot, q)]);
    const r = await w.router.handleReply('sms', null, { text: 'a' }, { ownerProven: true, senderId: '+15550100' });
    assert.strictEqual(r.outcome, 'refused: no-token');
    assert.strictEqual(r.ackText, `Add the code from the message, e.g. "#${out.batchToken} 1 a".`);
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('an answer behind a busy case is queued in inbox.jsonl and applied by drainInbox', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    const lock = path.join(w.runtime.getCase(w.lot.id).dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other-process', pid: process.ppid, at: new Date().toISOString() }));
    const r = await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    assert.deepStrictEqual(r, { ok: true, outcome: 'queued', ackText: 'Received — recording it after the current step' });
    assert.strictEqual(w.state.readInbox().length, 1);
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 0, kept: 1, refused: 0, dropped: 0 });
    fs.rmSync(lock);
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 1, kept: 0, refused: 0, dropped: 0 });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.optionId, 'a');
    assert.deepStrictEqual(w.state.readInbox(), []);
  });

  it('a briefing acknowledgement behind a busy case is queued and applied by drainInbox (ruling T5-brief)', async () => {
    const w = await world();
    const b = w.runtime.questions(w.lot.id).create({ kind: 'briefing', urgency: 'low', text: 'The listing went live today.' });
    const e = w.entry(w.lot, b);
    await w.router.deliver('telegram', [e]);
    const lock = path.join(w.runtime.getCase(w.lot.id).dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other-process', pid: process.ppid, at: new Date().toISOString() }));
    const r = await w.adapters.get('telegram').reply(e.token, { text: 'ok' });
    assert.deepStrictEqual(r, { ok: true, outcome: 'queued', ackText: 'Received — recording it after the current step' });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(b.id).answer, null, 'not reported as done');
    assert.strictEqual(w.state.readInbox()[0].acknowledge, true);
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 0, kept: 1, refused: 0, dropped: 0 });
    fs.rmSync(lock);
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 1, kept: 0, refused: 0, dropped: 0 });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(b.id).answer.channel, 'telegram');
    assert.deepStrictEqual(w.state.readInbox(), []);
  });

  it('token reuse after retirement: a late reply still resolves through deliveries.json', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    const out = await w.router.deliver('email', [e]);
    w.state.ladder().entries = {};
    w.state.saveLadder();
    const again = new ContactRouter({ state: new ContactState({ dir: w.state.dir, clock: w.clock }), runtime: w.runtime, adapters: w.adapters, clock: w.clock });
    const r = await again.handleReply('email', out.externalRef, { text: 'No.' }, { ownerProven: true, senderId: 'owner@example.com' });
    assert.strictEqual(r.outcome, 'recorded');
    assert.notStrictEqual(again.state.newToken(), e.token);
  });

  it('the same answer twice is acknowledged, not duplicated', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    const r = await w.adapters.get('telegram').reply(e.token, { text: 'no' });
    assert.deepStrictEqual(r, { ok: true, outcome: 'already', ackText: 'Already recorded.' });
    assert.strictEqual(facts(w.runtime, w.lot.id).filter((f) => f.source?.ref === q.id).length, 1);
  });
});

describe('conflicting answers', () => {
  it('the first stands; a follow-up pinned to the second channel carries both answers', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    await w.router.deliver('email', [e]);
    await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    const r = await w.adapters.get('email').reply(e.token, { optionId: 'b' });
    assert.strictEqual(r.outcome, 'conflict');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.optionId, 'a', 'never overwritten');
    const follow = w.runtime.questions(w.lot.id).open().find((x) => x.payload.type === 'conflict');
    assert.strictEqual(follow.kind, 'question');
    assert.strictEqual(follow.text, `You answered ${q.id} "No" on telegram at Sep 25 14:00, and now "Yes, up to 20 %". Which stands?`);
    assert.deepStrictEqual(follow.options, [{ id: 'keep', label: 'Keep "No"' }, { id: 'change', label: 'Change to "Yes, up to 20 %"' }]);
    assert.strictEqual(follow.payload.mcpAnswerable, false);
    assert.strictEqual(w.state.ladder().pins[`${w.lot.id}/${follow.id}`], 'email');

    await w.runtime.answerQuestion(w.lot.id, follow.id, { channel: 'email', optionId: 'change' });
    const first = w.runtime.questions(w.lot.id).get(q.id).answer.factId;
    const changed = facts(w.runtime, w.lot.id).find((f) => f.supersedes === first);
    assert.ok(changed, 'the second answer supersedes the first');
    assert.strictEqual(changed.value, 'Yes, up to 20 %');
    assert.strictEqual(changed.provenance, 'user');
  });

  it('after a default the follow-up says the default settled it', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }], defaultOnSilence: 'a', expiresAt: '2026-09-25T15:00:00Z' });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    w.advance(2 * 3600 * 1000);
    w.runtime.questions(w.lot.id).expire(w.clock());
    const r = await w.adapters.get('telegram').reply(e.token, { optionId: 'b' });
    assert.strictEqual(r.outcome, 'conflict');
    const follow = w.runtime.questions(w.lot.id).open().find((x) => x.payload.type === 'conflict');
    assert.strictEqual(follow.text, `${q.id} was settled by its default "No" at Sep 25 16:00; you now answered "Yes". Which stands?`);
  });

  it('an envelope approval changed to reject revokes the envelope', async () => {
    const revoked = [];
    const registry = { revokeEnvelope: async (caseId, envelopeId, reason) => { revoked.push({ caseId, envelopeId, reason }); return { ok: true, cancelled: [] }; } };
    const w = await world({ host: { getExecutorRegistry: () => registry } });
    w.addChannel('in-app', { owner: 'desktop' });
    w.addChannel('mobile', { owner: 'device-1' });
    const q = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Approve envelope env-0001?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], payload: { type: 'envelope', envelopeId: 'env-0001' } });
    const e = w.entry(w.lot, q);
    await w.router.deliver('in-app', [e]);
    await w.router.deliver('mobile', [e]);
    await w.adapters.get('in-app').reply(e.token, { optionId: 'approve' });
    await w.adapters.get('mobile').reply(e.token, { optionId: 'reject' });
    const follow = w.runtime.questions(w.lot.id).open().find((x) => x.payload.type === 'conflict');
    assert.strictEqual(follow.kind, 'approval', 'a conflict on an approval is itself an approval');
    assert.strictEqual(w.state.ladder().pins[`${w.lot.id}/${follow.id}`], 'mobile');
    await w.runtime.answerQuestion(w.lot.id, follow.id, { channel: 'mobile', optionId: 'change' });
    assert.deepStrictEqual(revoked, [{ caseId: w.lot.id, envelopeId: 'env-0001', reason: 'owner changed the answer' }]);
  });
});

describe('ContactRouter.sendExternal', () => {
  const gateStub = (calls) => () => ({
    gateLeaves: (payload, opts) => {
      calls.push({ payload, opts });
      if (/12 Birch/.test(payload.text)) return { ok: false, blocked: [{ path: 'text', reason: 'not-disclosable' }], rendered: payload };
      return { ok: true, blocked: [], rendered: { text: payload.text.replace('{{f-0001}}', 'the lakeside lot') } };
    }
  });

  it('the owner DM is exempt and needs no gate', async () => {
    const w = await world();
    const r = await w.router.sendExternal({ caseId: w.lot.id, channelId: 'telegram', target: '111', text: 'Status: {{f-0001}}' });
    assert.strictEqual(r.ok, true);
    assert.match(r.deliveryId, /^d-/);
    assert.deepStrictEqual(w.adapters.get('telegram').plain, [{ target: '111', text: 'Status: {{f-0001}}' }]);
  });

  it('a group chat is not exempt: refused before stage 3, gated and rendered after', async () => {
    const before = await world();
    const refused = await before.router.sendExternal({ caseId: before.lot.id, channelId: 'telegram', target: '-100222', text: 'hello' });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /only the owner can be messaged/);

    const calls = [];
    const w = await world({ getGate: gateStub(calls) });
    const r = await w.router.sendExternal({ caseId: w.lot.id, channelId: 'telegram', target: '-100222', text: 'About {{f-0001}}' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(w.adapters.get('telegram').plain, [{ target: '-100222', text: 'About the lakeside lot' }], 'the adapter receives rendered text');
    assert.deepStrictEqual(calls[0].opts.recipients, ['-100222']);
    assert.strictEqual(calls[0].opts.mode, 'message');
    assert.strictEqual(calls[0].opts.caseId, w.lot.id);
    assert.ok(calls[0].opts.facts instanceof Map);
  });

  it('a block returns blocked and sends nothing; ntfy is never exempt', async () => {
    const calls = [];
    const w = await world({ getGate: gateStub(calls) });
    const r = await w.router.sendExternal({ caseId: w.lot.id, channelId: 'telegram', target: '-100222', text: 'The lot next to 12 Birch' });
    assert.deepStrictEqual(r, { ok: false, error: 'outbound gate blocked the message', blocked: [{ path: 'text', reason: 'not-disclosable' }] });
    assert.deepStrictEqual(w.adapters.get('telegram').plain, []);
    assert.strictEqual(w.router.isOwnerTarget('ntfy', 'kl-topic'), false);
    await w.router.sendExternal({ caseId: w.lot.id, channelId: 'ntfy', target: 'kl-topic', text: 'ping' });
    assert.strictEqual(calls.length, 2, 'ntfy went through the gate');
  });

  it('normalizes the target before the owner check', async () => {
    const w = await world();
    assert.strictEqual(w.router.isOwnerTarget('sms', '+1 555 010 0'), true);
    assert.strictEqual(w.router.isOwnerTarget('email', 'Owner@Example.com'), true);
    assert.strictEqual(w.router.isOwnerTarget('email', 'someone@example.com'), false);
  });
});

describe('ContactRouter.ingestRelayEvents', () => {
  it('applies status and gathered events once and skips duplicates', async () => {
    const w = await world();
    w.addChannel('voice', { owner: '+15550100', relayName: 'main', caps: { authenticatedReplies: false, voice: true } });
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const e = w.entry(w.lot, q);
    const sms = await w.router.deliver('sms', [e]);
    w.state.deliveries()[sms.deliveryId].relayId = 'relay-1';
    const voice = await w.router.deliver('voice', [e]);
    w.state.deliveries()[voice.deliveryId].relayId = 'relay-v1';
    const r = await w.router.ingestRelayEvents('main', [
      { id: 'ev-1', type: 'status', messageId: 'relay-1', status: 'failed', error: 'unreachable', at: '2026-09-25T14:01:00Z' },
      { id: 'ev-1', type: 'status', messageId: 'relay-1', status: 'delivered' },
      { id: 'ev-2', type: 'gathered', messageId: 'relay-v1', results: [{ n: 1, digits: '2' }] }
    ]);
    assert.deepStrictEqual(r, { applied: 2, skipped: 1 });
    assert.strictEqual(w.state.deliveries()[sms.deliveryId].status, 'failed');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.optionId, 'b');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.channel, 'voice');
  });
});

// Owner decision M22 and the Task 2 carries: what SMS, email and voice may
// answer, and how a reply is read before it reaches answerQuestion.
describe('ContactRouter: app-only questions (owner decision M22)', () => {
  const APP_ONLY = [
    { type: 'budget-grant', text: 'Raise the usd limit for Lakeside lot?', payload: { type: 'budget-grant', budget: 'usd', mcpAnswerable: false } },
    { type: 'direction', text: 'The listing failed. What now?', payload: { type: 'direction', failure: 'journal/x.md', mcpAnswerable: false } },
    { type: 'commit-failed', text: 'Commits keep failing. Keep going?', payload: { type: 'commit-failed', mcpAnswerable: false, key: 'commit-failed' } }
  ];
  const create = (w, spec) => w.runtime.questions(w.lot.id).create({
    kind: 'question', urgency: 'high', text: spec.text, options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }], payload: spec.payload
  });
  const unchanged = (w, q) => {
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null, 'not answered');
    assert.strictEqual(facts(w.runtime, w.lot.id).filter((f) => f.source?.ref === q.id).length, 0, 'no fact');
    assert.deepStrictEqual(w.runtime.questions(w.lot.id).open().filter((x) => x.payload.type === 'conflict'), [], 'no follow-up');
    assert.deepStrictEqual(w.state.readInbox(), [], 'nothing queued');
  };

  for (const spec of APP_ONLY) {
    it(`${spec.type}: an SMS reply is refused with "answer this in the app"`, async () => {
      const w = await world();
      const q = create(w, spec);
      const e = w.entry(w.lot, q);
      await w.router.deliver('sms', [e]);
      const r = await w.router.handleReply('sms', null, { text: `#${e.token} a` }, { ownerProven: true, senderId: '+15550100' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.outcome, 'refused: app-only');
      assert.match(r.ackText, /^Answer this in the app: /);
      assert.match(r.ackText, /can't be answered by sms/);
      unchanged(w, q);
    });

    it(`${spec.type}: an email reply is refused, by token and in the thread`, async () => {
      const w = await world();
      const q = create(w, spec);
      const e = w.entry(w.lot, q);
      const out = await w.router.deliver('email', [e]);
      const byToken = await w.router.handleReply('email', null, { text: `#${e.token} Yes` }, { ownerProven: true, senderId: 'owner@example.com' });
      assert.strictEqual(byToken.outcome, 'refused: app-only');
      assert.match(byToken.ackText, /^Answer this in the app: .*can't be answered by email/);
      const threaded = await w.router.handleReply('email', out.externalRef, { text: 'Yes' }, { ownerProven: true, senderId: 'owner@example.com' });
      assert.strictEqual(threaded.outcome, 'refused: app-only');
      unchanged(w, q);
    });
  }

  it('an approval is refused on email too (SMS is covered above)', async () => {
    const w = await world();
    const q = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const e = w.entry(w.lot, q);
    const out = await w.router.deliver('email', [e]);
    for (const [ref, text] of [[null, `#${e.token} approve`], [out.externalRef, 'approve']]) {
      const r = await w.router.handleReply('email', ref, { text }, { ownerProven: true, senderId: 'owner@example.com' });
      assert.strictEqual(r.outcome, 'refused: approval');
      assert.strictEqual(r.ackText, `Answer this in the app: ${q.id} in Lakeside lot can't be answered by email.`);
    }
    unchanged(w, q);
  });

  it('voice digits never answer an approval or an app-only question', async () => {
    const w = await world();
    w.addChannel('voice', { owner: '+15550100', relayName: 'main', caps: { authenticatedReplies: false, voice: true } });
    const grant = create(w, APP_ONLY[0]);
    const approval = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'high', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const call = await w.router.deliver('voice', [w.entry(w.lot, grant), w.entry(w.lot, approval)]);
    w.state.deliveries()[call.deliveryId].relayId = 'relay-v9';
    await w.router.ingestRelayEvents('main', [{ id: 'ev-9', type: 'gathered', messageId: 'relay-v9', results: [{ n: 1, digits: '1' }, { n: 2, digits: '1' }] }]);
    unchanged(w, grant);
    unchanged(w, approval);
  });

  // Ruling T5-m22: authenticated replies are not enough; only the app and
  // the paired phone answer these.
  for (const channel of ['telegram', 'discord']) {
    it(`${channel} is refused for every app-only type and for an approval, with a button too`, async () => {
      const w = await world();
      const records = [...APP_ONLY.map((spec) => create(w, spec)), w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] })];
      const a = w.adapters.get(channel);
      for (const q of records) {
        const e = w.entry(w.lot, q);
        await w.router.deliver(channel, [e]);
        if (q.kind === 'approval') assert.strictEqual(a.last().message.items[0].answerable, false, 'the approval is only announced');
        for (const answer of [{ optionIndex: 0 }, { optionId: q.options[0].id }, { text: q.options[0].label }]) {
          const r = await a.reply(e.token, answer);
          assert.strictEqual(r.ok, false);
          assert.strictEqual(r.outcome, q.kind === 'approval' ? 'refused: approval' : 'refused: app-only');
          assert.strictEqual(r.ackText, `Answer this in the app: ${q.id} in Lakeside lot can't be answered by ${channel}.`);
        }
        unchanged(w, q);
      }
    });
  }

  it('in-app and the paired phone answer app-only questions and approvals', async () => {
    const w = await world();
    w.addChannel('in-app', { owner: 'desktop' });
    w.addChannel('mobile', { owner: 'device-1' });
    const grant = create(w, APP_ONLY[0]);
    const approval = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const eg = w.entry(w.lot, grant);
    const ea = w.entry(w.lot, approval);
    await w.router.deliver('mobile', [ea]);
    assert.strictEqual(w.adapters.get('mobile').last().message.items[0].answerable, true);
    await w.router.deliver('in-app', [eg]);
    assert.strictEqual((await w.adapters.get('in-app').reply(eg.token, { optionId: 'a' })).outcome, 'recorded');
    assert.strictEqual((await w.adapters.get('mobile').reply(ea.token, { optionId: 'approve' })).outcome, 'recorded');
  });

  it('an unlisted channel is refused even when it claims authenticated replies', async () => {
    const w = await world();
    w.addChannel('pager', { owner: 'p-1' });
    const q = create(w, APP_ONLY[1]);
    const e = w.entry(w.lot, q);
    await w.router.deliver('pager', [e]);
    assert.strictEqual((await w.adapters.get('pager').reply(e.token, { optionId: 'a' })).outcome, 'refused: app-only');
    unchanged(w, q);
  });

  it('mobile with authenticatedReplies off is refused (fail closed)', async () => {
    const w = await world();
    w.addChannel('mobile', { owner: 'device-1', caps: { authenticatedReplies: false } });
    const q = create(w, APP_ONLY[0]);
    const e = w.entry(w.lot, q);
    await w.router.deliver('mobile', [e]);
    assert.strictEqual((await w.adapters.get('mobile').reply(e.token, { optionId: 'a' })).outcome, 'refused: app-only');
  });

  it('a conflict follow-up inherits app-only; an ordinary one stays answerable by email', async () => {
    const w = await world();
    w.addChannel('in-app', { owner: 'desktop' });
    w.addChannel('mobile', { owner: 'device-1' });
    const grant = create(w, APP_ONLY[2]);
    const plain = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const eg = w.entry(w.lot, grant);
    const ep = w.entry(w.lot, plain);
    await w.router.deliver('in-app', [eg]);
    await w.router.deliver('mobile', [eg]);
    await w.router.deliver('telegram', [ep]);
    await w.router.deliver('discord', [ep]);
    await w.adapters.get('in-app').reply(eg.token, { optionId: 'a' });
    await w.adapters.get('mobile').reply(eg.token, { optionId: 'b' });
    await w.adapters.get('telegram').reply(ep.token, { optionId: 'a' });
    await w.adapters.get('discord').reply(ep.token, { optionId: 'b' });
    const follows = w.runtime.questions(w.lot.id).open().filter((x) => x.payload.type === 'conflict');
    const grantFollow = follows.find((x) => x.payload.conflictOf === grant.id);
    const plainFollow = follows.find((x) => x.payload.conflictOf === plain.id);
    const eGrant = w.entry(w.lot, grantFollow);
    const ePlain = w.entry(w.lot, plainFollow);
    await w.router.deliver('email', [eGrant, ePlain]);
    const refused = await w.router.handleReply('email', null, { text: `#${eGrant.token} keep` }, { ownerProven: true, senderId: 'owner@example.com' });
    assert.strictEqual(refused.outcome, 'refused: app-only');
    const ok = await w.router.handleReply('email', null, { text: `#${ePlain.token} keep` }, { ownerProven: true, senderId: 'owner@example.com' });
    assert.strictEqual(ok.outcome, 'recorded');
  });
});

describe('ContactRouter: reading replies (Task 2 carries)', () => {
  const approval = (w) => w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });

  it('a free-text answer to an approval is refused even where approvals are allowed', async () => {
    const w = await world();
    w.addChannel('mobile', { owner: 'device-1' });
    const q = approval(w);
    const e = w.entry(w.lot, q);
    await w.router.deliver('mobile', [e]);
    const r = await w.adapters.get('mobile').reply(e.token, { text: 'sure, go ahead' });
    assert.strictEqual(r.outcome, 'refused: approval-text');
    assert.strictEqual(r.ackText, `${q.id} is an approval: reply with one of its options (approve / reject).`);
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
    const ok = await w.adapters.get('mobile').reply(e.token, { text: 'Approve' });
    assert.strictEqual(ok.outcome, 'recorded', 'an exact option name is an option, not text');
  });

  it('an item stored as answerable: false is refused', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    const out = await w.router.deliver('telegram', [e]);
    assert.strictEqual(w.state.deliveries()[out.deliveryId].items[0].answerable, true, 'deliveries.json keeps answerable');
    w.state.deliveries()[out.deliveryId].items[0].answerable = false;
    const r = await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    assert.strictEqual(r.outcome, 'refused: not-answerable');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('a single-question thread drops quoted history before matching an option', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('email', [e]);
    const body = 'Yes\n\nOn Thu, Sep 25, 2026 at 2:00 PM King Louie <kl@example.com> wrote:\n> 1. Lakeside lot — Seller financing?\n>    a) No   b) Yes';
    const r = await w.router.handleReply('email', e.token, { text: body }, { ownerProven: true, senderId: 'owner@example.com' });
    assert.strictEqual(r.outcome, 'recorded');
    const answer = w.runtime.questions(w.lot.id).get(q.id).answer;
    assert.strictEqual(answer.optionId, 'b');
    assert.strictEqual(answer.text, null);
  });

  it('a single-question thread drops a signature and keeps free text as one answer', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'What price floor?', options: [] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('email', [e]);
    const r = await w.router.handleReply('email', e.token, { text: 'Not below 180k.\nFirm on that.\n\n-- \nOwner\n+1 555 0100' }, { ownerProven: true, senderId: 'owner@example.com' });
    assert.strictEqual(r.outcome, 'recorded');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.text, 'Not below 180k.\nFirm on that.');
  });

  it('batch items carry caseTitle, so a pasted question header is not the answer', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const out = await w.router.deliver('email', [w.entry(w.lot, q)]);
    const r = await w.router.handleReply('email', out.externalRef, { text: 'Yes\n1. Lakeside lot — Seller financing?' }, { ownerProven: true, senderId: 'owner@example.com' });
    assert.strictEqual(r.outcome, 'recorded');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.optionId, 'b');
  });

  it('every token lookup names the inbound channel', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    await w.router.deliver('sms', [e]);
    const calls = [];
    const resolve = w.state.resolve.bind(w.state);
    w.state.resolve = (id, opts = {}) => { calls.push(opts.channel ?? null); return resolve(id, opts); };
    const r = await w.router.handleReply('sms', null, { text: `#${e.token} a` }, { ownerProven: true, senderId: '+15550100' });
    assert.strictEqual(r.outcome, 'recorded');
    assert.ok(calls.length > 0);
    assert.deepStrictEqual([...new Set(calls)], ['sms']);
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer.channel, 'sms');
  });

  it('a reply-id from one channel does not resolve on another', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    await w.router.deliver('telegram', [w.entry(w.lot, q)]);
    const r = await w.router.handleReply('discord', 'telegram-msg-1', { text: 'No' }, { ownerProven: true, senderId: '222' });
    assert.strictEqual(r.outcome, 'unknown');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('presence is told about the inbound reply with a timestamp clamped to now', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    await w.adapters.get('telegram').reply(e.token, { optionId: 'a' }, { at: '2099-01-01T00:00:00Z' });
    assert.deepStrictEqual(w.notedAt.map((d) => d.toISOString()), ['2026-09-25T14:00:00.000Z']);
    const q2 = w.ask(w.lot.id, { text: 'Which agent?', options: [{ id: 'a', label: 'Ana' }] });
    const e2 = w.entry(w.lot, q2);
    await w.router.deliver('telegram', [e2]);
    await w.adapters.get('telegram').reply(e2.token, { optionId: 'a' }, { at: '2026-09-25T13:59:00Z' });
    assert.strictEqual(w.notedAt[1].toISOString(), '2026-09-25T13:59:00.000Z', 'a past time is kept');
  });
});

describe('ContactRouter: bad input returns an outcome, never throws', () => {
  it('handleReply', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    const proven = { ownerProven: true, senderId: '111' };
    for (const [channel, cid, answer, meta] of [
      ['telegram', e.token, null, proven],
      ['telegram', e.token, 'a', proven],
      ['telegram', { x: 1 }, { text: 'a' }, proven],
      ['telegram', e.token, { optionIndex: -1 }, proven],
      ['telegram', e.token, { optionIndex: 'x' }, proven],
      ['telegram', e.token, { optionId: 'zz' }, proven],
      ['telegram', e.token, { text: 42 }, proven],
      ['nope', e.token, { text: 'a' }, proven],
      ['telegram', e.token, { text: 'a' }, null],
      [undefined, undefined, undefined, undefined]
    ]) {
      const r = await w.router.handleReply(channel, cid, answer, meta);
      assert.strictEqual(typeof r.outcome, 'string');
      assert.strictEqual(r.ok, false, `${JSON.stringify([channel, cid, answer])} → ${r.outcome}`);
    }
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('handleReply turns an unexpected runtime error into an error outcome', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const e = w.entry(w.lot, q);
    await w.router.deliver('telegram', [e]);
    w.runtime.answerQuestion = async () => { throw new Error('disk full'); };
    const r = await w.adapters.get('telegram').reply(e.token, { optionId: 'a' });
    assert.deepStrictEqual(r, { ok: false, outcome: 'error', ackText: "Couldn't record that. Answer it in King Louie." });
  });

  it('drainInbox skips malformed lines and keeps a failing one for a few tries', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    w.state.appendInbox({ nonsense: true });
    w.state.appendInbox({ at: 'x', channel: 'telegram', caseId: 'no-such-case', questionId: 'q-0001', optionId: 'a', meta: {} });
    w.state.appendInbox({ at: 'x', channel: 'telegram', caseId: w.lot.id, questionId: q.id, optionId: 'a', meta: {} });
    const real = w.runtime.answerQuestion.bind(w.runtime);
    w.runtime.answerQuestion = async () => { throw new Error('disk full'); };
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 0, kept: 1, refused: 1, dropped: 1 }, 'malformed dropped, unknown case refused, the failing line waits');
    assert.strictEqual(w.state.readInbox()[0].attempts, 1);
    for (let i = 0; i < 4; i += 1) await w.router.drainInbox();
    assert.deepStrictEqual(w.state.readInbox(), [], 'dropped after five failed tries');
    const journalDir = path.join(w.runtime.getCase(w.lot.id).dir, 'journal');
    const journal = fs.readdirSync(journalDir).map((n) => fs.readFileSync(path.join(journalDir, n), 'utf8')).join('\n');
    assert.match(journal, new RegExp(`answer to ${q.id} via telegram could not be recorded after 5 tries and was dropped \\(disk full\\)`));
    w.runtime.answerQuestion = real;
    fs.writeFileSync(path.join(w.state.dir, 'inbox.jsonl'), 'not json\n');
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 0, kept: 0, refused: 0, dropped: 0 });
  });
});

// Task 5 review, fix round 1: relay trust, the inbox race, ruling T5-inbox,
// sendExternal and drain counting.
describe('ContactRouter.ingestRelayEvents: only what the named relay serves', () => {
  const spyIngest = (a) => {
    a.ingested = [];
    a.ingestRelayEvent = async (ev) => { a.ingested.push(ev); };
    return a;
  };

  it('an inbound event is dispatched only to an adapter that relay serves', async () => {
    const w = await world();
    const mobile = spyIngest(w.addChannel('mobile', { owner: 'device-1' }));
    const tg = spyIngest(w.adapters.get('telegram'));
    const sms = spyIngest(w.adapters.get('sms'));
    const r = await w.router.ingestRelayEvents('main', [
      { id: 'in-1', type: 'inbound', channel: 'mobile', from: 'device-1', text: 'approve' },
      { id: 'in-2', type: 'inbound', channel: 'telegram', from: '111', text: 'hi' },
      { id: 'in-3', type: 'inbound', channel: 'in-app', text: 'hi' },
      { id: 'in-4', type: 'inbound', channel: 'sms', from: '+15550100', text: '#K7QD4M a' }
    ]);
    assert.deepStrictEqual(r, { applied: 1, skipped: 3 });
    assert.deepStrictEqual(mobile.ingested, []);
    assert.deepStrictEqual(tg.ingested, []);
    assert.deepStrictEqual(sms.ingested.map((e) => e.id), ['in-4']);
    const other = await w.router.ingestRelayEvents('backup', [{ id: 'in-5', type: 'inbound', channel: 'sms', from: '+15550100', text: 'x' }]);
    assert.deepStrictEqual(other, { applied: 0, skipped: 1 }, 'another relay does not serve sms');
  });

  it('a status event cannot touch a delivery on a channel the relay does not serve', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const tg = await w.router.deliver('telegram', [w.entry(w.lot, q)]);
    const r = await w.router.ingestRelayEvents('main', [
      { id: 'st-1', type: 'status', messageId: 'telegram-msg-1', status: 'failed', error: 'unreachable' },
      { id: 'st-2', type: 'status', messageId: tg.deliveryId, status: 'failed' }
    ]);
    assert.deepStrictEqual(r, { applied: 0, skipped: 2 });
    assert.strictEqual(w.state.deliveries()[tg.deliveryId].status, 'sent');
    assert.strictEqual(w.router.recordStatus('email', { externalRef: 'telegram-msg-1', status: 'bounced' }), null, 'recordStatus stays on its channel');
    assert.strictEqual(w.state.deliveries()[tg.deliveryId].status, 'sent');
  });

  it('gathered digits need a voice delivery with that relay id: an SMS token or relay id is refused', async () => {
    const w = await world();
    w.addChannel('voice', { owner: '+15550100', relayName: 'main', caps: { authenticatedReplies: false, voice: true } });
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }] });
    const e = w.entry(w.lot, q);
    const sms = await w.router.deliver('sms', [e]);
    w.state.deliveries()[sms.deliveryId].relayId = 'relay-s1';
    const r = await w.router.ingestRelayEvents('main', [
      { id: 'g-1', type: 'gathered', messageId: e.token, results: [{ n: 1, digits: '1' }] },
      { id: 'g-2', type: 'gathered', messageId: 'relay-s1', results: [{ n: 1, digits: '1' }] },
      { id: 'g-3', type: 'gathered', messageId: sms.batchToken, results: [{ n: 1, digits: '1' }] },
      { id: 'g-4', type: 'gathered', messageId: sms.deliveryId, results: [{ n: 1, digits: '1' }] }
    ]);
    assert.deepStrictEqual(r, { applied: 0, skipped: 4 });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('gathered results are deduplicated by n and capped at the item count', async () => {
    const w = await world();
    w.addChannel('voice', { owner: '+15550100', relayName: 'main', caps: { authenticatedReplies: false, voice: true } });
    const q1 = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes' }, { id: 'c', label: 'Maybe' }] });
    const q2 = w.ask(w.lot.id, { text: 'Which agent?', options: [{ id: 'a', label: 'Ana' }, { id: 'b', label: 'Bo' }, { id: 'c', label: 'Cy' }] });
    const e1 = w.entry(w.lot, q1);
    const e2 = w.entry(w.lot, q2);
    await w.router.deliver('telegram', [e1]);
    await w.adapters.get('telegram').reply(e1.token, { optionId: 'a' });
    const call = await w.router.deliver('voice', [e1, e2]);
    w.state.deliveries()[call.deliveryId].relayId = 'relay-v2';
    const calls = [];
    const real = w.router.handleReply.bind(w.router);
    w.router.handleReply = (...args) => { calls.push(args); return real(...args); };
    const results = [];
    for (let i = 0; i < 5000; i += 1) results.push({ n: 1 + (i % 3), digits: String(2 + (i % 2)) });
    const r = await w.router.ingestRelayEvents('main', [{ id: 'g-9', type: 'gathered', messageId: 'relay-v2', results }]);
    assert.deepStrictEqual(r, { applied: 1, skipped: 0 });
    assert.strictEqual(calls.length, 2, 'one reply per item, however long the list');
    assert.strictEqual(w.runtime.questions(w.lot.id).open().filter((x) => x.payload.type === 'conflict').length, 1, 'at most one conflict per item');
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q2.id).answer.optionId, 'c', 'the first result for n 2 wins');
  });

  it('bad event ids and huge event lists are skipped without throwing', async () => {
    const w = await world();
    const r = await w.router.ingestRelayEvents('main', [
      { id: {}, type: 'status', messageId: 'x', status: 'failed' },
      { id: ['a'], type: 'status', messageId: 'x', status: 'failed' },
      { id: 42, type: 'status', messageId: 'x', status: 'failed' },
      { id: 'x'.repeat(10000), type: 'status', messageId: 'x', status: 'failed' },
      null, 'junk', 7
    ]);
    assert.deepStrictEqual(r, { applied: 0, skipped: 7 });
    const huge = [];
    for (let i = 0; i < 200000; i += 1) huge.push({ id: `h-${i}`, type: 'nope' });
    const started = Date.now();
    const h = await w.router.ingestRelayEvents('main', huge);
    assert.deepStrictEqual(h, { applied: 0, skipped: 200000 });
    assert.ok(Date.now() - started < 5000, 'bounded work');
    assert.deepStrictEqual(await w.router.ingestRelayEvents('main', { length: 3 }), { applied: 0, skipped: 0 });
  });
});

describe('ContactRouter inbox: the race and ruling T5-inbox', () => {
  it('an answer queued while a drain is running is not lost', async () => {
    const w = await world();
    const q1 = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    const q2 = w.ask(w.kitchen.id, { text: 'Which week?', options: [{ id: 'a', label: 'Oct 5' }] });
    w.state.appendInbox({ at: 'x', channel: 'telegram', caseId: w.lot.id, questionId: q1.id, optionId: 'a', meta: {} });
    const real = w.runtime.answerQuestion.bind(w.runtime);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let entered;
    const inside = new Promise((resolve) => { entered = resolve; });
    w.runtime.answerQuestion = async (...args) => { entered(); await held; return real(...args); };
    const draining = w.router.drainInbox();
    await inside;
    w.state.appendInbox({ at: 'y', channel: 'telegram', caseId: w.kitchen.id, questionId: q2.id, optionId: 'a', meta: {} });
    const second = w.router.drainInbox();
    release();
    assert.deepStrictEqual(await draining, { applied: 1, kept: 0, refused: 0, dropped: 0 });
    assert.strictEqual(await second, await draining, 'a drain already running is joined, not run twice');
    assert.deepStrictEqual(w.state.readInbox().map((l) => l.questionId), [q2.id], 'the line appended mid-drain survives');
    w.runtime.answerQuestion = real;
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 1, kept: 0, refused: 0, dropped: 0 });
    assert.strictEqual(w.runtime.questions(w.kitchen.id).get(q2.id).answer.optionId, 'a');
  });

  const busy = (w, caseInfo) => {
    const lock = path.join(w.runtime.getCase(caseInfo.id).dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other-process', pid: process.ppid, at: new Date().toISOString() }));
    return () => fs.rmSync(lock);
  };

  it('an approval or app-only answer on a busy case is refused, never queued', async () => {
    const w = await world();
    w.addChannel('mobile', { owner: 'device-1' });
    w.addChannel('in-app', { owner: 'desktop' });
    const approval = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const grant = w.runtime.questions(w.lot.id).create({ kind: 'question', urgency: 'high', text: 'Raise the limit?', options: [{ id: 'a', label: 'Yes' }], payload: { type: 'budget-grant', budget: 'usd', mcpAnswerable: false } });
    const ea = w.entry(w.lot, approval);
    const eg = w.entry(w.lot, grant);
    await w.router.deliver('mobile', [ea]);
    await w.router.deliver('in-app', [eg]);
    const free = busy(w, w.lot);
    for (const [ch, e, answer] of [['mobile', ea, { optionId: 'approve' }], ['in-app', eg, { optionId: 'a' }]]) {
      const r = await w.adapters.get(ch).reply(e.token, answer);
      assert.deepStrictEqual(r, { ok: false, outcome: 'refused: busy', ackText: 'The case is busy; answer again in a minute.' });
    }
    assert.deepStrictEqual(w.state.readInbox(), [], 'no authority in inbox.jsonl');
    free();
    assert.strictEqual(w.runtime.questions(w.lot.id).get(approval.id).answer, null);
  });

  it('a forged inbox line for an approval is refused on drain, even as in-app', async () => {
    const w = await world();
    w.addChannel('in-app', { owner: 'desktop' });
    const approval = w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const grant = w.runtime.questions(w.lot.id).create({ kind: 'question', urgency: 'high', text: 'Raise the limit?', options: [{ id: 'a', label: 'Yes' }], payload: { type: 'budget-grant', budget: 'usd', mcpAnswerable: false } });
    w.state.appendInbox({ at: 'x', channel: 'in-app', caseId: w.lot.id, questionId: approval.id, optionId: 'approve', meta: { ownerProven: true } });
    w.state.appendInbox({ at: 'x', channel: 'mobile', caseId: w.lot.id, questionId: grant.id, optionId: 'a', meta: { ownerProven: true } });
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 0, kept: 0, refused: 2, dropped: 0 });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(approval.id).answer, null);
    assert.strictEqual(w.runtime.questions(w.lot.id).get(grant.id).answer, null);
    assert.deepStrictEqual(w.state.readInbox(), []);
  });

  it('a case lookup that fails for another reason than not-found is retried, not dropped', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Seller financing?', options: [{ id: 'a', label: 'No' }] });
    w.state.appendInbox({ at: 'x', channel: 'telegram', caseId: w.lot.id, questionId: q.id, optionId: 'a', meta: {} });
    const real = w.runtime.getCase.bind(w.runtime);
    w.runtime.getCase = () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); };
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 0, kept: 1, refused: 0, dropped: 0 });
    assert.strictEqual(w.state.readInbox()[0].attempts, 1);
    w.runtime.getCase = real;
    assert.deepStrictEqual(await w.router.drainInbox(), { applied: 1, kept: 0, refused: 0, dropped: 0 });
  });
});

describe('ContactRouter.sendExternal never throws', () => {
  it('a throwing gate, an async gate, a malformed gate result and an unknown case', async () => {
    const throwing = await world({ getGate: () => ({ gateLeaves: () => { throw new Error('gate exploded'); } }) });
    const r1 = await throwing.router.sendExternal({ caseId: throwing.lot.id, channelId: 'telegram', target: '-100222', text: 'hi' });
    assert.strictEqual(r1.ok, false);
    assert.match(r1.error, /gate exploded/);
    assert.deepStrictEqual(throwing.adapters.get('telegram').plain, []);

    const asyncGate = await world({ getGate: () => ({ gateLeaves: async (p) => ({ ok: true, blocked: [], rendered: { text: p.text.toUpperCase() } }) }) });
    const r2 = await asyncGate.router.sendExternal({ caseId: asyncGate.lot.id, channelId: 'telegram', target: '-100222', text: 'hi' });
    assert.strictEqual(r2.ok, true);
    assert.deepStrictEqual(asyncGate.adapters.get('telegram').plain, [{ target: '-100222', text: 'HI' }]);

    const junk = await world({ getGate: () => ({ gateLeaves: () => ({ ok: true }) }) });
    const r3 = await junk.router.sendExternal({ caseId: junk.lot.id, channelId: 'telegram', target: '-100222', text: 'hi' });
    assert.strictEqual(r3.ok, false);
    assert.deepStrictEqual(junk.adapters.get('telegram').plain, [], 'no rendered text, nothing sent');
    const r4 = await junk.router.sendExternal({ caseId: 'no-such-case', channelId: 'telegram', target: '-100222', text: 'hi' });
    assert.strictEqual(r4.ok, false);
    const r5 = await junk.router.sendExternal(null);
    assert.strictEqual(r5.ok, false);
  });
});

// Ruling T9-token: a channel that expects no replies (ntfy) never carries a
// reply footer or a token, even when it sends the question text.
describe('ContactRouter.deliver on a delivery-only channel', () => {
  it('sends no reply footer and no token; a reply channel still gets them', async () => {
    const w = await world();
    const q = w.ask(w.lot.id, { text: 'Is seller financing ever acceptable?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] });
    const out = await w.router.deliver('ntfy', [w.entry(w.lot, q)]);
    const sent = w.adapters.get('ntfy').last();
    const tokens = [out.batchToken, ...w.state.deliveries()[out.deliveryId].items.map((i) => i.token)];
    for (const t of tokens) assert.ok(!sent.message.text.includes(t), `ntfy text carries ${t}: ${sent.message.text}`);
    assert.doesNotMatch(sent.message.text, /Reply|#/);
    assert.strictEqual(sent.meta.batchToken, null);
    assert.strictEqual(sent.meta.expectsReply, false);
    assert.ok(sent.message.items.every((i) => i.token === undefined));
    assert.match(sent.message.text, /Lakeside lot — Is seller financing ever acceptable\?/);
    assert.strictEqual(w.state.deliveries()[out.deliveryId].batchToken, out.batchToken, 'the delivery is still recorded with its token');

    const tg = await w.router.deliver('telegram', [w.entry(w.lot, q)]);
    const tgSent = w.adapters.get('telegram').last();
    assert.match(tgSent.message.text, new RegExp(`Reply "#${tg.batchToken} a"`));
    assert.strictEqual(tgSent.meta.batchToken, tg.batchToken);
    assert.ok(tgSent.message.items.every((i) => /^[0-9A-Z]{6}$/.test(i.token)));
  });
});

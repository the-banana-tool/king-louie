// tests/contact-mobile.test.js — cases stage 4 §3.9 (wave 3, R44): the phone
// app as a contact channel. Node side: kl.question.ask out (preflight M6),
// device-signed kl.question.answer and unsigned presence.foreground pings
// (ruling T17-presence) in. Relay side
// (appended in Task 18): the phone routes.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter, relayOf } = require('../src/cases/contact');
const { Presence } = require('../src/cases/presence');
const { defaultPolicy } = require('../src/cases/contact-format');
const { MobileAppChannel, validateAnswerMessage, SIGNED_AT_SKEW_MS, PRESENCE_MAX_AGE_MS, PRESENCE_MIN_GAP_MS } = require('../src/channels/mobile-app-channel');
const { createContactHost } = require('../src/cases/contact-host');
const { mergeSettings } = require('../src/core/settings');
const { open, seal, verifyEd25519 } = require('../src/approvals/envelope');
const { randomNonce } = require('../src/approvals/messages');
const { Mailbox } = require('../src/frontdoor/mailbox');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { createSealPolicy } = require('../src/approvals/seal-policy');
const { generateBoxKey } = require('../src/approvals/node-box-key');
const { sealContent, isSealedShape, boxKeyFingerprint } = require('../src/approvals/seal');
const { validateMessage } = require('../src/approvals/messages');
const { LadderEngine, RESEALS_PER_TICK } = require('../src/cases/ladder');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const dirs = [];
const stores = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  for (const s of stores) s.cleanup();
});
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function fakeLink() {
  const link = {
    sent: [],
    methods: {},
    send: async (envelope, opts) => { link.sent.push({ envelope, opts }); return { ok: true, seq: link.sent.length }; },
    registerMethod: (name, fn) => { link.methods[name] = fn; },
    canDeliver: () => ({ ok: true })
  };
  return link;
}

// sealing: the phone holds a box key and the node a real seal policy on it.
// sealFrom: 'later' leaves the policy off the channel until the test sets it,
// so the two questions below go out clear.
async function world({ records = null, sealing = false, sealFrom = 'start', presenceByConfigured = false } = {}) {
  const phone = createFakePhone({ name: 'Owner phone', boxKey: sealing });
  const stranger = createFakePhone({ name: 'Other phone' });
  const store = await approverStoreWith(records ? records(phone) : [phone.approverRecord({ boxKey: sealing })]);
  stores.push(store);
  const node = testNodeIdentity({ key: 'web-01', box: sealing });
  const now = new Date('2026-09-25T14:00:00Z');
  let current = now;
  const clock = () => current;
  const advance = (ms) => { current = new Date(current.getTime() + ms); };
  const runtime = new CaseRuntime({ root: tmp('kl-mobile-cases-'), now: clock });
  const data = tmp('kl-mobile-data-');
  const state = new ContactState({ dir: path.join(data, 'contact'), clock });
  const policy = defaultPolicy();
  const link = fakeLink();
  const adapters = new Map();
  const presence = new Presence({ file: path.join(data, 'contact', 'presence.json'), getPolicy: () => policy, clock, isEnabled: (c) => (presenceByConfigured ? Boolean(adapters.get(c)?.contactConfigured()) : adapters.has(c)) });
  const router = new ContactRouter({ state, runtime, adapters, presence, clock });
  const sealPolicy = sealing ? createSealPolicy({ approverStore: store, identity: node, dataDir: data }) : null;
  const mobile = new MobileAppChannel({ link, approverStore: store, identity: node, sealPolicy: sealFrom === 'start' ? sealPolicy : null, getRouter: () => router, presence, clock });
  adapters.set('mobile', mobile);
  mobile.registerMethods();
  mobile.onContactReply((cid, answer, meta) => router.handleReply('mobile', cid, answer, meta));
  const info = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  const q = runtime.questions(info.id).create({ kind: 'question', urgency: 'high', text: 'Accept the 41k offer?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] });
  const q2 = runtime.questions(info.id).create({ kind: 'question', urgency: 'normal', text: 'Relist in spring?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] });
  const token = state.newToken();
  const token2 = state.newToken();
  await router.deliver('mobile', [{ caseId: info.id, caseTitle: info.title, token, record: q }]);
  await router.deliver('mobile', [{ caseId: info.id, caseTitle: info.title, token: token2, record: q2 }]);
  const answer = (overrides = {}, signer = phone) => signer.sign({
    v: 1, type: 'kl.question.answer', node_id: node.nodeId, case_id: info.id, question_id: q.id, token,
    answer: { option_id: 'a' }, nonce: randomNonce(), signed_at: now.toISOString(), device_id: signer.deviceId, ...overrides
  });
  const call = (envelope) => link.methods['question.answer']({ envelope }, { peer: 'relay' });
  const ping = (params, ctx = { peer: 'relay' }) => link.methods['presence.foreground'](params, ctx);
  const fg = (overrides = {}) => ({ deviceId: phone.deviceId, foreground: true, at: clock().toISOString(), ...overrides });
  const answerOf = (qid = q.id) => runtime.questions(info.id).get(qid).answer;
  return { phone, stranger, store, node, runtime, router, mobile, link, info, q, q2, token, token2, answer, fg, call, ping, answerOf, presence, now, advance, sealPolicy, state, adapters, policy, clock, data };
}

// A real ladder on the world's router: mobile first, then telegram, for every urgency.
function ladderOn(w, steps = [{ channel: 'mobile', afterMin: 0 }, { channel: 'telegram', afterMin: 0 }], options = {}) {
  const telegram = new LoopbackChannel({ id: 'telegram', owner: 'telegram-owner', caps: {} });
  w.adapters.set('telegram', telegram);
  const policy = { ...w.policy, digest: null, ladders: steps ? { high: steps, normal: steps, low: steps } : w.policy.ladders };
  const ladder = new LadderEngine({ state: w.state, casesRoot: w.runtime.root, runtime: w.runtime, router: w.router, presence: w.presence, getPolicy: () => policy, clock: w.clock, dataDir: w.data, ...options });
  return { ladder, telegram, policy };
}

// A latched policy whose keys a test sets: `keys` is device id to box JWK.
function settablePolicy(w, keys) {
  const p = {
    keys,
    why: 'no active phone holds a box key. Enroll a phone or apply its box key',
    senderId: w.node.nodeId,
    nodeBox: w.node.box.jwk,
    sealing: () => true,
    canSeal: () => Object.keys(p.keys).length > 0,
    recipients: () => ({ ...p.keys, [w.node.nodeId]: w.node.box.jwk }),
    whyNot: () => (Object.keys(p.keys).length > 0 ? null : p.why)
  };
  w.mobile.sealPolicy = p;
  return p;
}

// A kl.question.answer as an updated phone builds it: sealed to the node's box,
// signed with the device key. `clear` and `content` change what is sealed;
// `recipients` whom to.
function sealedAnswer(w, { clear = {}, content = {}, signer = w.phone, recipients = null } = {}) {
  const clearPart = {
    v: 1, type: 'kl.question.answer', node_id: w.node.nodeId, token: w.token, device_id: signer.deviceId,
    nonce: randomNonce(), signed_at: w.now.toISOString(), ...clear
  };
  const message = sealContent({
    type: 'kl.question.answer', senderId: clearPart.device_id, clear: clearPart,
    content: { case_id: w.info.id, question_id: w.q.id, answer: { option_id: 'a' }, ...content },
    recipients: recipients || { [w.node.nodeId]: w.node.box.jwk }
  });
  return signer.sign(message);
}

describe('mobile contact channel (node side)', () => {
  it('sends one node-signed kl.question.ask per item and active device, pushing only the token (M6)', async () => {
    const w = await world();
    assert.strictEqual(w.link.sent.length, 2);
    const { envelope, opts } = w.link.sent[0];
    assert.deepStrictEqual(opts, { push: { kind: 'question', id: w.token }, to_device: w.phone.deviceId });
    assert.strictEqual(verifyEd25519(envelope, w.node.publicKey.toString('hex')), true);
    const { message } = open(envelope);
    assert.deepStrictEqual(message, {
      v: 1, type: 'kl.question.ask', node_id: w.node.nodeId, case_id: w.info.id, question_id: w.q.id, token: w.token, kind: 'question',
      urgency: 'high', case_title: 'Lakeside lot', text: 'Accept the 41k offer?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }], expires_at: null
    });
  });

  it('the kl.question.ask type is routable by the relay mailbox under the dotted prefix kl.question.', async () => {
    const w = await world();
    const mailbox = new Mailbox();
    mailbox.registerType('kl.question.', { ttlMs: 60000 });
    assert.throws(() => new Mailbox().registerType('kl.question', { ttlMs: 60000 }), /ending in '\.'/);
    mailbox.put(w.node.nodeId, w.link.sent[0].envelope, { to_device: w.phone.deviceId });
    assert.strictEqual(mailbox.list({ nodeIds: [w.node.nodeId], typePrefix: 'kl.question.ask', toDevice: w.phone.deviceId }).length, 1);
  });

  it('sends to every active device and skips revoked ones', async () => {
    const second = createFakePhone({ name: 'Tablet' });
    const gone = createFakePhone({ name: 'Lost phone' });
    const w = await world({
      records: (phone) => [phone.approverRecord(), second.approverRecord(), gone.approverRecord({ revokedAt: '2026-09-24T00:00:00.000Z', revokedBy: phone.deviceId })]
    });
    const targets = w.link.sent.filter((s) => s.opts.push.id === w.token).map((s) => s.opts.to_device).sort();
    assert.deepStrictEqual(targets, [w.phone.deviceId, second.deviceId].sort());
  });

  it('keeps the node payload bounded and clean: hidden code points escaped, long text cut', async () => {
    const w = await world();
    const long = `Sign‮evil​ ${'x'.repeat(5000)}`;
    await w.mobile.sendContact({ items: [{
      caseId: w.info.id, questionId: w.q.id, token: w.token, kind: 'question', urgency: 'high', caseTitle: 'Lake\u0007side',
      text: `line one\nline two ${long}`, options: [{ id: 'a', label: 'Y⁦es' }], expiresAt: null
    }] });
    const { message } = open(w.link.sent[w.link.sent.length - 1].envelope);
    assert.strictEqual(message.case_title, 'Lake‹U+0007›side');
    assert.strictEqual(message.options[0].label, 'Y‹U+2066›es');
    assert.ok(message.text.startsWith('line one\nline two Sign‹U+202E›evil‹U+200B› x'));
    assert.ok(Array.from(message.text).length <= 4000);
    assert.ok(message.text.endsWith('…'));
  });

  it('applies a valid device-signed answer as a user fact', async () => {
    const w = await world();
    const r = await w.call(w.answer());
    assert.deepStrictEqual(r, { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' });
    const rec = w.runtime.questions(w.info.id).get(w.q.id);
    assert.strictEqual(rec.answer.channel, 'mobile');
    assert.strictEqual(rec.answer.optionId, 'a');
  });

  it('refuses a bad signature, an unknown device, a reused nonce, a stale signed_at, the wrong node and the wrong token', async () => {
    const w = await world();
    const good = w.answer();
    // Change the first base64url character: still canonical, no longer the signature.
    const tampered = { ...good, sig: `${good.sig[0] === 'A' ? 'B' : 'A'}${good.sig.slice(1)}` };
    assert.deepStrictEqual(await w.call(tampered), { ok: false, error: 'bad_signature' });
    assert.deepStrictEqual(await w.call(w.answer({}, w.stranger)), { ok: false, error: 'unknown_device' });
    assert.deepStrictEqual(await w.call(w.answer({ signed_at: '2026-09-25T13:50:00.000Z' })), { ok: false, error: 'stale' });
    assert.deepStrictEqual(await w.call(w.answer({ signed_at: '2026-09-25T14:10:00.000Z' })), { ok: false, error: 'stale' }, 'from the future too');
    assert.deepStrictEqual(await w.call(w.answer({ node_id: testNodeIdentity({ key: 'gpu-box' }).nodeId })), { ok: false, error: 'wrong_node' });
    assert.deepStrictEqual(await w.call(w.answer({ token: 'ZZZZZZ' })), { ok: false, error: 'unknown_question' });
    assert.strictEqual(w.answerOf(), null, 'nothing was applied');
    assert.strictEqual((await w.call(good)).ok, true);
    assert.deepStrictEqual(await w.call(good), { ok: false, error: 'replay' }, 'the same bytes again');
  });

  it('accepts signed_at exactly at the edge of the window', async () => {
    const w = await world();
    const edge = new Date(w.now.getTime() - SIGNED_AT_SKEW_MS).toISOString();
    assert.strictEqual((await w.call(w.answer({ signed_at: edge }))).ok, true);
  });

  it('an unsigned answer (no envelope, or an envelope without a signature) is refused', async () => {
    const w = await world();
    const good = w.answer();
    assert.deepStrictEqual(await w.link.methods['question.answer']({}, { peer: 'relay' }), { ok: false, error: 'malformed' });
    assert.deepStrictEqual(await w.link.methods['question.answer'](undefined, { peer: 'relay' }), { ok: false, error: 'malformed' });
    assert.deepStrictEqual(await w.call({ alg: good.alg, kid: good.kid, payload: good.payload }), { ok: false, error: 'malformed' });
    assert.deepStrictEqual(await w.call({ ...good, sig: '' }), { ok: false, error: 'malformed' });
    assert.deepStrictEqual(await w.link.methods['question.answer']({ ...open(good).message }, { peer: 'relay' }), { ok: false, error: 'malformed' }, 'bare message fields, no envelope');
    assert.strictEqual(w.answerOf(), null);
  });

  it('a revoked device is refused (on file and in the overlay)', async () => {
    const other = createFakePhone({ name: 'Tablet' });
    const w = await world({ records: (phone) => [phone.approverRecord(), other.approverRecord()] });
    w.store.addToOverlay(w.phone.deviceId);
    assert.deepStrictEqual(await w.call(w.answer()), { ok: false, error: 'revoked_device' });
    const revoked = createFakePhone({ name: 'Old phone' });
    const w2 = await world({
      records: (phone) => [phone.approverRecord(), revoked.approverRecord({ revokedAt: '2026-09-24T00:00:00.000Z', revokedBy: phone.deviceId })]
    });
    assert.deepStrictEqual(await w2.call(w2.answer({}, revoked)), { ok: false, error: 'revoked_device' });
    assert.strictEqual(w.answerOf(), null);
    assert.strictEqual(w2.answerOf(), null);
  });

  it('a published test device key is refused while allowTestKeys is false', async () => {
    const testPhone = createFakePhone({ seed: 'A', name: 'Test phone' });
    const w = await world({ records: (phone) => [phone.approverRecord(), testPhone.approverRecord()] });
    assert.strictEqual(w.store.allowTestKeys, false);
    assert.deepStrictEqual(await w.call(w.answer({}, testPhone)), { ok: false, error: 'test_key' });
    assert.ok(!w.mobile.devices().includes(testPhone.deviceId), 'no question is sent to it either');
    assert.strictEqual(w.answerOf(), null);
  });

  it('an answer bound to a different question (question id, case id or token of another question) is refused', async () => {
    const w = await world();
    assert.deepStrictEqual(await w.call(w.answer({ question_id: w.q2.id })), { ok: false, error: 'unknown_question' }, 'token of q, question id of q2');
    assert.deepStrictEqual(await w.call(w.answer({ token: w.token2 })), { ok: false, error: 'unknown_question' }, 'token of q2, question id of q');
    assert.deepStrictEqual(await w.call(w.answer({ case_id: 'mfz1k2-0a1b2c3d' })), { ok: false, error: 'unknown_question' }, 'another case');
    assert.strictEqual(w.answerOf(w.q.id), null);
    assert.strictEqual(w.answerOf(w.q2.id), null);
  });

  it('a token delivered only on another channel is not answerable from the phone', async () => {
    const w = await world();
    const other = w.router.state.newToken();
    w.router.state.recordDelivery('d-other', {
      channel: 'sms', at: w.now.toISOString(), externalRef: null, relayId: null, batchToken: w.router.state.newToken(), idempotencyKey: 'd-other', status: 'sent',
      items: [{ n: 1, caseId: w.info.id, questionId: w.q.id, token: other, kind: 'question', answerable: true }]
    });
    assert.deepStrictEqual(await w.call(w.answer({ token: other })), { ok: false, error: 'unknown_question' });
  });

  it('a relay-forwarded answer without a device signature is never owner proof', async () => {
    const w = await world();
    const relay = testNodeIdentity({ key: 'relay' });
    const forged = seal({
      v: 1, type: 'kl.question.answer', node_id: w.node.nodeId, case_id: w.info.id, question_id: w.q.id, token: w.token,
      answer: { option_id: 'b' }, nonce: randomNonce(), signed_at: w.now.toISOString(), device_id: w.phone.deviceId
    }, relay.signer);
    assert.deepStrictEqual(await w.call(forged), { ok: false, error: 'malformed' });
    assert.strictEqual(w.answerOf(), null);
  });

  it('is not relay-addressable: relayOf(mobile) is null and it keeps its link on `link`', async () => {
    const w = await world();
    assert.strictEqual(relayOf(w.mobile), null);
    assert.strictEqual(w.mobile.relay, undefined);
    assert.strictEqual(w.mobile.relayName, undefined);
    // A relay event claiming channel 'mobile' touches nothing.
    await w.router.ingestRelayEvents('main', [{ id: 'e1', type: 'inbound', channel: 'mobile', text: `#${w.token} a`, from: 'x', at: w.now.toISOString() }]);
    assert.strictEqual(w.answerOf(), null);
  });

  it('an unsigned ping from a paired device over the relay link makes the phone the present channel', async () => {
    const w = await world();
    assert.deepStrictEqual(await w.ping(w.fg()), { ok: true });
    assert.strictEqual(w.presence.presentChannel(), 'mobile');
  });

  it('refuses a ping from an unknown or revoked device, with no state change', async () => {
    const revoked = createFakePhone({ name: 'Old phone' });
    const w = await world({
      records: (phone) => [phone.approverRecord(), revoked.approverRecord({ revokedAt: '2026-09-24T00:00:00.000Z', revokedBy: phone.deviceId })]
    });
    assert.deepStrictEqual(await w.ping(w.fg({ deviceId: w.stranger.deviceId })), { ok: false, error: 'unknown-device' });
    assert.deepStrictEqual(await w.ping(w.fg({ deviceId: revoked.deviceId })), { ok: false, error: 'unknown-device' });
    w.store.addToOverlay(w.phone.deviceId);
    assert.deepStrictEqual(await w.ping(w.fg()), { ok: false, error: 'unknown-device' }, 'revoked through the overlay');
    assert.notStrictEqual(w.presence.presentChannel(), 'mobile');
  });

  it('refuses a malformed ping and one that did not come over the relay link', async () => {
    const w = await world();
    for (const bad of [undefined, null, [], {}, w.fg({ at: undefined }), w.fg({ at: 'yesterday' }), w.fg({ at: NaN }), w.fg({ at: Infinity }), w.fg({ deviceId: 'phone-1' }), w.fg({ deviceId: 7 }), w.fg({ foreground: 'yes' }), w.fg({ foreground: 1 }), w.fg({ foreground: undefined })]) {
      assert.deepStrictEqual(await w.ping(bad), { ok: false, error: 'malformed' }, JSON.stringify(bad));
    }
    assert.deepStrictEqual(await w.ping(w.fg(), null), { ok: false, error: 'not-linked' });
    assert.deepStrictEqual(await w.ping(w.fg(), {}), { ok: false, error: 'not-linked' });
    assert.notStrictEqual(w.presence.presentChannel(), 'mobile');
  });

  it('ignores a ping more than two minutes old; a future `at` is accepted and never reaches Presence', async () => {
    const w = await world();
    const seen = [];
    w.mobile.presenceTracker = { mobileForeground: (p) => { seen.push(p); return { ok: true }; } };
    const old = new Date(w.now.getTime() - PRESENCE_MAX_AGE_MS - 1000).toISOString();
    assert.deepStrictEqual(await w.ping(w.fg({ at: old })), { ok: true });
    assert.deepStrictEqual(seen, [], 'a stale ping changes nothing');
    const edge = new Date(w.now.getTime() - PRESENCE_MAX_AGE_MS).toISOString();
    assert.deepStrictEqual(await w.ping(w.fg({ at: edge })), { ok: true });
    assert.strictEqual(seen.length, 1, 'exactly two minutes old still counts');
    const future = new Date(w.now.getTime() + 24 * 3600 * 1000).toISOString();
    assert.deepStrictEqual(await w.ping(w.fg({ at: future, foreground: false })), { ok: true });
    assert.deepStrictEqual(seen[1], { deviceId: w.phone.deviceId, foreground: false }, 'no phone time reaches Presence');
    // A far-future `at` does not freeze the device: a later ping stamped now still applies.
    w.advance(1000);
    assert.deepStrictEqual(await w.ping(w.fg({ foreground: true })), { ok: true });
    assert.strictEqual(seen.length, 3);
  });

  it('ignores a ping older than the last applied one (out of order delivery)', async () => {
    const w = await world();
    const seen = [];
    w.mobile.presenceTracker = { mobileForeground: (p) => { seen.push(p); return { ok: true }; } };
    const t0 = w.now.getTime();
    assert.deepStrictEqual(await w.ping(w.fg({ at: new Date(t0).toISOString(), foreground: false })), { ok: true });
    w.advance(10000);
    assert.deepStrictEqual(await w.ping(w.fg({ at: new Date(t0 - 5000).toISOString(), foreground: true })), { ok: true });
    assert.deepStrictEqual(seen, [{ deviceId: w.phone.deviceId, foreground: false }], 'the older foreground ping arrived late and is ignored');
    assert.deepStrictEqual(await w.ping(w.fg({ at: new Date(t0 + 10000).toISOString(), foreground: true })), { ok: true });
    assert.strictEqual(seen.length, 2);
  });

  it('rate-limits repeats of the same state to one every 5 s; a change of state always applies', async () => {
    const w = await world();
    const seen = [];
    w.mobile.presenceTracker = { mobileForeground: (p) => { seen.push(p.foreground); return { ok: true }; } };
    assert.deepStrictEqual(await w.ping(w.fg()), { ok: true });
    assert.deepStrictEqual(await w.ping(w.fg()), { ok: true });
    w.advance(PRESENCE_MIN_GAP_MS - 1);
    assert.deepStrictEqual(await w.ping(w.fg()), { ok: true });
    assert.deepStrictEqual(seen, [true], 'repeats inside 5 s are dropped');
    assert.deepStrictEqual(await w.ping(w.fg({ foreground: false })), { ok: true });
    assert.deepStrictEqual(await w.ping(w.fg({ foreground: true })), { ok: true });
    assert.deepStrictEqual(seen, [true, false, true], 'state changes apply at once');
    w.advance(PRESENCE_MIN_GAP_MS);
    assert.deepStrictEqual(await w.ping(w.fg()), { ok: true });
    assert.deepStrictEqual(seen, [true, false, true, true], 'a repeat after 5 s refreshes');
  });

  it('a presence ping never answers, approves, opens or closes a question', async () => {
    const w = await world();
    const deliveries = JSON.stringify(w.router.state.deliveries());
    const before = w.runtime.questions(w.info.id).open().map((r) => r.id).sort();
    for (const extra of [{}, { token: w.token, answer: { option_id: 'a' } }, { envelope: w.answer() }, { questionId: w.q.id, optionId: 'a', close: true }]) {
      await w.ping({ ...w.fg(), ...extra });
      w.advance(PRESENCE_MIN_GAP_MS);
    }
    assert.strictEqual(w.answerOf(w.q.id), null);
    assert.strictEqual(w.answerOf(w.q2.id), null);
    assert.deepStrictEqual(w.runtime.questions(w.info.id).open().map((r) => r.id).sort(), before);
    assert.strictEqual(w.runtime.questions(w.info.id).get(w.q.id).closed, null);
    assert.strictEqual(JSON.stringify(w.router.state.deliveries()), deliveries);
  });

  it('an answer signed ahead of the node clock reaches the router with `at` clamped to now', async () => {
    const w = await world();
    const metas = [];
    w.mobile.onContactReply((cid, answer, meta) => { metas.push(meta); return w.router.handleReply('mobile', cid, answer, meta); });
    const ahead = new Date(w.now.getTime() + 200000).toISOString();
    assert.strictEqual((await w.call(w.answer({ signed_at: ahead }))).ok, true);
    assert.strictEqual(metas[0].at, w.now.toISOString());
    assert.strictEqual(metas[0].ownerProven, true);
    assert.strictEqual(metas[0].senderId, w.phone.deviceId);
  });

  it('a signed text answer naming another question\'s #token is refused, and neither question is touched (T17-bound)', async () => {
    const w = await world();
    const r = await w.call(w.answer({ answer: { text: `#${w.token2} a` } }));
    assert.deepStrictEqual(r, { ok: false, error: 'malformed' });
    const lower = await w.call(w.answer({ answer: { text: `yes, and #${w.token2.toLowerCase()} too` } }));
    assert.deepStrictEqual(lower, { ok: false, error: 'malformed' });
    assert.strictEqual(w.answerOf(w.q.id), null);
    assert.strictEqual(w.answerOf(w.q2.id), null);
  });

  it('an approval\'s #token in a signed answer to another question never answers the approval (T17-bound)', async () => {
    const w = await world();
    const ap = w.runtime.questions(w.info.id).create({ kind: 'approval', urgency: 'high', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    const apToken = w.router.state.newToken();
    await w.router.deliver('mobile', [{ caseId: w.info.id, caseTitle: w.info.title, token: apToken, record: ap }]);
    assert.deepStrictEqual(await w.call(w.answer({ answer: { text: `#${apToken} approve` } })), { ok: false, error: 'malformed' });
    assert.strictEqual(w.answerOf(ap.id), null);
    // Router layer alone: a bound reply's text is only the body of its own question.
    const r = await w.router.handleReply('mobile', w.token, { text: `#${apToken} approve` }, { channel: 'mobile', senderId: w.phone.deviceId, ownerProven: true, bound: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(w.answerOf(ap.id), null, 'the approval is untouched');
    assert.strictEqual(w.answerOf(w.q.id).text, `#${apToken} approve`, 'the text answered q only, as its body');
    assert.strictEqual(w.answerOf(w.q2.id), null);
  });

  it('single-item answers still work: option, free text, and text naming its own token', async () => {
    const w = await world();
    assert.strictEqual((await w.call(w.answer({ answer: { text: 'Counter at 45k' } }))).ok, true);
    assert.strictEqual(w.answerOf(w.q.id).text, 'Counter at 45k');
    const own = await w.call(w.answer({ question_id: w.q2.id, token: w.token2, answer: { text: `#${w.token2} after the thaw` } }));
    assert.strictEqual(own.ok, true);
    assert.strictEqual(w.answerOf(w.q2.id).text, `#${w.token2} after the thaw`);
  });

  it('only the mobile channel may send a bound reply', async () => {
    const w = await world();
    const telegram = { contactCapabilities: () => ({ authenticatedReplies: false }), contactConfigured: () => true };
    const adapters = new Map([['telegram', telegram], ['mobile', w.mobile]]);
    const router = new ContactRouter({ state: w.router.state, runtime: w.runtime, adapters, clock: () => w.now });
    const r = await router.handleReply('telegram', w.token, { text: 'a' }, { channel: 'telegram', senderId: '1', ownerProven: true, bound: true });
    assert.deepStrictEqual(r, { ok: false, outcome: 'refused: not-bound', ackText: null });
    assert.strictEqual(w.answerOf(w.q.id), null);
  });

  it('the answer shape the apps build (KLProtocol / protocol Questions) passes the node validator', () => {
    const fromApps = JSON.parse('{"answer":{"option_id":"a"},"case_id":"mfz1k2-0a1b2c3d","device_id":"d-bbbbbbbbbbbbbbbb","node_id":"kl-aaaaaaaaaaaaaaaa","nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","question_id":"q-0012","signed_at":"2026-09-25T14:00:00Z","token":"7QD4KM","type":"kl.question.answer","v":1}');
    assert.strictEqual(validateAnswerMessage(fromApps), true);
    assert.strictEqual(validateAnswerMessage({ ...fromApps, answer: { option_id: 'a', text: 'both' } }), false);
    assert.strictEqual(validateAnswerMessage({ ...fromApps, extra: 1 }), false);
    assert.strictEqual(validateAnswerMessage({ ...fromApps, signed_at: '2026-02-30T14:00:00Z' }), false, 'a nonexistent date');
  });
});

describe('sealed questions: the ask', () => {
  it('a sealing node\'s ask holds no case, question, title, text or options in clear, and the phone opens it', async () => {
    const w = await world({ sealing: true });
    const { envelope, opts } = w.link.sent[0];
    assert.deepStrictEqual(opts, { push: { kind: 'question', id: w.token }, to_device: w.phone.deviceId }, 'the push is as before');
    assert.strictEqual(verifyEd25519(envelope, w.node.publicKey.toString('hex')), true);
    const { message, bytes } = open(envelope);
    assert.deepStrictEqual(Object.keys(message).sort(), ['expires_at', 'kind', 'node_box', 'node_id', 'sealed', 'token', 'type', 'urgency', 'v']);
    assert.deepStrictEqual(message.node_box, w.node.box.jwk);
    assert.strictEqual(message.token, w.token);
    const onTheWire = Buffer.from(bytes).toString('utf8');
    for (const secret of ['Accept the 41k', 'Lakeside', w.info.id, w.q.id, 'Yes']) assert.ok(!onTheWire.includes(secret), secret);
    assert.deepStrictEqual(w.phone.open(envelope, 'kl.question.ask').message, {
      v: 1, type: 'kl.question.ask', node_id: w.node.nodeId, token: w.token, kind: 'question', urgency: 'high', expires_at: null, node_box: w.node.box.jwk,
      case_id: w.info.id, question_id: w.q.id, case_title: 'Lakeside lot', text: 'Accept the 41k offer?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }]
    });
    assert.strictEqual(validateMessage('kl.question.ask', message), null);
  });

  it('seals to the phones with a box key and the node, sends to every active phone, and the phone with no box key cannot open it', async () => {
    const plain = createFakePhone({ name: 'Old phone' });
    const w = await world({ sealing: true, records: (phone) => [phone.approverRecord({ boxKey: true }), plain.approverRecord()] });
    const sent = w.link.sent.filter((s) => s.opts.push.id === w.token);
    assert.deepStrictEqual(sent.map((s) => s.opts.to_device).sort(), [w.phone.deviceId, plain.deviceId].sort());
    assert.deepStrictEqual(Object.keys(open(sent[0].envelope).message.sealed.keys).sort(), [w.phone.deviceId, w.node.nodeId].sort());
  });

  it('with no seal policy or sealing not on, the ask is byte for byte the clear one', async () => {
    const w = await world({ sealing: true, sealFrom: 'later' });
    assert.strictEqual(open(w.link.sent[0].envelope).message.text, 'Accept the 41k offer?');
    const off = { sealing: () => false, canSeal: () => false, recipients: () => ({}), senderId: w.node.nodeId, nodeBox: w.node.box.jwk };
    w.mobile.sealPolicy = off;
    const item = { caseId: w.info.id, questionId: w.q.id, token: w.token, kind: 'question', urgency: 'high', caseTitle: 'Lakeside lot', text: 'Accept the 41k offer?', options: [], expiresAt: null };
    await w.mobile.sendContact({ items: [item] });
    const { message } = open(w.link.sent[w.link.sent.length - 1].envelope);
    assert.deepStrictEqual(Object.keys(message).sort(), ['case_id', 'case_title', 'expires_at', 'kind', 'node_id', 'options', 'question_id', 'text', 'token', 'type', 'urgency', 'v']);
  });

  it('the clear part is what the relay mailbox needs: a sealed ask is stored and listed unchanged', async () => {
    const w = await world({ sealing: true });
    const mailbox = new Mailbox();
    mailbox.registerType('kl.question.', { ttlMs: 60000 });
    mailbox.put(w.node.nodeId, w.link.sent[0].envelope, { to_device: w.phone.deviceId });
    const [listed] = mailbox.list({ nodeIds: [w.node.nodeId], typePrefix: 'kl.question.ask', toDevice: w.phone.deviceId });
    assert.deepStrictEqual(listed.envelope, w.link.sent[0].envelope);
  });

  it('the delivery says it was sealed, and to whom, on disk before the send; a clear one has no such key', async () => {
    const w = await world({ sealing: true });
    const onDisk = [];
    const realSend = w.link.send;
    w.link.send = async (envelope, opts) => {
      onDisk.push(JSON.parse(fs.readFileSync(path.join(w.state.dir, 'deliveries.json'), 'utf8')));
      return realSend(envelope, opts);
    };
    const { deliveryId } = await w.router.deliver('mobile', [{ caseId: w.info.id, caseTitle: w.info.title, token: w.token, record: w.q }]);
    assert.strictEqual(onDisk.length, 1);
    const seen = onDisk[0].deliveries ? onDisk[0].deliveries[deliveryId] : onDisk[0][deliveryId];
    assert.strictEqual(seen.status, 'sending');
    assert.strictEqual(seen.sealed, true);
    assert.deepStrictEqual(seen.sealedTo, { [w.phone.deviceId]: boxKeyFingerprint(w.phone.boxJwk) });
    const clearWorld = await world();
    const clearDelivery = clearWorld.state.resolve(clearWorld.token, { channel: 'mobile' }).delivery;
    assert.ok(!('sealed' in clearDelivery));
    assert.ok(!('sealedTo' in clearDelivery));
  });
});

describe('sealed questions: latched with nobody to seal to', () => {
  const item = (w) => ({ caseId: w.info.id, questionId: w.q.id, token: w.token, kind: 'question', urgency: 'high', caseTitle: 'Lakeside lot', text: 'Accept the 41k offer?', options: [], expiresAt: null });

  it('a revoked last phone: nothing goes in clear, the rung is not configured, and answers still count as authenticated', async () => {
    const other = createFakePhone({ name: 'Tablet' });
    const w = await world({ sealing: true, records: (phone) => [phone.approverRecord({ boxKey: true }), other.approverRecord()] });
    assert.strictEqual(w.mobile.contactConfigured(), true);
    w.store.addToOverlay(w.phone.deviceId);
    const before = w.link.sent.length;
    assert.strictEqual(w.sealPolicy.sealing(), true);
    assert.strictEqual(w.sealPolicy.canSeal(), false);
    assert.strictEqual(w.mobile.contactConfigured(), false);
    assert.strictEqual(w.router.channelStatus('mobile').configured, false);
    assert.strictEqual(w.router.answersInApp('mobile'), true, 'a phone can still answer what it already holds');
    await assert.rejects(w.mobile.sendContact({ items: [item(w)] }), (err) => err.code === 'not-configured' && !err.message.includes('41k'));
    await assert.rejects(w.router.deliver('mobile', [{ caseId: w.info.id, caseTitle: w.info.title, token: w.token, record: w.q }]), (err) => err.code === 'not-configured');
    assert.strictEqual(w.link.sent.length, before);
  });

  it('logs at debug with no content in it', async () => {
    const w = await world({ sealing: true });
    const lines = [];
    const quiet = () => {};
    w.mobile.log = { debug: (text) => lines.push(text), info: quiet, warn: quiet, error: quiet };
    w.mobile.sealPolicy = { sealing: () => true, canSeal: () => false, recipients: () => ({}), senderId: w.node.nodeId, nodeBox: w.node.box.jwk };
    assert.strictEqual(w.mobile.contactConfigured(), false);
    assert.strictEqual(w.mobile.contactConfigured(), false);
    await assert.rejects(w.mobile.sendContact({ items: [item(w)] }));
    assert.ok(lines.length >= 1 && lines.length <= 2, `one on the change and one on the refused send, got ${lines.length}`);
    for (const line of lines) {
      for (const secret of ['41k', 'Lakeside', w.info.id, w.q.id, w.token]) assert.ok(!line.includes(secret), line);
    }
  });

  for (const [name, policy] of [
    ['a policy that throws', () => ({ sealing() { throw new Error('boom'); }, canSeal: () => true, recipients: () => ({}), senderId: 'x', nodeBox: {} })],
    ['canSeal but recipients empty (an untrusted store)', () => ({ sealing: () => true, canSeal: () => true, recipients: () => ({}), senderId: 'x', nodeBox: {} })],
    ['recipients holding the node alone', (w) => ({ sealing: () => true, canSeal: () => true, recipients: () => ({ [w.node.nodeId]: w.node.box.jwk }), senderId: w.node.nodeId, nodeBox: w.node.box.jwk })],
    ['no node box', () => ({ sealing: () => true, canSeal: () => true, recipients: () => ({ 'd-aaaaaaaaaaaaaaaa': generateBoxKey().jwk }), senderId: 'x', nodeBox: null })]
  ]) {
    it(`${name}: refused, never clear`, async () => {
      const w = await world({ sealing: true });
      const before = w.link.sent.length;
      w.mobile.sealPolicy = policy(w);
      assert.strictEqual(w.mobile.contactConfigured(), false);
      await assert.rejects(w.mobile.sendContact({ items: [item(w)] }), (err) => err.code === 'not-configured');
      assert.strictEqual(w.link.sent.length, before);
    });
  }

  it('the policy is read for each item: the last phone revoked mid-batch stops the batch, and what is left never goes clear', async () => {
    const w = await world({ sealing: true });
    const before = w.link.sent.length;
    const realSend = w.link.send;
    w.link.send = async (envelope, opts) => { const out = await realSend(envelope, opts); w.store.addToOverlay(w.phone.deviceId); return out; };
    await assert.rejects(w.mobile.sendContact({ items: [item(w), { ...item(w), token: w.token2, questionId: w.q2.id }] }), (err) => err.code === 'not-configured');
    assert.strictEqual(w.link.sent.length, before + 1);
    assert.ok(isSealedShape('kl.question.ask', open(w.link.sent[before].envelope).message));
  });

  it('the ladder moves to the next rung at once: skipped, never sent, no delivery, and nothing in the question\'s record', async () => {
    const other = createFakePhone({ name: 'Tablet' });
    const w = await world({ sealing: true, records: (phone) => [phone.approverRecord({ boxKey: true }), other.approverRecord()] });
    w.store.addToOverlay(w.phone.deviceId);
    const before = w.link.sent.length;
    const deliveriesBefore = Object.keys(w.state.deliveries()).length;
    const telegram = new LoopbackChannel({ id: 'telegram', owner: 'telegram-owner', caps: {} });
    w.adapters.set('telegram', telegram);
    const policy = { ...w.policy, digest: null, ladders: { ...w.policy.ladders, high: [{ channel: 'mobile', afterMin: 0 }, { channel: 'telegram', afterMin: 0 }] } };
    const ladder = new LadderEngine({ state: w.state, casesRoot: w.runtime.root, runtime: w.runtime, router: w.router, presence: w.presence, getPolicy: () => policy, clock: w.clock, dataDir: w.data });
    const q3 = w.runtime.questions(w.info.id).create({ kind: 'question', urgency: 'high', text: 'Take the counter?', options: [] });
    w.advance(120000);
    await ladder.tick();
    const entry = w.state.ladder().entries[`${w.info.id}/${q3.id}`];
    assert.deepStrictEqual(entry.attempts.filter((a) => a.channel === 'mobile').map((a) => [a.outcome, a.reason]), [['skipped', 'sealing']]);
    assert.ok(!entry.attempts.some((a) => a.channel === 'mobile' && a.outcome === 'sent'));
    assert.deepStrictEqual(entry.attempts.filter((a) => a.channel === 'telegram').map((a) => a.outcome), ['sent']);
    assert.strictEqual(w.link.sent.length, before, 'nothing went to the relay');
    assert.ok(!Object.values(w.state.deliveries()).slice(deliveriesBefore).some((d) => d.channel === 'mobile'));
    assert.ok(!(w.runtime.questions(w.info.id).get(q3.id).deliveries || []).some((d) => d.channel === 'mobile'));
    assert.ok(telegram.sent.length >= 1);
  });

  it('a latched node with no phone left: the ladder skips for sealing, and the status says why', async () => {
    const w = await world({ sealing: true });
    assert.strictEqual(w.sealPolicy.sealing(), true);
    w.store.addToOverlay(w.phone.deviceId);
    assert.strictEqual(w.mobile.devices().length, 0);
    const before = w.link.sent.length;
    const status = w.router.channelStatus('mobile');
    assert.strictEqual(status.configured, false);
    assert.strictEqual(status.sealing, true);
    assert.strictEqual(status.reason, w.sealPolicy.whyNot());
    assert.match(status.reason, /no active phone holds a box key/);
    const { ladder } = ladderOn(w);
    w.advance(120000);
    await ladder.tick();
    const entry = w.state.ladder().entries[`${w.info.id}/${w.q.id}`];
    assert.deepStrictEqual(entry.attempts.filter((a) => a.channel === 'mobile').map((a) => [a.outcome, a.reason]), [['skipped', 'sealing']]);
    assert.strictEqual(w.link.sent.length, before);
  });

  it('with no seal policy the reason stays what it was', async () => {
    const w = await world();
    w.store.addToOverlay(w.phone.deviceId);
    assert.deepStrictEqual(w.router.channelStatus('mobile'), { enabled: true, configured: false, reason: 'no owner target is configured' });
  });

  it('the present rung: a phone in front on a latched node is not present, so the ladder records the sealing skip and tries the next rung', async () => {
    const other = createFakePhone({ name: 'Tablet' });
    const w = await world({ sealing: true, presenceByConfigured: true, records: (phone) => [phone.approverRecord({ boxKey: true }), other.approverRecord()] });
    assert.deepStrictEqual(await w.ping(w.fg()), { ok: true });
    assert.strictEqual(w.presence.presentChannel(), 'mobile', 'it can be read: it is present');
    w.store.addToOverlay(w.phone.deviceId);
    assert.deepStrictEqual(await w.ping(w.fg({ deviceId: other.deviceId })), { ok: true });
    assert.strictEqual(w.mobile.contactConfigured(), false);
    assert.notStrictEqual(w.presence.presentChannel(), 'mobile');
    const before = w.link.sent.length;
    const { ladder, telegram } = ladderOn(w, [{ channel: 'present', afterMin: 0 }, { channel: 'telegram', afterMin: 0 }]);
    w.advance(120000);
    await ladder.tick();
    const entry = w.state.ladder().entries[`${w.info.id}/${w.q.id}`];
    assert.deepStrictEqual(entry.attempts.map((a) => `${a.channel}:${a.outcome}:${a.reason || ''}`), ['mobile:skipped:sealing', 'telegram:sent:']);
    assert.strictEqual(w.link.sent.length, before);
    assert.ok(telegram.sent.length >= 1);
  });
});

describe('sealed questions: back to the phone once it can read', () => {
  const asksOf = (w, token) => w.link.sent.filter((x) => x.opts.push.id === token);
  const entryOf = (w, q = w.q) => w.state.ladder().entries[`${w.info.id}/${q.id}`];
  const mobileAttempts = (e) => e.attempts.filter((a) => a.channel === 'mobile');

  it('held back: one warning with the reason, however many ticks; the key arrives: one re-send on the same token, which the phone opens', async () => {
    const w = await world({ sealing: true });
    const p = settablePolicy(w, {});
    const warnings = [];
    const { ladder } = ladderOn(w, undefined, { warnOwner: (text) => warnings.push(text) });
    w.advance(120000);
    await ladder.tick();
    await ladder.tick();
    await ladder.tick();
    const entry = entryOf(w);
    assert.deepStrictEqual(mobileAttempts(entry).map((a) => [a.outcome, a.reason]), [['skipped', 'sealing']]);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes(p.why), warnings[0]);
    for (const secret of ['41k', 'Lakeside', w.info.id, w.q.id, entry.token]) assert.ok(!warnings[0].includes(secret));

    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    const before = asksOf(w, entry.token).length;
    assert.strictEqual(before, 0);
    await ladder.tick();
    const sent = asksOf(w, entry.token);
    assert.strictEqual(sent.length, 1);
    const opened = w.phone.open(sent[0].envelope, 'kl.question.ask').message;
    assert.strictEqual(opened.token, entry.token);
    assert.strictEqual(opened.question_id, w.q.id);
    await ladder.tick();
    await ladder.tick();
    assert.strictEqual(asksOf(w, entry.token).length, 1, 'once');
    assert.strictEqual(entryOf(w).token, entry.token);
    assert.strictEqual(warnings.length, 1);
    // An ordinary answer on the live token counts.
    const reply = sealedAnswer(w, { clear: { token: entry.token, signed_at: w.clock().toISOString() } });
    assert.strictEqual((await w.call(reply)).ok, true);
    assert.strictEqual(w.answerOf().optionId, 'a');
  });

  it('the default ladder: held at its present rung, the question reaches the phone once, when it has a key and comes to the front', async () => {
    const w = await world({ sealing: true, presenceByConfigured: true });
    const p = settablePolicy(w, {});
    const warnings = [];
    const { ladder } = ladderOn(w, null, { warnOwner: (text) => warnings.push(text) });
    assert.deepStrictEqual(w.policy.ladders.high.map((step) => step.channel), ['present', 'sms', 'voice'], 'the default');
    w.advance(120000);
    await ladder.tick();
    const entry = entryOf(w);
    assert.strictEqual(entry.steps[0].channel, 'present');
    assert.deepStrictEqual(mobileAttempts(entry).map((a) => [a.outcome, a.reason]), [['skipped', 'sealing']]);
    assert.ok(!entry.attempts.some((a) => a.channel === 'present'), 'not recorded as absent');
    assert.strictEqual(warnings.length, 1);
    const token = entry.token;

    // The key alone: the rung asked for where the owner is, and he is not there.
    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 0);
    assert.deepStrictEqual(Object.keys(entryOf(w).sealResends || {}), [], 'waiting spends nothing');

    assert.deepStrictEqual(await w.ping(w.fg({ at: w.clock().toISOString() })), { ok: true });
    await ladder.tick();
    const sent = asksOf(w, token);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(w.phone.open(sent[0].envelope, 'kl.question.ask').message.question_id, w.q.id);
    await ladder.tick();
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 1, 'once');
    assert.strictEqual(entryOf(w).token, token);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual((await w.call(sealedAnswer(w, { clear: { token, signed_at: w.clock().toISOString() } }))).ok, true);
    assert.strictEqual(w.answerOf().optionId, 'a');
  });

  it('the present rung with nothing held back still records absent', async () => {
    const w = await world({ sealing: true, presenceByConfigured: true });
    settablePolicy(w, { [w.phone.deviceId]: w.phone.boxJwk });
    const { ladder } = ladderOn(w, null);
    w.advance(120000);
    await ladder.tick();
    assert.ok(entryOf(w).attempts.some((a) => a.channel === 'present' && a.outcome === 'absent'));
    assert.deepStrictEqual(mobileAttempts(entryOf(w)), []);
  });

  it('a new episode warns again, and a changed reason does too', async () => {
    const w = await world({ sealing: true });
    const p = settablePolicy(w, {});
    const warnings = [];
    const { ladder } = ladderOn(w, undefined, { warnOwner: (text) => warnings.push(text) });
    w.advance(120000);
    await ladder.tick();
    p.why = 'the approver set is not trusted: a test said so';
    await ladder.tick();
    assert.strictEqual(warnings.length, 2);
    assert.ok(warnings[1].includes(p.why));
    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    await ladder.tick();
    delete p.keys[w.phone.deviceId];
    await w.runtime.questions(w.info.id).create({ kind: 'question', urgency: 'high', text: 'Take the counter?', options: [] });
    w.advance(120000);
    await ladder.tick();
    assert.strictEqual(warnings.length, 3);
  });

  it('a sealed delivery that lacks a phone which now holds a key is sent once more, and a stale key once per new key', async () => {
    const second = createFakePhone({ name: 'Tablet', boxKey: true });
    const w = await world({ sealing: true, records: (phone) => [phone.approverRecord({ boxKey: true }), second.approverRecord()] });
    const p = settablePolicy(w, { [w.phone.deviceId]: w.phone.boxJwk });
    const { ladder } = ladderOn(w);
    w.advance(120000);
    await ladder.tick();
    const token = entryOf(w).token;
    const perSend = 2; // one message per active device
    assert.strictEqual(asksOf(w, token).length, perSend);
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, perSend, 'nothing new: nothing sent');

    p.keys[second.deviceId] = second.boxJwk;
    await ladder.tick();
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, perSend * 2);
    const last = asksOf(w, token)[perSend * 2 - 1];
    assert.strictEqual(second.open(last.envelope, 'kl.question.ask').message.token, token);

    // The first phone was Reset: same device, new key.
    const newKey = generateBoxKey().jwk;
    const oldKey = p.keys[w.phone.deviceId];
    p.keys[w.phone.deviceId] = newKey;
    await ladder.tick();
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, perSend * 3);
    // Its old key back again was already sent to.
    p.keys[w.phone.deviceId] = oldKey;
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, perSend * 3);
    assert.strictEqual(entryOf(w).token, token);
  });

  it('a clear delivery is not re-sent: it could be read', async () => {
    const w = await world({ sealing: true, sealFrom: 'later' });
    const { ladder } = ladderOn(w);
    w.advance(120000);
    await ladder.tick();
    const token = entryOf(w).token;
    assert.strictEqual(asksOf(w, token).length, 1);
    w.mobile.sealPolicy = w.sealPolicy;
    await ladder.tick();
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 1);
  });

  it('no storm: a node with many open questions sends a few a tick, each exactly once', async () => {
    const w = await world({ sealing: true });
    const p = settablePolicy(w, {});
    const { ladder } = ladderOn(w);
    const open = [w.q, w.q2];
    for (let i = 0; i < 12; i += 1) open.push(w.runtime.questions(w.info.id).create({ kind: 'question', urgency: 'high', text: `Question ${i}?`, options: [] }));
    w.advance(120000);
    await ladder.tick();
    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    const before = w.link.sent.length;
    await ladder.tick();
    assert.strictEqual(w.link.sent.length - before, RESEALS_PER_TICK);
    for (let i = 0; i < 5; i += 1) await ladder.tick();
    assert.strictEqual(w.link.sent.length - before, open.length);
    for (const q of open) assert.strictEqual(asksOf(w, entryOf(w, q).token).length, 1, q.id);
  });

  it('a link that is down spends nothing; a send that fails is not tried again for that key', async () => {
    const w = await world({ sealing: true });
    const p = settablePolicy(w, {});
    const { ladder } = ladderOn(w);
    w.advance(120000);
    await ladder.tick();
    const token = entryOf(w).token;
    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    w.link.canDeliver = () => ({ ok: false, reason: 'down' });
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 0);
    assert.deepStrictEqual(mobileAttempts(entryOf(w)).map((a) => a.outcome), ['skipped']);
    w.link.canDeliver = () => ({ ok: true });
    const realSend = w.link.send;
    w.link.send = async () => { throw new Error('relay said no'); };
    await ladder.tick();
    assert.deepStrictEqual(mobileAttempts(entryOf(w)).map((a) => a.outcome).slice(0, 2), ['skipped', 'failed']);
    w.link.send = realSend;
    const attempts = entryOf(w).attempts.length;
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 0);
    assert.strictEqual(entryOf(w).attempts.length, attempts);
  });

  it('away or quiet hours hold a re-send back without spending it', async () => {
    const w = await world({ sealing: true });
    const p = settablePolicy(w, {});
    const held = { away: { until: new Date(w.clock().getTime() + 3600000).toISOString(), mode: 'email-only' } };
    const { ladder, policy } = ladderOn(w);
    w.advance(120000);
    await ladder.tick();
    const token = entryOf(w).token;
    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    policy.away = held.away;
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 0);
    policy.away = null;
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 1);
  });

  it('an answered question is not sent again', async () => {
    const w = await world({ sealing: true });
    const p = settablePolicy(w, {});
    const { ladder } = ladderOn(w);
    w.advance(120000);
    await ladder.tick();
    const token = entryOf(w).token;
    await w.runtime.answerQuestion(w.info.id, w.q.id, { optionId: 'a', channel: 'in-app', quote: 'Yes' }).catch(() => w.runtime.questions(w.info.id).close(w.q.id, { reason: 'test' }));
    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    await ladder.tick();
    assert.strictEqual(asksOf(w, token).length, 0);
  });

  it('a re-send cut off by a restart does not move the ladder on', async () => {
    const w = await world({ sealing: true });
    const p = settablePolicy(w, {});
    const { ladder } = ladderOn(w);
    w.advance(120000);
    await ladder.tick();
    const entry = entryOf(w);
    const step = entry.step;
    p.keys[w.phone.deviceId] = w.phone.boxJwk;
    const realDeliver = w.router.deliver.bind(w.router);
    w.router.deliver = async () => { throw new Error('crash stand-in'); };
    await ladder.tick();
    w.router.deliver = realDeliver;
    const after = mobileAttempts(entryOf(w)).pop();
    after.outcome = 'inFlight';
    w.state.saveLadder();
    ladder.recovered = false;
    await ladder.tick();
    assert.strictEqual(entryOf(w).step, step);
    assert.strictEqual(after.outcome, 'unknown');
  });

  it('a briefing stops at sent only when every active phone is in the seal', async () => {
    const second = createFakePhone({ name: 'Tablet', boxKey: true });
    const w = await world({ sealing: true, records: (phone) => [phone.approverRecord({ boxKey: true }), second.approverRecord()] });
    const p = settablePolicy(w, { [w.phone.deviceId]: w.phone.boxJwk });
    const { ladder, telegram } = ladderOn(w);
    const brief = w.runtime.questions(w.info.id).create({ kind: 'briefing', urgency: 'high', text: 'The lot sold.', options: [] });
    w.advance(120000);
    await ladder.tick();
    const entry = entryOf(w, brief);
    assert.strictEqual(entry.attempts.find((a) => a.channel === 'mobile').outcome, 'sent');
    assert.strictEqual(entry.stopped, false, 'the tablet cannot read it');
    await ladder.tick();
    assert.deepStrictEqual(entryOf(w, brief).attempts.filter((a) => a.channel === 'telegram').map((a) => a.outcome), ['sent']);
    assert.ok(telegram.sent.length >= 1);

    p.keys[second.deviceId] = second.boxJwk;
    const all = w.runtime.questions(w.info.id).create({ kind: 'briefing', urgency: 'high', text: 'The cheque cleared.', options: [] });
    w.advance(120000);
    await ladder.tick();
    const whole = entryOf(w, all);
    assert.strictEqual(whole.attempts.find((a) => a.channel === 'mobile').outcome, 'sent');
    assert.strictEqual(whole.stopped, true);
    assert.ok(!whole.attempts.some((a) => a.channel === 'telegram'));
  });

  it('a briefing sent clear stops at sent, as before', async () => {
    const w = await world();
    const { ladder } = ladderOn(w);
    const brief = w.runtime.questions(w.info.id).create({ kind: 'briefing', urgency: 'high', text: 'The lot sold.', options: [] });
    w.advance(120000);
    await ladder.tick();
    assert.strictEqual(entryOf(w, brief).stopped, true);
  });
});

describe('sealed questions: the answer', () => {
  it('a sealed answer is accepted and ownerProven, on the content inside it', async () => {
    const w = await world({ sealing: true });
    const metas = [];
    w.mobile.onContactReply((cid, answer, meta) => { metas.push({ cid, answer, meta }); return w.router.handleReply('mobile', cid, answer, meta); });
    const r = await w.call(sealedAnswer(w));
    assert.deepStrictEqual(r, { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' });
    assert.strictEqual(metas[0].meta.ownerProven, true);
    assert.strictEqual(metas[0].meta.senderId, w.phone.deviceId);
    assert.strictEqual(metas[0].meta.bound, true);
    assert.deepStrictEqual(metas[0].answer, { optionId: 'a' });
    assert.strictEqual(w.answerOf().optionId, 'a');
    assert.strictEqual(w.answerOf().channel, 'mobile');
  });

  it('free text inside the seal is the answer', async () => {
    const w = await world({ sealing: true });
    assert.strictEqual((await w.call(sealedAnswer(w, { content: { answer: { text: 'Counter at 45k' } } }))).ok, true);
    assert.strictEqual(w.answerOf().text, 'Counter at 45k');
  });

  it('a token changed in clear and signed again is refused: the seal covers the clear part', async () => {
    const w = await world({ sealing: true });
    const { message } = open(sealedAnswer(w));
    assert.deepStrictEqual(await w.call(w.phone.sign({ ...message, token: w.token2 })), { ok: false, error: 'open_failed' });
    assert.strictEqual(w.answerOf(w.q.id), null);
    assert.strictEqual(w.answerOf(w.q2.id), null);
  });

  it('one answer\'s seal moved onto another answer\'s clear part is refused', async () => {
    const w = await world({ sealing: true });
    const moved = { ...open(sealedAnswer(w, { clear: { token: w.token2 } })).message, sealed: open(sealedAnswer(w)).message.sealed };
    assert.deepStrictEqual(await w.call(w.phone.sign(moved)), { ok: false, error: 'open_failed' });
    assert.strictEqual(w.answerOf(), null);
  });

  it('a seal that names another device than the signer does not open', async () => {
    const w = await world({ sealing: true });
    const clear = { device_id: w.stranger.deviceId };
    const { message } = open(sealedAnswer(w, { clear }));
    // Signed by the phone, sealed as the stranger: keys derive from the sender.
    const forged = { ...message, device_id: w.phone.deviceId };
    assert.deepStrictEqual(await w.call(w.phone.sign(forged)), { ok: false, error: 'open_failed' });
  });

  it('nothing is opened until the envelope verifies and its signer is the device it names', async () => {
    const w = await world({ sealing: true });
    let opens = 0;
    const box = w.node.box;
    w.node.box = { ...box, agree: (jwk) => { opens += 1; return box.agree(jwk); } };
    const good = sealedAnswer(w);
    const flipped = { ...good, sig: `${good.sig[0] === 'A' ? 'B' : 'A'}${good.sig.slice(1)}` };
    assert.deepStrictEqual(await w.call(flipped), { ok: false, error: 'bad_signature' });
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { signer: w.stranger })), { ok: false, error: 'unknown_device' });
    // The phone's id in the message, the stranger's key on the envelope.
    const named = open(sealedAnswer(w)).message;
    assert.deepStrictEqual(await w.call(w.stranger.sign(named)), { ok: false, error: 'malformed' });
    // The relay's own signature over a phone's sealed message.
    const relay = testNodeIdentity({ key: 'relay' });
    assert.deepStrictEqual(await w.call(seal(named, relay.signer)), { ok: false, error: 'malformed' });
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { clear: { node_id: testNodeIdentity({ key: 'gpu-box' }).nodeId } })), { ok: false, error: 'wrong_node' });
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { clear: { signed_at: '2026-09-25T13:50:00.000Z' } })), { ok: false, error: 'stale' });
    assert.strictEqual(opens, 0);
    assert.strictEqual(w.answerOf(), null);
    assert.strictEqual((await w.call(good)).ok, true);
    assert.strictEqual(opens, 1);
  });

  it('a revoked phone\'s sealed answer is refused, though it opens', async () => {
    const other = createFakePhone({ name: 'Tablet' });
    const w = await world({ sealing: true, records: (phone) => [phone.approverRecord({ boxKey: true }), other.approverRecord({ boxKey: false })] });
    w.store.addToOverlay(w.phone.deviceId);
    assert.deepStrictEqual(await w.call(sealedAnswer(w)), { ok: false, error: 'revoked_device' });
    assert.strictEqual(w.answerOf(), null);
  });

  it('the case and the question come from inside the seal, and must be what the live token names', async () => {
    const w = await world({ sealing: true });
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { content: { question_id: w.q2.id } })), { ok: false, error: 'unknown_question' }, 'token of q, question of q2');
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { clear: { token: w.token2 } })), { ok: false, error: 'unknown_question' }, 'token of q2, question of q');
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { content: { case_id: 'mfz1k2-0a1b2c3d' } })), { ok: false, error: 'unknown_question' }, 'another case');
    assert.strictEqual(w.answerOf(w.q.id), null);
    assert.strictEqual(w.answerOf(w.q2.id), null);
  });

  it('an answer that does not open is refused open_failed before unknown_question', async () => {
    const w = await world({ sealing: true });
    const elsewhere = { [w.node.nodeId]: generateBoxKey().jwk };
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { clear: { token: 'ZZZZZZ' }, recipients: elsewhere })), { ok: false, error: 'open_failed' }, 'sealed to another box');
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { clear: { token: 'ZZZZZZ' }, recipients: { [w.phone.deviceId]: w.node.box.jwk } })), { ok: false, error: 'open_failed' }, 'not to this node');
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { clear: { token: 'ZZZZZZ' } })), { ok: false, error: 'unknown_question' }, 'it opens: now the token counts');
    const noBox = await world({ sealing: true });
    delete noBox.node.box;
    const made = await world({ sealing: true });
    const envelope = sealedAnswer({ ...noBox, node: { ...noBox.node, box: made.node.box } });
    assert.deepStrictEqual(await noBox.call(envelope), { ok: false, error: 'open_failed' }, 'a node with no box key');
  });

  it('content that opens but is not a whole answer is malformed', async () => {
    const w = await world({ sealing: true });
    const bad = [
      { answer: { option_id: 'a', text: 'both' } },
      { answer: { text: '   ' } },
      { answer: { text: 'x'.repeat(2001) } },
      { answer: 'a' },
      { question_id: 'nope' },
      { case_id: 7 }
    ];
    for (const content of bad) {
      assert.deepStrictEqual(await w.call(sealedAnswer(w, { content })), { ok: false, error: 'malformed' }, JSON.stringify(content));
    }
    assert.strictEqual(w.answerOf(), null);
  });

  it('text naming another question\'s #token is refused inside the seal too (T17-bound)', async () => {
    const w = await world({ sealing: true });
    assert.deepStrictEqual(await w.call(sealedAnswer(w, { content: { answer: { text: `#${w.token2} a` } } })), { ok: false, error: 'malformed' });
    assert.strictEqual(w.answerOf(w.q.id), null);
    assert.strictEqual(w.answerOf(w.q2.id), null);
  });

  it('the same sealed bytes twice are a replay, and a refused one spends no nonce', async () => {
    const w = await world({ sealing: true });
    const nonce = randomNonce();
    assert.strictEqual((await w.call(sealedAnswer(w, { clear: { nonce }, content: { question_id: w.q2.id } }))).error, 'unknown_question');
    const good = sealedAnswer(w, { clear: { nonce } });
    assert.strictEqual((await w.call(good)).ok, true);
    assert.deepStrictEqual(await w.call(good), { ok: false, error: 'replay' });
  });

  it('the validator takes the sealed shape and only that: no content key beside it', async () => {
    const w = await world({ sealing: true });
    const { message } = open(sealedAnswer(w));
    assert.strictEqual(validateAnswerMessage(message), true);
    assert.strictEqual(validateAnswerMessage({ ...message, answer: { option_id: 'a' } }), false);
    assert.strictEqual(validateAnswerMessage({ ...message, case_id: w.info.id }), false);
    assert.strictEqual(validateAnswerMessage({ ...message, token: 'nope' }), false);
    assert.strictEqual(validateAnswerMessage({ ...message, token: [w.token] }), false, 'a one-element array is not a token');
    const { nonce: dropped, ...withoutNonce } = message;
    assert.ok(dropped);
    assert.strictEqual(validateAnswerMessage(withoutNonce), false);
    assert.strictEqual(validateAnswerMessage({ ...message, sealed: { ...message.sealed, keys: {} } }), false);
  });
});

describe('sealed questions: a clear answer', () => {
  it('against a clear ask is accepted on a node that has begun sealing since (an older phone)', async () => {
    const w = await world({ sealing: true, sealFrom: 'later' });
    w.mobile.sealPolicy = w.sealPolicy;
    assert.strictEqual(w.sealPolicy.sealing(), true);
    const r = await w.call(w.answer());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(w.answerOf().optionId, 'a');
  });

  it('against a sealed ask is refused, spends no nonce and answers nothing', async () => {
    const w = await world({ sealing: true });
    const nonce = randomNonce();
    assert.deepStrictEqual(await w.call(w.answer({ nonce })), { ok: false, error: 'sealed_required' });
    assert.strictEqual(w.answerOf(), null);
    assert.strictEqual((await w.call(sealedAnswer(w, { clear: { nonce } }))).ok, true, 'the sealed one with that nonce still counts');
  });

  it('the rule survives a restart: it is on the delivery, not in memory', async () => {
    const w = await world({ sealing: true });
    const state = new ContactState({ dir: w.state.dir, clock: w.clock });
    const adapters = new Map();
    const router = new ContactRouter({ state, runtime: w.runtime, adapters, presence: w.presence, clock: w.clock });
    const again = new MobileAppChannel({ link: fakeLink(), approverStore: w.store, identity: w.node, sealPolicy: w.sealPolicy, getRouter: () => router, presence: w.presence, clock: w.clock });
    adapters.set('mobile', again);
    again.onContactReply((cid, answer, meta) => router.handleReply('mobile', cid, answer, meta));
    assert.deepStrictEqual(await again.handleAnswer({ envelope: w.answer() }), { ok: false, error: 'sealed_required' });
  });

  it('a question sent clear and then sealed under one token still takes the clear answer: that clear ask really left', async () => {
    const w = await world({ sealing: true, sealFrom: 'later' });
    w.mobile.sealPolicy = w.sealPolicy;
    w.advance(60000);
    await w.router.deliver('mobile', [{ caseId: w.info.id, caseTitle: w.info.title, token: w.token, record: w.q }]);
    assert.strictEqual(w.state.resolve(w.token, { channel: 'mobile' }).delivery.sealed, true, 'the newest is sealed');
    assert.strictEqual((await w.call(w.answer())).ok, true);
    assert.strictEqual(w.answerOf().optionId, 'a');
  });

  it('a delivery refused while latched is not a clear ask that left', async () => {
    const w = await world({ sealing: true });
    const token = w.state.newToken();
    w.mobile.sealPolicy = { sealing: () => true, canSeal: () => false, recipients: () => ({}), senderId: w.node.nodeId, nodeBox: w.node.box.jwk, whyNot: () => 'no phone' };
    await assert.rejects(w.router.deliver('mobile', [{ caseId: w.info.id, caseTitle: w.info.title, token, record: w.q }]));
    assert.deepStrictEqual(await w.call(w.answer({ token })), { ok: false, error: 'unknown_question' }, 'the rung never recorded it');
  });

  it('a sealed answer against a clear ask is accepted: it tells the relay less', async () => {
    const w = await world({ sealing: true, sealFrom: 'later' });
    assert.strictEqual((await w.call(sealedAnswer(w))).ok, true);
    assert.strictEqual(w.answerOf().optionId, 'a');
  });
});

describe('contact host: startMobile', () => {
  async function hostWith({ approvals }) {
    const runtime = new CaseRuntime({ root: path.join(tmp('kl-mobile-host-'), 'cases'), host: {} });
    const settings = mergeSettings({ channels: { mobile: { enabled: true } } });
    const host = createContactHost({ getSettings: () => settings, caseRuntime: runtime, dataDir: tmp('kl-mobile-hostdata-'), features: { channels: false }, approvals, tickMs: 3600000 });
    await host.start();
    return host;
  }

  it('builds the phone channel from the F3 approvals result (relay link, admin approver store, node identity)', async () => {
    const phone = createFakePhone();
    const store = await approverStoreWith([phone.approverRecord()]);
    stores.push(store);
    const link = fakeLink();
    const host = await hostWith({ approvals: { relayClient: link, approverStore: store, identity: testNodeIdentity({ key: 'web-01' }) } });
    try {
      const mobile = host.adapters.get('mobile');
      assert.ok(mobile instanceof MobileAppChannel);
      assert.strictEqual(mobile.approverStore, store);
      assert.strictEqual(mobile.link, link);
      assert.deepStrictEqual(Object.keys(link.methods).sort(), ['presence.foreground', 'question.answer']);
      assert.strictEqual(relayOf(mobile), null);
      assert.ok(mobile.contactConfigured());
    } finally {
      await host.stop();
    }
  });

  it('has no phone channel without approvals', async () => {
    const host = await hostWith({ approvals: null });
    try {
      assert.strictEqual(host.adapters.get('mobile'), null);
    } finally {
      await host.stop();
    }
  });
});

describe('question routes (relay side)', () => {
  const { registerQuestionRoutes, WEEK_MS } = require('../src/frontdoor/question-routes');

  function relay({ offline = false, nodesForDevice = null } = {}) {
    const routes = new Map();
    const rpcs = [];
    const phoneApi = { registerRoute: (method, pattern, spec) => routes.set(`${method} ${pattern}`, spec) };
    const nodeHub = {
      rpc: async (nodeId, method, params, opts) => {
        rpcs.push({ nodeId, method, params, opts });
        if (offline) throw Object.assign(new Error('timeout'), { code: 'timeout' });
        return method === 'question.answer' ? { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' } : { ok: true };
      }
    };
    const mailbox = new Mailbox({ now: () => Date.parse('2026-09-25T14:00:00Z') });
    const devices = { nodesForDevice: nodesForDevice || ((id) => [{ node_id: 'kl-aaaaaaaaaaaaaaaa', state: id === 'd-revokedrevokedre' ? 'revoked' : 'active' }]) };
    const log = { warn() {}, debug() {}, info() {} };
    registerQuestionRoutes({ phoneApi, nodeHub, mailbox, devices, log });
    return { routes, rpcs, mailbox };
  }

  const NODE = 'kl-aaaaaaaaaaaaaaaa';
  const answerFor = (phone, fields = {}) => phone.sign({ v: 1, type: 'kl.question.answer', node_id: NODE, case_id: 'mfz1k2-0a1b2c3d', question_id: 'q-0012', token: '7QD4KM', answer: { option_id: 'a' }, nonce: randomNonce(), signed_at: '2026-09-25T14:00:00.000Z', device_id: phone.deviceId, ...fields });
  function askFor(r, phone) {
    const node = testNodeIdentity({ key: 'web-01' });
    const question = seal({ v: 1, type: 'kl.question.ask', node_id: node.nodeId, token: '7QD4KM' }, node.signer);
    r.mailbox.put(NODE, question, { to_device: phone.deviceId });
    return question;
  }

  it('registers the three signed routes (either key, android-slim §8.4) with their rate limits and the kl.question. mailbox prefix', () => {
    const r = relay();
    assert.deepStrictEqual([...r.routes.keys()], ['GET /v1/questions', 'POST /v1/questions/{token}/answer', 'POST /v1/presence']);
    for (const spec of r.routes.values()) assert.strictEqual(spec.auth, 'read');
    assert.deepStrictEqual(r.routes.get('POST /v1/questions/{token}/answer').rate, { perMin: 30 });
    assert.deepStrictEqual(r.routes.get('POST /v1/presence').rate, { perMin: 6 });
    assert.strictEqual(WEEK_MS, 7 * 24 * 3600 * 1000);
    assert.strictEqual(r.mailbox.types.get('kl.question.').ttlMs, WEEK_MS);
  });

  it('lists the mailbox for this device and forwards an answer envelope unchanged to its node', async () => {
    const r = relay();
    const phone = createFakePhone();
    const question = askFor(r, phone);
    const listed = await r.routes.get('GET /v1/questions').handler({}, { deviceId: phone.deviceId, params: {}, query: {}, body: null });
    assert.strictEqual(listed.body.length, 1);
    assert.deepStrictEqual(listed.body[0].envelope, question);
    const other = await r.routes.get('GET /v1/questions').handler({}, { deviceId: 'd-otherotherother', params: {}, query: {}, body: null });
    assert.deepStrictEqual(other.body, []);

    const envelope = answerFor(phone);
    const sent = JSON.parse(JSON.stringify(envelope));
    const answerRoute = r.routes.get('POST /v1/questions/{token}/answer');
    const out = await answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, query: {}, body: envelope });
    assert.deepStrictEqual(out.body, { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' });
    assert.deepStrictEqual(r.rpcs[0], { nodeId: NODE, method: 'question.answer', params: { envelope }, opts: { timeoutMs: 10000 } });
    // The relay adds or rewrites nothing: the node gets exactly the signed body.
    assert.deepStrictEqual(r.rpcs[0].params, { envelope: sent });

    await assert.rejects(answerRoute.handler({}, { deviceId: 'd-otherotherother', params: { token: '7QD4KM' }, body: envelope }), (err) => err.status === 403);
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: 'K7QD4M' }, body: envelope }), (err) => err.status === 400);
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: { not: 'an envelope' } }), (err) => err.status === 400);
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: 'not-a-token' }, body: envelope }), (err) => err.status === 400);
    assert.strictEqual(r.rpcs.length, 1);
  });

  it('refuses an answer from a device not active on the named node, or not an answer, before any rpc', async () => {
    const r = relay();
    const phone = createFakePhone();
    const answerRoute = r.routes.get('POST /v1/questions/{token}/answer');
    // A node this device is not paired with.
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: answerFor(phone, { node_id: 'kl-bbbbbbbbbbbbbbbb' }) }), (err) => err.status === 404 && err.code === 'not_found');
    // A device whose pairing with the node is not active.
    await assert.rejects(answerRoute.handler({}, { deviceId: 'd-revokedrevokedre', params: { token: '7QD4KM' }, body: answerFor(phone, { device_id: 'd-revokedrevokedre' }) }), (err) => err.status === 404);
    // Not an answer type.
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: answerFor(phone, { type: 'kl.question.ask' }) }), (err) => err.status === 400 && err.code === 'malformed');
    assert.strictEqual(r.rpcs.length, 0);
  });

  it('forwards an answer the relay mailbox holds no entry for (ruling T18-lookup: the node verifies it)', async () => {
    const r = relay();
    const phone = createFakePhone();
    assert.deepStrictEqual(r.mailbox.list({ nodeIds: [NODE] }), []);
    const envelope = answerFor(phone);
    const out = await r.routes.get('POST /v1/questions/{token}/answer').handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: envelope });
    assert.deepStrictEqual(out.body, { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' });
    assert.deepStrictEqual(r.rpcs, [{ nodeId: NODE, method: 'question.answer', params: { envelope }, opts: { timeoutMs: 10000 } }]);
  });

  // A sealed answer as the route gets it: the content is ciphertext to the relay.
  function sealedBody(phone, fields = {}) {
    const nodeBox = generateBoxKey();
    const clear = { v: 1, type: 'kl.question.answer', node_id: NODE, token: '7QD4KM', device_id: phone.deviceId, nonce: randomNonce(), signed_at: '2026-09-25T14:00:00.000Z', ...fields };
    return phone.sign(sealContent({
      type: 'kl.question.answer', senderId: clear.device_id, clear,
      content: { case_id: 'mfz1k2-0a1b2c3d', question_id: 'q-0012', answer: { text: 'Counter at 45k' } }, recipients: { [NODE]: nodeBox.jwk }
    }));
  }

  it('forwards a sealed answer unchanged, on its clear part alone', async () => {
    const r = relay();
    const phone = createFakePhone();
    const route = r.routes.get('POST /v1/questions/{token}/answer');
    const envelope = sealedBody(phone);
    const sent = JSON.parse(JSON.stringify(envelope));
    const out = await route.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, query: {}, body: envelope });
    assert.deepStrictEqual(out.body, { ok: true, outcome: 'recorded', ack: 'Recorded for Lakeside lot.' });
    assert.deepStrictEqual(r.rpcs, [{ nodeId: NODE, method: 'question.answer', params: { envelope: sent }, opts: { timeoutMs: 10000 } }]);
    assert.ok(!Buffer.from(envelope.payload, 'base64url').toString('utf8').includes('45k'));
    // The route's own checks still bind, from the clear part.
    await assert.rejects(route.handler({}, { deviceId: 'd-otherotherother', params: { token: '7QD4KM' }, body: envelope }), (err) => err.status === 403);
    await assert.rejects(route.handler({}, { deviceId: phone.deviceId, params: { token: 'K7QD4M' }, body: envelope }), (err) => err.status === 400);
    await assert.rejects(route.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: sealedBody(phone, { node_id: 'kl-bbbbbbbbbbbbbbbb' }) }), (err) => err.status === 404);
    assert.strictEqual(r.rpcs.length, 1);
  });

  it('the route reads only type, device_id, token and node_id of a message, and no relay file names question content', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontdoor', 'question-routes.js'), 'utf8');
    const read = [...new Set([...src.matchAll(/\bmessage\.(\w+)/g)].map((m) => m[1]))].sort();
    assert.deepStrictEqual(read, ['device_id', 'node_id', 'token', 'type']);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : [])));
    for (const file of walk(path.join(__dirname, '..', 'src', 'frontdoor'))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /\b(case_title|question_id)\b/, file);
      assert.doesNotMatch(text, /\bopenSealed\b/, file);
    }
  });

  it('M5: the path token must itself be a question token, even when the signed body carries the same string', async () => {
    const r = relay();
    const phone = createFakePhone();
    const route = r.routes.get('POST /v1/questions/{token}/answer');
    // Six characters Crockford base32 never uses (I, L, O, U): only the path check refuses these.
    for (const token of ['I0O1LU', '7qd4km', '7QD4K', '7QD4KMX']) {
      await assert.rejects(route.handler({}, { deviceId: phone.deviceId, params: { token }, body: answerFor(phone, { token }) }), (err) => err.status === 400 && err.code === 'bad_token', token);
    }
    assert.strictEqual(r.rpcs.length, 0);
  });

  it('M5: GET /v1/questions lists only the active nodes of the device', async () => {
    const OTHER = 'kl-bbbbbbbbbbbbbbbb';
    const r = relay({ nodesForDevice: () => [{ node_id: NODE, state: 'active' }, { node_id: OTHER, state: 'revoked' }, { node_id: 'kl-cccccccccccccccc', state: 'pending' }] });
    const phone = createFakePhone();
    const node = testNodeIdentity({ key: 'web-01' });
    const ask = (token) => seal({ v: 1, type: 'kl.question.ask', node_id: node.nodeId, token }, node.signer);
    r.mailbox.put(NODE, ask('7QD4KM'), { to_device: phone.deviceId });
    r.mailbox.put(OTHER, ask('K7QD4M'), { to_device: phone.deviceId });
    r.mailbox.put('kl-cccccccccccccccc', ask('ABCDEF'), { to_device: phone.deviceId });
    const listed = await r.routes.get('GET /v1/questions').handler({}, { deviceId: phone.deviceId, params: {}, query: {}, body: null });
    assert.deepStrictEqual(listed.body.map((i) => i.node_id), [NODE]);
  });

  it('answers 502 node_offline when the node does not answer', async () => {
    const r = relay({ offline: true });
    const phone = createFakePhone();
    askFor(r, phone);
    await assert.rejects(r.routes.get('POST /v1/questions/{token}/answer').handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: answerFor(phone) }), (err) => err.status === 502 && err.code === 'node_offline');
  });

  it('forwards foreground pings as presence.foreground { deviceId, foreground, at } to each active node', async () => {
    const r = relay();
    const at = Date.parse('2026-09-25T14:00:00Z');
    const out = await r.routes.get('POST /v1/presence').handler({}, { deviceId: 'd-bbbbbbbbbbbbbbbb', params: {}, body: { foreground: true, at } });
    assert.deepStrictEqual(out.body, { ok: true, nodes: 1 });
    assert.deepStrictEqual(r.rpcs[0], { nodeId: 'kl-aaaaaaaaaaaaaaaa', method: 'presence.foreground', params: { deviceId: 'd-bbbbbbbbbbbbbbbb', foreground: true, at }, opts: { timeoutMs: 5000 } });

    // deviceId always comes from the device auth context, never the body.
    await r.routes.get('POST /v1/presence').handler({}, { deviceId: 'd-bbbbbbbbbbbbbbbb', params: {}, body: { foreground: false, at, deviceId: 'd-cccccccccccccccc' } });
    assert.deepStrictEqual(r.rpcs[1].params, { deviceId: 'd-bbbbbbbbbbbbbbbb', foreground: false, at });

    // A revoked pairing is not forwarded to.
    const none = await r.routes.get('POST /v1/presence').handler({}, { deviceId: 'd-revokedrevokedre', params: {}, body: { foreground: true, at } });
    assert.deepStrictEqual(none.body, { ok: true, nodes: 0 });
    assert.strictEqual(r.rpcs.length, 2);
  });

  it('refuses a presence ping whose foreground is not a boolean or whose at is not a finite number (400 malformed)', async () => {
    const r = relay();
    const route = r.routes.get('POST /v1/presence');
    const at = Date.parse('2026-09-25T14:00:00Z');
    const bad = [null, {}, [], { at }, { foreground: 'true', at }, { foreground: 1, at }, { foreground: null, at },
      { foreground: true }, { foreground: true, at: '2026-09-25T14:00:00Z' }, { foreground: true, at: NaN }, { foreground: true, at: Infinity }, { foreground: true, at: null }];
    for (const body of bad) {
      await assert.rejects(route.handler({}, { deviceId: 'd-bbbbbbbbbbbbbbbb', params: {}, body }), (err) => err.status === 400 && err.code === 'malformed', JSON.stringify(body));
    }
    assert.strictEqual(r.rpcs.length, 0);
  });
});

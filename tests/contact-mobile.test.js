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

async function world({ records = null } = {}) {
  const phone = createFakePhone({ name: 'Owner phone' });
  const stranger = createFakePhone({ name: 'Other phone' });
  const store = await approverStoreWith(records ? records(phone) : [phone.approverRecord()]);
  stores.push(store);
  const node = testNodeIdentity({ key: 'web-01' });
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
  const presence = new Presence({ file: path.join(data, 'contact', 'presence.json'), getPolicy: () => policy, clock, isEnabled: (c) => adapters.has(c) });
  const router = new ContactRouter({ state, runtime, adapters, presence, clock });
  const mobile = new MobileAppChannel({ link, approverStore: store, identity: node, getRouter: () => router, presence, clock });
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
  return { phone, stranger, store, node, runtime, router, mobile, link, info, q, q2, token, token2, answer, fg, call, ping, answerOf, presence, now, advance };
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

  function relay({ offline = false } = {}) {
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
    const devices = { nodesForDevice: (id) => [{ node_id: 'kl-aaaaaaaaaaaaaaaa', state: id === 'd-revokedrevokedre' ? 'revoked' : 'active' }] };
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

  it('registers the three device-authenticated routes with their rate limits and the kl.question. mailbox prefix', () => {
    const r = relay();
    assert.deepStrictEqual([...r.routes.keys()], ['GET /v1/questions', 'POST /v1/questions/{token}/answer', 'POST /v1/presence']);
    for (const spec of r.routes.values()) assert.strictEqual(spec.auth, 'device');
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

  it('refuses an answer with no matching mailbox entry, or from a device not active on the node, before any rpc', async () => {
    const r = relay();
    const phone = createFakePhone();
    askFor(r, phone);
    const answerRoute = r.routes.get('POST /v1/questions/{token}/answer');
    // A token this device was never sent.
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: 'K7QD4M' }, body: answerFor(phone, { token: 'K7QD4M' }) }), (err) => err.status === 404 && err.code === 'not_found');
    // A node the question did not come from.
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: answerFor(phone, { node_id: 'kl-bbbbbbbbbbbbbbbb' }) }), (err) => err.status === 404);
    // A question sent to another device.
    await assert.rejects(answerRoute.handler({}, { deviceId: 'd-dddddddddddddddd', params: { token: '7QD4KM' }, body: answerFor(phone, { device_id: 'd-dddddddddddddddd' }) }), (err) => err.status === 404);
    // A device whose pairing with the node is not active.
    await assert.rejects(answerRoute.handler({}, { deviceId: 'd-revokedrevokedre', params: { token: '7QD4KM' }, body: answerFor(phone, { device_id: 'd-revokedrevokedre' }) }), (err) => err.status === 404);
    // Not an answer type.
    await assert.rejects(answerRoute.handler({}, { deviceId: phone.deviceId, params: { token: '7QD4KM' }, body: answerFor(phone, { type: 'kl.question.ask' }) }), (err) => err.status === 400 && err.code === 'malformed');
    assert.strictEqual(r.rpcs.length, 0);
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

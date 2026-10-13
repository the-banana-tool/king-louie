// tests/contact-send-envelope.test.js
// C3 follow-up: ContactRouter.sendExternal to anyone but the owner goes out
// only under a stored, intact, active, owner-approved envelope that fits the
// send (envelopeFit) and names the channel, checked and counted through the
// executor registry (the counting is in contact-send-counting.test.js). The
// real gate, the real envelope flow and a loopback channel; no network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { LoopbackChannel } = require('./helpers/loopback-channel');
const { ContactRouter } = require('../src/cases/contact');
const { ContactState } = require('../src/cases/contact-state');
const { createContactHost } = require('../src/cases/contact-host');
const { EnvelopeStore } = require('../src/cases/executors');
const envelopeOps = require('../src/cases/executors/envelope-ops');
const gates = require('../src/cases/gates');

after(fx.cleanup);

const OWNER = '+15550100';
const BROKER = '+15550101';
const OTHER = '+15550102';

async function setup({ authority = 'envelope', approve = true, wire = true } = {}) {
  // A phone approver that never answers: a signed envelope stays ungranted.
  const env = fx.setupExecutors({ registryOptions: { getPhoneApprover: () => ({ requestAction: () => new Promise(() => {}) }) } });
  fx.withFakeAgent(env, 'fake-agent', { entry: { authority } });
  const rt = env.runtime;
  const reg = env.registry;
  const meta = await fx.activeCase(rt);
  const acres = rt.ledger(meta.id).assert({
    stmt: 'Lot size is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acres',
    provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/lot' }
  });
  const req = await envelopeOps.requestEnvelope(reg, { caseId: meta.id, turnId: 'turn-1' }, {
    executor: 'fake-agent', intent: 'Ask a broker for a listing quote', recipients: { allow: [BROKER] }, facts: [acres.id],
    caps: { usd: 10, contacts: 1, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' },
    channels: ['sms', 'loop-sms']
  });
  assert.strictEqual(req.ok, true, req.error);
  if (approve) {
    await rt.answerQuestion(meta.id, req.questionId, { channel: 'in-app', optionId: 'approve' });
    envelopeOps.syncEnvelopes(reg, meta.id);
  }
  const sms = new LoopbackChannel({ id: 'sms', owner: OWNER });
  const state = new ContactState({ dir: path.join(env.dataDir, 'contact'), clock: () => env.clock.now });
  const router = new ContactRouter({
    state, runtime: rt, adapters: new Map([['sms', sms]]), getGate: () => gates, clock: () => env.clock.now,
    reserveSend: (args) => reg.reserveChannelSend(args), settleSend: (reservation, outcome) => reg.settleChannelSend(reservation, outcome),
    ...(wire ? { checkEnvelope: (args) => envelopeOps.sendEnvelope(reg, args) } : {})
  });
  const send = (over = {}) => router.sendExternal({
    caseId: meta.id, channelId: 'sms', target: BROKER, text: `The lot is {{${acres.id}}}.`, envelopeId: req.envelopeId, executorId: 'fake-agent', ...over
  });
  const store = new EnvelopeStore(meta.dir);
  return { env, rt, reg, meta, acres, sms, router, send, store, envelopeId: req.envelopeId };
}

const refused = async (s, promise, pattern) => {
  const r = await promise;
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.match(r.error, pattern);
  assert.deepStrictEqual(s.sms.plain, [], 'nothing was sent');
};

describe('ContactRouter.sendExternal: a non-owner send needs an owner-approved envelope', () => {
  it('goes out under an active envelope that names the recipient; the owner needs none', async () => {
    const s = await setup();
    const r = await s.send();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(s.sms.plain, [{ target: BROKER, text: 'The lot is 2.12 acres.' }]);
    const owner = await s.router.sendExternal({ caseId: s.meta.id, channelId: 'sms', target: OWNER, text: 'A status line.' });
    assert.strictEqual(owner.ok, true, JSON.stringify(owner));
  });

  it('refuses with no envelope named, an unknown one, or no executor named', async () => {
    const s = await setup();
    await refused(s, s.send({ envelopeId: undefined }), /needs an owner-approved envelope/);
    await refused(s, s.send({ envelopeId: 'env-09' }), /env-09 was not found in this case/);
    await refused(s, s.send({ executorId: undefined }), /needs an owner-approved envelope.*no executor/);
    await refused(s, s.send({ executorId: 'no-such-agent' }), /unknown executor "no-such-agent"/);
  });

  it('a caller-built envelope object is never trusted', async () => {
    const s = await setup({ approve: false });
    const forged = { ...s.store.get(s.envelopeId), status: 'active' };
    await refused(s, s.send({ envelopeId: undefined, envelope: forged }), /needs an owner-approved envelope/);
    await refused(s, s.send({ envelope: forged }), /envelope env-01 is requested/);
  });

  it('refuses an envelope that is not active: requested, rejected, revoked', async () => {
    const pending = await setup({ approve: false });
    await refused(pending, pending.send(), /envelope env-01 is requested/);
    const s = await setup();
    await envelopeOps.revokeEnvelope(s.reg, s.meta.id, s.envelopeId);
    await refused(s, s.send(), /envelope env-01 is revoked/);
  });

  it('refuses an envelope edited since approval', async () => {
    const s = await setup();
    const env = s.store.get(s.envelopeId);
    env.recipients.allow.push(OTHER);
    s.store.write(env);
    await refused(s, s.send({ target: OTHER }), /changed since approval/);
  });

  it('refuses a recipient outside it, another executor, and a day outside its window', async () => {
    const s = await setup();
    await refused(s, s.send({ target: OTHER }), /outside envelope env-01: adds recipient \+15550102/);
    fx.withFakeAgent(s.env, 'other-agent');
    await refused(s, s.send({ executorId: 'other-agent' }), /envelope env-01 is for fake-agent, not other-agent/);
    s.env.clock.now = new Date('2026-11-02T15:00:00Z');
    await refused(s, s.send(), /outside envelope env-01: extends window end/);
  });

  it('a fact outside the envelope is still blocked by the gate, against the stored envelope', async () => {
    const s = await setup();
    const price = s.rt.ledger(s.meta.id).assert({
      stmt: 'The asking price is 240000', subject: 'lot', attr: 'asking price', value: 240000,
      provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/listing' }
    });
    const r = await s.send({ text: `We ask {{${price.id}}}.` });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.blocked.map((b) => b.reason), ['not-in-envelope']);
    assert.deepStrictEqual(s.sms.plain, []);
  });

  it('a signed envelope without its phone grant is refused', async () => {
    const s = await setup({ authority: 'signed', approve: false });
    // Even marked active on disk, with its hash intact: no verified grant.
    s.store.write({ ...s.store.get(s.envelopeId), status: 'active' });
    await refused(s, s.send(), /signed approval not found for this envelope/);
  });

  it('a router with no envelope check refuses every non-owner send', async () => {
    const s = await setup({ wire: false });
    await refused(s, s.send(), /no envelope check is available.*only the owner can be messaged/);
  });

  it('createContactHost wires the check from the executor registry', async () => {
    const s = await setup();
    const sms = new LoopbackChannel({ id: 'loop-sms', owner: 'owner-1' });
    const build = (extras) => createContactHost({
      getSettings: () => s.env.settings, caseRuntime: s.rt, dataDir: fx.tempDir('kl-host-env-'), features: { channels: true },
      extraAdapters: { 'loop-sms': sms }, tickMs: 60000, fetchImpl: async () => { throw new Error('offline in tests'); }, ...extras
    });
    const none = build({});
    const wired = build({ getExecutorRegistry: () => s.reg });
    try {
      await none.start();
      const args = { caseId: s.meta.id, channelId: 'loop-sms', target: BROKER, text: 'Is the lot still listed?', envelopeId: s.envelopeId, executorId: 'fake-agent' };
      const r0 = await none.context().router.sendExternal(args);
      assert.strictEqual(r0.ok, false);
      assert.match(r0.error, /no envelope check is available/);
      await none.stop();
      await wired.start();
      const { router } = wired.context();
      const noEnvelope = await router.sendExternal({ ...args, envelopeId: undefined });
      assert.strictEqual(noEnvelope.ok, false);
      assert.match(noEnvelope.error, /needs an owner-approved envelope/);
      const ok = await router.sendExternal(args);
      assert.strictEqual(ok.ok, true, JSON.stringify(ok));
      assert.deepStrictEqual(sms.plain, [{ target: BROKER, text: 'Is the lot still listed?' }]);
    } finally {
      await none.stop();
      await wired.stop();
    }
  });
});

// tests/cases-envelope-ops.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const ops = require('../src/cases/executors/envelope-ops');
const { EnvelopeStore, JobStore } = require('../src/cases/executors');
const { envelopeCore, envelopeHash } = require('../src/cases/executors/envelope');
const { approvalHelpers, signedAction } = require('../src/cases/executors/signed');

after(fx.cleanup);

async function setup({ authority = 'envelope', approver = null } = {}) {
  const env = fx.setupExecutors({ registryOptions: { getPhoneApprover: () => approver } });
  const ctl = fx.withFakeAgent(env, 'fake-agent', { entry: { authority } });
  const meta = await fx.activeCase(env.runtime);
  const fact = env.runtime.ledger(meta.id).assert({
    stmt: 'Lot size is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acres',
    provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/lot' }
  });
  return { env, ctl, meta, reg: env.registry, rt: env.runtime, factId: fact.id };
}
const body = (factId, over = {}) => ({
  executor: 'fake-agent', intent: 'Ask three brokers for a listing quote', recipients: { allow: ['+15550100', '+15550101'] },
  facts: [factId], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' }, ...over
});
const envelopeOf = (s, id = 'env-01') => new EnvelopeStore(s.meta.dir).get(id);
const journalText = (s) => fs.readdirSync(path.join(s.meta.dir, 'journal')).filter((n) => n.includes('-envelope'))
  .map((n) => fs.readFileSync(path.join(s.meta.dir, 'journal', n), 'utf8')).join('\n');
const rehash = (e) => ({ ...e, hash: envelopeHash(envelopeCore(e)) });

describe('requesting and approving', () => {
  it('writes a requested envelope and an approval question; an owner approve activates it', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id, turnId: 'turn-1' }, body(s.factId));
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual([r.envelopeId, r.status], ['env-01', 'requested']);
    const q = s.rt.questions(s.meta.id).get(r.questionId);
    assert.deepStrictEqual([q.kind, q.payload.type, q.payload.envelopeId, q.payload.hash, q.options.map((o) => o.id)], ['approval', 'envelope', 'env-01', r.hash, ['approve', 'reject']]);
    assert.match(q.text, /^Approve envelope env-01 for fake-agent in case "Lakeside lot"\?/);
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [], 'nothing changes before the answer');
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'active' }]);
    const e = envelopeOf(s);
    assert.deepStrictEqual([e.status, e.grantedBy.channel, e.grantedBy.questionId, e.grantedBy.evidence], ['active', 'in-app', r.questionId, null]);
    assert.match(e.grantedBy.factId, /^f-\d{4}$/);
  });

  it('a reject rejects it', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'reject' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    assert.strictEqual(envelopeOf(s).status, 'rejected');
  });

  it("approving env-01's question never activates env-02 (question bound to its envelope)", async () => {
    const s = await setup();
    const r1 = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const e2 = envelopeOf(s, 'env-02');
    assert.strictEqual(e2.hash, r1.hash, 'same core, same hash: only the envelope id tells them apart');
    e2.questionId = r1.questionId;
    new EnvelopeStore(s.meta.dir).write(e2);
    await s.rt.answerQuestion(s.meta.id, r1.questionId, { channel: 'in-app', optionId: 'approve' });
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'active' }]);
    assert.strictEqual(envelopeOf(s, 'env-02').status, 'requested');
    assert.match(journalText(s), /env-02: the owner approved a different version; request it again/);
  });

  it('a file edited and re-hashed after the question stays requested when approved', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const e = envelopeOf(s);
    e.caps.usd = 500;
    new EnvelopeStore(s.meta.dir).write(rehash(e));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), []);
    assert.strictEqual(envelopeOf(s).status, 'requested');
    ops.syncEnvelopes(s.reg, s.meta.id);
    const said = journalText(s).match(/approved a different version/g) || [];
    assert.strictEqual(said.length, 1, 'journaled once, not on every sync');
  });

  it('keeps the authority recorded at request time when the executor is later lowered', async () => {
    const s = await setup({ authority: 'signed', approver: { requestAction: () => new Promise(() => {}) } });
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    assert.strictEqual(envelopeOf(s).authority, 'signed');
    s.env.settings.executors.entries['fake-agent'].authority = 'envelope';
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    assert.strictEqual(envelopeOf(s).status, 'requested', 'an in-app answer never grants an envelope requested as signed');
    assert.strictEqual(ops.effectiveAuthority(s.reg, s.meta.id, envelopeOf(s)), 'signed');
  });

  it('an edited envelope turns tampered', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const e = envelopeOf(s);
    e.caps.usd = 500;
    new EnvelopeStore(s.meta.dir).write(e);
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'tampered' }]);
  });

  it('expires after the window and is exhausted at the usd cap', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const e = envelopeOf(s);
    e.usage.usd = 20;
    new EnvelopeStore(s.meta.dir).write(e);
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'exhausted' }]);
    const s2 = await setup();
    const r2 = await ops.requestEnvelope(s2.reg, { caseId: s2.meta.id }, body(s2.factId));
    await s2.rt.answerQuestion(s2.meta.id, r2.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s2.reg, s2.meta.id);
    s2.env.clock.now = new Date('2026-10-31T12:00:00Z');
    assert.deepStrictEqual(ops.syncEnvelopes(s2.reg, s2.meta.id), [{ envelopeId: 'env-01', status: 'expired' }]);
  });
});

describe('deltas', () => {
  it('asks once per set of differences and applies them on approve', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const deltas = [{ kind: 'recipient', value: '+15550102', text: 'adds recipient +15550102' }];
    const q1 = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), deltas);
    assert.strictEqual(ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), deltas), q1, 'reused while pending');
    const q = s.rt.questions(s.meta.id).get(q1);
    assert.deepStrictEqual([q.payload.type, q.payload.fromHash, q.payload.deltas], ['envelope-delta', r.hash, deltas]);
    assert.match(q.text, /\n- adds recipient \+15550102\n/);
    await s.rt.answerQuestion(s.meta.id, q1, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const e = envelopeOf(s);
    assert.deepStrictEqual([e.status, e.version, e.recipients.allow, e.pendingDelta], ['active', 2, ['+15550100', '+15550101', '+15550102'], null]);
    assert.notStrictEqual(e.hash, r.hash);
  });

  it('shows the owner the amount of a cap raise', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const qid = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), [{ kind: 'usd', value: 5000, text: 'raises usd cap' }]);
    assert.match(s.rt.questions(s.meta.id).get(qid).text, /- raises usd cap from \$20\.00 to \$5000\.00/);
  });

  it('a delta approved against a stale fromHash does not apply and is cleared', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const qid = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), [{ kind: 'usd', value: 30, text: 'raises usd cap' }]);
    const e = envelopeOf(s);
    e.caps.contacts = 5;
    new EnvelopeStore(s.meta.dir).write(rehash(e));
    await s.rt.answerQuestion(s.meta.id, qid, { channel: 'in-app', optionId: 'approve' });
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), []);
    const after = envelopeOf(s);
    assert.deepStrictEqual([after.caps.usd, after.version, after.pendingDelta], [20, 1, null]);
    assert.match(journalText(s), /env-01: the owner approved a different version; request it again/);
  });

  it("a delta approved for env-01 never changes env-02 (delta question bound to its envelope)", async () => {
    const s = await setup();
    const r1 = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const r2 = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r1.questionId, { channel: 'in-app', optionId: 'approve' });
    await s.rt.answerQuestion(s.meta.id, r2.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const qid = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), [{ kind: 'usd', value: 30, text: 'raises usd cap' }]);
    const store = new EnvelopeStore(s.meta.dir);
    const e2 = store.get('env-02');
    assert.strictEqual(e2.hash, envelopeOf(s).hash, 'same core, same hash: only the envelope id tells them apart');
    e2.pendingDelta = { ...envelopeOf(s).pendingDelta };
    store.write(e2);
    await s.rt.answerQuestion(s.meta.id, qid, { channel: 'in-app', optionId: 'approve' });
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'active' }]);
    assert.deepStrictEqual([envelopeOf(s, 'env-02').caps.usd, envelopeOf(s, 'env-02').version, envelopeOf(s, 'env-02').pendingDelta], [20, 1, null]);
  });

  it('applies only what the owner saw: a changed pending delta is not applied', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const shown = [{ kind: 'recipient', value: '+15550102', text: 'adds recipient +15550102' }];
    const qid = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), shown);
    const store = new EnvelopeStore(s.meta.dir);
    const e = store.get('env-01');
    e.pendingDelta.deltas = [{ kind: 'usd', value: 5000, text: 'raises usd cap' }];
    store.write(e);
    await s.rt.answerQuestion(s.meta.id, qid, { channel: 'in-app', optionId: 'approve' });
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), []);
    const after = envelopeOf(s);
    assert.deepStrictEqual([after.version, after.caps.usd, after.recipients.allow.length], [1, 20, 2]);
  });

  it('applies the deltas from the question payload, not from the file', async () => {
    const s = await setup();
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    const shown = [{ kind: 'usd', value: 30, text: 'raises usd cap' }];
    const qid = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s), shown);
    await s.rt.answerQuestion(s.meta.id, qid, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    assert.deepStrictEqual([envelopeOf(s).caps.usd, envelopeOf(s).deltas[0].deltas], [30, shown]);
  });

  it('a delta that cannot apply is skipped for that envelope only', async () => {
    const s = await setup();
    const r1 = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.rt.answerQuestion(s.meta.id, r1.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    // env-02 is still requested: applyDeltas refuses it and throws.
    const deltas = [{ kind: 'usd', value: 30, text: 'raises usd cap' }];
    const qid = ops.requestDelta(s.reg, s.meta.id, envelopeOf(s, 'env-02'), deltas);
    await s.rt.answerQuestion(s.meta.id, qid, { channel: 'in-app', optionId: 'approve' });
    const e1 = envelopeOf(s, 'env-01');
    e1.usage.usd = 20;
    new EnvelopeStore(s.meta.dir).write(e1);
    assert.deepStrictEqual(ops.syncEnvelopes(s.reg, s.meta.id), [{ envelopeId: 'env-01', status: 'exhausted' }]);
    assert.deepStrictEqual([envelopeOf(s, 'env-02').status, envelopeOf(s, 'env-02').version, envelopeOf(s, 'env-02').pendingDelta], ['requested', 1, null]);
    assert.match(journalText(s), /env-02: the approved change could not be applied/);
  });
});

describe('signed envelopes', () => {
  const helpers = approvalHelpers();
  const approverSaying = (decision) => ({
    calls: [],
    async requestAction(action, opts) {
      this.calls.push([action, opts]);
      return { decision, request_id: 'r-1', device_id: 'd-1', action_hash: helpers.actionHash(action), reason: null };
    }
  });

  it('refuses when no phone approver is enrolled, writing nothing', async () => {
    const s = await setup({ authority: 'signed' });
    assert.deepStrictEqual(await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId)), { ok: false, error: 'signed approval unavailable' });
    assert.deepStrictEqual(new EnvelopeStore(s.meta.dir).list(), []);
  });

  it('activates only from the phone Outcome; an in-app approve does not', async () => {
    const approver = approverSaying('approve');
    const s = await setup({ authority: 'signed', approver });
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await s.reg.lastSignedRequest;
    const [action, opts] = approver.calls[0];
    // Ruling M14: F3's origin type.
    assert.deepStrictEqual([action.kind, action.name, action.params.case_id, opts.origin], ['envelope', 'fake-agent', s.meta.id, { client: 'king-louie', session: s.meta.id, job_id: null }]);
    assert.deepStrictEqual(opts.currentAction(), action);
    const e = envelopeOf(s);
    assert.deepStrictEqual([e.status, e.grantedBy.channel, e.grantedBy.evidence], ['active', 'phone', { request_id: 'r-1', action_hash: helpers.actionHash(action) }]);
    assert.strictEqual(s.rt.questions(s.meta.id).get(r.questionId).answer.channel, 'phone');
    assert.strictEqual(ops.signedOutcomesFor(s.reg, s.meta.id, 'env-01').length, 1);

    const denying = approverSaying('deny');
    const d = await setup({ authority: 'signed', approver: denying });
    const rd = await ops.requestEnvelope(d.reg, { caseId: d.meta.id }, body(d.factId));
    await d.reg.lastSignedRequest;
    await d.rt.answerQuestion(d.meta.id, rd.questionId, { channel: 'in-app', optionId: 'approve' });
    ops.syncEnvelopes(d.reg, d.meta.id);
    assert.strictEqual(envelopeOf(d).status, 'requested');
  });

  // Final review minor 1: the in-app Reject of a signed envelope is not
  // dropped; it rejects the envelope and withdraws the phone request, so a
  // later phone approve cannot activate it.
  it('an in-app reject rejects a signed envelope and withdraws the phone request', async () => {
    let signal = null;
    let settle = null;
    const approver = {
      requestAction(action, opts) {
        signal = opts.signal;
        return new Promise((resolve) => {
          settle = () => resolve({ decision: 'approve', request_id: 'r-9', device_id: 'd-1', action_hash: helpers.actionHash(action), reason: null });
        });
      }
    };
    const s = await setup({ authority: 'signed', approver });
    const r = await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    assert.match(s.rt.questions(s.meta.id).get(r.questionId).text, /Approve this on your phone/);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'reject' });
    ops.syncEnvelopes(s.reg, s.meta.id);
    assert.deepStrictEqual([envelopeOf(s).status, signal.aborted], ['rejected', true]);
    settle();
    await s.reg.lastSignedRequest;
    assert.strictEqual(envelopeOf(s).status, 'rejected', 'a late phone approve does not activate it');
  });

  it('keeps a late grant in memory while the case is busy, then applies it', async () => {
    const approver = { requestAction: () => new Promise(() => {}) };
    const s = await setup({ authority: 'signed', approver });
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const real = s.rt.systemAction.bind(s.rt);
    s.rt.systemAction = async () => {
      const err = new Error('Case "Lakeside lot" is busy');
      err.name = 'CaseBusyError';
      throw err;
    };
    const outcome = { decision: 'approve', request_id: 'r-2', action_hash: helpers.actionHash(signedAction(envelopeOf(s), s.meta.id, helpers)), device_id: 'd-1' };
    assert.deepStrictEqual(await ops.applySignedOutcome(s.reg, s.meta.id, 'env-01', outcome), { applied: false, pending: true });
    s.rt.systemAction = real;
    await ops.applyPendingSignedGrants(s.reg, s.meta.id);
    assert.deepStrictEqual([envelopeOf(s).status, s.reg.pendingSignedGrants.size], ['active', 0]);
  });

  it('refuses an Outcome whose action hash is not the live envelope action (T10-hash)', async () => {
    const approver = { requestAction: () => new Promise(() => {}) };
    const s = await setup({ authority: 'signed', approver });
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const outcome = { decision: 'approve', request_id: 'r-3', action_hash: 'h', device_id: 'd-1' };
    assert.deepStrictEqual(await ops.applySignedOutcome(s.reg, s.meta.id, 'env-01', outcome), { applied: false, error: 'the phone approved a different action; request it again' });
    assert.deepStrictEqual([envelopeOf(s).status, ops.signedOutcomesFor(s.reg, s.meta.id, 'env-01')], ['requested', []]);
    // The pending path (busy case) checks it again at the turn start.
    s.reg.pendingSignedGrants.set(`${s.meta.id}/env-01`, outcome);
    await ops.applyPendingSignedGrants(s.reg, s.meta.id);
    assert.deepStrictEqual([envelopeOf(s).status, s.reg.pendingSignedGrants.size], ['requested', 0]);
  });

  it('refuses a request_id another envelope already used', async () => {
    const approver = { requestAction: () => new Promise(() => {}) };
    const s = await setup({ authority: 'signed', approver });
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const outcome = { decision: 'approve', request_id: 'r-7', action_hash: helpers.actionHash(signedAction(envelopeOf(s), s.meta.id, helpers)), device_id: 'd-1' };
    assert.deepStrictEqual(await ops.applySignedOutcome(s.reg, s.meta.id, 'env-01', outcome), { applied: true });
    const again = await ops.applySignedOutcome(s.reg, s.meta.id, 'env-02', { ...outcome });
    assert.strictEqual(again.applied, false);
    assert.match(again.error, /request r-7 already granted env-01/);
    assert.deepStrictEqual([envelopeOf(s, 'env-02').status, ops.signedOutcomesFor(s.reg, s.meta.id, 'env-02')], ['requested', []]);
  });

  it('passes the registry trust (approver store, node id and key) to the grant check', async () => {
    const store = { admin: true };
    const s = await setup({ authority: 'signed', approver: { requestAction: () => new Promise(() => {}) } });
    s.reg.getApprovalTrust = () => ({ approverStore: store, nodeId: 'kl-node', nodePublicKey: 'ab' });
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const o = ops.grantCheckOptions(s.reg, s.meta.id, 'env-01');
    assert.deepStrictEqual([o.approverStore, o.nodeId, o.nodePublicKey, o.caseId, o.outcomes, o.auditScanEntries], [store, 'kl-node', 'ab', s.meta.id, [], 5000]);
    // Without the trust the audit path fails closed; no outcome, no grant.
    s.reg.getApprovalTrust = () => null;
    assert.deepStrictEqual(ops.verifyEnvelopeGrant(s.reg, s.meta.id, envelopeOf(s)), { ok: false, error: 'signed approval not found for this envelope; ask again' });
  });
});

describe('revoke', () => {
  it('revokes the envelope and cancels its open jobs', async () => {
    const s = await setup();
    await ops.requestEnvelope(s.reg, { caseId: s.meta.id }, body(s.factId));
    const job = new JobStore(s.meta.dir).create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', envelopeId: 'env-01', state: 'submitted', externalId: 'ext-9' });
    s.ctl.jobs.set('ext-9', { state: 'running', contacts: [] });
    assert.deepStrictEqual(await s.reg.revokeEnvelope(s.meta.id, 'env-01', 'the owner changed their mind'), { ok: true, cancelled: [job.id] });
    assert.strictEqual(envelopeOf(s).status, 'revoked');
    assert.strictEqual(new JobStore(s.meta.dir).get(job.id).state, 'cancelled');
    const journal = fs.readdirSync(path.join(s.meta.dir, 'journal')).filter((n) => n.includes('-envelope'));
    assert.ok(journal.length >= 2);
  });
});

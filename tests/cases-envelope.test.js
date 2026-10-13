// tests/cases-envelope.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EnvelopeStore, envelopeCore, envelopeHash, validateEnvelopeRequest, renderEnvelopeQuestion,
  envelopeFit, applyDeltas, renderDeltaQuestion, deltasEqual, envelopeIntact, renderSignedSummary
} = require('../src/cases/executors/envelope');
const { verifySignedGrant, signedAction, approvalHelpers } = require('../src/cases/executors/signed');
const { buildRequest } = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { windowInstants } = require('../src/cases/executors/util');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fact(id, over = {}) {
  return {
    id, stmt: over.stmt || `Fact ${id}`, subject: 'lot', attr: id, value: null, unit: null,
    provenance: 'sourced', category: null, disclosable: true, status: 'active', supersededBy: null, ...over
  };
}
const facts = (...list) => new Map(list.map((f) => [f.id, f]));
const ACRES = fact('f-0001', { value: 2.12, unit: 'acres', stmt: 'Lot size is 2.12 acres' });
const ZONING = fact('f-0003', { value: 'R-1', stmt: 'Zoned R-1' });
const GUESS = fact('f-0004', { value: 'owner may sell low', provenance: 'inferred', disclosable: false });
const FLOOR = fact('f-0005', { value: 1250000, unit: 'USD', provenance: 'user', category: 'financial', disclosable: false });
const PHONE_AGENT = {
  id: 'phone-agent', kind: 'external-agent', capabilities: ['call', 'voicemail'], authority: 'envelope',
  constraints: { contactsPerDay: 5, callingWindow: { tz: 'America/Chicago', start: '09:00', end: '17:00', weekdays: [1, 2, 3, 4, 5] } }
};
const request = (over = {}) => ({
  intent: 'Ask three brokers for a listing quote on the lot',
  recipients: { allow: ['+1 555 0100', '+15550101'] },
  facts: ['f-0001'],
  rules: ["Say the owner's first name only"],
  caps: { usd: 20, contacts: 3, attemptsPerContact: 2 },
  window: { start: '2026-10-26', end: '2026-10-30' },
  ...over
});
function activeEnvelope(over = {}) {
  const env = {
    id: 'env-01', version: 1, status: 'active', authority: 'envelope', executor: 'phone-agent',
    intent: 'Ask three brokers for a listing quote on the lot',
    recipients: { allow: ['+15550100', '+15550101'], addRequiresApproval: true },
    facts: ['f-0001'], rules: [], caps: { usd: 20, contacts: 3, attemptsPerContact: 2 },
    window: { start: '2026-10-26', end: '2026-10-30', tz: 'America/Chicago' },
    usage: { usd: 0, contacts: [], attempts: {} }, payloads: [], deltas: [], grantedBy: null, ...over
  };
  env.hash = envelopeHash(envelopeCore(env));
  return env;
}
const MONDAY_NOON = new Date('2026-10-26T17:00:00Z');

describe('EnvelopeStore', () => {
  it('numbers envelopes by replay and lists them in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-env-'));
    dirs.push(dir);
    const store = new EnvelopeStore(dir);
    assert.strictEqual(store.nextId(), 'env-01');
    store.write(activeEnvelope({ id: 'env-09' }));
    store.write(activeEnvelope({ id: 'env-10' }));
    assert.strictEqual(store.nextId(), 'env-11');
    assert.deepStrictEqual(store.list().map((e) => e.id), ['env-09', 'env-10']);
    assert.strictEqual(store.get('../x'), null);
  });
});

describe('envelope hash', () => {
  it('covers the core only and is stable under key order', () => {
    const a = activeEnvelope();
    const b = activeEnvelope({ usage: { usd: 5, contacts: ['+15550100'], attempts: {} } });
    assert.strictEqual(a.hash, b.hash);
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
    assert.notStrictEqual(envelopeHash(envelopeCore({ ...a, caps: { ...a.caps, usd: 21 } })), a.hash);
  });
});

describe('validateEnvelopeRequest', () => {
  const ctx = { entry: PHONE_AGENT, facts: facts(ACRES, GUESS, FLOOR), casesTimeZone: 'UTC' };

  it('normalizes recipients and takes the executor\'s zone by default', () => {
    const r = validateEnvelopeRequest(request(), ctx);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.core.recipients.allow, ['+15550100', '+15550101']);
    assert.strictEqual(r.core.window.tz, 'America/Chicago');
    assert.strictEqual(r.core.executor, 'phone-agent');
    const utc = validateEnvelopeRequest(request(), { ...ctx, entry: { ...PHONE_AGENT, constraints: {} } });
    assert.strictEqual(utc.core.window.tz, 'UTC');
  });

  it('refuses facts that may not leave, naming each', () => {
    const r = validateEnvelopeRequest(request({ facts: ['f-0001', 'f-0004', 'f-0005', 'f-0099'] }), ctx);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /f-0004 is inferred/);
    assert.match(r.error, /f-0005 is not disclosable/);
    assert.match(r.error, /f-0099 does not exist/);
  });

  it('refuses an executor without authority, a window past the deadline, and caps over the daily limit', () => {
    assert.match(validateEnvelopeRequest(request(), { ...ctx, entry: { ...PHONE_AGENT, authority: 'none' } }).error, /does not take envelopes/);
    assert.match(validateEnvelopeRequest(request(), { ...ctx, deadline: '2026-10-28' }).error, /window ends 2026-10-30, after the deadline 2026-10-28/);
    assert.match(validateEnvelopeRequest(request({ caps: { usd: 20, contacts: 30, attemptsPerContact: 2 } }), ctx).error, /caps.contacts 30 is more than 5\/day × 5 window days/);
    assert.match(validateEnvelopeRequest(request({ recipients: { allow: ['555-0100'] } }), ctx).error, /E\.164/);
  });

  it('refuses intent text that pastes a private value', () => {
    const r = validateEnvelopeRequest(request({ intent: 'Tell them we will not go under 1,250,000' }), ctx);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /non-disclosable f-0005/);
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason, b.factId]), [['intent', 'non-disclosable', 'f-0005']]);
  });

  it('envelope intent with an invented date is flagged in the approval text', () => {
    const r = validateEnvelopeRequest(request({ intent: 'Tell brokers offers are due by Friday November 14' }), ctx);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.notBacked.map((n) => [n.path, n.text]), [['intent', 'due by'], ['intent', 'Friday November 14']]);
    const env = { id: 'env-02', ...r.core };
    const text = renderEnvelopeQuestion(env, { facts: ctx.facts, caseTitle: 'Lakeside lot', notBacked: r.notBacked });
    assert.match(text, /^Approve envelope env-02 for phone-agent\?\n/);
    assert.match(text, /\nCase: Lakeside lot$/);
    assert.match(text, /\nFact f-0001: Lot size is 2\.12 acres = 2\.12 acres\n/);
    assert.match(text, /\nNot backed by a fact: "due by" \(.*\)\nNot backed by a fact: "Friday November 14" \(.*\)\n/);
    assert.match(text, /Caps: \$20\.00 total, 3 contacts, 2 attempts per contact/);
  });
});

describe('envelopeFit', () => {
  const all = facts(ACRES, ZONING, GUESS);
  const fitOpts = (over = {}) => ({ facts: all, recipients: ['+15550100'], now: MONDAY_NOON, estimateUsd: 2, executorId: 'phone-agent', ...over });

  it('fits a payload inside the envelope', () => {
    assert.deepStrictEqual(envelopeFit(activeEnvelope(), { attemptsPerContact: 1 }, fitOpts()), { fits: true, refusals: [], deltas: [] });
  });

  it('names only the differences as deltas', () => {
    const r = envelopeFit(activeEnvelope(), { facts: ['f-0003'], attemptsPerContact: 1 }, fitOpts({ recipients: ['+15550100', '+15550102'] }));
    assert.deepStrictEqual(r.deltas.map((d) => d.text), ['adds recipient +15550102', 'discloses f-0003 "Zoned R-1"']);
    assert.strictEqual(r.fits, false);
  });

  it('refuses an inferred fact, a wrong executor and an envelope that is not approved', () => {
    assert.deepStrictEqual(envelopeFit(activeEnvelope(), { facts: ['f-0004'] }, fitOpts()).refusals, ['f-0004 cannot be disclosed (inferred)']);
    assert.deepStrictEqual(envelopeFit(activeEnvelope(), {}, fitOpts({ executorId: 'browser' })).refusals, ['envelope env-01 is for phone-agent, not browser']);
    assert.deepStrictEqual(envelopeFit(activeEnvelope({ status: 'requested' }), {}, fitOpts()).refusals, ['envelope env-01 is requested']);
  });

  it('counts the gate\'s not-in-envelope blocks as disclosures', () => {
    const r = envelopeFit(activeEnvelope(), {}, fitOpts({ gateBlocked: [{ reason: 'not-in-envelope', factId: 'f-0003' }] }));
    assert.deepStrictEqual(r.deltas.map((d) => d.kind), ['fact']);
  });

  it('raises the usd and contacts caps as deltas', () => {
    const env = activeEnvelope({ usage: { usd: 19, contacts: ['+15550100', '+15550101', '+15550103'], attempts: {} } });
    const r = envelopeFit(env, {}, fitOpts({ recipients: ['+15550101'], estimateUsd: 2 }));
    assert.deepStrictEqual(r.deltas.map((d) => [d.kind, d.value, d.text]), [['usd', 21, 'raises usd cap from $20.00 to $21.00']]);
    const more = envelopeFit(activeEnvelope({ caps: { usd: 20, contacts: 1, attemptsPerContact: 2 } }), {}, fitOpts({ recipients: ['+15550100', '+15550101'] }));
    assert.deepStrictEqual(more.deltas.map((d) => [d.kind, d.value, d.text]), [['contacts', 2, 'raises contacts cap from 1 to 2']]);
  });

  it('attempts cap counts payload attempts', () => {
    const env = activeEnvelope({ usage: { usd: 0, contacts: ['+15550100'], attempts: { '+15550100': 1 } } });
    assert.deepStrictEqual(envelopeFit(env, { attemptsPerContact: 1 }, fitOpts()).deltas, []);
    const r = envelopeFit(env, { attemptsPerContact: 2 }, fitOpts());
    assert.deepStrictEqual(r.deltas.map((d) => [d.text, d.value]), [['raises attempts per contact from 2 to 3', 3]]);
  });

  it('window is local calendar days across DST', () => {
    const env = activeEnvelope({ window: { start: '2026-10-30', end: '2026-11-01', tz: 'America/Chicago' } });
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ now: new Date('2026-11-02T05:30:00Z') })).deltas, []);
    const late = envelopeFit(env, {}, fitOpts({ now: new Date('2026-11-02T06:30:00Z') }));
    assert.deepStrictEqual(late.deltas.map((d) => d.text), ['extends window end from 2026-11-01 to 2026-11-02']);
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ now: new Date('2026-10-30T04:30:00Z') })).refusals, ['envelope env-01 opens 2026-10-30']);
    assert.strictEqual(windowInstants('2026-10-30', '2026-11-01', 'America/Chicago').notAfter, '2026-11-02T05:59:59Z');
  });

  it('exhausted envelope takes a delta', () => {
    const env = activeEnvelope({ status: 'exhausted', caps: { usd: 20, contacts: 2, attemptsPerContact: 2 }, usage: { usd: 3, contacts: ['+15550100', '+15550101'], attempts: {} } });
    const r = envelopeFit(env, {}, fitOpts({ recipients: ['+15550100'], estimateUsd: 0 }));
    assert.deepStrictEqual(r.deltas.map((d) => [d.kind, d.value]), [['contacts', 3]]);
    const next = applyDeltas(env, r.deltas, { questionId: 'q-0003', factId: 'f-0010', at: '2026-10-26T17:05:00Z' });
    assert.deepStrictEqual([next.status, next.version, next.caps.contacts], ['active', 2, 3]);
    assert.notStrictEqual(next.hash, env.hash);
    assert.deepStrictEqual(next.deltas, [{ questionId: 'q-0003', deltas: r.deltas, at: '2026-10-26T17:05:00Z', factId: 'f-0010' }]);
    assert.strictEqual(env.status, 'exhausted', 'applyDeltas does not mutate its input');
  });

  it('renders a delta question naming only the differences and compares deltas canonically', () => {
    const deltas = [{ kind: 'recipient', value: '+15550102', text: 'adds recipient +15550102' }];
    const text = renderDeltaQuestion(activeEnvelope(), deltas);
    assert.match(text, /^Envelope env-01 \(phone-agent\) needs your approval for:\n- adds recipient \+15550102/);
    assert.strictEqual(deltasEqual(deltas, [{ text: 'adds recipient +15550102', value: '+15550102', kind: 'recipient' }]), true);
  });

  it("the owner sees every change with its amount, never the caller's wording", () => {
    const deltas = [
      { kind: 'usd', value: 5000, text: 'raises usd cap' },
      { kind: 'contacts', value: 10, text: 'a small change' },
      { kind: 'attempts', value: 3, text: 'raises attempts per contact' },
      { kind: 'window', value: '2026-11-06', text: 'x' },
      { kind: 'fact', value: 'f-0003', text: 'discloses nothing much' },
      { kind: 'recipient', value: '+15550102', text: 'y' }
    ];
    const text = renderDeltaQuestion(activeEnvelope(), deltas, { facts: all });
    assert.deepStrictEqual(text.split('\n').slice(1, 7), [
      '- raises usd cap from $20.00 to $5000.00',
      '- raises contacts cap from 3 to 10',
      '- raises attempts per contact from 2 to 3',
      '- extends window end from 2026-10-30 to 2026-11-06',
      '- discloses f-0003 "Zoned R-1"',
      '- adds recipient +15550102'
    ]);
    assert.doesNotMatch(text, /a small change|discloses nothing much/);
  });
});

describe('envelope core and fit inputs (review fixes)', () => {
  const all = facts(ACRES, ZONING, GUESS);
  const fitOpts = (over = {}) => ({ facts: all, recipients: ['+15550100'], now: MONDAY_NOON, estimateUsd: 2, executorId: 'phone-agent', ...over });

  it('envelopeCore rejects a missing or non-finite cap instead of reading it as 0', () => {
    const env = activeEnvelope();
    for (const usd of [undefined, null, NaN, Infinity, '20', -1]) {
      assert.throws(() => envelopeCore({ ...env, caps: { ...env.caps, usd } }), /caps\.usd/);
    }
    assert.throws(() => envelopeCore({ ...env, caps: { usd: 20, contacts: 3 } }), /caps\.attemptsPerContact/);
  });

  it('fit checks the core: a deleted usd cap is refused, not unlimited', () => {
    const env = activeEnvelope();
    delete env.caps.usd;
    const r = envelopeFit(env, {}, fitOpts({ estimateUsd: 5000 }));
    assert.strictEqual(r.fits, false);
    assert.match(r.refusals.join('; '), /envelope env-01 is malformed: .*caps\.usd/);
  });

  it('fit refuses an envelope whose core no longer matches its hash', () => {
    const env = activeEnvelope();
    env.caps.usd = 500;
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts()), { fits: false, refusals: ['envelope env-01 changed since approval; request it again'], deltas: [] });
  });

  it('refuses a missing executor, no recipients, bad attempts and a bad estimate', () => {
    const env = activeEnvelope();
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ executorId: null })).refusals, ['no executor named for the fit']);
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ recipients: [] })).refusals, ['the job names no recipients']);
    for (const a of [0, -1, 1.5, '2', null, NaN]) {
      assert.deepStrictEqual(envelopeFit(env, { attemptsPerContact: a }, fitOpts()).refusals, ['attemptsPerContact must be a positive integer'], String(a));
    }
    for (const e of [-1, NaN, Infinity, '2', null]) {
      assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ estimateUsd: e })).refusals, ['estimateUsd must be a finite number ≥ 0'], String(e));
    }
    assert.strictEqual(envelopeFit(env, {}, fitOpts()).fits, true, 'attemptsPerContact undefined defaults to 1');
  });

  it('a fact already in the envelope is still checked for active and disclosable', () => {
    const env = activeEnvelope();
    const nowPrivate = facts({ ...ACRES, disclosable: false }, ZONING);
    assert.deepStrictEqual(envelopeFit(env, { facts: ['f-0001'] }, fitOpts({ facts: nowPrivate })).refusals, ['f-0001 cannot be disclosed (not disclosable)']);
    const retracted = facts({ ...ACRES, status: 'retracted' }, ZONING);
    assert.deepStrictEqual(envelopeFit(env, { facts: ['f-0001'] }, fitOpts({ facts: retracted })).refusals, ['f-0001 cannot be disclosed (retracted)']);
  });

  it('applyDeltas never revives an envelope outside the fittable statuses', () => {
    const deltas = [{ kind: 'contacts', value: 4, text: 'raises contacts cap' }];
    for (const status of ['revoked', 'rejected', 'tampered', 'requested']) {
      assert.throws(() => applyDeltas(activeEnvelope({ status }), deltas, {}), new RegExp(`envelope env-01 is ${status}`));
    }
  });
});

describe('signed grants', () => {
  const REQ = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const OTHER_REQ = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const env = activeEnvelope({
    status: 'active',
    grantedBy: { channel: 'phone', at: '2026-10-26T17:00:00Z', questionId: 'q-0002', evidence: { request_id: REQ, action_hash: 'forged' } }
  });
  const helpers = approvalHelpers();
  const hash = helpers.actionHash(signedAction(env, 'case-1', helpers));
  const ledger = (entries, ok = true) => ({ verify: () => ({ ok }), tail: (n) => entries.slice(-n) });
  const node = testNodeIdentity();
  const phone = createFakePhone({ name: 'Owner phone' });
  const stranger = createFakePhone({ name: 'Unknown phone' });
  let store;
  before(async () => { store = await approverStoreWith([phone.approverRecord()]); });
  after(() => { if (store) store.cleanup(); });
  const trust = () => ({ approverStore: store, nodeId: node.nodeId, nodePublicKey: node.publicKey });
  const origin = { client: 'king-louie', session: 'case-1', job_id: null };
  const request = ({ action = signedAction(env, 'case-1', helpers), requestId = REQ, identity = node } = {}) => buildRequest({ identity, action, origin, requestId });
  const approved = (requestId = REQ) => ({ request_id: requestId, state: 'approved', reason: null, job_id: null });
  // F3 phone-approver.js: approval.request (node-signed), approval.response
  // (the phone-signed envelope, audited before the post-audit re-checks),
  // then approval.outcome from _finish, the final decision (M13).
  function audit({ req = request(), response = (r) => phone.respond(r.envelope, 'approve'), outcomes = [approved()] } = {}) {
    return [
      { kind: 'approval.request', data: { job_id: null, envelope: req.envelope } },
      { kind: 'approval.response', data: { request_id: req.message.request_id, device_id: phone.deviceId, decision: 'approve', envelope: response(req), job_id: null } },
      ...outcomes.map((data) => ({ kind: 'approval.outcome', data }))
    ];
  }
  const check = (entries, over = {}) => verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries), ...trust(), ...over });
  const NOT_FOUND = { ok: false, error: 'signed approval not found for this envelope; ask again' };

  it('uses F3 envelopeAction and actionHash now that F3 has merged', () => {
    const messages = require('../src/approvals/messages');
    assert.strictEqual(helpers.envelopeAction, messages.envelopeAction);
    assert.strictEqual(helpers.actionHash, messages.actionHash);
  });

  it('builds the F3 envelope action, naming the envelope id in the signed summary', () => {
    const action = signedAction(env, 'case-1', helpers);
    assert.deepStrictEqual([action.kind, action.name, action.params], ['envelope', 'phone-agent', { case_id: 'case-1', envelope_hash: env.hash }]);
    assert.match(action.summary, /^env-01 · phone-agent: /);
  });

  it('two envelopes with the same core are different signed actions', () => {
    const other = { ...env, id: 'env-02' };
    assert.strictEqual(other.hash, env.hash);
    assert.notStrictEqual(helpers.actionHash(signedAction(other, 'case-1', helpers)), hash);
    assert.strictEqual(verifySignedGrant(other, { caseId: 'case-1', outcomes: [{ decision: 'approve', action_hash: hash }] }).ok, false, 'the env-01 approval does not activate env-02');
  });

  it('signed grant file forgery', () => {
    assert.deepStrictEqual(verifySignedGrant(env, { caseId: 'case-1', outcomes: [], auditLedger: ledger([]), ...trust() }), NOT_FOUND);
  });

  it('accepts an approve Outcome held in memory for the exact action', () => {
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', outcomes: [{ decision: 'approve', action_hash: hash }] }).via, 'memory');
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', outcomes: [{ decision: 'deny', action_hash: hash }] }).ok, false);
  });

  it('accepts a verified audit ledger holding the signed request, the signed approval and an approved outcome', () => {
    assert.deepStrictEqual(check(audit()), { ok: true, via: 'audit' });
    assert.deepStrictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(audit(), false), ...trust() }), NOT_FOUND, 'a broken chain proves nothing');
  });

  it('refuses without the approver store or the node key (fails closed)', () => {
    assert.deepStrictEqual(check(audit(), { approverStore: null }), NOT_FOUND);
    assert.deepStrictEqual(check(audit(), { nodePublicKey: null }), NOT_FOUND);
    assert.deepStrictEqual(check(audit(), { nodeId: null }), NOT_FOUND);
    assert.deepStrictEqual(check(audit(), { nodePublicKey: testNodeIdentity().publicKey }), NOT_FOUND, 'a key that is not this node');
  });

  it('refuses a forged, unsigned response', () => {
    const badSig = (r) => ({ ...phone.respond(r.envelope, 'approve'), sig: Buffer.alloc(64).toString('base64url') });
    assert.deepStrictEqual(check(audit({ response: badSig })), NOT_FOUND);
    const plain = (r) => ({
      alg: 'ES256', kid: phone.deviceId,
      payload: Buffer.from(JSON.stringify({ request_id: r.message.request_id, action_hash: hash, decision: 'approve' })).toString('base64url'),
      sig: 'x'
    });
    assert.deepStrictEqual(check(audit({ response: plain })), NOT_FOUND);
  });

  it('refuses a response signed by a device that is not an enrolled approver', () => {
    assert.deepStrictEqual(check(audit({ response: (r) => stranger.respond(r.envelope, 'approve') })), NOT_FOUND);
  });

  it('refuses a valid signed response for another request or another hash', () => {
    const other = request({ requestId: OTHER_REQ });
    assert.deepStrictEqual(check(audit({ response: () => phone.respond(other.envelope, 'approve') })), NOT_FOUND);
    const otherHash = helpers.actionHash({ ...signedAction(env, 'case-1', helpers), summary: 'something else' });
    assert.deepStrictEqual(check(audit({ response: (r) => phone.respond(r.envelope, 'approve', { overrides: { action_hash: otherHash } }) })), NOT_FOUND);
  });

  it('refuses a signed request for another action or signed by another node', () => {
    const otherAction = request({ action: signedAction({ ...env, id: 'env-02' }, 'case-1', helpers) });
    assert.deepStrictEqual(check(audit({ req: otherAction })), NOT_FOUND);
    const impostor = testNodeIdentity();
    const forgedNode = request({ identity: { ...impostor, nodeId: node.nodeId } });
    assert.deepStrictEqual(check(audit({ req: forgedNode })), NOT_FOUND);
  });

  it('refuses a signed deny, even with an approved outcome', () => {
    assert.deepStrictEqual(check(audit({ response: (r) => phone.respond(r.envelope, 'deny') })), NOT_FOUND);
  });

  it('refuses an audited approval that F3 then refused', () => {
    assert.deepStrictEqual(check(audit({ outcomes: [{ request_id: REQ, state: 'refused', reason: 'action_changed', job_id: null }] })), NOT_FOUND);
  });

  it('refuses an audited approval with no outcome (fails closed)', () => {
    assert.deepStrictEqual(check(audit({ outcomes: [] })), NOT_FOUND);
  });

  it('refuses when any outcome for the request is not approved, or the outcome is for another request', () => {
    assert.deepStrictEqual(check(audit({ outcomes: [approved(), { request_id: REQ, state: 'expired', reason: null, job_id: null }] })), NOT_FOUND);
    assert.deepStrictEqual(check(audit({ outcomes: [approved(OTHER_REQ)] })), NOT_FOUND);
  });

  it('refuses a tampered envelope before anything else', () => {
    const tampered = { ...env, caps: { ...env.caps, usd: 500 } };
    assert.deepStrictEqual(verifySignedGrant(tampered, { caseId: 'case-1', outcomes: [{ decision: 'approve', action_hash: hash }] }), {
      ok: false, error: 'envelope changed since approval; request it again'
    });
  });

  it('returns a refusal, never throws, for a malformed envelope or a failing hash step', () => {
    const broken = { ...env, caps: { contacts: 3, attemptsPerContact: 2 } };
    assert.deepStrictEqual(verifySignedGrant(broken, { caseId: 'case-1', outcomes: [] }), { ok: false, error: 'envelope changed since approval; request it again' });
    const throwing = { envelopeAction: () => { throw new Error('non_canonical'); }, actionHash: () => 'x' };
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', helpers: throwing }).ok, false);
  });
});

// Owner decision 2026-10-12: a channel send (ContactRouter.sendExternal) to
// anyone but the owner needs the channel named in the envelope the owner
// approved. The list is part of the hash only when the envelope has one.
describe('envelope channels', () => {
  const ctx = { entry: PHONE_AGENT, facts: facts(ACRES, GUESS, FLOOR), casesTimeZone: 'UTC' };
  const all = facts(ACRES, ZONING, GUESS);
  const fitOpts = (over = {}) => ({ facts: all, recipients: ['+15550100'], now: MONDAY_NOON, estimateUsd: 0, executorId: 'phone-agent', ...over });

  it('an envelope without the field hashes, and signs, exactly as before the field existed', () => {
    const env = activeEnvelope();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(envelopeCore(env), 'channels'), false);
    assert.strictEqual(env.hash, 'sha256:799c5609c37ab744f5e3d12bcdcedc9b5217bea84dd51fef94c47f6730fc2cd4');
    const helpers = approvalHelpers();
    assert.strictEqual(helpers.actionHash(signedAction(env, 'case-1', helpers)), 'nMFe7-TqOTDjlx-qScVdU6b7saTAnfNf_gtMDPzcHeE');
    const signed = activeEnvelope({ authority: 'signed' });
    assert.strictEqual(signed.hash, 'sha256:2d6e6e1f8b9a33ee62b4f3754dbea387e4898ce3ad14c61e2b10224179d2d2df');
    assert.strictEqual(helpers.actionHash(signedAction(signed, 'case-1', helpers)), 'WSxjVkGcPoVh7TNlYn_sF_IGWPCQqPCFAFJz6_L8bR8');
    assert.strictEqual(
      renderSignedSummary(envelopeCore(env), env.id),
      'env-01 · phone-agent: Ask three brokers for a listing quote on the lot (2 recipients, $20.00, 2026-10-26 to 2026-10-30)'
    );
  });

  it('the list is inside the hash: adding, removing or changing it on disk breaks the envelope', () => {
    const plain = activeEnvelope();
    const sms = activeEnvelope({ channels: ['sms'] });
    assert.deepStrictEqual(envelopeCore(sms).channels, ['sms']);
    assert.notStrictEqual(sms.hash, plain.hash);
    assert.notStrictEqual(activeEnvelope({ channels: ['sms', 'voice'] }).hash, sms.hash);
    assert.strictEqual(envelopeIntact(sms), true);
    assert.strictEqual(envelopeIntact({ ...plain, channels: ['sms'] }), false, 'a channel added to an approved envelope');
    assert.strictEqual(envelopeIntact({ ...sms, channels: ['sms', 'email'] }), false);
    const { channels, ...stripped } = sms;
    assert.strictEqual(envelopeIntact(stripped), false);
    // A list that is not a clean list of channel ids is malformed, never "no list".
    for (const bad of [null, 'sms', [42], ['SMS'], ['call'], ['sms', 'sms'], [''], ['a b'], { sms: true }]) {
      assert.throws(() => envelopeCore({ ...plain, channels: bad }), /channels/, JSON.stringify(bad));
      assert.strictEqual(envelopeIntact({ ...plain, channels: bad }), false, JSON.stringify(bad));
    }
  });

  it('a request names channels explicitly; call means voice; none asked, none allowed', () => {
    // A new request always stores the list, empty when none is asked, so it
    // gets the host-first phone summary; a stored envelope without the key
    // (activeEnvelope()) is what allows none by having none.
    const none = validateEnvelopeRequest(request(), ctx);
    assert.deepStrictEqual(none.core.channels, []);
    assert.deepStrictEqual(validateEnvelopeRequest(request({ channels: [] }), ctx).core.channels, []);
    const r = validateEnvelopeRequest(request({ channels: ['SMS', ' call ', 'voice', 'sms'] }), ctx);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.core.channels, ['sms', 'voice']);
    for (const bad of ['sms', null, [42], ['a b'], ['sms', '../x'], [{}]]) {
      const refused = validateEnvelopeRequest(request({ channels: bad }), ctx);
      assert.strictEqual(refused.ok, false, JSON.stringify(bad));
      assert.match(refused.error, /"channels"/);
    }
  });

  it('the owner sees the channels in the approval question and on the phone; an envelope without them reads as before', () => {
    const plain = activeEnvelope();
    const env = activeEnvelope({ channels: ['sms', 'voice'] });
    const text = renderEnvelopeQuestion(env, { facts: all });
    assert.match(text, /\nChannel sends allowed: sms, voice\nRecipients \(2\): \+15550100, \+15550101\n/);
    assert.doesNotMatch(renderEnvelopeQuestion(plain, { facts: all }), /Channel sends/);
    const summary = renderSignedSummary(envelopeCore(env), env.id);
    assert.strictEqual(summary, 'env-01 · phone-agent · 2 recipients · $20.00 cap · 3 contacts · 2 attempts each · 2026-10-26 to 2026-10-30 · channel sends: sms, voice · intent: Ask three brokers for a listing quote on the lot');
    // Before the intent, so F3's 300-character cut never drops it.
    const long = renderSignedSummary(envelopeCore(activeEnvelope({ channels: ['sms'], intent: 'x'.repeat(500) })), 'env-01');
    assert.ok(long.indexOf('channel sends: sms') < 130);
  });

  it('fit: a channel send needs its channel in the list; a job (no channel) is unaffected', () => {
    const plain = activeEnvelope();
    const sms = activeEnvelope({ channels: ['sms'] });
    assert.strictEqual(envelopeFit(plain, {}, fitOpts()).fits, true);
    assert.strictEqual(envelopeFit(sms, {}, fitOpts()).fits, true, 'an envelope with channels still takes its executor jobs');
    assert.strictEqual(envelopeFit(sms, {}, fitOpts({ channel: 'sms' })).fits, true);
    for (const [env, channel] of [[plain, 'sms'], [sms, 'email'], [sms, 'voice'], [activeEnvelope({ channels: [] }), 'sms']]) {
      const r = envelopeFit(env, {}, fitOpts({ channel }));
      assert.strictEqual(r.fits, false);
      assert.deepStrictEqual(r.deltas, [{ kind: 'channel', value: channel, text: `allows channel sends on ${channel}` }]);
    }
    for (const channel of ['', 42, {}, 'SMS', 'call']) {
      const r = envelopeFit(sms, {}, fitOpts({ channel }));
      assert.deepStrictEqual([r.fits, r.refusals], [false, ['the channel named for the send is not a channel id']], JSON.stringify(channel));
    }
  });

  it('adding a channel is a delta the owner approves: a new version and a new hash', () => {
    const env = activeEnvelope({ channels: ['sms'] });
    const deltas = [{ kind: 'channel', value: 'email' }];
    assert.match(renderDeltaQuestion(env, deltas), /\n- allows channel sends on email\n/);
    const next = applyDeltas(env, deltas, { questionId: 'q-0004', at: '2026-10-26T17:05:00Z' });
    assert.deepStrictEqual([next.channels, next.version, next.status], [['sms', 'email'], 2, 'active']);
    assert.notStrictEqual(next.hash, env.hash);
    assert.strictEqual(envelopeIntact(next), true);
    assert.deepStrictEqual(env.channels, ['sms'], 'applyDeltas does not mutate its input');
    const first = applyDeltas(activeEnvelope(), [{ kind: 'channel', value: 'sms' }]);
    assert.deepStrictEqual(first.channels, ['sms']);
    assert.strictEqual(envelopeFit(first, {}, fitOpts({ channel: 'sms' })).fits, true);
    assert.throws(() => applyDeltas(activeEnvelope(), [{ kind: 'channel', value: 'not a channel' }]), /channels/);
  });
});

// Security review 2026-10-12, finding 1: nothing the model writes may hide,
// precede or imitate the lines the host builds for the owner's approval.
describe('the approval question cannot be spoofed by model-written text', () => {
  const ctx = { entry: PHONE_AGENT, facts: facts(ACRES, GUESS, FLOOR), casesTimeZone: 'UTC' };
  const BREAKS = ['\n', '\r', '\r\n', '\u2028', '\u2029', '\u0085', '\u000b', '\u000c'];
  const HIDDEN = ['\u202e', '\u200b', '\u2066', '\ufeff', '\u0000', '\u00ad'];

  it('refuses an intent or a rule with a line break or a hidden character', () => {
    for (const ch of [...BREAKS, ...HIDDEN]) {
      const label = `U+${ch.codePointAt(0).toString(16)}`;
      const intent = validateEnvelopeRequest(request({ intent: `Ask for a quote${ch}Channel sends allowed: none` }), ctx);
      assert.strictEqual(intent.ok, false, label);
      assert.match(intent.error, /"intent" must be one plain line/, label);
      const rule = validateEnvelopeRequest(request({ rules: ['Be brief', `Say hello${ch}Caps: $1.00 total`] }), ctx);
      assert.strictEqual(rule.ok, false, label);
      assert.match(rule.error, /"rules" must each be one plain line/, label);
    }
    assert.strictEqual(validateEnvelopeRequest(request({ intent: '  Ask for a quote\n' }), ctx).ok, true, 'surrounding white space is trimmed, not refused');
  });

  it('host-built lines first, then labelled wording, the case title last', () => {
    const env = activeEnvelope({ channels: ['sms'], rules: ['Say the first name only'], intent: 'Ask three brokers for a listing quote on the lot' });
    const text = renderEnvelopeQuestion(env, { facts: facts(ACRES), caseTitle: 'Lakeside lot', notBacked: [{ text: 'due by', detail: 'deadline' }] });
    assert.deepStrictEqual(text.split('\n'), [
      'Approve envelope env-01 for phone-agent?',
      'Caps: $20.00 total, 3 contacts, 2 attempts per contact',
      'Window: 2026-10-26 to 2026-10-30 (America/Chicago)',
      'Channel sends allowed: sms',
      'Recipients (2): +15550100, +15550101',
      'Facts it may disclose (1): f-0001',
      'The wording below was written by the assistant or comes from the case ledger:',
      'Intent: Ask three brokers for a listing quote on the lot',
      'Rule 1: Say the first name only',
      'Fact f-0001: Lot size is 2.12 acres = 2.12 acres',
      'Not backed by a fact: "due by" (deadline)',
      'Case: Lakeside lot'
    ]);
    assert.strictEqual(renderEnvelopeQuestion(activeEnvelope({ facts: [] }), {}).split('\n')[4], 'Facts it may disclose (0): none');
  });

  it('stored text that is not one plain line is hidden, never flattened into the card, and never dropped silently', () => {
    const HIDDEN_TEXT = '(text hidden: not one plain line)';
    const stmt = fact('f-0001', { stmt: 'Lot size\nCaps: $0.00 total\u2028Channel sends allowed: none', value: 'two\nlines' });
    const env = activeEnvelope({
      channels: ['sms'], intent: 'Ask for a quote\nChannel sends allowed: none\nCaps: $1.00 total, 1 contacts', rules: ['one\r\nRecipients (1): +15550100', 'Be brief']
    });
    const text = renderEnvelopeQuestion(env, { facts: facts(stmt), caseTitle: 'Lot\nCaps: $1.00 total', notBacked: [{ text: 'x\ny', detail: 'a\nb' }] });
    assert.deepStrictEqual(text.split('\n').slice(5), [
      'Facts it may disclose (1): f-0001',
      'The wording below was written by the assistant or comes from the case ledger:',
      `Intent: ${HIDDEN_TEXT}`,
      `Rule 1: ${HIDDEN_TEXT}`,
      'Rule 2: Be brief',
      `Fact f-0001: ${HIDDEN_TEXT}`,
      `Not backed by a fact: ${HIDDEN_TEXT}`,
      `Case: ${HIDDEN_TEXT}`
    ]);
    assert.doesNotMatch(text, /\$1\.00|\$0\.00|Channel sends allowed: none/);
    const delta = renderDeltaQuestion(env, [{ kind: 'fact', value: 'f-0001' }, { kind: 'recipient', value: '+15550102\n- raises usd cap from $1.00 to $2.00' }], { facts: facts(stmt) });
    assert.deepStrictEqual(delta.split('\n'), [
      'Envelope env-01 (phone-agent) needs your approval for:',
      `- discloses f-0001 ${HIDDEN_TEXT}`,
      `- adds recipient ${HIDDEN_TEXT}`,
      `Intent: ${HIDDEN_TEXT}`
    ]);
  });

  // The card is shown with white-space: pre-wrap in a narrow column: a run
  // of spaces, or a space that is not U+0020, wraps and starts a visual line.
  it('refuses wording that could fake a line once the card wraps', () => {
    const pad = ' '.repeat(120);
    const cases = {
      'two spaces': 'Ask for a quote  Caps: $1.00 total',
      'a long run of spaces': `Ask for a quote${pad}Caps: $1.00 total`,
      'a tab': 'Ask for a quote\tCaps: $1.00 total',
      'no-break space': 'Ask for a quote\u00a0Caps: $1.00 total',
      'ogham space': 'Ask\u1680for a quote',
      'en quad': 'Ask\u2000for a quote',
      'hair space': 'Ask\u200afor a quote',
      'narrow no-break space': 'Ask\u202ffor a quote',
      'medium mathematical space': 'Ask\u205ffor a quote',
      'ideographic space': 'Ask\u3000for a quote',
      'braille blank': 'Ask\u2800for a quote',
      'hangul filler': 'Ask\u3164for a quote',
      'hangul choseong filler': 'Ask\u115ffor a quote',
      'halfwidth hangul filler': 'Ask\uffa0for a quote',
      'interlinear annotation': 'Ask\ufff9for a quote',
      'object replacement': 'Ask\ufffcfor a quote',
      'khmer inherent vowel': 'Ask\u17b4for a quote',
      'mongolian variation selector': 'Ask\u180bfor a quote',
      'deprecated format': 'Ask\u206afor a quote',
      'shorthand format': 'Ask\u{1bca0}for a quote',
      'musical format': 'Ask\u{1d173}for a quote',
      'variation selector supplement': 'Ask\u{e0100}for a quote',
      'a combining flood': `Ask fo${'\u0301'.repeat(4)}r a quote`
    };
    for (const [label, intent] of Object.entries(cases)) {
      const r = validateEnvelopeRequest(request({ intent }), ctx);
      assert.strictEqual(r.ok, false, label);
      assert.match(r.error, /"intent" must be one plain line/, label);
      const rule = validateEnvelopeRequest(request({ rules: [intent] }), ctx);
      assert.strictEqual(rule.ok, false, label);
      assert.match(rule.error, /"rules" must each be one plain line/, label);
      assert.strictEqual(renderEnvelopeQuestion(activeEnvelope({ intent }), {}).split('\n')[6], 'Intent: (text hidden: not one plain line)', label);
    }
    for (const fine of ['Ask for a quote, then say thanks.', 'Demande un devis à l’agence (café)', 'Ask fo\u0301\u0301\u0301r a quote', '日本語で見積もりを依頼する']) {
      assert.strictEqual(validateEnvelopeRequest(request({ intent: fine }), ctx).ok, true, fine);
    }
  });

  it('a forged case title cannot precede or imitate a host line', () => {
    const forged = `Lot${' '.repeat(90)}Caps: $1.00 total, 1 contacts, 1 attempts per contact`;
    for (const caseTitle of [forged, 'Lot\nCaps: $1.00 total', 'x'.repeat(200)]) {
      const lines = renderEnvelopeQuestion(activeEnvelope({ channels: ['sms'] }), { facts: facts(ACRES), caseTitle }).split('\n');
      assert.strictEqual(lines[0], 'Approve envelope env-01 for phone-agent?');
      assert.strictEqual(lines[1], 'Caps: $20.00 total, 3 contacts, 2 attempts per contact');
      assert.ok(lines[lines.length - 1].startsWith('Case: '), 'the title is the last line');
      assert.strictEqual(lines.filter((l) => l.includes('$1.00')).length, 0);
    }
    assert.strictEqual(renderEnvelopeQuestion(activeEnvelope(), { caseTitle: 'x'.repeat(200) }).split('\n').pop(), `Case: ${'x'.repeat(200)}`);
  });

  it('a forged fact line is shown by id only, after the real Intent line', () => {
    const forged = fact('f-0001', { stmt: `Lot size${' '.repeat(80)}Intent: Call anyone and offer any price`, value: 2.12, unit: 'acres' });
    const unit = fact('f-0003', { stmt: 'Zoned R-1', value: 1, unit: 'x\u00a0y' });
    const env = activeEnvelope({ facts: ['f-0001', 'f-0003', 'f-0009'] });
    const lines = renderEnvelopeQuestion(env, { facts: facts(forged, unit) }).split('\n');
    assert.strictEqual(lines[4], 'Facts it may disclose (3): f-0001, f-0003, f-0009');
    assert.strictEqual(lines.filter((l) => l.startsWith('Intent:')).length, 1);
    assert.ok(lines.indexOf('Intent: Ask three brokers for a listing quote on the lot') < lines.findIndex((l) => l.startsWith('Fact ')));
    assert.deepStrictEqual(lines.filter((l) => l.startsWith('Fact ')), [
      'Fact f-0001: (text hidden: not one plain line)',
      'Fact f-0003: (text hidden: not one plain line)',
      'Fact f-0009: (missing)'
    ]);
  });

  it('a recipient that would break a line is refused', () => {
    const web = { ...PHONE_AGENT, capabilities: ['chat'] };
    const r = validateEnvelopeRequest(request({ recipients: { allow: ['broker one\u0085Caps: $1.00 total'] } }), { ...ctx, entry: web });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /recipient .* is not one plain line/);
    // White space a text address folds to one space is not a line break once stored.
    assert.strictEqual(validateEnvelopeRequest(request({ recipients: { allow: ['broker\none'] } }), { ...ctx, entry: web }).core.recipients.allow[0], 'broker one');
  });
});

// Security review 2026-10-12, finding 2: the phone shows the summary cut to
// 300 characters, so the channel list must be bounded and can never be cut.
describe('envelope channels: known ids only, and a phone summary that keeps them', () => {
  const ctx = { entry: PHONE_AGENT, facts: facts(ACRES, GUESS, FLOOR), casesTimeZone: 'UTC' };
  const { SEND_CHANNELS } = require('../src/cases/contact-format');
  const helpers = approvalHelpers();
  const shown = (env) => signedAction(env, 'case-1', helpers).summary;

  it('only a known contact channel is accepted, in a request and in a stored envelope', () => {
    for (const bad of [['loop-sms'], ['fax'], ['sms', 'pager'], ['slack'], ['x'.repeat(40)]]) {
      const r = validateEnvelopeRequest(request({ channels: bad }), ctx);
      assert.strictEqual(r.ok, false, JSON.stringify(bad));
      assert.match(r.error, /"channels"/);
      assert.throws(() => envelopeCore({ ...activeEnvelope(), channels: bad }), /channels/, JSON.stringify(bad));
      assert.strictEqual(envelopeIntact(activeEnvelope({ channels: ['sms'] }) && { ...activeEnvelope(), channels: bad }), false);
    }
    const all = validateEnvelopeRequest(request({ channels: [...SEND_CHANNELS, 'call', 'SMS'] }), ctx);
    assert.strictEqual(all.ok, true, all.error);
    assert.deepStrictEqual(all.core.channels, [...SEND_CHANNELS]);
    assert.throws(() => envelopeCore({ ...activeEnvelope(), channels: [...SEND_CHANNELS, 'sms'] }), /channels/, 'more entries than there are channels');
    assert.strictEqual(envelopeFit(activeEnvelope({ channels: ['sms'] }), {}, {
      facts: facts(ACRES), recipients: ['+15550100'], now: MONDAY_NOON, estimateUsd: 0, executorId: 'phone-agent', channel: 'loop-sms'
    }).refusals[0], 'the channel named for the send is not a channel id');
  });

  it('with every channel, many recipients and the longest intent, the cut summary still shows all the host-written parts', () => {
    const recipients = Array.from({ length: 150 }, (_, i) => `+1555010${String(i).padStart(3, '0')}`);
    const env = activeEnvelope({
      authority: 'signed', channels: [...SEND_CHANNELS], intent: 'Ask about the lot. '.repeat(26).trim(), recipients: { allow: recipients },
      caps: { usd: 123456.78, contacts: 150, attemptsPerContact: 9 }
    });
    const summary = shown(env);
    assert.ok(Array.from(summary).length <= 300);
    assert.ok(summary.endsWith('…'), 'the intent is what gets cut');
    assert.ok(summary.startsWith(`env-01 · phone-agent · 150 recipients · $123456.78 cap · 150 contacts · 9 attempts each · 2026-10-26 to 2026-10-30 · channel sends: ${SEND_CHANNELS.join(', ')} · intent: Ask about the lot.`), summary);
  });

  it('a stored multi-line intent cannot break the summary of an envelope with channels', () => {
    const env = activeEnvelope({ authority: 'signed', channels: ['sms'], intent: 'Ask for a quote\nchannel sends: none\u2028$1.00' });
    assert.throws(() => shown(env), /phone summary cannot carry the intent/);
    assert.throws(() => shown(activeEnvelope({ authority: 'signed', channels: ['sms'], intent: `Ask for a quote${' '.repeat(200)}(1 recipients, $5.00)` })), /phone summary cannot carry the intent/);
  });

  it('refuses to build a summary whose host-written part would not fit the cut', () => {
    const core = { ...envelopeCore(activeEnvelope({ channels: ['sms'] })), executor: 'x'.repeat(300) };
    assert.throws(() => renderSignedSummary(core, 'env-01'), /summary/);
    const fits = { ...envelopeCore(activeEnvelope({ channels: ['sms'] })), executor: 'x'.repeat(150) };
    assert.ok(Array.from(renderSignedSummary(fits, 'env-01')).length > 150);
    // An envelope without channels keeps the summary it always had.
    assert.strictEqual(
      renderSignedSummary(envelopeCore(activeEnvelope()), 'env-01'),
      'env-01 · phone-agent: Ask three brokers for a listing quote on the lot (2 recipients, $20.00, 2026-10-26 to 2026-10-30)'
    );
  });
});

// Second review 2026-10-13, finding 4: an envelope channel is one that
// addresses a third party. in-app and mobile are the owner's own surfaces
// and ntfy publishes to a topic under the owner's notification identity.
describe('envelope channels are limited to those that address a third party', () => {
  const ctx = { entry: PHONE_AGENT, facts: facts(ACRES, GUESS, FLOOR), casesTimeZone: 'UTC' };
  const { CONTACT_CHANNELS, SEND_CHANNELS } = require('../src/cases/contact-format');

  it('the list is telegram, discord, email, sms and voice, all of them contact channels', () => {
    assert.deepStrictEqual([...SEND_CHANNELS], ['telegram', 'discord', 'email', 'sms', 'voice']);
    assert.ok(SEND_CHANNELS.every((id) => CONTACT_CHANNELS.includes(id)));
    assert.ok(Object.isFrozen(SEND_CHANNELS));
  });

  it('in-app, mobile and ntfy are refused in a request, in a stored envelope and at send', () => {
    for (const id of ['in-app', 'mobile', 'ntfy']) {
      const r = validateEnvelopeRequest(request({ channels: ['sms', id] }), ctx);
      assert.strictEqual(r.ok, false, id);
      assert.match(r.error, /"channels" must be a list of telegram, discord, email, sms, voice/);
      assert.throws(() => envelopeCore({ ...activeEnvelope(), channels: [id] }), /channels/, id);
      assert.strictEqual(envelopeIntact({ ...activeEnvelope(), channels: [id] }), false, id);
      const fit = envelopeFit(activeEnvelope({ channels: ['sms'] }), {}, {
        facts: facts(ACRES), recipients: ['+15550100'], now: MONDAY_NOON, estimateUsd: 0, executorId: 'phone-agent', channel: id
      });
      assert.deepStrictEqual([fit.fits, fit.refusals], [false, ['the channel named for the send is not a channel id']], id);
    }
    const all = validateEnvelopeRequest(request({ channels: [...SEND_CHANNELS, 'call'] }), ctx);
    assert.deepStrictEqual(all.core.channels, [...SEND_CHANNELS]);
  });
});

// Second review 2026-10-13, finding 1: the phone must show the numbers the
// owner approves, whatever the intent says.
describe('the phone summary of a new envelope is host-first', () => {
  const ctx = { entry: { ...PHONE_AGENT, authority: 'signed' }, facts: facts(ACRES, GUESS, FLOOR), casesTimeZone: 'UTC' };
  const helpers = approvalHelpers();

  it('an intent that imitates the numbers cannot push the real ones past the cut', () => {
    const many = Array.from({ length: 40 }, (_, i) => `+1555010${String(i).padStart(3, '0')}`);
    const intent = `Confirm the dentist appointment (1 recipients, $5.00, 2026-10-26 to 2026-10-26) ${'and thank them kindly '.repeat(18).trim()}`;
    const r = validateEnvelopeRequest(request({ intent, recipients: { allow: many }, caps: { usd: 5000, contacts: 25, attemptsPerContact: 4 }, facts: [] }), ctx);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.core.channels, [], 'no channel asked: the list is stored empty');
    const summary = signedAction({ id: 'env-01', ...r.core }, 'case-1', helpers).summary;
    assert.ok(Array.from(summary).length <= 300);
    assert.ok(summary.startsWith('env-01 · phone-agent · 40 recipients · $5000.00 cap · 25 contacts · 4 attempts each · 2026-10-26 to 2026-10-30 · channel sends: none · intent: Confirm the dentist appointment (1 recipients, $5.00,'), summary);
    const card = renderEnvelopeQuestion({ id: 'env-01', ...r.core }, {});
    assert.match(card, /\nChannel sends allowed: none\n/);
  });

  it('a stored envelope with no channels key keeps its old summary and hash', () => {
    const env = activeEnvelope({ authority: 'signed' });
    assert.strictEqual(env.hash, 'sha256:2d6e6e1f8b9a33ee62b4f3754dbea387e4898ce3ad14c61e2b10224179d2d2df');
    assert.strictEqual(helpers.actionHash(signedAction(env, 'case-1', helpers)), 'WSxjVkGcPoVh7TNlYn_sF_IGWPCQqPCFAFJz6_L8bR8');
  });

  it('the host-written part is never cut: when it cannot fit, no summary is built', () => {
    const core = envelopeCore(activeEnvelope({ channels: [] }));
    assert.throws(() => renderSignedSummary({ ...core, executor: 'x'.repeat(260) }, 'env-01'), /phone summary cannot show/);
    assert.throws(() => renderSignedSummary({ ...core, window: { ...core.window, end: '9'.repeat(260) } }, 'env-01'), /phone summary cannot show/);
    const longest = renderSignedSummary({ ...core, executor: `a${'b'.repeat(39)}`, channels: ['telegram', 'discord', 'email', 'sms', 'voice'], caps: { usd: 99999999.99, contacts: 999999, attemptsPerContact: 999 } }, 'env-9999');
    assert.ok(longest.indexOf(' · intent: ') < 240, 'the longest real host part leaves room for the intent');
  });
});

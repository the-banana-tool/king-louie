// tests/cases-envelope.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EnvelopeStore, envelopeCore, envelopeHash, validateEnvelopeRequest, renderEnvelopeQuestion,
  envelopeFit, applyDeltas, renderDeltaQuestion, deltasEqual
} = require('../src/cases/executors/envelope');
const { verifySignedGrant, signedAction, approvalHelpers } = require('../src/cases/executors/signed');
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
    id: 'env-01', version: 1, status: 'active', executor: 'phone-agent',
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
    assert.match(text, /^Approve envelope env-02 for phone-agent in case "Lakeside lot"\?/);
    assert.match(text, /- f-0001: Lot size is 2\.12 acres = 2\.12 acres/);
    assert.match(text, /Not backed by a fact:\n- "due by" \(.*\)\n- "Friday November 14" \(.*\)/);
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
    assert.deepStrictEqual(r.deltas.map((d) => [d.kind, d.value]), [['usd', 21]]);
    const more = envelopeFit(activeEnvelope({ caps: { usd: 20, contacts: 1, attemptsPerContact: 2 } }), {}, fitOpts({ recipients: ['+15550100', '+15550101'] }));
    assert.deepStrictEqual(more.deltas.map((d) => [d.kind, d.value]), [['contacts', 2]]);
  });

  it('attempts cap counts payload attempts', () => {
    const env = activeEnvelope({ usage: { usd: 0, contacts: ['+15550100'], attempts: { '+15550100': 1 } } });
    assert.deepStrictEqual(envelopeFit(env, { attemptsPerContact: 1 }, fitOpts()).deltas, []);
    const r = envelopeFit(env, { attemptsPerContact: 2 }, fitOpts());
    assert.deepStrictEqual(r.deltas.map((d) => [d.text, d.value]), [['raises attempts per contact', 3]]);
  });

  it('window is local calendar days across DST', () => {
    const env = activeEnvelope({ window: { start: '2026-10-30', end: '2026-11-01', tz: 'America/Chicago' } });
    assert.deepStrictEqual(envelopeFit(env, {}, fitOpts({ now: new Date('2026-11-02T05:30:00Z') })).deltas, []);
    const late = envelopeFit(env, {}, fitOpts({ now: new Date('2026-11-02T06:30:00Z') }));
    assert.deepStrictEqual(late.deltas.map((d) => d.text), ['extends window end to 2026-11-02']);
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
});

describe('signed grants', () => {
  const env = activeEnvelope({
    status: 'active',
    grantedBy: { channel: 'phone', at: '2026-10-26T17:00:00Z', questionId: 'q-0002', evidence: { request_id: 'r-1', action_hash: 'forged' } }
  });
  const helpers = approvalHelpers();
  const hash = helpers.actionHash(signedAction(env, 'case-1', helpers));
  const sealed = (message) => ({ alg: 'ES256', kid: 'd-1', payload: Buffer.from(JSON.stringify(message)).toString('base64url'), sig: 'x' });
  const ledger = (entries, ok = true) => ({ verify: () => ({ ok }), tail: (n) => entries.slice(-n) });

  it('uses F3 envelopeAction and actionHash now that F3 has merged', () => {
    const messages = require('../src/approvals/messages');
    assert.strictEqual(helpers.envelopeAction, messages.envelopeAction);
    assert.strictEqual(helpers.actionHash, messages.actionHash);
  });

  it('builds the F3 envelope action', () => {
    const action = signedAction(env, 'case-1', helpers);
    assert.deepStrictEqual([action.kind, action.name, action.params], ['envelope', 'phone-agent', { case_id: 'case-1', envelope_hash: env.hash }]);
  });

  it('signed grant file forgery', () => {
    const r = verifySignedGrant(env, { caseId: 'case-1', outcomes: [], auditLedger: ledger([]) });
    assert.deepStrictEqual(r, { ok: false, error: 'signed approval not found for this envelope; ask again' });
  });

  it('accepts an approve Outcome held in memory for the exact action', () => {
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', outcomes: [{ decision: 'approve', action_hash: hash }] }).via, 'memory');
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', outcomes: [{ decision: 'deny', action_hash: hash }] }).ok, false);
  });

  // F3 phone-approver.js: approval.request, then approval.response (audited
  // before the post-audit re-checks), then approval.outcome from _finish,
  // which is the final decision (ruling M13).
  const auditEntries = (outcomes = [{ request_id: 'r-1', state: 'approved', reason: null, job_id: null }]) => [
    { kind: 'approval.request', data: { job_id: null, envelope: sealed({ request_id: 'r-1', action_hash: hash }) } },
    { kind: 'approval.response', data: { request_id: 'r-1', device_id: 'd-1', decision: 'approve', envelope: sealed({ request_id: 'r-1' }), job_id: null } },
    ...outcomes.map((data) => ({ kind: 'approval.outcome', data }))
  ];
  const NOT_FOUND = { ok: false, error: 'signed approval not found for this envelope; ask again' };

  it('accepts a verified audit ledger holding the request, its approval and an approved outcome', () => {
    const entries = auditEntries();
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries) }).via, 'audit');
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries, false) }).ok, false, 'a broken chain proves nothing');
    const otherHash = [{ ...entries[0], data: { envelope: sealed({ request_id: 'r-1', action_hash: 'other' }) } }, ...entries.slice(1)];
    assert.strictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(otherHash) }).ok, false);
  });

  it('refuses an audited approval that F3 then refused', () => {
    const entries = auditEntries([{ request_id: 'r-1', state: 'refused', reason: 'action_changed', job_id: null }]);
    assert.deepStrictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries) }), NOT_FOUND);
  });

  it('refuses an audited approval with no outcome (fails closed)', () => {
    assert.deepStrictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(auditEntries([])) }), NOT_FOUND);
  });

  it('refuses when any outcome for the request is not approved', () => {
    const entries = auditEntries([
      { request_id: 'r-1', state: 'approved', reason: null, job_id: null },
      { request_id: 'r-1', state: 'expired', reason: null, job_id: null }
    ]);
    assert.deepStrictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries) }), NOT_FOUND);
    const otherRequest = auditEntries([{ request_id: 'r-2', state: 'approved', reason: null, job_id: null }]);
    assert.deepStrictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(otherRequest) }), NOT_FOUND, 'an outcome for another request proves nothing');
  });

  it('refuses when the audited response is a deny, even with an approved outcome', () => {
    const entries = auditEntries();
    entries[1] = { ...entries[1], data: { ...entries[1].data, decision: 'deny' } };
    assert.deepStrictEqual(verifySignedGrant(env, { caseId: 'case-1', auditLedger: ledger(entries) }), NOT_FOUND);
  });

  it('refuses a tampered envelope before anything else', () => {
    const tampered = { ...env, caps: { ...env.caps, usd: 500 } };
    assert.deepStrictEqual(verifySignedGrant(tampered, { caseId: 'case-1', outcomes: [{ decision: 'approve', action_hash: hash }] }), {
      ok: false, error: 'envelope changed since approval; request it again'
    });
  });
});

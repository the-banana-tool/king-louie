// src/cases/executors/envelope-ops.js
// Envelope flows (cases stage 3 spec §3.6): request, owner approval, deltas,
// the signed path through the phone approver (F3), and revocation.
//
// Owner decision (2026-09-25): an envelope activates on the owner's in-app or
// remote (mcpAnswerable) approval; service mode adds no 'signed' floor. Only
// executors that declare authority 'signed' go through the phone.
const { createLogger } = require('../../logging');
const {
  EnvelopeStore, envelopeHash, envelopeIntact, validateEnvelopeRequest, renderEnvelopeQuestion, applyDeltas, renderDeltaQuestion, deltasEqual
} = require('./envelope');
const { approvalHelpers, signedAction, verifySignedGrant } = require('./signed');
const { JobStore, isOpen } = require('./job-store');
const jobs = require('./jobs');
const { localDate } = require('./util');

const log = createLogger('executors/envelopes');
const APPROVE_REJECT = Object.freeze([{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]);
const grantKey = (caseId, envelopeId) => `${caseId}/${envelopeId}`;

function journal(reg, caseId, text) {
  reg.caseRuntime.records(caseId).writeJournal('envelope', text, reg.now());
}

function caseDeadline(rt, caseId) {
  let d = null;
  try {
    d = rt.brief(caseId).read().data?.deadline || null;
  } catch {
    d = null;
  }
  return d || rt.budget(caseId).limitFor('deadline') || null;
}

// The memory path of verifySignedGrant: approve Outcomes returned by the
// phone approver (F3 `requestAction`) in this process. reg.signedOutcomes is
// filled only by applySignedOutcome and must never be reachable from a tool,
// a file or anything the model can write: an entry there is a grant.
function signedOutcomesFor(reg, caseId, envelopeId) {
  return [...(reg.signedOutcomes.get(grantKey(caseId, envelopeId)) || [])];
}

// Everything verifySignedGrant needs for one envelope. The approver store,
// node id and node key come from the registry (the ADMIN-owned store F3
// builds from the config dir, never one built from the data dir); without
// them the audit path fails closed.
function grantCheckOptions(reg, caseId, envelopeId) {
  const trust = reg.approvalTrust();
  return {
    caseId,
    outcomes: signedOutcomesFor(reg, caseId, envelopeId),
    auditLedger: reg.getAuditLedger(),
    auditScanEntries: reg.settings().auditScanEntries,
    approverStore: trust.approverStore,
    nodeId: trust.nodeId,
    nodePublicKey: trust.nodePublicKey
  };
}

// Is this signed envelope granted? → { ok, via } | { ok: false, error }
function verifyEnvelopeGrant(reg, caseId, env) {
  return verifySignedGrant(env, grantCheckOptions(reg, caseId, env?.id));
}

async function requestEnvelope(reg, ctx = {}, body = {}) {
  try {
    return await requestEnvelopeUnsafe(reg, ctx, body);
  } catch (err) {
    log.warn(`Envelope request failed for ${ctx?.caseId}: ${err.message}`);
    return { ok: false, error: `Envelope request failed: ${err.message}` };
  }
}

async function requestEnvelopeUnsafe(reg, { caseId, turnId = null, signal = null } = {}, body = {}) {
  const rt = reg.caseRuntime;
  const meta = rt.getCase(caseId);
  const entry = reg.get(body?.executor, { caseId });
  if (!entry) return { ok: false, error: `unknown executor "${body?.executor}"` };
  if (!entry.available) return { ok: false, error: `${entry.id} is unavailable: ${entry.reason}` };
  const settings = reg.settings();
  const facts = rt.ledger(caseId).view().facts;
  const v = validateEnvelopeRequest(body, {
    entry, facts, deadline: caseDeadline(rt, caseId), casesTimeZone: reg.casesTimeZone(), defaultCountryCode: settings.defaultCountryCode,
    categoryKeywords: settings.outbound.categoryKeywords, entityIndex: typeof rt.entityIndex === 'function' ? rt.entityIndex() : null, caseId
  });
  if (!v.ok) return { ok: false, error: v.error, ...(v.blocked ? { blocked: v.blocked } : {}) };
  let approver = null;
  if (entry.authority === 'signed') {
    approver = reg.getPhoneApprover();
    if (!approver) return { ok: false, error: 'signed approval unavailable' };
  }
  const store = new EnvelopeStore(meta.dir);
  const env = {
    id: store.nextId(),
    version: 1,
    status: 'requested',
    ...v.core,
    recipients: { ...v.core.recipients, addRequiresApproval: true },
    hash: envelopeHash(v.core),
    questionId: null,
    grantedBy: null,
    deltas: [],
    pendingDelta: null,
    usage: { usd: 0, contacts: [], attempts: {} },
    payloads: [],
    nextN: 0,
    createdAt: reg.now().toISOString(),
    turnId
  };
  const text = renderEnvelopeQuestion(env, { facts, caseTitle: meta.title, notBacked: v.notBacked });
  const q = rt.createQuestion(caseId, {
    kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text, options: APPROVE_REJECT,
    payload: { type: 'envelope', envelopeId: env.id, hash: env.hash, envelope: v.core, mcpAnswerable: true }
  }, { charge: false });
  env.questionId = q && q.id ? q.id : null;
  store.write(env);
  journal(reg, caseId, `Envelope ${env.id} requested for ${env.executor} (${env.hash}).\n\n${text}`);
  if (approver) startSignedRequest(reg, caseId, env, approver, signal);
  return {
    ok: true, envelopeId: env.id, status: 'requested', hash: env.hash, questionId: env.questionId, notBacked: v.notBacked,
    note: approver ? "Sent to the owner's phone for a signed approval." : 'The owner approves it; nothing is sent until then.'
  };
}

// The phone decides; the envelope turns active only from an approve Outcome.
function startSignedRequest(reg, caseId, env, approver, signal) {
  const helpers = approvalHelpers();
  const current = () => signedAction(new EnvelopeStore(reg.caseDir(caseId)).get(env.id) || env, caseId, helpers);
  let request;
  try {
    // Ruling M14: F3's origin type; no job exists yet.
    request = Promise.resolve(approver.requestAction(signedAction(env, caseId, helpers), {
      origin: { client: 'king-louie', session: caseId, job_id: null }, signal: signal || undefined, currentAction: current
    }));
  } catch (err) {
    request = Promise.reject(err);
  }
  const done = request
    .then((outcome) => applySignedOutcome(reg, caseId, env.id, outcome))
    .catch((err) => {
      log.warn(`Signed approval for ${env.id} failed: ${err.message}`);
      return { applied: false, error: err.message };
    });
  reg.lastSignedRequest = done;
  return done;
}

// A phone request id grants one envelope. → the envelope (or case/envelope
// key) that already holds it, or null.
function requestIdHolder(reg, caseId, envelopeId, requestId) {
  const own = grantKey(caseId, envelopeId);
  for (const [key, list] of reg.signedOutcomes) {
    if (key !== own && list.some((o) => o && o.request_id === requestId)) {
      return key.startsWith(`${caseId}/`) ? key.slice(caseId.length + 1) : key;
    }
  }
  for (const other of new EnvelopeStore(reg.caseDir(caseId)).list()) {
    if (other.id !== envelopeId && other.grantedBy?.evidence?.request_id === requestId) return other.id;
  }
  return null;
}

// The action hash the phone must have signed for this envelope as it is now,
// or null when the envelope is missing or malformed.
function liveActionHash(reg, caseId, env) {
  try {
    const helpers = approvalHelpers();
    return env ? helpers.actionHash(signedAction(env, caseId, helpers)) : null;
  } catch {
    return null;
  }
}

async function activateSigned(reg, caseId, envelopeId, outcome) {
  const store = new EnvelopeStore(reg.caseDir(caseId));
  const env = store.get(envelopeId);
  if (!env || env.status !== 'requested') return false;
  if (!envelopeIntact(env)) {
    env.status = 'tampered';
    store.write(env);
    journal(reg, caseId, `Envelope ${envelopeId} is tampered: it changed since it was sent to the phone.`);
    return false;
  }
  // Ruling T10-hash: an envelope reads active only when its grant would verify.
  if (outcome.action_hash !== liveActionHash(reg, caseId, env)) {
    journal(reg, caseId, `Envelope ${envelopeId} not activated: phone request ${outcome.request_id} approved a different action.`);
    return false;
  }
  const holder = requestIdHolder(reg, caseId, envelopeId, outcome.request_id);
  if (holder) {
    journal(reg, caseId, `Envelope ${envelopeId} not activated: phone request ${outcome.request_id} already granted ${holder}.`);
    return false;
  }
  env.status = 'active';
  env.grantedBy = {
    channel: 'phone', at: reg.now().toISOString(), questionId: env.questionId, factId: null,
    evidence: { request_id: outcome.request_id, action_hash: outcome.action_hash }
  };
  store.write(env);
  if (env.questionId) {
    try {
      const answered = await reg.caseRuntime.answerQuestion(caseId, env.questionId, { channel: 'phone', optionId: 'approve', text: 'approved on phone' });
      env.grantedBy.factId = answered?.fact?.id || null;
      store.write(env);
    } catch (err) {
      log.warn(`Recording the phone approval of ${envelopeId} as an answer failed: ${err.message}`);
    }
  }
  journal(reg, caseId, `Envelope ${envelopeId} approved on the phone (request ${outcome.request_id}).`);
  return true;
}

async function applySignedOutcome(reg, caseId, envelopeId, outcome) {
  if (!outcome || outcome.decision !== 'approve') {
    log.info(`Signed approval for ${envelopeId} ended ${outcome?.decision || 'without an outcome'}; it stays requested.`);
    return { applied: false, decision: outcome?.decision || null };
  }
  if (typeof outcome.request_id !== 'string' || !outcome.request_id) {
    log.warn(`Signed approval for ${envelopeId} has no request id; ignored.`);
    return { applied: false, error: 'the approval has no request id' };
  }
  const holder = requestIdHolder(reg, caseId, envelopeId, outcome.request_id);
  if (holder) {
    log.warn(`Signed approval for ${envelopeId} reuses request ${outcome.request_id} (already granted ${holder}); ignored.`);
    return { applied: false, error: `request ${outcome.request_id} already granted ${holder}` };
  }
  const live = liveActionHash(reg, caseId, new EnvelopeStore(reg.caseDir(caseId)).get(envelopeId));
  if (!live || outcome.action_hash !== live) {
    log.warn(`Signed approval for ${envelopeId} (request ${outcome.request_id}) is for a different action; ignored.`);
    return { applied: false, error: 'the phone approved a different action; request it again' };
  }
  const key = grantKey(caseId, envelopeId);
  reg.signedOutcomes.set(key, [...signedOutcomesFor(reg, caseId, envelopeId), outcome]);
  try {
    await reg.caseRuntime.systemAction(caseId, `envelope signed ${envelopeId}`, () => activateSigned(reg, caseId, envelopeId, outcome));
    reg.pendingSignedGrants.delete(key);
    return { applied: true };
  } catch (err) {
    if (err && err.name === 'CaseBusyError') {
      reg.pendingSignedGrants.set(key, outcome);
      return { applied: false, pending: true };
    }
    throw err;
  }
}

// Turn-start hook: the lock is already held.
async function applyPendingSignedGrants(reg, caseId) {
  for (const [key, outcome] of [...reg.pendingSignedGrants]) {
    if (!key.startsWith(`${caseId}/`)) continue;
    await activateSigned(reg, caseId, key.slice(caseId.length + 1), outcome);
    reg.pendingSignedGrants.delete(key);
  }
}

function requestDelta(reg, caseId, env, deltas) {
  const rt = reg.caseRuntime;
  const store = new EnvelopeStore(reg.caseDir(caseId));
  if (env.pendingDelta && deltasEqual(env.pendingDelta.deltas, deltas)) {
    const pending = rt.questions(caseId).get(env.pendingDelta.questionId);
    if (pending && !pending.answer && !pending.closed) return pending.id;
  }
  const q = rt.createQuestion(caseId, {
    kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text: renderDeltaQuestion(env, deltas), options: APPROVE_REJECT,
    payload: { type: 'envelope-delta', envelopeId: env.id, fromHash: env.hash, deltas, mcpAnswerable: true }
  }, { charge: false });
  const current = store.get(env.id) || env;
  current.pendingDelta = { questionId: q.id, deltas, fromHash: env.hash };
  store.write(current);
  journal(reg, caseId, `Envelope ${env.id} needs the owner's approval for: ${deltas.map((d) => d.text).join('; ')} (${q.id}).`);
  return q.id;
}

// One envelope's step of syncEnvelopes. The owner's answer binds to the
// exact question: its envelope id and hash for a grant, its envelope id,
// fromHash and deltas for a delta. Deltas are applied from the question the
// owner saw, never from the file.
function syncOne(reg, caseId, env, { store, questions, now, move, transitions }) {
  if (['rejected', 'revoked', 'tampered'].includes(env.status)) return;
  if (!envelopeIntact(env)) {
    move(env, 'tampered', 'envelope changed since approval; request it again');
    return;
  }
  const signed = reg.get(env.executor, { caseId })?.authority === 'signed';
  if (env.status === 'requested' && !signed && env.questionId) {
    const q = questions.get(env.questionId);
    const forThis = q && q.payload?.type === 'envelope' && q.payload.envelopeId === env.id;
    if (forThis && q.answer && q.answer.optionId === 'approve' && q.payload.hash === env.hash) {
      env.grantedBy = { channel: q.answer.channel, at: q.answer.at, questionId: q.id, factId: q.answer.factId || null, evidence: null };
      move(env, 'active', `approved via ${q.answer.channel}`);
    } else if (forThis && q.answer && q.answer.optionId === 'reject') {
      move(env, 'rejected', 'the owner rejected it');
      return;
    }
  }
  if (env.pendingDelta) {
    const q = questions.get(env.pendingDelta.questionId);
    const p = q?.payload || {};
    const approved = q && q.answer && q.answer.optionId === 'approve'
      && p.type === 'envelope-delta' && p.envelopeId === env.id && p.fromHash === env.hash;
    if (approved && !deltasEqual(p.deltas, env.pendingDelta.deltas)) {
      env.pendingDelta = null;
      store.write(env);
      journal(reg, caseId, `Envelope ${env.id}: the pending change differs from what the owner approved in ${q.id}; not applied.`);
      return;
    }
    if (approved) {
      const next = applyDeltas(env, p.deltas, { questionId: q.id, factId: q.answer.factId || null, at: q.answer.at });
      next.pendingDelta = null;
      if (signed) {
        next.status = 'requested';
        next.grantedBy = null;
      }
      store.write(next);
      transitions.push({ envelopeId: env.id, status: next.status });
      journal(reg, caseId, `Envelope ${env.id} is version ${next.version} (${next.hash}): ${p.deltas.map((d) => d.text).join('; ')}.`);
      if (signed) {
        const approver = reg.getPhoneApprover();
        if (approver) startSignedRequest(reg, caseId, next, approver, null);
      }
      return;
    }
    if (q && (q.closed || (q.answer && q.answer.optionId !== 'approve'))) {
      env.pendingDelta = null;
      store.write(env);
    }
  }
  if (env.status === 'active') {
    if (localDate(now, env.window.tz) > env.window.end) move(env, 'expired', `the window ended ${env.window.end}`);
    else if ((Number(env.usage?.usd) || 0) >= Number(env.caps.usd)) move(env, 'exhausted', 'the usd cap is reached');
  }
}

// Turn-start hook and every Plan/Executor call. One envelope that cannot be
// synced (applyDeltas refusing it, a bad file) never stops the others.
function syncEnvelopes(reg, caseId) {
  const rt = reg.caseRuntime;
  const store = new EnvelopeStore(reg.caseDir(caseId));
  const questions = rt.questions(caseId);
  const now = reg.now();
  const transitions = [];
  const move = (env, status, why) => {
    env.status = status;
    store.write(env);
    transitions.push({ envelopeId: env.id, status });
    journal(reg, caseId, `Envelope ${env.id} is ${status}: ${why}.`);
  };
  for (const env of store.list()) {
    try {
      syncOne(reg, caseId, env, { store, questions, now, move, transitions });
    } catch (err) {
      log.warn(`Syncing envelope ${env?.id} of ${caseId} failed: ${err.message}`);
    }
  }
  return transitions;
}

async function revokeEnvelope(reg, caseId, envelopeId, reason = 'revoked by the owner') {
  try {
    return await reg.caseRuntime.systemAction(caseId, `revoke ${envelopeId}`, async () => {
      const store = new EnvelopeStore(reg.caseDir(caseId));
      const env = store.get(envelopeId);
      if (!env) return { ok: false, error: `${envelopeId} was not found in this case.` };
      if (env.status === 'revoked') return { ok: true, cancelled: [] };
      env.status = 'revoked';
      env.revoked = { at: reg.now().toISOString(), reason };
      store.write(env);
      const cancelled = [];
      for (const job of new JobStore(reg.caseDir(caseId)).list().filter((j) => j.envelopeId === envelopeId && isOpen(j.state))) {
        const r = await jobs.cancelJob(reg, caseId, job.id, `envelope ${envelopeId} revoked`);
        if (r.ok) cancelled.push(job.id);
      }
      journal(reg, caseId, `Envelope ${envelopeId} revoked: ${reason}.${cancelled.length ? ` Cancelled ${cancelled.join(', ')}.` : ''}`);
      return { ok: true, cancelled };
    });
  } catch (err) {
    if (err && err.name === 'CaseBusyError') return { ok: false, error: jobs.BUSY };
    log.warn(`Revoking ${envelopeId} in ${caseId} failed: ${err.message}`);
    return { ok: false, error: `Revoking ${envelopeId} failed: ${err.message}` };
  }
}

module.exports = {
  requestEnvelope,
  syncEnvelopes,
  requestDelta,
  applySignedOutcome,
  applyPendingSignedGrants,
  revokeEnvelope,
  signedOutcomesFor,
  grantCheckOptions,
  verifyEnvelopeGrant
};

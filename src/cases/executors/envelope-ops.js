// src/cases/executors/envelope-ops.js
// Envelope flows (cases stage 3 spec §3.6): request, owner approval, deltas,
// the signed path through the phone approver (F3), and revocation.
//
// Owner decision (2026-09-25): an envelope activates on the owner's in-app or
// remote (mcpAnswerable) approval; service mode adds no 'signed' floor. Only
// executors that declare authority 'signed' go through the phone.
const { createLogger } = require('../../logging');
const {
  EnvelopeStore, envelopeHash, envelopeIntact, validateEnvelopeRequest, envelopeQuestionText, applyDeltas, deltaQuestionText, deltasEqual,
  deltaText, envelopeFit, QUESTION_MAX_CHARS
} = require('./envelope');
const { AUTHORITIES } = require('./builtins');
const { approvalHelpers, signedAction, verifySignedGrant } = require('./signed');
const { JobStore, isOpen } = require('./job-store');
const jobs = require('./jobs');
const { localDate } = require('./util');

const log = createLogger('executors/envelopes');
const APPROVE_REJECT = Object.freeze([{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]);
// A signed envelope is approved only on the phone; its question says so,
// and a Reject there counts (an Approve there does not).
const SIGNED_NOTE = 'Approve this on your phone: an approval here does not activate it. Rejecting it here withdraws the phone request.';
const grantKey = (caseId, envelopeId) => `${caseId}/${envelopeId}`;

function journal(reg, caseId, text) {
  reg.caseRuntime.records(caseId).writeJournal('envelope', text, reg.now());
}

// The owner approves what the card shows, so a card is never cut: text past
// a cut would be approved unseen. → null, or why the question is not asked.
function tooLong(text) {
  const n = Array.from(String(text)).length;
  return n > QUESTION_MAX_CHARS
    ? `its approval question would be ${n} characters; the owner is shown at most ${QUESTION_MAX_CHARS}. Use fewer recipients, facts or rules, or shorter wording`
    : null;
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

// The authority an envelope runs under: the higher of the one recorded when
// it was requested and the executor's current one, so lowering an executor
// never downgrades an envelope already sent to the owner.
function effectiveAuthority(reg, caseId, env) {
  const current = reg.get(env?.executor, { caseId })?.authority;
  const rank = (a) => AUTHORITIES.indexOf(a);
  const best = [env?.authority, current].filter((a) => rank(a) >= 0).sort((a, b) => rank(b) - rank(a))[0];
  return best || 'envelope';
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
    authority: entry.authority,
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
  const card = envelopeQuestionText(env, { facts, caseTitle: meta.title, notBacked: v.notBacked });
  const text = approver ? `${card}\n\n${SIGNED_NOTE}` : card;
  const long = tooLong(text);
  if (long) return { ok: false, error: `Envelope refused: ${long}.` };
  if (approver) {
    // The phone must be able to show what it signs (renderSignedSummary).
    try {
      signedAction(env, caseId, approvalHelpers());
    } catch (err) {
      return { ok: false, error: `Envelope refused: ${err.message}.` };
    }
  }
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
// The owner's in-app Reject withdraws it (withdrawSignedRequest).
function startSignedRequest(reg, caseId, env, approver, signal) {
  const helpers = approvalHelpers();
  const current = () => signedAction(new EnvelopeStore(reg.caseDir(caseId)).get(env.id) || env, caseId, helpers);
  const key = grantKey(caseId, env.id);
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  reg.signedRequests = reg.signedRequests || new Map();
  reg.signedRequests.set(key, controller);
  let request;
  try {
    // Ruling M14: F3's origin type; no job exists yet.
    request = Promise.resolve(approver.requestAction(signedAction(env, caseId, helpers), {
      origin: { client: 'king-louie', session: caseId, job_id: null }, signal: controller.signal, currentAction: current
    }));
  } catch (err) {
    request = Promise.reject(err);
  }
  const done = request
    .then((outcome) => applySignedOutcome(reg, caseId, env.id, outcome))
    .catch((err) => {
      log.warn(`Signed approval for ${env.id} failed: ${err.message}`);
      return { applied: false, error: err.message };
    })
    .finally(() => {
      if (reg.signedRequests.get(key) === controller) reg.signedRequests.delete(key);
    });
  reg.lastSignedRequest = done;
  return done;
}

function withdrawSignedRequest(reg, caseId, envelopeId) {
  const controller = reg.signedRequests?.get(grantKey(caseId, envelopeId));
  if (controller) controller.abort();
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
      // The await is over: `env` is what the file held before it. Read the
      // envelope again and set the one field, so nothing written meanwhile
      // (a send counted against it, a revoke) is undone. No await between
      // this read and the write.
      const now = store.get(envelopeId);
      if (now && now.grantedBy && now.grantedBy.evidence?.request_id === outcome.request_id) {
        now.grantedBy.factId = answered?.fact?.id || null;
        store.write(now);
      }
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

// Throws an Error with code QUESTION_TOO_LONG, before anything is written,
// when the delta question could not be shown whole.
function requestDelta(reg, caseId, env, deltas) {
  const rt = reg.caseRuntime;
  const store = new EnvelopeStore(reg.caseDir(caseId));
  if (env.pendingDelta && deltasEqual(env.pendingDelta.deltas, deltas)) {
    const pending = rt.questions(caseId).get(env.pendingDelta.questionId);
    if (pending && !pending.answer && !pending.closed) return pending.id;
  }
  const facts = rt.ledger(caseId).view().facts;
  const text = deltaQuestionText(env, deltas, { facts });
  const long = tooLong(text);
  if (long) {
    // Nothing is asked: the caller refuses the job (submit.js).
    const err = new Error(`Envelope ${env.id} change refused: ${long}.`);
    err.code = 'QUESTION_TOO_LONG';
    throw err;
  }
  const q = rt.createQuestion(caseId, {
    kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text, options: APPROVE_REJECT,
    payload: { type: 'envelope-delta', envelopeId: env.id, fromHash: env.hash, deltas, mcpAnswerable: true }
  }, { charge: false });
  const current = store.get(env.id) || env;
  current.pendingDelta = { questionId: q.id, deltas, fromHash: env.hash };
  store.write(current);
  journal(reg, caseId, `Envelope ${env.id} needs the owner's approval for: ${deltas.map((d) => deltaText(env, d, { facts })).join('; ')} (${q.id}).`);
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
  const signed = effectiveAuthority(reg, caseId, env) === 'signed';
  if (env.status === 'requested' && signed && env.questionId) {
    // Final review minor 1: the in-app Reject of a signed envelope counts;
    // an approve here does not (the phone approves).
    const q = questions.get(env.questionId);
    const bound = q && q.payload?.type === 'envelope' && q.payload.envelopeId === env.id && q.payload.hash === env.hash;
    if (bound && q.answer && q.answer.optionId === 'reject') {
      withdrawSignedRequest(reg, caseId, env.id);
      move(env, 'rejected', 'the owner rejected it');
      return;
    }
  }
  if (env.status === 'requested' && !signed && env.questionId) {
    const q = questions.get(env.questionId);
    const bound = q && q.payload?.type === 'envelope' && q.payload.envelopeId === env.id && q.payload.hash === env.hash;
    if (bound && q.answer && q.answer.optionId === 'approve') {
      env.grantedBy = { channel: q.answer.channel, at: q.answer.at, questionId: q.id, factId: q.answer.factId || null, evidence: null };
      move(env, 'active', `approved via ${q.answer.channel}`);
    } else if (bound && q.answer && q.answer.optionId === 'reject') {
      move(env, 'rejected', 'the owner rejected it');
      return;
    } else if (q && q.answer && q.answer.optionId === 'approve' && env.staleAnswer !== q.id) {
      // Journaled once per answer; the envelope stays requested.
      env.staleAnswer = q.id;
      store.write(env);
      journal(reg, caseId, `Envelope ${env.id}: the owner approved a different version; request it again (${q.id}).`);
    }
  }
  if (env.pendingDelta) {
    const q = questions.get(env.pendingDelta.questionId);
    const p = q?.payload || {};
    const clear = (why) => {
      env.pendingDelta = null;
      store.write(env);
      journal(reg, caseId, `Envelope ${env.id}: ${why}`);
    };
    if (q && q.answer && q.answer.optionId === 'approve') {
      const bound = p.type === 'envelope-delta' && p.envelopeId === env.id && p.fromHash === env.hash
        && deltasEqual(p.deltas, env.pendingDelta.deltas);
      if (!bound) {
        clear(`the owner approved a different version; request it again (${q.id}).`);
        return;
      }
      let next;
      try {
        next = applyDeltas(env, p.deltas, { questionId: q.id, factId: q.answer.factId || null, at: q.answer.at });
      } catch (err) {
        clear(`the approved change could not be applied (${q.id}): ${err.message}.`);
        return;
      }
      next.pendingDelta = null;
      if (signed) {
        next.status = 'requested';
        next.grantedBy = null;
      }
      store.write(next);
      transitions.push({ envelopeId: env.id, status: next.status });
      journal(reg, caseId, `Envelope ${env.id} is version ${next.version} (${next.hash}): ${p.deltas.map((d) => deltaText(env, d)).join('; ')}.`);
      if (signed) {
        const approver = reg.getPhoneApprover();
        if (approver) startSignedRequest(reg, caseId, next, approver, null);
      }
      return;
    }
    if (q && (q.closed || q.answer)) {
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

// Jobs under this envelope that are open but have not recorded their send
// yet (still inside adapter.submit, or held unconfirmed): recordSend has not
// added their contacts and attempts to `usage`. → the envelope with a usage
// that counts them, for a fit; the stored envelope is never changed.
function withPendingJobs(reg, caseId, env) {
  if (!env) return env;
  const recorded = new Set((Array.isArray(env.payloads) ? env.payloads : []).map((p) => p && p.jobId).filter(Boolean));
  const usage = { usd: 0, contacts: [], attempts: {}, ...(env.usage || {}) };
  const contacts = [...(Array.isArray(usage.contacts) ? usage.contacts : [])];
  const attempts = { ...(usage.attempts || {}) };
  let any = false;
  for (const job of new JobStore(reg.caseDir(caseId)).list()) {
    if (!job || job.envelopeId !== env.id || !isOpen(job.state) || recorded.has(job.id)) continue;
    any = true;
    const per = Number(job.originalPayload?.attemptsPerContact) || 1;
    for (const r of Array.isArray(job.recipients) ? job.recipients : []) {
      if (!contacts.includes(r)) contacts.push(r);
      attempts[r] = (Number(attempts[r]) || 0) + per;
    }
  }
  return any ? { ...env, usage: { ...usage, contacts, attempts } } : env;
}

// New contacts of this case's open jobs that the case's contactsPerDay has
// not been charged for yet (a job charges at commit: jobs.js recordSend).
function pendingJobContacts(reg, caseId) {
  let n = 0;
  for (const job of new JobStore(reg.caseDir(caseId)).list()) {
    if (!job || !isOpen(job.state) || job.contactsCharged === true) continue;
    n += Math.max(0, Math.floor(Number(job.newContacts) || 0));
  }
  return n;
}

// Every recipient of a job still open under this envelope. Such a job read
// the envelope's contacts when it was checked, so none of them may be taken
// out of `usage.contacts` (or refunded) under it.
function openJobRecipients(reg, caseId, envelopeId) {
  const out = new Set();
  for (const job of new JobStore(reg.caseDir(caseId)).list()) {
    if (!job || job.envelopeId !== envelopeId || !isOpen(job.state)) continue;
    for (const r of Array.isArray(job.recipients) ? job.recipients : []) out.add(r);
  }
  return out;
}

// The channel id a send is checked under: 'call' is 'voice', as in the
// contact ladders. Anything that is not a string is null (refused).
function sendChannel(channelId) {
  if (typeof channelId !== 'string' || !channelId) return null;
  return channelId === 'call' ? 'voice' : channelId;
}

// For ContactRouter.sendExternal: the envelope a channel send to anyone but
// the owner goes out under. → { ok: true, envelope } only for the envelope
// as stored in the case (never a caller's object), intact, `active`, for the
// named executor, naming this channel in its `channels` (an envelope with no
// such list allows no channel send), with every recipient in it, today in
// its window and one more attempt per recipient inside its caps
// (envelopeFit; a delta is a refusal here, there is no delta question), and
// with its phone grant when it is `signed`. Never throws. It reads only:
// channel-send.js counts the send (reserveChannelSend runs this check again
// at the moment it counts).
function sendEnvelope(reg, { caseId, envelopeId, executorId, recipients, channelId } = {}) {
  const refuse = (error) => ({ ok: false, error });
  const NEEDS = 'a send to anyone but the owner needs an owner-approved envelope';
  try {
    const channel = sendChannel(channelId);
    if (!channel) return refuse(`${NEEDS} that names the channel; no channel was named`);
    if (typeof envelopeId !== 'string' || !envelopeId) return refuse(`${NEEDS}; none was named`);
    if (typeof executorId !== 'string' || !executorId) return refuse(`${NEEDS} for the executor that sends; no executor was named`);
    const entry = reg.get(executorId, { caseId });
    if (!entry) return refuse(`unknown executor "${executorId}"`);
    if (!entry.available) return refuse(`${entry.id} is unavailable: ${entry.reason}`);
    const env = new EnvelopeStore(reg.caseDir(caseId)).get(envelopeId);
    if (!env) return refuse(`${envelopeId} was not found in this case`);
    const fit = envelopeFit(withPendingJobs(reg, caseId, env), {}, {
      facts: reg.caseRuntime.ledger(caseId).view().facts, recipients, now: reg.now(), estimateUsd: 0, executorId: entry.id, channel
    });
    const problems = [...fit.refusals, ...fit.deltas.map((d) => d.text)];
    // envelopeFit also fits `expired` and `exhausted` (they take a delta); a send needs `active`.
    if (env.status !== 'active' && !problems.some((p) => p.includes(` is ${env.status}`))) problems.unshift(`envelope ${env.id} is ${env.status}`);
    if (problems.length) return refuse(`outside envelope ${env.id}: ${problems.join('; ')}`);
    if (effectiveAuthority(reg, caseId, env) === 'signed') {
      const v = verifyEnvelopeGrant(reg, caseId, env);
      if (!v || v.ok !== true) return refuse(v?.error || `envelope ${env.id} has no verified phone grant`);
    }
    return { ok: true, envelope: env };
  } catch (err) {
    log.warn(`Envelope check for a send in ${caseId} failed: ${err.message}`);
    return refuse(`the envelope could not be checked: ${err.message}`);
  }
}

module.exports = {
  sendEnvelope,
  sendChannel,
  withPendingJobs,
  openJobRecipients,
  pendingJobContacts,
  requestEnvelope,
  syncEnvelopes,
  requestDelta,
  applySignedOutcome,
  applyPendingSignedGrants,
  revokeEnvelope,
  signedOutcomesFor,
  effectiveAuthority,
  grantCheckOptions,
  verifyEnvelopeGrant
};

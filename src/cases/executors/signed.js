// src/cases/executors/signed.js
// authority: signed (cases stage 3 spec §3.6). The envelope file is never
// trusted: a grant is proven by an approve Outcome held in memory or by the
// hash-chained audit ledger (F3 §4.16).
const { canonicalize, sha256b64url } = require('../../platform/jcs');
const { envelopeCore, envelopeHash, renderSignedSummary } = require('./envelope');

const SUMMARY_MAX = 300;
const NOT_FOUND = 'signed approval not found for this envelope; ask again';

// The spec keeps F3 optional, so this require is soft. F3 has merged, so
// the require always succeeds today and the fallbacks below are unused
// (ruling M19).
function loadApprovalMessages() {
  try {
    return require('../../approvals/messages');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('approvals')) return null;
    throw err;
  }
}

// Identical to F3's envelopeAction (program §4.12) for nodes without F3.
function fallbackEnvelopeAction({ executorId, caseId, envelopeHash: hash, summary }) {
  const chars = Array.from(String(summary || `Run ${executorId} for case ${caseId}`));
  const text = chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : chars.join('');
  return { kind: 'envelope', name: String(executorId), params: { case_id: String(caseId), envelope_hash: String(hash) }, summary: text };
}

function approvalHelpers(messages = loadApprovalMessages()) {
  return {
    envelopeAction: typeof messages?.envelopeAction === 'function' ? messages.envelopeAction : fallbackEnvelopeAction,
    actionHash: typeof messages?.actionHash === 'function' ? messages.actionHash : (action) => sha256b64url(canonicalize(action))
  };
}

// The action for the live envelope: its hash is recomputed from the core.
function signedAction(env, caseId, helpers = approvalHelpers()) {
  const core = envelopeCore(env);
  return helpers.envelopeAction({ executorId: env.executor, caseId, envelopeHash: envelopeHash(core), summary: renderSignedSummary(core) });
}

function decodeSealed(sealed) {
  try {
    return JSON.parse(Buffer.from(String(sealed?.payload || ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// F3's phone approver (src/approvals/phone-approver.js) audits
// `approval.request` { job_id, envelope }, then `approval.response`
// { request_id, device_id, decision, envelope, job_id } *before* its
// post-audit re-checks (action_changed, expired, withdrawn), and finally
// `approval.outcome` { request_id, state, reason, job_id } from _finish.
// Only the outcome is the final decision (ruling M13): the grant needs the
// request for this exact action, an approve response, and outcomes for that
// request that are all 'approved' — none at all fails closed.
function auditProvesGrant(entries, requestId, hash) {
  let requested = false;
  let approved = false;
  let outcomes = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'approval.request') {
      const m = decodeSealed(e.data?.envelope);
      if (m && m.request_id === requestId && m.action_hash === hash) requested = true;
    } else if (e.kind === 'approval.response' && e.data?.request_id === requestId) {
      if (e.data.decision === 'approve') approved = true;
    } else if (e.kind === 'approval.outcome' && e.data?.request_id === requestId) {
      if (e.data.state !== 'approved') return false;
      outcomes += 1;
    }
  }
  return requested && approved && outcomes > 0;
}

function verifySignedGrant(env, { caseId, outcomes = [], auditLedger = null, auditScanEntries = 5000, helpers = null } = {}) {
  const h = helpers || approvalHelpers();
  if (envelopeHash(envelopeCore(env)) !== env.hash) {
    return { ok: false, error: 'envelope changed since approval; request it again' };
  }
  const hash = h.actionHash(signedAction(env, caseId, h));
  if ((outcomes || []).some((o) => o && o.decision === 'approve' && o.action_hash === hash)) return { ok: true, via: 'memory' };
  const requestId = env.grantedBy?.evidence?.request_id;
  if (auditLedger && requestId) {
    let verified = null;
    let entries = [];
    try {
      verified = auditLedger.verify();
      if (verified && verified.ok === true) entries = auditLedger.tail(auditScanEntries) || [];
    } catch {
      verified = null;
    }
    if (verified && verified.ok === true && Array.isArray(entries) && auditProvesGrant(entries, requestId, hash)) {
      return { ok: true, via: 'audit' };
    }
  }
  return { ok: false, error: NOT_FOUND };
}

module.exports = { approvalHelpers, signedAction, verifySignedGrant, decodeSealed, fallbackEnvelopeAction };

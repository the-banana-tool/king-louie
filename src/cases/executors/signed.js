// src/cases/executors/signed.js
// authority: signed (cases stage 3 spec §3.6). The envelope file is never
// trusted: a grant is proven by an approve Outcome held in memory or by the
// hash-chained audit ledger (F3 §4.16), whose phone and node signatures are
// checked here, because the ledger's chain has no key and lives in the
// service-writable data dir (ruling T4-C1).
const { canonicalize, sha256b64url } = require('../../platform/jcs');
const { envelopeCore, envelopeHash, envelopeIntact, renderSignedSummary } = require('./envelope');

const SUMMARY_MAX = 300;
const NOT_FOUND = 'signed approval not found for this envelope; ask again';
const TAMPERED = 'envelope changed since approval; request it again';

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

// The signature checks need F3's verifiers; without F3 the audit path
// cannot prove anything and fails closed.
function loadVerifiers() {
  try {
    const { verifyDeviceEnvelope } = require('../../approvals/verify-device');
    const { open, verifyEd25519 } = require('../../approvals/envelope');
    const { validateMessage } = require('../../approvals/messages');
    const { deriveNodeId } = require('../../mesh/node-identity');
    return { verifyDeviceEnvelope, open, verifyEd25519, validateMessage, deriveNodeId };
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
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

// The action for the live envelope: its hash is recomputed from the core,
// and the summary names the envelope id, so an approval covers one envelope.
function signedAction(env, caseId, helpers = approvalHelpers()) {
  const core = envelopeCore(env);
  return helpers.envelopeAction({ executorId: env.executor, caseId, envelopeHash: envelopeHash(core), summary: renderSignedSummary(core, env.id) });
}

// Reads a sealed payload WITHOUT checking its signature. Only for envelopes
// that have already been verified; never a basis for a trust decision.
function decodeSealed(sealed) {
  try {
    return JSON.parse(Buffer.from(String(sealed?.payload || ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function spkiHex(key) {
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) return Buffer.from(key).toString('hex');
  return typeof key === 'string' && /^[0-9a-f]+$/i.test(key) ? key.toLowerCase() : null;
}

// The node-signed kl.approval.request: a well-formed message for this
// request and this exact action, signed by this node's key. → message | null
function verifiedRequest(sealed, v, { nodeId, keyHex, requestId, hash }) {
  let opened;
  try {
    opened = v.open(sealed);
  } catch {
    return null;
  }
  const m = opened.message;
  if (v.validateMessage('kl.approval.request', m)) return null;
  if (sealed.alg !== 'Ed25519' || sealed.kid !== nodeId || m.node_id !== nodeId) return null;
  if (!v.verifyEd25519(sealed, keyHex)) return null;
  if (m.request_id !== requestId || m.action_hash !== hash) return null;
  return m;
}

// The phone-signed kl.approval.response, through F3's device-envelope check
// (known, trusted, unrevoked approver; signature; this node), bound to the
// request: same request_id, action_hash, nonce and expiry, decision approve.
function responseApproves(sealed, v, { approverStore, nodeId, request }) {
  let r;
  try {
    r = v.verifyDeviceEnvelope(sealed, { approverStore, type: 'kl.approval.response', nodeId });
  } catch {
    return false;
  }
  if (!r || r.ok !== true) return false;
  const m = r.message;
  return m.request_id === request.request_id
    && m.action_hash === request.action_hash
    && m.nonce === request.nonce
    && m.expires_at === request.expires_at
    && m.decision === 'approve';
}

// F3's phone approver (src/approvals/phone-approver.js) audits
// `approval.request` { job_id, envelope }, then `approval.response`
// { request_id, device_id, decision, envelope, job_id } *before* its
// post-audit re-checks (action_changed, expired, withdrawn), and finally
// `approval.outcome` { request_id, state, reason, job_id } from _finish.
// The unsigned `data` fields are only used to find entries; the decision is
// read from the signed envelopes. The outcome is F3's final decision (ruling
// M13): outcomes for the request must exist and all be 'approved'.
function auditProvesGrant(entries, { requestId, hash, approverStore, nodeId, keyHex, v }) {
  let request = null;
  for (const e of entries) {
    if (e && e.kind === 'approval.request') {
      request = verifiedRequest(e.data?.envelope, v, { nodeId, keyHex, requestId, hash });
      if (request) break;
    }
  }
  if (!request) return false;
  let approved = false;
  let outcomes = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'approval.response' && !approved) {
      approved = responseApproves(e.data?.envelope, v, { approverStore, nodeId, request });
    } else if (e.kind === 'approval.outcome' && e.data?.request_id === requestId) {
      if (e.data.state !== 'approved') return false;
      outcomes += 1;
    }
  }
  return approved && outcomes > 0;
}

function auditTrustReady({ approverStore, nodeId, nodePublicKey }, v) {
  if (!v || !approverStore || typeof nodeId !== 'string' || !nodeId) return null;
  const keyHex = spkiHex(nodePublicKey);
  if (!keyHex) return null;
  try {
    if (v.deriveNodeId(keyHex) !== nodeId) return null;
  } catch {
    return null;
  }
  return keyHex;
}

// `outcomes` (the memory path) must come only from F3 approver results
// (`approver.requestAction`), held in process memory by the envelope flows.
// The registry's `signedOutcomes` must never be reachable from a tool,
// a file or anything the model can write: an entry there is a grant.
//
// The audit path needs `approverStore` (F3's ApproverStore), `nodeId` and
// `nodePublicKey` (this node's Ed25519 SPKI, Buffer or hex); without them it
// fails closed.
function verifySignedGrant(env, {
  caseId, outcomes = [], auditLedger = null, auditScanEntries = 5000, helpers = null, approverStore = null, nodeId = null, nodePublicKey = null
} = {}) {
  if (!envelopeIntact(env)) return { ok: false, error: TAMPERED };
  let hash;
  try {
    const h = helpers || approvalHelpers();
    hash = h.actionHash(signedAction(env, caseId, h));
  } catch {
    return { ok: false, error: NOT_FOUND };
  }
  if (typeof hash !== 'string' || !hash) return { ok: false, error: NOT_FOUND };
  if ((outcomes || []).some((o) => o && o.decision === 'approve' && o.action_hash === hash)) return { ok: true, via: 'memory' };
  const requestId = env.grantedBy?.evidence?.request_id;
  const v = auditLedger && requestId ? loadVerifiers() : null;
  const keyHex = v ? auditTrustReady({ approverStore, nodeId, nodePublicKey }, v) : null;
  if (keyHex) {
    try {
      const verified = auditLedger.verify();
      const entries = verified && verified.ok === true ? auditLedger.tail(auditScanEntries) : null;
      if (Array.isArray(entries) && auditProvesGrant(entries, { requestId, hash, approverStore, nodeId, keyHex, v })) {
        return { ok: true, via: 'audit' };
      }
    } catch {
      // A ledger or verifier that throws proves nothing.
    }
  }
  return { ok: false, error: NOT_FOUND };
}

module.exports = { approvalHelpers, signedAction, verifySignedGrant, decodeSealed, fallbackEnvelopeAction };

// What the front door (and, for the front-door-signed messages, a node or a
// phone) checks before acting on a client-grant-v1 message
// (docs/protocol/client-grant-v1.md §4). Steps run in the order below and the
// first failure decides `reason`; the vectors pin that order. Acceptance
// never judges signed_at or created_at: freshness comes from a pending item
// or a challenge held on the verifier's own clock.
const crypto = require('crypto');
const { open, verifyEs256, verifyEd25519, EnvelopeError } = require('../../approvals/envelope');
const { validateMessage } = require('../../approvals/messages');
const { isTestDeviceKey } = require('../../approvals/test-keys');
const { deriveNodeId } = require('../../mesh/node-identity');
const { spkiHexFromRaw } = require('./messages');

const FLEET_SCOPE_RULES = Object.freeze({
  supported: Object.freeze(['fleet:delegate', 'fleet:read', 'fleet:run', 'fleet:unsafe']),
  requires: Object.freeze({ 'fleet:unsafe': Object.freeze(['fleet:run', 'fleet:delegate']) })
});

const fail = (reason) => ({ ok: false, reason });

function openTyped(envelope, type) {
  let opened;
  try {
    opened = open(envelope);
  } catch (e) {
    if (e instanceof EnvelopeError) return { error: 'malformed' };
    throw e;
  }
  const shape = validateMessage(type, opened.message);
  return shape ? { error: shape } : opened;
}

function scopeProblem(names, { supported, requires }) {
  for (const n of names) if (!supported.includes(n)) return 'invalid_scope';
  for (const n of names) {
    const anyOf = requires[n];
    if (anyOf && !anyOf.some((r) => names.includes(r))) return 'invalid_scope';
  }
  return null;
}

function verifyPhoneEnvelope(envelope, { approverStore, type, frontdoorId, acceptedAt = null }) {
  const opened = openTyped(envelope, type);
  if (opened.error) return fail(opened.error);
  const { message, bytes } = opened;
  if (envelope.alg !== 'ES256' || envelope.kid !== message.device_id) return fail('malformed');
  const record = approverStore.get(envelope.kid);
  if (!record) return fail('unknown_device');
  if (record.platform === 'demo') return fail('demo_device');
  if (!approverStore.allowTestKeys && isTestDeviceKey(record.public_key)) return fail('test_key');
  if (acceptedAt === null) {
    if (!approverStore.isActive(envelope.kid)) return fail('revoked_device');
  } else if (record.revoked_at !== null && !(Date.parse(acceptedAt) < Date.parse(record.revoked_at))) {
    // R25: revoking a device ends what it signs from then on; what the
    // front door accepted before stays valid.
    return fail('revoked_device');
  }
  if (!verifyEs256(envelope, record.public_key)) return fail('bad_signature');
  if (message.frontdoor_id !== frontdoorId) return fail('wrong_frontdoor');
  return { ok: true, reason: null, message, bytes, deviceId: envelope.kid };
}

function checkGrantDecision(envelope, { approverStore, frontdoorId, pending, scopes = FLEET_SCOPE_RULES, now }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.client.grant', frontdoorId });
  if (!v.ok) return v;
  const m = v.message;
  if (!pending || m.grant_id !== pending.grant_id) return fail('unknown_request');
  if (pending.claimed_by && pending.claimed_by !== v.deviceId) return fail('not_claimant');
  if (!(now <= pending.expires_at_ms)) return fail('expired');
  if (m.client_id !== pending.client_id || m.redirect_uri !== pending.redirect_uri || m.resource !== pending.resource
    || m.code_challenge !== pending.code_challenge) return fail('binding_mismatch');
  if (m.user_code !== pending.user_code) return fail('user_code_mismatch');
  if (pending.nonces && pending.nonces.has(m.nonce)) return fail('replay');
  if (m.decision === 'approve') {
    const names = m.scopes.map((s) => s.scope);
    if (names.some((n) => !pending.requested_scopes.includes(n))) return fail('invalid_scope');
    const problem = scopeProblem(names, scopes);
    if (problem) return fail(problem);
  }
  return v;
}

function takeChallenge(v, challenges) {
  const r = challenges.take(v.deviceId, v.message.challenge);
  if (r === 'ok') return v;
  return fail(r === 'expired' ? 'challenge_expired' : r === 'reused' ? 'challenge_reused' : 'unknown_challenge');
}

function checkClientRevoke(envelope, { approverStore, frontdoorId, challenges }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.client.revoke', frontdoorId });
  return v.ok ? takeChallenge(v, challenges) : v;
}

function checkNodeRemove(envelope, { approverStore, frontdoorId, challenges }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.node.remove', frontdoorId });
  return v.ok ? takeChallenge(v, challenges) : v;
}

function derivedNodeId(rawKey) {
  try {
    return deriveNodeId(spkiHexFromRaw(rawKey));
  } catch {
    return null;
  }
}

function checkNodeEnroll(envelope, { approverStore, frontdoorId, pairing, now }) {
  const v = verifyPhoneEnvelope(envelope, { approverStore, type: 'kl.node.enroll', frontdoorId });
  if (!v.ok) return v;
  const m = v.message;
  if (derivedNodeId(m.public_key) !== m.node_id) return fail('node_id_mismatch');
  if (!pairing || m.pairing_id !== pairing.pairing_id) return fail('unknown_pairing');
  if (!(now <= pairing.expires_at_ms)) return fail('expired');
  for (const k of ['node_id', 'node_name', 'profile', 'public_key', 'tls_fingerprint', 'replaces']) {
    if (m[k] !== (pairing[k] === undefined ? null : pairing[k])) return fail('binding_mismatch');
  }
  if (pairing.nonces && pairing.nonces.has(m.nonce)) return fail('replay');
  return v;
}

function checkNodePair(envelope, { frontdoorHost }) {
  const opened = openTyped(envelope, 'kl.node.pair');
  if (opened.error) return fail(opened.error);
  const m = opened.message;
  if (envelope.alg !== 'Ed25519' || envelope.kid !== m.node_id) return fail('malformed');
  let spki;
  try {
    spki = spkiHexFromRaw(m.public_key);
  } catch {
    return fail('malformed');
  }
  if (deriveNodeId(spki) !== m.node_id) return fail('node_id_mismatch');
  if (!verifyEd25519(envelope, spki)) return fail('bad_signature');
  if (m.frontdoor_host !== frontdoorHost) return fail('wrong_host');
  let tlsFingerprint;
  try {
    tlsFingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(m.tls_cert).raw).digest('hex');
  } catch {
    return fail('malformed');
  }
  return { ok: true, reason: null, message: m, publicKeySpkiHex: spki, tlsFingerprint };
}

function checkFrontDoorSigned(envelope, type, frontdoorId, spkiHex) {
  const opened = openTyped(envelope, type);
  if (opened.error) return fail(opened.error);
  const m = opened.message;
  if (envelope.alg !== 'Ed25519') return fail('malformed');
  if (envelope.kid !== frontdoorId || m.frontdoor_id !== frontdoorId) return fail('wrong_frontdoor');
  if (!verifyEd25519(envelope, spkiHex)) return fail('bad_signature');
  return { ok: true, reason: null, message: m };
}

// The node's side of §3.11 step 3: the key comes with the message, and the
// front door id is what that key derives (the owner compares its fingerprint).
function verifyPairAccept(envelope, { nodeId, nonce }) {
  const opened = openTyped(envelope, 'kl.node.pair.accept');
  if (opened.error) return fail(opened.error);
  let spki;
  try {
    spki = spkiHexFromRaw(opened.message.frontdoor_public_key);
  } catch {
    return fail('malformed');
  }
  const frontdoorId = deriveNodeId(spki);
  const v = checkFrontDoorSigned(envelope, 'kl.node.pair.accept', frontdoorId, spki);
  if (!v.ok) return v;
  if (v.message.node_id !== nodeId) return fail('wrong_node');
  if (v.message.nonce !== nonce) return fail('nonce_mismatch');
  return { ...v, frontdoorId, frontdoorSpkiHex: spki };
}

// The phone's re-pin rule (§3.3.1), ported for tests and doctor.
function verifyRepin(envelope, { frontdoorId, frontdoorPublicKey, receivedSpki, currentPin }) {
  let spki;
  try {
    spki = spkiHexFromRaw(frontdoorPublicKey);
  } catch {
    return fail('malformed');
  }
  const v = checkFrontDoorSigned(envelope, 'kl.relay.repin', frontdoorId, spki);
  if (!v.ok) return v;
  if (v.message.new_spki !== receivedSpki) return fail('spki_mismatch');
  if (v.message.old_spki !== currentPin) return fail('old_pin_mismatch');
  return v;
}

module.exports = {
  FLEET_SCOPE_RULES,
  scopeProblem,
  verifyPhoneEnvelope,
  checkGrantDecision,
  checkClientRevoke,
  checkNodeRemove,
  checkNodeEnroll,
  checkNodePair,
  verifyPairAccept,
  verifyRepin
};

// The one check every phone-signed envelope passes on a node: approval
// responses here, `kl.lease.*` in F5, `kl.question.answer` in C4. Steps run in
// the order of the spec's table and the first failure decides `reason`; the
// approval-v1 vectors pin that order.
const crypto = require('crypto');
const { open, verifyEs256, EnvelopeError } = require('./envelope');
const { validateMessage, enrollMac } = require('./messages');
const { isTestDeviceKey } = require('./test-keys');

// Nonces of decided messages, in memory. `get` → { sha256 } | null.
class NonceCache {
  constructor({ max = 10000, ttlMs = 600000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  _prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [nonce, entry] of this.entries) {
      if (entry.at >= cutoff && this.entries.size <= this.max) break;
      this.entries.delete(nonce);
    }
  }

  get(nonce) {
    this._prune();
    const entry = this.entries.get(nonce);
    return entry ? { sha256: entry.sha256 } : null;
  }

  add(nonce, sha256) {
    this.entries.delete(nonce);
    this.entries.set(nonce, { sha256, at: this.now() });
    this._prune();
  }
}

function bytesSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

function verifyDeviceEnvelope(envelope, { approverStore, type, nodeId, nonces = null, overlay = true } = {}) {
  const fail = (reason) => ({ ok: false, reason });

  // 1. Opens, canonical bytes, v === 1, the expected type, well-formed fields.
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    if (err instanceof EnvelopeError) return fail('malformed');
    throw err;
  }
  const { message, bytes } = opened;
  const shape = validateMessage(type, message);
  if (shape) return fail(shape);

  // 2. A phone signature, by the device the message names.
  if (envelope.alg !== 'ES256' || envelope.kid !== message.device_id) return fail('malformed');

  // 3–5. A known, real, currently trusted approver.
  const record = approverStore.get(envelope.kid);
  if (!record) return fail('unknown_device');
  if (record.platform === 'demo') return fail('demo_device');
  if (!approverStore.allowTestKeys && isTestDeviceKey(record.public_key)) return fail('test_key');
  if (!approverStore.isActive(envelope.kid, { overlay })) return fail('revoked_device');

  // 6. Signature over the bytes received.
  if (!verifyEs256(envelope, record.public_key)) return fail('bad_signature');

  // 7. Meant for this node.
  if (message.node_id !== nodeId) return fail('wrong_node');

  // 8. Single use: the same bytes again is a replay; different bytes for a
  // decided nonce (a second phone) is already_decided.
  if (nonces) {
    const seen = nonces.get(message.nonce);
    if (seen) return fail(seen.sha256 === bytesSha256(bytes) ? 'replay' : 'already_decided');
  }
  return { ok: true, message, bytes, deviceId: envelope.kid };
}

// The console side of `enroll-device` (§3.10 step 4): the phone signed its own
// kl.device.enroll with the key it enrolls, and proved it scanned the QR with
// code_mac = HMAC-SHA256(code, JCS(message without code_mac)). The relay never
// sees `code`, so it cannot forge this.
function verifyConsoleEnrollment(envelope, { codeId, code, now = Date.now(), allowTestKeys = false } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  let opened;
  try {
    opened = open(envelope);
  } catch (err) {
    if (err instanceof EnvelopeError) return fail('malformed');
    throw err;
  }
  const { message } = opened;
  const shape = validateMessage('kl.device.enroll', message);
  if (shape) return fail(shape);
  if (message.enrolled_by !== null) return fail('malformed');
  if (envelope.alg !== 'ES256' || envelope.kid !== message.device.device_id) return fail('malformed');
  if (message.code_id !== codeId) return fail('wrong_code');
  if (message.device.platform === 'demo') return fail('demo_device');
  if (!allowTestKeys && isTestDeviceKey(message.device.public_key)) return fail('test_key');
  if (!verifyEs256(envelope, message.device.public_key)) return fail('bad_signature');
  const { code_mac: mac, ...withoutMac } = message;
  const expected = Buffer.from(enrollMac(code, withoutMac));
  const given = Buffer.from(String(mac));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return fail('bad_mac');
  // `!(now <= expires)` rather than `now > expires`: a NaN or otherwise
  // non-number `now` makes both comparisons false, and the negated form is
  // the one that fails closed (rejects as expired) in that case.
  if (!(now <= Date.parse(message.expires_at))) return fail('expired');
  return { ok: true, message, deviceId: message.device.device_id };
}

module.exports = { verifyDeviceEnvelope, verifyConsoleEnrollment, NonceCache, bytesSha256 };

// What a window's enrollment says to the phones (remote window plan R-RW-14, R-RW-34),
// beside the validators in messages.js. A front door carries all of it and is trusted
// with none of it: the requests, the answers, the revokes and the lists are sealed, and
// each is checked against a key the front door never gave anyone.
//
// The phone compares two things the node and the window hold apart. `h` in the QR is
// SHA-256 over the window's key and the node's key, and the phone computes it from the
// opened request's key and its own pin for the node, never the request's `node_key`.
// The 6-digit code goes the other way: the phone shows it, the owner types it, and the
// window computes it over the key its handshake proved, with `n`, which never crosses
// a socket. So a key a front door hands a window earns nothing, however it answers.
const crypto = require('crypto');
const { seal, open, nodeSigner, verifyEs256, verifyEd25519, toB64url } = require('./envelope');
const { sealContent, openSealed, newSalt, saltedHash, SealError } = require('./seal');
const { MessageError, encodeQr, sealTargets, iso, randomNonce, validateOpenedWindow, validateMessage } = require('./messages');
const { isTestWindowKey } = require('./test-keys');

const ENROLL_TYPE = 'kl.window.enroll';
const RESPONSE_TYPE = 'kl.window.enroll.response';
const REVOKE_TYPE = 'kl.window.revoke';
const LIST_TYPE = 'kl.window.list';
const QR_TYPE = 'kl.window';
const ENROLL_TTL_MS = 10 * 60 * 1000;
const WINDOW_PLATFORM = 'windows';
const KEY_BYTES = 32;
const QR_NONCE_BYTES = 16;
const CODE_DOMAIN = Buffer.from('kl-window-confirm-v1\n', 'ascii');
const CODE_MODULUS = 1000000n;
// How far a phone's clock may run behind the node's when a revoke meets a record: a
// revoke dated this long before the record was written is about an earlier enrollment.
const REVOKE_SKEW_MS = 5 * 60 * 1000;

// Ed25519 points of order 1, 2, 4 and 8, as libsodium lists them, without the sign bit
// (p and p + 1 are the non-canonical forms of 0 and 1). OpenSSL verifies a crafted
// signature over any message for one of these (window-v1 §2), so none is ever stored.
const SMALL_ORDER = Object.freeze([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
]);

function rawKeyOf(value, what) {
  const bytes = Buffer.isBuffer(value) ? value : (value instanceof Uint8Array ? Buffer.from(value) : null);
  if (!bytes || bytes.length !== KEY_BYTES) throw new MessageError('malformed', `${what} is 32 raw bytes`);
  return bytes;
}

// The raw key at the end of a DER SPKI, given as hex or as bytes.
function rawNodeKey(spki) {
  const der = Buffer.isBuffer(spki) ? spki : Buffer.from(String(spki), 'hex');
  return der.subarray(-KEY_BYTES);
}

const spkiHex = (identity) => (Buffer.isBuffer(identity.publicKey) ? identity.publicKey.toString('hex') : String(identity.publicKey));

function enrollHashBytes(devRaw, nodeRaw) {
  return crypto.createHash('sha256').update(rawKeyOf(devRaw, 'a device key')).update(rawKeyOf(nodeRaw, 'a node key')).digest();
}

function qrNonce(nonce) {
  const bytes = Buffer.isBuffer(nonce) ? nonce : null;
  if (!bytes || bytes.length !== QR_NONCE_BYTES) throw new MessageError('malformed', 'n is 16 random bytes');
  return bytes;
}

// The window calls these (Task 10): `n` is made after its handshake and is sent nowhere.
function qrFor({ devicePublicKey, nodePublicKey, nonce }) {
  return encodeQr({ t: QR_TYPE, h: toB64url(enrollHashBytes(devicePublicKey, nodePublicKey)), n: toB64url(qrNonce(nonce)) });
}

function enrollCode({ nonce, devicePublicKey, nodePublicKey }) {
  const digest = crypto.createHash('sha256')
    .update(CODE_DOMAIN)
    .update(qrNonce(nonce))
    .update(rawKeyOf(devicePublicKey, 'a device key'))
    .update(rawKeyOf(nodePublicKey, 'a node key'))
    .digest();
  return String(digest.readBigUInt64BE(0) % CODE_MODULUS).padStart(6, '0');
}

function isSmallOrderKey(raw) {
  const masked = Buffer.from(rawKeyOf(raw, 'a key'));
  masked[KEY_BYTES - 1] &= 0x7f;
  return SMALL_ORDER.includes(masked.toString('hex'));
}

// Why this key may never be a window's, or null.
function refusedWindowKey(raw, { allowTestKeys = false } = {}) {
  if (isSmallOrderKey(raw)) return 'small_order_key';
  if (!allowTestKeys && isTestWindowKey(raw)) return 'test_key';
  return null;
}

// Born sealed (R-SP-14): there is no clear form, whatever the policy says of other types.
function windowTargets(sealPolicy) {
  const targets = sealTargets(sealPolicy);
  if (!targets) throw new MessageError('no_sealed_recipient', 'a window enrollment is never sent in clear');
  return targets;
}

function sealed(type, senderId, clear, content, recipients) {
  try {
    return sealContent({ type, senderId, clear, content, recipients });
  } catch (err) {
    if (err instanceof SealError) throw new MessageError(err.reason, err.message);
    throw err;
  }
}

function buildWindowEnroll({ identity, window, nodeKey, sealPolicy, now = Date.now(), requestId = null, nonce = null }) {
  const targets = windowTargets(sealPolicy);
  const salt = newSalt();
  const hash = saltedHash(salt, { window, node_key: nodeKey });
  const clear = {
    v: 1,
    type: ENROLL_TYPE,
    request_id: requestId || crypto.randomUUID(),
    node_id: identity.nodeId,
    node_name: String(identity.nodeName || 'unnamed-node'),
    enroll_hash: hash,
    created_at: iso(now),
    expires_at: iso(now + ENROLL_TTL_MS),
    nonce: nonce || randomNonce(),
    node_box: targets.nodeBox
  };
  const message = sealed(ENROLL_TYPE, targets.senderId, clear, { window, node_key: nodeKey, salt }, targets.recipients);
  return { message, envelope: seal(message, nodeSigner(identity)), salt, hash };
}

// To one phone, sealed to it alone: what a phone is told of the windows goes to no other.
function buildWindowList({ identity, toDevice, recipientBox, windows, now = Date.now(), nonce = null }) {
  if (!identity.box) throw new MessageError('no_sealed_recipient', 'this node has no box key');
  const clear = { v: 1, type: LIST_TYPE, node_id: identity.nodeId, to_device: toDevice, at: iso(now), nonce: nonce || randomNonce(), node_box: identity.box.jwk };
  const message = sealed(LIST_TYPE, identity.nodeId, clear, { windows }, { [toDevice]: recipientBox });
  return seal(message, nodeSigner(identity));
}

// A request envelope as this node signed it: → { reason: null, message, content }, or the
// reason it is not. A staged copy is the service account's to write, so an administrator's
// CLI asks this of it: the signature first, and nothing is believed before it holds.
function openWindowEnroll({ envelope, nodeSpki, nodeId, agree }) {
  let message;
  try {
    ({ message } = open(envelope));
  } catch {
    return { reason: 'malformed' };
  }
  if (envelope.alg !== 'Ed25519' || envelope.kid !== nodeId || message.node_id !== nodeId || !verifyEd25519(envelope, nodeSpki)) return { reason: 'bad_node_signature' };
  if (validateMessage(ENROLL_TYPE, message)) return { reason: 'malformed' };
  let opened;
  try {
    opened = openSealed({ type: ENROLL_TYPE, message, recipientId: nodeId, agree });
  } catch {
    return { reason: 'open_failed' };
  }
  const fault = validateOpenedWindow(ENROLL_TYPE, opened.message);
  if (fault) return { reason: fault };
  if (opened.content.node_key !== nodeSpki) return { reason: 'wrong_node_key' };
  return { reason: null, message: opened.message, content: opened.content };
}

// What both a phone's answer and its revoke must show first: the shape, this node, and
// its signer's device key, so a read key's signature fails here. `signerOf` answers an
// approver record (with `inactive` set for one that no longer counts), or null.
function verifySigned(envelope, type, nodeId, signerOf) {
  let message;
  try {
    ({ message } = open(envelope));
  } catch {
    return { reason: 'malformed' };
  }
  if (validateMessage(type, message)) return { reason: 'malformed' };
  if (message.node_id !== nodeId) return { reason: 'wrong_node' };
  if (envelope.alg !== 'ES256' || envelope.kid !== message.device_id) return { reason: 'malformed' };
  const signer = signerOf(message.device_id);
  if (!signer) return { reason: 'unknown_device' };
  if (signer.inactive) return { reason: 'signer_not_active' };
  if (!verifyEs256(envelope, signer.public_key)) return { reason: 'bad_signature' };
  return { reason: null, message };
}

// A phone's answer: → { reason: null, decision, message } or { reason }. `expected` is the
// request's clear part. `now` null (device apply, days later) leaves out the expiry,
// which staging checked.
function verifyWindowResponse({ envelope, expected, nodeId, signerOf, agree, now = null }) {
  const { reason, message } = verifySigned(envelope, RESPONSE_TYPE, nodeId, signerOf);
  if (reason) return { reason };
  if (!expected || message.request_id !== expected.request_id) return { reason: 'unknown_request' };
  if (message.nonce !== expected.nonce) return { reason: 'nonce_mismatch' };
  if (message.enroll_hash !== expected.enroll_hash) return { reason: 'enroll_hash_mismatch' };
  if (message.expires_at !== expected.expires_at) return { reason: 'expires_mismatch' };
  if (now !== null && now > Date.parse(message.expires_at)) return { reason: 'expired' };
  let opened;
  try {
    opened = openSealed({ type: RESPONSE_TYPE, message, recipientId: nodeId, agree });
  } catch {
    return { reason: 'malformed' };
  }
  if (validateOpenedWindow(RESPONSE_TYPE, opened.message)) return { reason: 'malformed' };
  return { reason: null, decision: opened.message.decision, message: opened.message };
}

// A revoke's clear part and signature: `reason` inside the seal changes nothing, so a
// node need not open it to act. → { reason: null, message } or { reason }.
function verifyWindowRevoke({ envelope, nodeId, signerOf, now = null }) {
  const { reason, message } = verifySigned(envelope, REVOKE_TYPE, nodeId, signerOf);
  if (reason) return { reason };
  if (now !== null && now > Date.parse(message.expires_at)) return { reason: 'expired' };
  return { reason: null, message };
}

// True when a revoke dated `revokedAt` (ms) is about this record, not about an earlier
// enrollment of the same key. A close call counts as covered: that fails closed.
function revokeCovers(record, revokedAt) {
  return Date.parse(record.pairedAt) <= revokedAt + REVOKE_SKEW_MS;
}

module.exports = {
  ENROLL_TYPE,
  RESPONSE_TYPE,
  REVOKE_TYPE,
  LIST_TYPE,
  QR_TYPE,
  ENROLL_TTL_MS,
  WINDOW_PLATFORM,
  enrollHashBytes,
  qrFor,
  enrollCode,
  isSmallOrderKey,
  refusedWindowKey,
  rawNodeKey,
  spkiHex,
  buildWindowEnroll,
  buildWindowList,
  openWindowEnroll,
  verifyWindowResponse,
  verifyWindowRevoke,
  revokeCovers
};

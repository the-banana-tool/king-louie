// The seal: what a node and a phone exchange, unreadable to the relay between
// them (sealed phones plan, R-SP-1, R-SP-2, R-SP-4).
//
//   sealed = { v: 1, epk, iv, ct, keys }
//   ct     = AES-256-GCM(cek, iv, JCS(content), aad = JCS(clear part)) ‖ tag
//   keys   = { [recipient id]: AES-256-GCM(kek, 12 zero bytes, cek) ‖ tag }
//   kek    = HKDF-SHA256(ECDH(epk, recipient box key), salt = empty,
//                        info = "kl-seal-v1\n<type>\n<sender id>\n<recipient id>")
//
// The zero iv is safe because a kek is fresh per message and recipient: `epk`
// is new every time. An injected `ephemeral` is for vectors only.
//
// The message a validator checks is clear ∪ content. Nothing here reads a
// clear value but the sender id; whether the fields hold what they should is
// the validators' work.
const crypto = require('crypto');
const { canonicalize } = require('../platform/jcs');
const { deriveDeviceId, fingerprintGroups, fromB64url, isDeviceJwk, toB64url } = require('./envelope');

class SealError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'SealError';
    this.reason = reason;
  }
}

const freeze = (table) => Object.freeze(Object.fromEntries(Object.entries(table).map(([k, keys]) => [k, Object.freeze(keys)])));

// The content column of R-SP-4.
const SEAL_SPLIT = freeze({
  'kl.approval.request': ['action', 'origin', 'salt'],
  'kl.lease.request': ['lease', 'origin', 'salt'],
  'kl.lease.status': ['name'],
  'kl.lease.view': ['foreground', 'frame', 'frame_dropped', 'actions'],
  'kl.question.ask': ['case_id', 'question_id', 'case_title', 'text', 'options'],
  'kl.question.answer': ['case_id', 'question_id', 'answer']
});

// The clear column. A sealed message holds exactly these and `sealed`.
const SEAL_CLEAR = freeze({
  'kl.approval.request': ['v', 'type', 'request_id', 'node_id', 'node_name', 'action_hash', 'created_at', 'expires_at', 'nonce', 'node_box'],
  'kl.lease.request': ['v', 'type', 'request_id', 'lease_id', 'node_id', 'node_name', 'lease_hash', 'created_at', 'expires_at', 'nonce', 'node_box'],
  'kl.lease.status': ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'state', 'locked', 'reason', 'expires_at', 'contact_token', 'granted_by', 'kind', 'unattended'],
  'kl.lease.view': ['v', 'type', 'node_id', 'lease_id', 'seq', 'at', 'to_device', 'state', 'locked', 'remaining_s', 'contact_token'],
  'kl.question.ask': ['v', 'type', 'node_id', 'token', 'kind', 'urgency', 'expires_at', 'node_box'],
  'kl.question.answer': ['v', 'type', 'node_id', 'token', 'device_id', 'nonce', 'signed_at']
});

// Which clear key names the sender, the third line of the HKDF info. A phone
// sends only the answer; a node sends the rest.
const senderKey = (type) => (type === 'kl.question.answer' ? 'device_id' : 'node_id');

const SEALED_KEYS = 'ct,epk,iv,keys,v';
const RECIPIENT_ID_RE = /^(d|kl)-[a-z2-7]{16}$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAP_BYTES = KEY_BYTES + TAG_BYTES;
const ZERO_IV = Buffer.alloc(IV_BYTES);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isSealedType = (type) => typeof type === 'string' && Object.hasOwn(SEAL_SPLIT, type);

function byteLength(text) {
  try {
    return fromB64url(text).length;
  } catch {
    return -1;
  }
}

function hasExactly(object, keys) {
  const have = Object.keys(object);
  return have.length === keys.length && keys.every((k) => Object.hasOwn(object, k));
}

function isSealedObject(sealed) {
  if (!isPlainObject(sealed) || Object.keys(sealed).sort().join(',') !== SEALED_KEYS) return false;
  if (sealed.v !== 1 || !isDeviceJwk(sealed.epk)) return false;
  if (byteLength(sealed.iv) !== IV_BYTES || byteLength(sealed.ct) < TAG_BYTES) return false;
  if (!isPlainObject(sealed.keys)) return false;
  const entries = Object.entries(sealed.keys);
  return entries.length > 0 && entries.every(([id, wrap]) => RECIPIENT_ID_RE.test(id) && byteLength(wrap) === WRAP_BYTES);
}

// Exactly the type's clear keys plus `sealed`, and `sealed` well formed.
function isSealedShape(type, message) {
  if (!isSealedType(type) || !isPlainObject(message) || message.type !== type) return false;
  return hasExactly(message, [...SEAL_CLEAR[type], 'sealed']) && isSealedObject(message.sealed);
}

// JCS refuses what has no one encoding (a lone surrogate, a non-finite number).
function jcs(value, reason, what) {
  try {
    return canonicalize(value);
  } catch {
    throw new SealError(reason, `${what} cannot be canonicalized`);
  }
}

function ecPoint(jwk) {
  return Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
}

function newEphemeral() {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  return {
    jwk: { kty: 'EC', crv: 'P-256', x: toB64url(pub.subarray(1, 33)), y: toB64url(pub.subarray(33, 65)) },
    agree: (jwk) => ecdh.computeSecret(ecPoint(jwk))
  };
}

function kekFor(secret, type, senderId, recipientId) {
  const info = Buffer.from(`kl-seal-v1\n${type}\n${senderId}\n${recipientId}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, KEY_BYTES));
}

function gcmSeal(key, iv, plaintext, aad = null) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

// final() checks the tag; nothing update() gave leaves here until it has.
function gcmOpen(key, iv, sealedBytes, aad = null) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(sealedBytes.subarray(sealedBytes.length - TAG_BYTES));
  const body = decipher.update(sealedBytes.subarray(0, sealedBytes.length - TAG_BYTES));
  const tail = decipher.final();
  return Buffer.concat([body, tail]);
}

function freshBytes(random, length) {
  const bytes = random(length);
  if (!Buffer.isBuffer(bytes) || bytes.length !== length) throw new SealError('malformed', 'the random source gave the wrong size');
  return bytes;
}

function sealContent({ type, senderId, clear, content, recipients, ephemeral = null, random = crypto.randomBytes }) {
  if (!isSealedType(type)) throw new SealError('malformed', 'this type is not sealed');
  if (!isPlainObject(clear) || !isPlainObject(content) || !isPlainObject(recipients)) throw new SealError('malformed', 'clear, content and recipients are objects');
  if (typeof senderId !== 'string' || clear[senderKey(type)] !== senderId) throw new SealError('malformed', 'senderId is not the sender the clear part names');
  if (!Object.keys(content).every((k) => SEAL_SPLIT[type].includes(k))) throw new SealError('malformed', 'content holds a key the type does not seal');
  const ids = Object.keys(recipients);
  if (ids.length === 0) throw new SealError('malformed', 'no recipients');
  for (const id of ids) {
    if (!RECIPIENT_ID_RE.test(id)) throw new SealError('malformed', 'a recipient id is not a device or node id');
    if (!isDeviceJwk(recipients[id])) throw new SealError('malformed', 'a recipient key is not a P-256 point');
  }
  const eph = ephemeral || newEphemeral();
  const cek = freshBytes(random, KEY_BYTES);
  const iv = freshBytes(random, IV_BYTES);
  const ct = gcmSeal(cek, iv, Buffer.from(jcs(content, 'malformed', 'content'), 'utf8'), Buffer.from(jcs(clear, 'malformed', 'the clear part'), 'utf8'));
  const keys = {};
  for (const id of ids) {
    const secret = eph.agree(recipients[id]);
    if (!Buffer.isBuffer(secret) || secret.length !== KEY_BYTES) throw new SealError('malformed', 'the key agreement gave the wrong size');
    keys[id] = toB64url(gcmSeal(kekFor(secret, type, senderId, id), ZERO_IV, cek));
  }
  const message = { ...clear, sealed: { v: 1, epk: eph.jwk, iv: toB64url(iv), ct: toB64url(ct), keys } };
  // What is built here must be what an opener takes: a clear key missing or
  // extra is refused now, not by every phone later.
  if (!isSealedShape(type, message)) throw new SealError('malformed', 'the clear part does not fit the type');
  return message;
}

function parseContent(type, plaintext) {
  const text = plaintext.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(plaintext)) throw new SealError('content_malformed', 'not UTF-8');
  let content;
  try {
    content = JSON.parse(text);
  } catch {
    throw new SealError('content_malformed', 'not JSON');
  }
  if (!isPlainObject(content)) throw new SealError('content_malformed', 'not an object');
  // The table's keys and no other: a clear key here could overrule what the
  // relay and the AAD saw.
  if (!Object.keys(content).every((k) => SEAL_SPLIT[type].includes(k))) throw new SealError('content_malformed', 'holds a key the type does not seal');
  // The bytes are the JCS of the object, which rules out duplicate keys and
  // parser differentials, as envelope.open does for a payload.
  if (jcs(content, 'content_malformed', 'content') !== text) throw new SealError('content_malformed', 'not canonical');
  return content;
}

function openSealed({ type, message, recipientId, agree }) {
  if (!isSealedShape(type, message)) throw new SealError('malformed', 'not a sealed message of this type');
  const { sealed, ...clear } = message;
  if (typeof recipientId !== 'string' || !Object.hasOwn(sealed.keys, recipientId)) throw new SealError('not_recipient');
  const aad = Buffer.from(jcs(clear, 'malformed', 'the clear part'), 'utf8');
  const senderId = clear[senderKey(type)];
  if (typeof senderId !== 'string') throw new SealError('malformed', 'no sender id');
  let plaintext;
  try {
    const secret = agree(sealed.epk);
    if (!Buffer.isBuffer(secret) || secret.length !== KEY_BYTES) throw new SealError('open_failed');
    const cek = gcmOpen(kekFor(secret, type, senderId, recipientId), ZERO_IV, fromB64url(sealed.keys[recipientId]));
    plaintext = gcmOpen(cek, fromB64url(sealed.iv), fromB64url(sealed.ct), aad);
  } catch {
    // One answer whichever step failed, and no bytes from a step that did.
    throw new SealError('open_failed');
  }
  const content = parseContent(type, plaintext);
  return { message: { ...clear, ...content }, content };
}

function splitMessage(type, full) {
  if (!isSealedType(type)) throw new SealError('malformed', 'this type is not sealed');
  if (!isPlainObject(full) || Object.hasOwn(full, 'sealed')) throw new SealError('malformed', 'not a full message');
  const clear = {};
  const content = {};
  for (const [key, value] of Object.entries(full)) {
    (SEAL_SPLIT[type].includes(key) ? content : clear)[key] = value;
  }
  return { clear, content };
}

function newSalt() {
  return toB64url(crypto.randomBytes(KEY_BYTES));
}

// R-SP-2: b64url(SHA-256(raw(salt) ‖ JCS(value))).
function saltedHash(saltB64url, value) {
  if (byteLength(saltB64url) !== KEY_BYTES) throw new SealError('malformed', 'a salt is 32 bytes');
  return crypto.createHash('sha256').update(fromB64url(saltB64url)).update(jcs(value, 'malformed', 'the value'), 'utf8').digest('base64url');
}

// What people compare for a box key: `b-` and the device id's rule over
// 0x04||x||y, in groups of four. A box key has no id of its own.
function boxKeyFingerprint(jwk) {
  if (!isDeviceJwk(jwk)) throw new SealError('malformed', 'not a P-256 JWK');
  return `b-${fingerprintGroups(deriveDeviceId(ecPoint(jwk), 'b-'))}`;
}

module.exports = {
  SealError,
  SEAL_SPLIT,
  sealContent,
  openSealed,
  splitMessage,
  isSealedShape,
  newSalt,
  saltedHash,
  boxKeyFingerprint
};

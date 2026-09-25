// Ed25519 helpers for desktop device keys (program §4.17). Device keys are
// raw 32-byte keys in base64url; node keys are DER SPKI hex.
//
// Fleet stage 3 (src/approvals/envelope.js) defines equivalent
// deriveDeviceId/ed25519RawToSpki helpers (same algorithm, same vectors).
// That file does not exist on this branch yet, so this module carries its
// own copies; whichever of that stage or this one merges second should
// dedupe against the other's implementation.
const crypto = require('crypto');
const { base32Encode } = require('../mesh/node-identity');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

function toB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

// Strict: the alphabet regex rejects padding ('=') and any non-base64url
// character (Node's own base64url decoder is lenient about both), and the
// round-trip re-encode rejects a non-canonical string — one whose decoded
// bytes re-encode to something else, e.g. trailing bits that aren't zero.
function fromB64url(text) {
  if (typeof text !== 'string' || !B64URL_RE.test(text)) throw new Error('not base64url');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new Error('not canonical base64url');
  return bytes;
}

function deriveDeviceId(rawPublicKey, prefix = 'd-') {
  const raw = Buffer.from(rawPublicKey);
  return prefix + base32Encode(crypto.createHash('sha256').update(raw).digest()).slice(0, 16);
}

function ed25519RawToSpki(raw32) {
  const raw = Buffer.from(raw32);
  if (raw.length !== 32) throw new Error('an Ed25519 key is 32 bytes');
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

function rawFromPublicKeyObject(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX.length);
}

// Shared by verifyWithRawKey and verifyWithSpkiHex: strict on every input —
// only an Ed25519 SPKI key and only a 64-byte signature are accepted, and
// nothing here ever throws (bad input just verifies false).
function verifyWithSpkiDer(der, message, signature) {
  try {
    if (!Buffer.isBuffer(signature) || signature.length !== 64) return false;
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(message), key, signature);
  } catch {
    return false;
  }
}

function verifyWithRawKey(raw32, message, signature) {
  let raw;
  try {
    raw = Buffer.from(raw32);
  } catch {
    return false;
  }
  if (raw.length !== 32) return false;
  let der;
  try {
    der = ed25519RawToSpki(raw);
  } catch {
    return false;
  }
  return verifyWithSpkiDer(der, message, signature);
}

function verifyWithSpkiHex(spkiHex, message, signature) {
  if (typeof spkiHex !== 'string' || spkiHex.length === 0 || spkiHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(spkiHex)) {
    return false;
  }
  let der;
  try {
    der = Buffer.from(spkiHex, 'hex');
  } catch {
    return false;
  }
  return verifyWithSpkiDer(der, message, signature);
}

// 'kld-abcdefghijklmnop' → 'abcd efgh ijkl mnop': what the owner compares on two screens.
function fingerprintGroups(id) {
  const text = String(id);
  const body = text.slice(text.indexOf('-') + 1);
  return (body.match(/.{1,4}/g) || []).join(' ');
}

module.exports = {
  ED25519_SPKI_PREFIX,
  toB64url,
  fromB64url,
  deriveDeviceId,
  ed25519RawToSpki,
  rawFromPublicKeyObject,
  verifyWithRawKey,
  verifyWithSpkiHex,
  fingerprintGroups
};

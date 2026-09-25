// Signed envelopes: { alg, kid, payload, sig }. `payload` is the base64url
// JCS bytes of the message and `sig` is the signature over exactly those
// bytes. Verifiers check the bytes they received and never re-canonicalize to
// verify; `open` additionally insists the bytes are canonical, which rules out
// duplicate keys and parser differentials.
const crypto = require('crypto');
const { canonicalize } = require('../platform/jcs');
const { base32Encode } = require('../mesh/node-identity');

class EnvelopeError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'EnvelopeError';
    this.reason = reason;
  }
}

const B64URL = /^[A-Za-z0-9_-]*$/;
const ENVELOPE_KEYS = ['alg', 'kid', 'payload', 'sig'];
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

// Strict: only the base64url alphabet, no padding, and the text must be the
// one canonical encoding of the bytes it decodes to.
function fromB64url(text) {
  if (typeof text !== 'string' || !B64URL.test(text) || text.length % 4 === 1) {
    throw new EnvelopeError('malformed', 'not base64url');
  }
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new EnvelopeError('malformed', 'non-canonical base64url');
  return bytes;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function isBufferLike(v) {
  return Buffer.isBuffer(v) || v instanceof Uint8Array;
}

function seal(message, signer) {
  if (!signer || typeof signer.sign !== 'function') throw new TypeError('seal needs a signer { alg, kid, sign(bytes) }');
  const bytes = Buffer.from(canonicalize(message), 'utf8');
  const sig = signer.sign(bytes);
  return { alg: signer.alg, kid: signer.kid, payload: toB64url(bytes), sig: toB64url(sig) };
}

function open(envelope) {
  if (!isPlainObject(envelope)) throw new EnvelopeError('malformed', 'envelope is not an object');
  const keys = Object.keys(envelope).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) {
    throw new EnvelopeError('malformed', 'envelope must have exactly alg, kid, payload, sig');
  }
  for (const k of ENVELOPE_KEYS) {
    if (typeof envelope[k] !== 'string' || envelope[k] === '') throw new EnvelopeError('malformed', `${k} must be a non-empty string`);
  }
  const bytes = fromB64url(envelope.payload);
  fromB64url(envelope.sig);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new EnvelopeError('malformed', 'payload is not UTF-8');
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new EnvelopeError('malformed', 'payload is not JSON');
  }
  if (!isPlainObject(message)) throw new EnvelopeError('malformed', 'payload is not an object');
  let canonical;
  try {
    canonical = canonicalize(message);
  } catch {
    throw new EnvelopeError('malformed', 'payload cannot be canonicalized');
  }
  if (!Buffer.from(canonical, 'utf8').equals(bytes)) throw new EnvelopeError('malformed', 'payload is not canonical');
  return { message, bytes };
}

function verifyEd25519(envelope, spkiDerHex) {
  try {
    if (!envelope || envelope.alg !== 'Ed25519') return false;
    const bytes = fromB64url(envelope.payload);
    const sig = fromB64url(envelope.sig);
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(spkiDerHex, 'hex'), format: 'der', type: 'spki' });
    // A P-256 SPKI key parses fine and a P1363-encoded P-256 signature can be
    // exactly 64 bytes too, so without this check a type-confused key/sig
    // pair could slip past the length check above.
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

function isDeviceJwk(jwk) {
  if (!isPlainObject(jwk)) return false;
  const keys = Object.keys(jwk).sort();
  if (keys.join(',') !== 'crv,kty,x,y') return false;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
  try {
    if (fromB64url(jwk.x).length !== 32 || fromB64url(jwk.y).length !== 32) return false;
    // x/y of the right length is not enough: confirm (x, y) is actually a
    // point on the P-256 curve. crypto.createPublicKey rejects an off-curve
    // JWK point.
    crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

function verifyEs256(envelope, jwk) {
  try {
    if (!envelope || envelope.alg !== 'ES256' || !isDeviceJwk(jwk)) return false;
    const bytes = fromB64url(envelope.payload);
    const sig = fromB64url(envelope.sig);
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    // ECDSA is malleable: (r, s) and (r, n-s) are both valid signatures over
    // the same message (negating s negates the recovered point, which has
    // the same x-coordinate r). Phones do not normalize to low-S, and this
    // verify doesn't enforce it either, so a device may submit either
    // encoding for the same signed message. That means `sig` bytes are NOT a
    // stable, unique identifier for a signed message — no dedupe, replay or
    // audit key may be derived from `sig`; key on the message (or device id
    // + payload hash) instead.
    return crypto.verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

// The node's Ed25519 identity as an envelope signer. `identity` is a
// NodeIdentity or anything with nodeId and sign(bytes).
function nodeSigner(identity) {
  if (!identity || typeof identity.nodeId !== 'string' || typeof identity.sign !== 'function') {
    throw new EnvelopeError('malformed', 'nodeSigner needs an identity with nodeId and sign(bytes)');
  }
  return { alg: 'Ed25519', kid: identity.nodeId, sign: (bytes) => identity.sign(bytes) };
}

// prefix + base32(sha256(raw))[0..16], lowercase RFC 4648 without padding.
// Phones: raw is the 65-byte uncompressed P-256 point. Desktops (F7): the
// 32-byte Ed25519 key with prefix `kld-`.
function deriveDeviceId(rawPublicKey, prefix = 'd-') {
  if (!isBufferLike(rawPublicKey)) throw new EnvelopeError('malformed', 'raw public key must be a Buffer or Uint8Array');
  const raw = Buffer.isBuffer(rawPublicKey) ? rawPublicKey : Buffer.from(rawPublicKey);
  return prefix + base32Encode(crypto.createHash('sha256').update(raw).digest()).slice(0, 16);
}

function deviceIdFromJwk(jwk) {
  if (!isDeviceJwk(jwk)) throw new EnvelopeError('malformed', 'not a P-256 device JWK');
  return deriveDeviceId(Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]));
}

function ed25519RawToSpki(raw32) {
  if (!isBufferLike(raw32)) throw new EnvelopeError('malformed', 'an Ed25519 key must be a Buffer or Uint8Array');
  const raw = Buffer.isBuffer(raw32) ? raw32 : Buffer.from(raw32);
  if (raw.length !== 32) throw new EnvelopeError('malformed', 'an Ed25519 key is 32 bytes');
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

// 'd-abcdefghijklmnop' → 'abcd efgh ijkl mnop': what the owner compares on two screens.
function fingerprintGroups(id) {
  const body = String(id).slice(String(id).indexOf('-') + 1);
  return (body.match(/.{1,4}/g) || []).join(' ');
}

module.exports = {
  EnvelopeError,
  seal,
  open,
  verifyEd25519,
  verifyEs256,
  nodeSigner,
  deriveDeviceId,
  deviceIdFromJwk,
  ed25519RawToSpki,
  fingerprintGroups,
  isDeviceJwk,
  toB64url,
  fromB64url
};

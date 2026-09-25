// tests/approvals-envelope.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  EnvelopeError, seal, open, verifyEd25519, verifyEs256, nodeSigner, deriveDeviceId,
  deviceIdFromJwk, ed25519RawToSpki, fingerprintGroups, isDeviceJwk, toB64url, fromB64url
} = require('../src/approvals/envelope');

function ed25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { spkiHex: spki.toString('hex'), identity: { nodeId: 'kl-aaaaaaaaaaaaaaaa', sign: (b) => crypto.sign(null, b, privateKey) } };
}

function p256() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const jwk = { kty, crv, x, y };
  const id = deviceIdFromJwk(jwk);
  return { jwk, id, signer: { alg: 'ES256', kid: id, sign: (b) => crypto.sign('sha256', b, { key: privateKey, dsaEncoding: 'ieee-p1363' }) } };
}

describe('seal / open', () => {
  it('round-trips a message and signs the JCS bytes', () => {
    const node = ed25519();
    const env = seal({ z: 1, a: 'x', v: 1 }, nodeSigner(node.identity));
    assert.deepEqual(Object.keys(env).sort(), ['alg', 'kid', 'payload', 'sig']);
    assert.equal(env.alg, 'Ed25519');
    assert.equal(env.kid, 'kl-aaaaaaaaaaaaaaaa');
    const { message, bytes } = open(env);
    assert.deepEqual(message, { a: 'x', v: 1, z: 1 });
    assert.equal(bytes.toString('utf8'), '{"a":"x","v":1,"z":1}');
    assert.equal(verifyEd25519(env, node.spkiHex), true);
  });

  it('refuses non-canonical, duplicate-key, non-object and extra-member envelopes as malformed', () => {
    const node = ed25519();
    const signer = nodeSigner(node.identity);
    const raw = (text) => ({ alg: 'Ed25519', kid: signer.kid, payload: toB64url(Buffer.from(text)), sig: toB64url(signer.sign(Buffer.from(text))) });
    const cases = [
      raw('{ "a": 1 }'),
      raw('{"a":1,"a":1}'),
      raw('[1]'),
      raw('not json'),
      { ...seal({ a: 1 }, signer), extra: 'x' },
      { alg: 'Ed25519', kid: signer.kid, payload: 'eyJhIjoxfQ==', sig: 'AA' },
      null
    ];
    for (const env of cases) {
      assert.throws(() => open(env), (err) => err instanceof EnvelopeError && err.reason === 'malformed');
    }
  });

  it('verifies over the bytes received: a changed payload fails', () => {
    const node = ed25519();
    const env = seal({ a: 1 }, nodeSigner(node.identity));
    const tampered = { ...env, payload: toB64url(Buffer.from('{"a":2}')) };
    assert.equal(verifyEd25519(tampered, node.spkiHex), false);
    assert.equal(verifyEd25519({ ...env, alg: 'ES256' }, node.spkiHex), false);
    assert.equal(verifyEd25519(env, ed25519().spkiHex), false);
  });
});

describe('ES256 device signatures', () => {
  it('verifies P1363 signatures against the JWK and rejects others', () => {
    const phone = p256();
    const env = seal({ v: 1, device_id: phone.id }, phone.signer);
    assert.equal(verifyEs256(env, phone.jwk), true);
    assert.equal(verifyEs256(env, p256().jwk), false);
    assert.equal(verifyEs256({ ...env, alg: 'Ed25519' }, phone.jwk), false);
    // A DER-encoded signature (what Android's Signature produces) is not P1363.
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const derSig = crypto.sign('sha256', fromB64url(env.payload), privateKey);
    assert.equal(verifyEs256({ ...env, sig: toB64url(derSig) }, phone.jwk), false);
  });

  it('accepts only a JWK with exactly kty, crv, x, y', () => {
    const { jwk } = p256();
    assert.equal(isDeviceJwk(jwk), true);
    assert.equal(isDeviceJwk({ ...jwk, d: 'secret' }), false);
    assert.equal(isDeviceJwk({ ...jwk, crv: 'P-384' }), false);
    assert.equal(isDeviceJwk({ kty: 'EC', crv: 'P-256', x: jwk.x }), false);
    assert.throws(() => deviceIdFromJwk({ ...jwk, d: 'secret' }), EnvelopeError);
  });
});

describe('identifiers', () => {
  it('derives device ids from the uncompressed point, and kld- ids from Ed25519 keys', () => {
    const raw = Buffer.alloc(65, 7);
    raw[0] = 4;
    const id = deriveDeviceId(raw);
    assert.match(id, /^d-[a-z2-7]{16}$/);
    assert.match(deriveDeviceId(Buffer.alloc(32, 1), 'kld-'), /^kld-[a-z2-7]{16}$/);
    const { jwk } = p256();
    const point = Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]);
    assert.equal(deviceIdFromJwk(jwk), deriveDeviceId(point));
  });

  it('wraps a raw Ed25519 key in DER SPKI that Node accepts', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    assert.deepEqual(ed25519RawToSpki(spki.subarray(12)), spki);
    assert.throws(() => ed25519RawToSpki(Buffer.alloc(31)), EnvelopeError);
  });

  it('groups a fingerprint in fours after the prefix', () => {
    assert.equal(fingerprintGroups('d-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
    assert.equal(fingerprintGroups('kl-abcdefghijklmnop'), 'abcd efgh ijkl mnop');
  });

  it('decodes base64url strictly', () => {
    assert.deepEqual(fromB64url('AQID'), Buffer.from([1, 2, 3]));
    for (const bad of ['AQID=', 'AQ+D', 'A', 'AR']) assert.throws(() => fromB64url(bad), EnvelopeError, bad);
  });
});

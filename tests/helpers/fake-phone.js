// tests/helpers/fake-phone.js
//
// A phone in software: a P-256 key that signs approval-v1 messages the way
// the mobile apps do (ES256, IEEE P1363 r||s), plus a lightweight node
// identity for tests that must not spawn openssl to make a TLS certificate.
// Keys come from tests/vectors/approval-v1/keys.json when `seed` is 'A', 'B'
// or 'C' (these are test keys nodes refuse without allowTestKeys), else they
// are random.
const crypto = require('crypto');
const path = require('path');
const { seal, open, deviceIdFromJwk, nodeSigner } = require('../../src/approvals/envelope');
const { deriveNodeId } = require('../../src/mesh/node-identity');
const { enrollMac, phoneAuthString, randomNonce, iso } = require('../../src/approvals/messages');

const KEYS = require(path.join(__dirname, '..', 'vectors', 'approval-v1', 'keys.json'));
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function p256FromD(d) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(d, 'base64url'));
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') };
  return { jwk, privateKey: crypto.createPrivateKey({ key: { ...jwk, d }, format: 'jwk' }) };
}

function createFakePhone({ seed = null, name = 'Test phone', platform = 'android' } = {}) {
  let jwk;
  let privateKey;
  if (seed) {
    const fixed = KEYS.devices[seed];
    if (!fixed) throw new Error(`no test device key ${seed}`);
    ({ jwk, privateKey } = p256FromD(fixed.d));
  } else {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' });
    jwk = { kty, crv, x, y };
    privateKey = pair.privateKey;
  }
  const deviceId = deviceIdFromJwk(jwk);
  const signer = { alg: 'ES256', kid: deviceId, sign: (bytes) => crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }) };

  const phone = {
    deviceId,
    jwk,
    name,
    platform,
    signer,
    sign: (message) => seal(message, signer),

    device() {
      return { device_id: deviceId, name, platform, public_key: jwk };
    },

    approverRecord({ enrolledBy = 'console', enrolledAt = '2026-09-23T18:00:00.000Z', revokedAt = null, revokedBy = null, enrollment = null } = {}) {
      return {
        v: 1, device_id: deviceId, name, platform, public_key: jwk,
        enrolled_at: enrolledAt, enrolled_by: enrolledBy, revoked_at: revokedAt, revoked_by: revokedBy, enrollment
      };
    },

    // Answers a node-signed kl.approval.request exactly as the app does.
    respond(requestEnvelope, decision, { signedAt = new Date().toISOString(), overrides = {} } = {}) {
      const { message: req } = open(requestEnvelope);
      return seal({
        v: 1,
        type: 'kl.approval.response',
        request_id: req.request_id,
        node_id: req.node_id,
        action_hash: req.action_hash,
        nonce: req.nonce,
        decision,
        expires_at: req.expires_at,
        device_id: deviceId,
        signed_at: signedAt,
        ...overrides
      }, signer);
    },

    // Console enrollment (codeId + code: self-signed with code_mac) or a
    // signed enrollment of `device` by this phone.
    enroll({ device = null, codeId = null, code = null, now = Date.now(), ttlMs = 10 * 60 * 1000, nonce = null } = {}) {
      const base = {
        v: 1,
        type: 'kl.device.enroll',
        device: device || phone.device(),
        enrolled_by: codeId ? null : deviceId,
        created_at: iso(now),
        expires_at: iso(now + ttlMs),
        nonce: nonce || randomNonce()
      };
      if (!codeId) return seal(base, signer);
      const withCode = { ...base, code_id: codeId };
      return seal({ ...withCode, code_mac: enrollMac(code, withCode) }, signer);
    },

    revoke(targetDeviceId, { now = Date.now(), ttlMs = 60 * 60 * 1000, reason = 'lost', nonce = null } = {}) {
      return seal({
        v: 1,
        type: 'kl.device.revoke',
        device_id: targetDeviceId,
        revoked_by: deviceId,
        reason,
        created_at: iso(now),
        expires_at: iso(now + ttlMs),
        nonce: nonce || randomNonce()
      }, signer);
    },

    // Headers for a device-authenticated phone API call.
    signApi(method, pathWithQuery, body = '', { timestamp = new Date().toISOString() } = {}) {
      const s = phoneAuthString(method, pathWithQuery, timestamp, body);
      return {
        'X-KL-Device': deviceId,
        'X-KL-Timestamp': timestamp,
        'X-KL-Signature': signer.sign(Buffer.from(s, 'utf8')).toString('base64url')
      };
    }
  };
  return phone;
}

// A node identity without a TLS certificate: { nodeId, nodeName, publicKey
// (DER SPKI Buffer), sign(bytes) }. `key` names a node in keys.json.
function testNodeIdentity({ key = null, nodeName = null } = {}) {
  let privateKey;
  if (key) {
    const fixed = KEYS.nodes[key];
    if (!fixed) throw new Error(`no test node key ${key}`);
    privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(fixed.seed, 'hex')]), format: 'der', type: 'pkcs8' });
  } else {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  }
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const identity = {
    nodeId: deriveNodeId(publicKey),
    nodeName: nodeName || key || 'web-01',
    publicKey,
    sign: (bytes) => crypto.sign(null, Buffer.from(bytes), privateKey)
  };
  identity.signer = nodeSigner(identity);
  return identity;
}

module.exports = { createFakePhone, testNodeIdentity, KEYS };

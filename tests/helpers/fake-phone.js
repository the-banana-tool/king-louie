// tests/helpers/fake-phone.js
//
// A phone in software: a P-256 key that signs approval-v1 messages the way
// the mobile apps do (ES256, IEEE P1363 r||s), plus a lightweight node
// identity for tests that must not spawn openssl to make a TLS certificate.
// Keys come from tests/vectors/approval-v1/keys.json when `seed` is 'A', 'B'
// or 'C' (these are test keys nodes refuse without allowTestKeys), else they
// are random. Every phone also has a read key (spec 2026-10-28 §8.1):
// `readJwk`/`readSigner`, and `signApi(..., { key: 'read' })` for a
// read-signed phone API call. It is keys.json's `<seed>_read` when the file
// has one, else random.
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
  const fixedRead = seed ? KEYS.devices[`${seed}_read`] : null;
  let readJwk;
  let readPrivateKey;
  if (fixedRead) {
    ({ jwk: readJwk, privateKey: readPrivateKey } = p256FromD(fixedRead.d));
  } else {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' });
    readJwk = { kty, crv, x, y };
    readPrivateKey = pair.privateKey;
  }
  // The read key has no id of its own: what it signs names the device.
  const readSigner = { alg: 'ES256', kid: deviceId, sign: (bytes) => crypto.sign('sha256', bytes, { key: readPrivateKey, dsaEncoding: 'ieee-p1363' }) };

  const phone = {
    deviceId,
    jwk,
    name,
    platform,
    signer,
    readJwk,
    readSigner,
    sign: (message) => seal(message, signer),

    // `readKey: true` adds the read key's public half (android-slim §8.2),
    // as an Android phone built from that change enrolls.
    device({ readKey = false } = {}) {
      const d = { device_id: deviceId, name, platform, public_key: jwk };
      if (readKey) d.read_key = readJwk;
      return d;
    },

    // kl.device.read_key (android-slim §8.7): this phone's statement of its
    // read key, signed with the device key (`signWith: 'read'` signs it with
    // the read key, for refusal tests).
    readKeyStatement({ now = Date.now(), ttlMs = 7 * 24 * 60 * 60 * 1000, nonce = null, readKey = null, signWith = 'device', overrides = {} } = {}) {
      return seal({
        v: 1,
        type: 'kl.device.read_key',
        device_id: deviceId,
        read_key: readKey || readJwk,
        created_at: iso(now),
        expires_at: iso(now + ttlMs),
        nonce: nonce || randomNonce(),
        ...overrides
      }, signWith === 'read' ? readSigner : signer);
    },

    // `readKey: true` adds this phone's read key to the record (android-slim
    // spec §8.2); without it the record is as before the read key.
    approverRecord({ enrolledBy = 'console', enrolledAt = '2026-09-23T18:00:00.000Z', revokedAt = null, revokedBy = null, enrollment = null, readKey = false } = {}) {
      const record = {
        v: 1, device_id: deviceId, name, platform, public_key: jwk,
        enrolled_at: enrolledAt, enrolled_by: enrolledBy, revoked_at: revokedAt, revoked_by: revokedBy, enrollment
      };
      if (readKey) record.read_key = readJwk;
      return record;
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

    // lease-v1 (fleet stage 5 §4.1): answers a node-signed kl.lease.request
    // the way the apps do (the request's nonce and expires_at are copied).
    leaseGrant(requestEnvelope, { decision = 'grant', apps = null, minutes = 10, signedAt = new Date().toISOString(), overrides = {} } = {}) {
      const { message: req } = open(requestEnvelope);
      return seal({
        v: 1, type: 'kl.lease.grant', request_id: req.request_id, lease_id: req.lease_id, node_id: req.node_id,
        lease_hash: req.lease_hash, nonce: req.nonce, decision,
        grant: decision === 'grant' ? { apps: apps || req.lease.apps.map((a) => a.id), minutes } : null,
        expires_at: req.expires_at, device_id: deviceId, signed_at: signedAt, ...overrides
      }, signer);
    },

    leaseRevoke(nodeId, leaseId, { reason = 'kill_switch', nonce = null, signedAt = new Date().toISOString() } = {}) {
      return seal({ v: 1, type: 'kl.lease.revoke', node_id: nodeId, lease_id: leaseId, reason, device_id: deviceId, nonce: nonce || randomNonce(), signed_at: signedAt }, signer);
    },

    // contactToken: the newest token this phone has applied from a status or
    // a view of the lease (null when it has none); only a watch that echoes
    // one the node issued recently is contact (R-F5-15).
    leaseWatch(nodeId, leaseId, { nonce = null, signedAt = new Date().toISOString(), contactToken = null } = {}) {
      return seal({ v: 1, type: 'kl.lease.watch', node_id: nodeId, lease_id: leaseId, device_id: deviceId, contact_token: contactToken, nonce: nonce || randomNonce(), signed_at: signedAt }, signer);
    },

    // Headers for a device-authenticated phone API call. `key: 'read'` signs
    // KL-PHONE-READ-V1 with the read key and adds `X-KL-Key: read`; `key:
    // 'device'` adds `X-KL-Key: device` (absent is the same). `signWith`
    // ('device' | 'read') signs with the other key than the one claimed, and
    // `header: false` leaves X-KL-Key out, for refusal tests.
    signApi(method, pathWithQuery, body = '', { timestamp = new Date().toISOString(), key = null, signWith = null, header = true } = {}) {
      const kind = key || 'device';
      const s = phoneAuthString(method, pathWithQuery, timestamp, body, { key: kind });
      const by = (signWith || kind) === 'read' ? readSigner : signer;
      const headers = {
        'X-KL-Device': deviceId,
        'X-KL-Timestamp': timestamp,
        'X-KL-Signature': by.sign(Buffer.from(s, 'utf8')).toString('base64url')
      };
      if (key && header) headers['X-KL-Key'] = key;
      return headers;
    },

    // Shorthand: headers for a read-signed phone API call.
    signReadApi(method, pathWithQuery, body = '', options = {}) {
      return phone.signApi(method, pathWithQuery, body, { ...options, key: 'read' });
    },

    // client-grant-v1 (fleet stage 4 §4.2–4.3). `pending` is the view the
    // front door returns from GET /v1/grants/pending plus its binding fields.
    grant({ frontdoorId, pending, decision = 'approve', scopes = null, nonce = null, signedAt = new Date().toISOString(), overrides = {} } = {}) {
      const chosen = decision === 'deny' ? [] : (scopes || [...pending.requested_scopes].sort().map((scope) => ({ scope, machines: null })));
      return seal({
        v: 1,
        type: 'kl.client.grant',
        frontdoor_id: frontdoorId,
        grant_id: pending.grant_id,
        client_id: pending.client_id,
        client_name: pending.client_name,
        redirect_uri: pending.redirect_uri,
        resource: pending.resource,
        code_challenge: pending.code_challenge,
        user_code: pending.user_code,
        scopes: chosen,
        decision,
        nonce: nonce || randomNonce(),
        device_id: deviceId,
        signed_at: signedAt,
        ...overrides
      }, signer);
    },

    revokeClient({ frontdoorId, grantId, challenge, signedAt = new Date().toISOString() } = {}) {
      return seal({ v: 1, type: 'kl.client.revoke', frontdoor_id: frontdoorId, grant_id: grantId, challenge, device_id: deviceId, signed_at: signedAt }, signer);
    },

    enrollNode({ frontdoorId, pairing, decision = 'approve', nonce = null, signedAt = new Date().toISOString(), overrides = {} } = {}) {
      return seal({
        v: 1,
        type: 'kl.node.enroll',
        frontdoor_id: frontdoorId,
        pairing_id: pairing.pairing_id,
        node_id: pairing.node_id,
        node_name: pairing.node_name,
        profile: pairing.profile,
        public_key: pairing.public_key,
        tls_fingerprint: pairing.tls_fingerprint,
        replaces: pairing.replaces === undefined ? null : pairing.replaces,
        decision,
        nonce: nonce || randomNonce(),
        device_id: deviceId,
        signed_at: signedAt,
        ...overrides
      }, signer);
    },

    removeNode({ frontdoorId, nodeId, challenge, signedAt = new Date().toISOString() } = {}) {
      return seal({ v: 1, type: 'kl.node.remove', frontdoor_id: frontdoorId, node_id: nodeId, challenge, device_id: deviceId, signed_at: signedAt }, signer);
    },
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

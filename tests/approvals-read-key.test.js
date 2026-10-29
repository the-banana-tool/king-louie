// tests/approvals-read-key.test.js
// The read key (spec 2026-10-28-android-app-slim-design.md §8): the message
// layer's `device.read_key`, `kl.device.read_key`, the KL-PHONE-READ-V1
// string and verifyDeviceEnvelope's `allowReadKey`.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { deviceIdFromJwk, seal } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');
const { verifyDeviceEnvelope, verifyConsoleEnrollment, NonceCache, bytesSha256 } = require('../src/approvals/verify-device');
const { testNodeIdentity } = require('./helpers/fake-phone');

function p256() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return { jwk: { kty, crv, x, y }, sign: (b) => crypto.sign('sha256', b, { key: privateKey, dsaEncoding: 'ieee-p1363' }) };
}

function testPhone() {
  const device = p256();
  const read = p256();
  const id = deviceIdFromJwk(device.jwk);
  return {
    id,
    jwk: device.jwk,
    readJwk: read.jwk,
    signer: { alg: 'ES256', kid: id, sign: device.sign },
    readSigner: { alg: 'ES256', kid: id, sign: read.sign }
  };
}

// A point off the P-256 curve: a real key's x with y changed by one bit.
function offCurve(jwk) {
  const y = Buffer.from(jwk.y, 'base64url');
  y[31] ^= 1;
  return { ...jwk, y: y.toString('base64url') };
}

function enrollment(device) {
  return { v: 1, type: 'kl.device.enroll', device, enrolled_by: testPhone().id, created_at: '2026-10-28T14:00:00.000Z', expires_at: '2026-10-28T14:10:00.000Z', nonce: m.randomNonce() };
}

describe('device.read_key in kl.device.enroll', () => {
  const phone = testPhone();
  const base = { device_id: phone.id, name: 'Pixel', platform: 'android', public_key: phone.jwk };

  it('accepts a device with the four keys of today or with read_key as the fifth', () => {
    assert.equal(m.validateMessage('kl.device.enroll', enrollment(base)), null);
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, read_key: phone.readJwk })), null);
  });

  it('refuses a read_key equal to public_key, off the curve, not a P-256 JWK, or null', () => {
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, read_key: { ...phone.jwk } })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, read_key: offCurve(phone.readJwk) })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, read_key: { ...phone.readJwk, d: 'x' } })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, read_key: { ...phone.readJwk, crv: 'P-384' } })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, read_key: null })), 'malformed');
  });

  it('refuses any other extra key, with or without read_key', () => {
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, other: 1 })), 'malformed');
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, read_key: phone.readJwk, other: 1 })), 'malformed');
  });

  it('still derives device_id from public_key alone', () => {
    const readId = deviceIdFromJwk(phone.readJwk);
    assert.equal(m.validateMessage('kl.device.enroll', enrollment({ ...base, device_id: readId, read_key: phone.readJwk })), 'malformed');
  });
});

describe('kl.device.read_key', () => {
  const phone = testPhone();
  const statement = () => ({ v: 1, type: 'kl.device.read_key', device_id: phone.id, read_key: phone.readJwk, created_at: '2026-10-28T14:00:00.000Z', expires_at: '2026-11-04T14:00:00.000Z', nonce: m.randomNonce() });

  it('accepts exactly its keys with a window of at most 7 days', () => {
    assert.equal(m.validateMessage('kl.device.read_key', statement()), null);
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), expires_at: '2026-10-28T14:00:01.000Z' }), null);
  });

  it('refuses a window over 7 days, an empty or reversed one', () => {
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), expires_at: '2026-11-04T14:00:00.001Z' }), 'malformed');
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), expires_at: '2026-10-28T14:00:00.000Z' }), 'malformed');
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), expires_at: '2026-10-28T13:00:00.000Z' }), 'malformed');
  });

  it('refuses extra or missing keys, a bad nonce, device id, timestamp or read_key', () => {
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), extra: 1 }), 'malformed');
    const noNonce = statement();
    delete noNonce.nonce;
    assert.equal(m.validateMessage('kl.device.read_key', noNonce), 'malformed');
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), nonce: crypto.randomBytes(31).toString('base64url') }), 'malformed');
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), device_id: 'kl-abcdefghijklmnop' }), 'malformed');
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), created_at: '2026-02-30T14:00:00.000Z' }), 'malformed');
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), read_key: offCurve(phone.readJwk) }), 'malformed');
    assert.equal(m.validateMessage('kl.device.read_key', { ...statement(), v: 2 }), 'unsupported_version');
  });
});

describe('phoneAuthString with the key kind', () => {
  const args = ['post', '/v1/leases/x/watch?a=1', '2026-10-28T14:05:09.120Z', '{"k":1}'];

  it('is KL-PHONE-V1 by default and for the device key, KL-PHONE-READ-V1 for the read key', () => {
    const today = m.phoneAuthString(...args);
    assert.equal(today.split('\n')[0], 'KL-PHONE-V1');
    assert.equal(m.phoneAuthString(...args, { key: 'device' }), today);
    const read = m.phoneAuthString(...args, { key: 'read' });
    assert.deepEqual(read.split('\n'), ['KL-PHONE-READ-V1', ...today.split('\n').slice(1)]);
  });

  it('refuses an unknown key kind', () => {
    assert.throws(() => m.phoneAuthString(...args, { key: 'other' }), (err) => err.reason === 'malformed');
  });
});

describe('readKeyFingerprint', () => {
  it('is r- and the device-id rule over the read key, in groups of four', () => {
    const phone = testPhone();
    const fp = m.readKeyFingerprint(phone.readJwk);
    assert.match(fp, /^r-[a-z2-7]{4} [a-z2-7]{4} [a-z2-7]{4} [a-z2-7]{4}$/);
    // The same rule as the device id, prefix aside.
    assert.equal(fp.replace(/ /g, ''), `r-${deviceIdFromJwk(phone.readJwk).slice(2)}`);
  });

  it('matches a known literal for the published key A', () => {
    // keys.json device A has the device id d-3vmwrihhdbnit4oi (test-keys.js),
    // so the same point read as a read key is r-3vmw rihh dbni t4oi.
    const a = { kty: 'EC', crv: 'P-256', x: 'krcyG5D6HPx9P3Gi5oaR6OyU9D1gIrc3UD6pIRcDq74', y: '9XqgPXsMAYplX5IZVn-9FRP2sN4oHFRPjnZyfG-GpaI' };
    assert.equal(m.readKeyFingerprint(a), 'r-3vmw rihh dbni t4oi');
  });

  it('throws on something that is not a P-256 JWK', () => {
    assert.throws(() => m.readKeyFingerprint({ kty: 'EC' }));
  });
});

// A stand-in for ApproverStore's read side (get, isActive, allowTestKeys):
// the store learns `read_key` in a later ticket, and these tests are about
// the check, not the store.
function storeOf(records, { revoked = [], allowTestKeys = false } = {}) {
  const byId = new Map(records.map((r) => [r.device_id, r]));
  return {
    allowTestKeys,
    get: (id) => byId.get(id) || null,
    isActive: (id) => byId.has(id) && !revoked.includes(id)
  };
}

function recordOf(phone, { withReadKey = true } = {}) {
  const record = { device_id: phone.id, name: 'Pixel', platform: 'android', public_key: phone.jwk };
  return withReadKey ? { ...record, read_key: phone.readJwk } : record;
}

describe('verifyDeviceEnvelope and the read key', () => {
  const node = testNodeIdentity();
  const { message: request } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
  const response = (phone) => ({
    v: 1, type: 'kl.approval.response', request_id: request.request_id, node_id: node.nodeId, action_hash: request.action_hash,
    nonce: request.nonce, decision: 'approve', expires_at: request.expires_at, device_id: phone.id, signed_at: request.created_at
  });
  const verify = (env, store, extra = {}) => verifyDeviceEnvelope(env, { approverStore: store, type: 'kl.approval.response', nodeId: node.nodeId, ...extra });

  it('says which key verified: the device key, by default and with allowReadKey', () => {
    const phone = testPhone();
    const store = storeOf([recordOf(phone)]);
    const env = seal(response(phone), phone.signer);
    assert.equal(verify(env, store).key, 'device');
    assert.equal(verify(env, store, { allowReadKey: true }).key, 'device');
    assert.equal(verify(env, storeOf([recordOf(phone, { withReadKey: false })])).key, 'device');
  });

  it('refuses a read-key signature as bad_signature by default', () => {
    const phone = testPhone();
    const env = seal(response(phone), phone.readSigner);
    assert.deepEqual(verify(env, storeOf([recordOf(phone)])), { ok: false, reason: 'bad_signature' });
    assert.deepEqual(verify(env, storeOf([recordOf(phone)]), { allowReadKey: false }), { ok: false, reason: 'bad_signature' });
  });

  it('accepts a read-key signature with allowReadKey when the record has read_key', () => {
    const phone = testPhone();
    const result = verify(seal(response(phone), phone.readSigner), storeOf([recordOf(phone)]), { allowReadKey: true });
    assert.equal(result.ok, true);
    assert.equal(result.key, 'read');
    assert.equal(result.deviceId, phone.id);
  });

  it('refuses a read-key signature with allowReadKey when the record has no read_key', () => {
    const phone = testPhone();
    const env = seal(response(phone), phone.readSigner);
    assert.deepEqual(verify(env, storeOf([recordOf(phone, { withReadKey: false })]), { allowReadKey: true }), { ok: false, reason: 'bad_signature' });
  });

  it('refuses another device\'s read key, even one the store holds', () => {
    const phone = testPhone();
    const other = testPhone();
    const env = seal(response(phone), { ...other.readSigner, kid: phone.id });
    assert.deepEqual(verify(env, storeOf([recordOf(phone), recordOf(other)]), { allowReadKey: true }), { ok: false, reason: 'bad_signature' });
  });

  it('refuses a revoked device\'s read key as revoked_device', () => {
    const phone = testPhone();
    const env = seal(response(phone), phone.readSigner);
    assert.deepEqual(verify(env, storeOf([recordOf(phone)], { revoked: [phone.id] }), { allowReadKey: true }), { ok: false, reason: 'revoked_device' });
  });

  it('refuses a record whose read key is a published test key as test_key, unless the store allows them', () => {
    const phone = testPhone();
    const testA = { kty: 'EC', crv: 'P-256', x: 'krcyG5D6HPx9P3Gi5oaR6OyU9D1gIrc3UD6pIRcDq74', y: '9XqgPXsMAYplX5IZVn-9FRP2sN4oHFRPjnZyfG-GpaI' };
    const record = { ...recordOf(phone), read_key: testA };
    const env = seal(response(phone), phone.signer);
    assert.deepEqual(verify(env, storeOf([record])), { ok: false, reason: 'test_key' });
    assert.equal(verify(env, storeOf([record], { allowTestKeys: true })).ok, true);
  });

  it('keeps the later steps after a read-key signature: wrong_node and replays', () => {
    const phone = testPhone();
    const store = storeOf([recordOf(phone)]);
    const env = seal(response(phone), phone.readSigner);
    assert.deepEqual(verify(env, store, { allowReadKey: true, nodeId: testNodeIdentity().nodeId }), { ok: false, reason: 'wrong_node' });
    const nonces = new NonceCache();
    const first = verify(env, store, { allowReadKey: true, nonces });
    nonces.add(first.message.nonce, bytesSha256(first.bytes));
    assert.deepEqual(verify(env, store, { allowReadKey: true, nonces }), { ok: false, reason: 'replay' });
  });
});

describe('verifyConsoleEnrollment with a read key', () => {
  const codeId = crypto.randomBytes(16).toString('base64url');
  const code = crypto.randomBytes(32).toString('base64url');
  const now = Date.parse('2026-10-28T14:05:00.000Z');

  function consoleEnroll(phone, readKey) {
    const device = { device_id: phone.id, name: 'Pixel', platform: 'android', public_key: phone.jwk, ...(readKey ? { read_key: readKey } : {}) };
    const message = { v: 1, type: 'kl.device.enroll', device, enrolled_by: null, code_id: codeId, created_at: '2026-10-28T14:00:00.000Z', expires_at: '2026-10-28T14:10:00.000Z', nonce: m.randomNonce() };
    return seal({ ...message, code_mac: m.enrollMac(code, message) }, phone.signer);
  }

  it('accepts a console enrollment whose device carries read_key, and refuses an equal one', () => {
    const phone = testPhone();
    const ok = verifyConsoleEnrollment(consoleEnroll(phone, phone.readJwk), { codeId, code, now });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.message.device.read_key, phone.readJwk);
    assert.deepEqual(verifyConsoleEnrollment(consoleEnroll(phone, { ...phone.jwk }), { codeId, code, now }), { ok: false, reason: 'malformed' });
  });

  it('refuses a published test key as the read key unless test keys are allowed', () => {
    const phone = testPhone();
    const testA = { kty: 'EC', crv: 'P-256', x: 'krcyG5D6HPx9P3Gi5oaR6OyU9D1gIrc3UD6pIRcDq74', y: '9XqgPXsMAYplX5IZVn-9FRP2sN4oHFRPjnZyfG-GpaI' };
    const env = consoleEnroll(phone, testA);
    assert.deepEqual(verifyConsoleEnrollment(env, { codeId, code, now }), { ok: false, reason: 'test_key' });
    assert.equal(verifyConsoleEnrollment(env, { codeId, code, now, allowTestKeys: true }).ok, true);
  });
});

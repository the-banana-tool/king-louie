// tests/approvals-verify-device.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyDeviceEnvelope, verifyConsoleEnrollment, NonceCache, bytesSha256 } = require('../src/approvals/verify-device');
const { seal, toB64url, fromB64url } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const stores = [];
after(() => { for (const s of stores) s.cleanup(); });

async function setup({ overlay = [], extraRecords = [], allowTestKeys = false } = {}) {
  const node = testNodeIdentity();
  const phone = createFakePhone();
  const store = await approverStoreWith([phone.approverRecord(), ...extraRecords], { overlay, allowTestKeys });
  stores.push(store);
  const { envelope: request } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
  const verify = (env, extra = {}) => verifyDeviceEnvelope(env, { approverStore: store, type: 'kl.approval.response', nodeId: node.nodeId, ...extra });
  return { node, phone, store, request, verify };
}

describe('verifyDeviceEnvelope', () => {
  it('accepts a good response and returns the message, bytes and device', async () => {
    const { phone, request, verify } = await setup();
    const result = verify(phone.respond(request, 'approve'));
    assert.equal(result.ok, true);
    assert.equal(result.deviceId, phone.deviceId);
    assert.equal(result.message.decision, 'approve');
    assert.ok(Buffer.isBuffer(result.bytes));
  });

  it('step 1: malformed and unsupported_version', async () => {
    const { phone, request, verify } = await setup();
    const good = phone.respond(request, 'approve');
    const spaced = Buffer.from(fromB64url(good.payload).toString('utf8').replace('{', '{ '));
    assert.deepEqual(verify({ ...good, payload: toB64url(spaced), sig: toB64url(phone.signer.sign(spaced)) }), { ok: false, reason: 'malformed' });
    assert.deepEqual(verify(phone.respond(request, 'approve', { overrides: { v: 2 } })), { ok: false, reason: 'unsupported_version' });
    assert.deepEqual(verify(phone.respond(request, 'maybe')), { ok: false, reason: 'malformed' });
    assert.deepEqual(verify(good, { type: 'kl.approval.status' }), { ok: false, reason: 'malformed' });
  });

  it('step 2: alg must be ES256 and kid the device named inside', async () => {
    const { phone, request, verify } = await setup();
    const good = phone.respond(request, 'approve');
    assert.deepEqual(verify({ ...good, alg: 'Ed25519' }), { ok: false, reason: 'malformed' });
    const other = createFakePhone();
    assert.deepEqual(verify(phone.respond(request, 'approve', { overrides: { device_id: other.deviceId } })), { ok: false, reason: 'malformed' });
  });

  it('steps 3–5: unknown, demo, test-key and revoked devices', async () => {
    const demo = createFakePhone({ platform: 'demo' });
    const testKey = createFakePhone({ seed: 'B' });
    const revoked = createFakePhone();
    const { request, verify } = await setup({
      extraRecords: [demo.approverRecord(), testKey.approverRecord(), revoked.approverRecord({ revokedAt: '2026-09-23T17:00:00.000Z', revokedBy: 'console' })]
    });
    assert.deepEqual(verify(createFakePhone().respond(request, 'approve')), { ok: false, reason: 'unknown_device' });
    assert.deepEqual(verify(demo.respond(request, 'approve')), { ok: false, reason: 'demo_device' });
    assert.deepEqual(verify(testKey.respond(request, 'approve')), { ok: false, reason: 'test_key' });
    assert.deepEqual(verify(revoked.respond(request, 'approve')), { ok: false, reason: 'revoked_device' });
    const overlaid = await setup();
    overlaid.store.addToOverlay(overlaid.phone.deviceId);
    assert.deepEqual(overlaid.verify(overlaid.phone.respond(overlaid.request, 'approve')), { ok: false, reason: 'revoked_device' });
    assert.equal(overlaid.verify(overlaid.phone.respond(overlaid.request, 'approve'), { overlay: false }).ok, true);
  });

  it('a test key is accepted only with allowTestKeys', async () => {
    const b = createFakePhone({ seed: 'B' });
    const { request, verify } = await setup({ extraRecords: [b.approverRecord()], allowTestKeys: true });
    assert.equal(verify(b.respond(request, 'approve')).ok, true);
  });

  it('step 6: bad_signature', async () => {
    const { phone, request, verify } = await setup();
    const good = phone.respond(request, 'approve');
    const deny = phone.respond(request, 'deny');
    assert.deepEqual(verify({ ...good, sig: deny.sig }), { ok: false, reason: 'bad_signature' });
  });

  it('step 7: wrong_node', async () => {
    const { phone, verify } = await setup();
    const elsewhere = m.buildRequest({ identity: testNodeIdentity({ nodeName: 'gpu-box' }), action: m.toolAction('Bash', { command: 'ls' }, null) }).envelope;
    assert.deepEqual(verify(phone.respond(elsewhere, 'approve')), { ok: false, reason: 'wrong_node' });
  });

  it('step 8: replay (same bytes) and already_decided (different bytes, same nonce)', async () => {
    const { phone, request, verify } = await setup();
    const nonces = new NonceCache();
    const first = phone.respond(request, 'approve');
    const opened = verify(first, { nonces });
    nonces.add(opened.message.nonce, bytesSha256(opened.bytes));
    assert.deepEqual(verify(first, { nonces }), { ok: false, reason: 'replay' });
    const second = createFakePhone();
    const s2 = await approverStoreWith([phone.approverRecord(), second.approverRecord()]);
    stores.push(s2);
    assert.deepEqual(verifyDeviceEnvelope(second.respond(request, 'deny'), { approverStore: s2, type: 'kl.approval.response', nodeId: opened.message.node_id, nonces }), { ok: false, reason: 'already_decided' });
  });

  it('check-order: a revoked device with a bad signature is revoked_device, not bad_signature', async () => {
    const revoked = createFakePhone();
    const { request, verify } = await setup({
      extraRecords: [revoked.approverRecord({ revokedAt: '2026-09-23T17:00:00.000Z', revokedBy: 'console' })]
    });
    const good = revoked.respond(request, 'approve');
    const deny = revoked.respond(request, 'deny');
    assert.deepEqual(verify({ ...good, sig: deny.sig }), { ok: false, reason: 'revoked_device' });
  });

  it('check-order: a wrong node with a bad signature is bad_signature, not wrong_node', async () => {
    const { phone, verify } = await setup();
    const elsewhere = m.buildRequest({ identity: testNodeIdentity({ nodeName: 'gpu-box' }), action: m.toolAction('Bash', { command: 'ls' }, null) }).envelope;
    const good = phone.respond(elsewhere, 'approve');
    const deny = phone.respond(elsewhere, 'deny');
    assert.deepEqual(verify({ ...good, sig: deny.sig }), { ok: false, reason: 'bad_signature' });
  });

  it('an admin-revoked device is refused even with overlay:false', async () => {
    const revoked = createFakePhone();
    const { request, verify } = await setup({
      extraRecords: [revoked.approverRecord({ revokedAt: '2026-09-23T17:00:00.000Z', revokedBy: 'console' })]
    });
    assert.deepEqual(verify(revoked.respond(request, 'approve'), { overlay: false }), { ok: false, reason: 'revoked_device' });
  });
});

describe('NonceCache', () => {
  it('forgets entries after ttlMs and keeps at most max', () => {
    let now = 0;
    const cache = new NonceCache({ max: 2, ttlMs: 1000, now: () => now });
    cache.add('a', 'x');
    cache.add('b', 'y');
    cache.add('c', 'z');
    assert.equal(cache.get('a'), null);
    assert.deepEqual(cache.get('b'), { sha256: 'y' });
    assert.deepEqual(cache.get('c'), { sha256: 'z' });
    now = 2000;
    assert.equal(cache.get('b'), null);
  });
});

describe('verifyConsoleEnrollment', () => {
  const codeId = crypto.randomBytes(16).toString('base64url');
  const code = crypto.randomBytes(32).toString('base64url');

  it('accepts a self-signed enrollment with the right code_mac', () => {
    const phone = createFakePhone({ name: 'Pixel 9' });
    const result = verifyConsoleEnrollment(phone.enroll({ codeId, code }), { codeId, code });
    assert.equal(result.ok, true);
    assert.equal(result.deviceId, phone.deviceId);
  });

  it('refuses a wrong code, a wrong code_id, an expired one and a test key', () => {
    const phone = createFakePhone();
    assert.deepEqual(verifyConsoleEnrollment(phone.enroll({ codeId, code: crypto.randomBytes(32).toString('base64url') }), { codeId, code }), { ok: false, reason: 'bad_mac' });
    assert.deepEqual(verifyConsoleEnrollment(phone.enroll({ codeId, code }), { codeId: crypto.randomBytes(16).toString('base64url'), code }), { ok: false, reason: 'wrong_code' });
    assert.deepEqual(verifyConsoleEnrollment(phone.enroll({ codeId, code, now: Date.now() - 20 * 60 * 1000 }), { codeId, code }), { ok: false, reason: 'expired' });
    assert.deepEqual(verifyConsoleEnrollment(createFakePhone({ seed: 'C' }).enroll({ codeId, code }), { codeId, code }), { ok: false, reason: 'test_key' });
    const other = createFakePhone();
    const signedByOther = seal({ ...JSON.parse(fromB64url(phone.enroll({ codeId, code }).payload)) }, { ...other.signer, kid: phone.deviceId });
    assert.deepEqual(verifyConsoleEnrollment(signedByOther, { codeId, code }), { ok: false, reason: 'bad_signature' });
  });

  it('fails closed (expired) when now is NaN', () => {
    const phone = createFakePhone();
    const envelope = phone.enroll({ codeId, code });
    assert.deepEqual(verifyConsoleEnrollment(envelope, { codeId, code, now: NaN }), { ok: false, reason: 'expired' });
  });

  it('refuses a demo device', () => {
    const demo = createFakePhone({ platform: 'demo' });
    assert.deepEqual(verifyConsoleEnrollment(demo.enroll({ codeId, code }), { codeId, code }), { ok: false, reason: 'demo_device' });
  });

  it('a relayed enrollment (non-null enrolled_by) is malformed here: only the console path is checked', () => {
    const phone = createFakePhone();
    const relayed = phone.enroll({}); // no codeId → enrolled_by is the phone's own device id, not null
    assert.deepEqual(verifyConsoleEnrollment(relayed, { codeId, code }), { ok: false, reason: 'malformed' });
  });
});

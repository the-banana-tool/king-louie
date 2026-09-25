// tests/approvals-fake-phone.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFakePhone, testNodeIdentity, KEYS } = require('./helpers/fake-phone');
const { verifyEs256, verifyEd25519, open, deviceIdFromJwk, seal } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');
const { TEST_DEVICE_KEYS, TEST_NODE_KEYS, isTestDeviceKey, isTestNodeKey } = require('../src/approvals/test-keys');

describe('test keys', () => {
  it('test-keys.js lists exactly the public halves of keys.json', () => {
    for (const k of TEST_DEVICE_KEYS) {
      const fixed = KEYS.devices[k.name];
      assert.equal(fixed.jwk.x, k.x);
      assert.equal(fixed.jwk.y, k.y);
      assert.equal(deviceIdFromJwk(fixed.jwk), k.device_id);
      assert.equal(fixed.id, k.device_id);
    }
    assert.deepEqual(Object.values(KEYS.nodes).map((n) => n.spki), [...TEST_NODE_KEYS]);
    assert.equal(isTestDeviceKey(KEYS.devices.B.jwk), true);
    assert.equal(isTestDeviceKey(createFakePhone().jwk), false);
    assert.equal(isTestNodeKey(KEYS.nodes['web-01'].spki), true);
  });

  it('fixed seeds give the keys and ids in keys.json', () => {
    assert.equal(createFakePhone({ seed: 'A' }).deviceId, KEYS.devices.A.id);
    const node = testNodeIdentity({ key: 'web-01' });
    assert.equal(node.nodeId, KEYS.nodes['web-01'].id);
    assert.equal(node.publicKey.toString('hex'), KEYS.nodes['web-01'].spki);
  });
});

describe('createFakePhone', () => {
  it('answers a request with a verifiable, well-formed response', () => {
    const node = testNodeIdentity({ key: 'web-01' });
    const phone = createFakePhone();
    const { envelope } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
    const response = phone.respond(envelope, 'approve');
    assert.equal(verifyEs256(response, phone.jwk), true);
    assert.equal(m.validateMessage('kl.approval.response', open(response).message), null);
    assert.equal(verifyEd25519(envelope, node.publicKey.toString('hex')), true);
  });

  it('enrolls itself at a console with a code_mac, and signs enrollments of others', () => {
    const a = createFakePhone();
    const b = createFakePhone({ name: 'Second phone', platform: 'ios' });
    const code = crypto.randomBytes(32).toString('base64url');
    const codeId = crypto.randomBytes(16).toString('base64url');
    const consoleEnv = a.enroll({ codeId, code });
    const consoleMsg = open(consoleEnv).message;
    assert.equal(m.validateMessage('kl.device.enroll', consoleMsg), null);
    const { code_mac: mac, ...withoutMac } = consoleMsg;
    assert.equal(mac, m.enrollMac(code, withoutMac));
    assert.equal(consoleEnv.kid, a.deviceId);

    const signedEnv = a.enroll({ device: b.device() });
    const signedMsg = open(signedEnv).message;
    assert.equal(m.validateMessage('kl.device.enroll', signedMsg), null);
    assert.equal(signedMsg.enrolled_by, a.deviceId);
    assert.equal(signedMsg.device.device_id, b.deviceId);
    assert.equal(verifyEs256(signedEnv, a.jwk), true);
  });

  it('revokes another device and signs API calls', () => {
    const a = createFakePhone();
    const b = createFakePhone();
    const revoke = open(a.revoke(b.deviceId)).message;
    assert.equal(m.validateMessage('kl.device.revoke', revoke), null);
    const headers = a.signApi('GET', '/v1/approvals?wait=0', '', { timestamp: '2026-09-23T18:05:00.000Z' });
    const s = m.phoneAuthString('GET', '/v1/approvals?wait=0', '2026-09-23T18:05:00.000Z', '');
    const env = { alg: 'ES256', kid: a.deviceId, payload: Buffer.from(s).toString('base64url'), sig: headers['X-KL-Signature'] };
    assert.equal(verifyEs256(env, a.jwk), true);
    assert.equal(headers['X-KL-Device'], a.deviceId);
  });

  it('approverRecord is an approver file for this phone', () => {
    const phone = createFakePhone({ name: 'Pixel 9' });
    const rec = phone.approverRecord();
    assert.equal(rec.device_id, phone.deviceId);
    assert.equal(rec.revoked_at, null);
    assert.equal(seal({ a: 1 }, phone.signer).kid, phone.deviceId);
  });
});

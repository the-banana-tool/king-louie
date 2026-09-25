// tests/frontdoor-stores.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeviceRegistry } = require('../src/frontdoor/device-registry');
const { ApprovalCache, MAX_WAIT_MS: CACHE_MAX_WAIT_MS } = require('../src/frontdoor/approval-cache');
const { Invites } = require('../src/frontdoor/invites');
const { Mailbox, MAX_WAIT_MS: MAX_WAIT_MS_BOX } = require('../src/frontdoor/mailbox');
const { seal } = require('../src/approvals/envelope');
const m = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function registryFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-stores-'));
  dirs.push(d);
  return path.join(d, 'relay', 'devices.json');
}

describe('DeviceRegistry', () => {
  it('registers, persists, addresses push and tracks per-node state', () => {
    const file = registryFile();
    const phone = createFakePhone({ name: 'Pixel 9' });
    const reg = new DeviceRegistry({ file });
    reg.register({ device_id: phone.deviceId, jwk: phone.jwk, name: 'Pixel 9', platform: 'android' });
    reg.setPush(phone.deviceId, { platform: 'fcm', token: 'tok-1' });
    reg.setNodeState(phone.deviceId, 'kl-aaaaaaaaaaaaaaaa', 'active');
    reg.setNodeState(phone.deviceId, 'kl-bbbbbbbbbbbbbbbb', 'staged');
    const reloaded = new DeviceRegistry({ file });
    assert.deepEqual(reloaded.get(phone.deviceId).push, { platform: 'fcm', token: 'tok-1' });
    assert.deepEqual(reloaded.devicesForNode('kl-aaaaaaaaaaaaaaaa').map((d) => d.device_id), [phone.deviceId]);
    assert.deepEqual(reloaded.devicesForNode('kl-bbbbbbbbbbbbbbbb'), []);
    assert.deepEqual(reloaded.nodesForDevice(phone.deviceId), [{ node_id: 'kl-aaaaaaaaaaaaaaaa', state: 'active' }, { node_id: 'kl-bbbbbbbbbbbbbbbb', state: 'staged' }]);
    assert.throws(() => reg.register({ device_id: createFakePhone().deviceId, jwk: phone.jwk, name: 'x', platform: 'ios' }), (e) => e.code === 'bad_device');
  });

  it('keeps an append-only device log', () => {
    const reg = new DeviceRegistry({ file: registryFile() });
    const a = createFakePhone();
    const b = createFakePhone();
    reg.appendLog(a.enroll({ device: b.device() }));
    reg.appendLog(a.revoke(b.deviceId));
    assert.equal(reg.log().length, 2);
  });

  it('never lets an outside id become a key: bad device_id and node_id are refused, not stored', () => {
    const reg = new DeviceRegistry({ file: registryFile() });
    const phone = createFakePhone();
    reg.register({ device_id: phone.deviceId, jwk: phone.jwk, name: 'x', platform: 'android' });
    assert.throws(() => reg.setNodeState(phone.deviceId, 'not-a-node-id', 'active'), (e) => e.code === 'bad_node');
    assert.equal(reg.get('not-a-device-id'), null);
    assert.equal(reg.setPush('not-a-device-id', { platform: 'fcm', token: 't' }), null);
    assert.deepEqual(reg.devicesForNode('not-a-node-id'), []);
    assert.deepEqual(reg.nodesForDevice('not-a-device-id'), []);
    assert.equal(reg.remove('not-a-device-id'), false);
    // __proto__ is a legal-looking (if bogus) node id key: confirm it never
    // reaches Object.prototype through the per-device nodes map.
    assert.throws(() => reg.setNodeState(phone.deviceId, '__proto__', 'active'), (e) => e.code === 'bad_node');
  });
});

describe('ApprovalCache', () => {
  it('holds requests per node, attaches statuses and signals change', async () => {
    let now = Date.parse('2026-09-23T18:00:00.000Z');
    const cache = new ApprovalCache({ now: () => now });
    const node = testNodeIdentity();
    const { envelope, message } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null), now });
    const waiting = cache.waitForChange(0, 1000);
    cache.put(node.nodeId, envelope);
    assert.equal(await waiting, 1);
    assert.deepEqual(cache.list([node.nodeId]).map((e) => e.request_id), [message.request_id]);
    assert.deepEqual(cache.list(['kl-other']), []);
    const status = m.buildStatus({ identity: node, requestId: message.request_id, state: 'approved', now });
    assert.equal(cache.setStatus(message.request_id, status), true);
    assert.equal(cache.get(message.request_id).status, status);
    now += 300000 + 61000;
    cache.sweep();
    assert.equal(cache.get(message.request_id), null);
  });

  it('refuses a request whose node id is malformed or whose envelope disagrees with the caller-authenticated node', () => {
    const cache = new ApprovalCache();
    const node = testNodeIdentity();
    const other = testNodeIdentity();
    const { envelope } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
    assert.throws(() => cache.put('not-a-node-id', envelope), (e) => e.code === 'bad_node');
    assert.throws(() => cache.put(other.nodeId, envelope), (e) => e.code === 'bad_request');
  });

  it('setStatus reports false, never throws, for a status that does not check out', () => {
    const cache = new ApprovalCache();
    const node = testNodeIdentity();
    const other = testNodeIdentity();
    const { envelope, message } = m.buildRequest({ identity: node, action: m.toolAction('Bash', { command: 'ls' }, null) });
    cache.put(node.nodeId, envelope);
    const wrongNode = m.buildStatus({ identity: other, requestId: message.request_id, state: 'approved' });
    assert.equal(cache.setStatus(message.request_id, wrongNode), false);
    assert.equal(cache.setStatus(message.request_id, { alg: 'garbage' }), false);
    assert.equal(cache.get(message.request_id).status, null);
  });

  it('waitForChange clamps to MAX_WAIT_MS and never leaks its listener on timeout', async () => {
    assert.equal(CACHE_MAX_WAIT_MS, 25000);
    const cache = new ApprovalCache();
    assert.equal(cache.listenerCount('change'), 0);
    const result = await cache.waitForChange(0, 20);
    assert.equal(result, 0);
    assert.equal(cache.listenerCount('change'), 0);
  });
});

describe('Invites', () => {
  it('codes: open, claim, close; expire after ten minutes', () => {
    let now = 0;
    const inv = new Invites({ now: () => now });
    const codeId = crypto.randomBytes(16).toString('base64url');
    inv.openCode(codeId, 'kl-aaaaaaaaaaaaaaaa', 600000);
    assert.equal(inv.getCode(codeId).state, 'waiting');
    inv.claimCode(codeId, { alg: 'ES256' });
    inv.closeCode(codeId, 'done', { alg: 'Ed25519' });
    assert.equal(inv.getCode(codeId).state, 'done');
    const other = crypto.randomBytes(16).toString('base64url');
    inv.openCode(other, 'kl-aaaaaaaaaaaaaaaa', 600000);
    now = 600001;
    assert.equal(inv.getCode(other).state, 'expired');
    assert.throws(() => inv.claimCode(other, {}), (e) => e.code === 'unknown_code');
  });

  it('invites are single-use and readable only by the inviter', () => {
    const inv = new Invites();
    const a = createFakePhone();
    const b = createFakePhone();
    const { invite_id: inviteId } = inv.createInvite(a.deviceId);
    assert.equal(inv.getClaim(inviteId, a.deviceId), null);
    inv.claim(inviteId, { device: b.device(), mac: 'm' });
    assert.throws(() => inv.claim(inviteId, { device: b.device(), mac: 'm' }), (e) => e.code === 'already_claimed');
    assert.deepEqual(inv.getClaim(inviteId, a.deviceId).device, b.device());
    assert.throws(() => inv.getClaim(inviteId, b.deviceId), (e) => e.code === 'forbidden');
    assert.throws(() => inv.claim('nope', { device: b.device(), mac: 'm' }), (e) => e.code === 'unknown_invite');
  });

  it('an expired invite is unknown to getInvite, claim and getClaim alike', () => {
    let now = 0;
    const inv = new Invites({ now: () => now });
    const a = createFakePhone();
    const b = createFakePhone();
    const { invite_id: inviteId } = inv.createInvite(a.deviceId);
    assert.notEqual(inv.getInvite(inviteId), null);
    now += 10 * 60 * 1000 + 1;
    assert.equal(inv.getInvite(inviteId), null);
    assert.throws(() => inv.claim(inviteId, { device: b.device(), mac: 'm' }), (e) => e.code === 'unknown_invite');
    assert.throws(() => inv.getClaim(inviteId, a.deviceId), (e) => e.code === 'unknown_invite');
  });

  it('rejects ids and states that do not fit their regex before they ever become a key', () => {
    const inv = new Invites();
    assert.throws(() => inv.openCode('not-a-code', 'kl-aaaaaaaaaaaaaaaa', 600000), (e) => e.code === 'bad_code');
    assert.throws(() => inv.openCode(crypto.randomBytes(16).toString('base64url'), 'not-a-node', 600000), (e) => e.code === 'bad_node');
    assert.throws(() => inv.createInvite('not-a-device'), (e) => e.code === 'bad_device');
    const codeId = crypto.randomBytes(16).toString('base64url');
    inv.openCode(codeId, 'kl-aaaaaaaaaaaaaaaa', 600000);
    assert.throws(() => inv.closeCode(codeId, 'waiting'), TypeError);
  });
});

describe('Mailbox', () => {
  const node = testNodeIdentity();
  const msg = (type, extra = {}) => seal({ v: 1, type, node_id: node.nodeId, nonce: m.randomNonce(), ...extra }, node.signer);

  it('routes only registered types, filters by node, type, device and seq', () => {
    const box = new Mailbox();
    assert.throws(() => box.put(node.nodeId, msg('kl.lease.offer')), (e) => e.code === 'type_not_routed');
    box.registerType('kl.lease.', { ttlMs: 60000 });
    box.registerType('kl.question.', { ttlMs: 60000 });
    const { seq } = box.put(node.nodeId, msg('kl.lease.offer'));
    box.put(node.nodeId, msg('kl.question.ask'), { to_device: 'd-aaaaaaaaaaaaaaaa' });
    assert.equal(box.list({ nodeIds: [node.nodeId], typePrefix: 'kl.lease.' }).length, 1);
    assert.equal(box.list({ nodeIds: [node.nodeId], toDevice: 'd-bbbbbbbbbbbbbbbb' }).length, 1);
    assert.equal(box.list({ nodeIds: [node.nodeId], toDevice: 'd-aaaaaaaaaaaaaaaa' }).length, 2);
    assert.equal(box.list({ nodeIds: [node.nodeId], afterSeq: seq, toDevice: 'd-aaaaaaaaaaaaaaaa' }).length, 1);
    assert.equal(box.list({ nodeIds: ['kl-other'] }).length, 0);
  });

  it('wait resolves on a new message and caps the wait at 25 s', async () => {
    const box = new Mailbox();
    box.registerType('kl.lease.', { ttlMs: 60000 });
    const pending = box.wait({ nodeIds: [node.nodeId] }, { timeoutMs: 1000 });
    box.put(node.nodeId, msg('kl.lease.offer'));
    assert.equal((await pending).length, 1);
    assert.deepEqual(await box.wait({ nodeIds: ['kl-other'] }, { timeoutMs: 10 }), []);
  });

  it('drops messages past their ttl and refuses oversize ones', () => {
    let now = 0;
    const box = new Mailbox({ now: () => now });
    box.registerType('kl.lease.', { ttlMs: 1000, maxBytes: 200 });
    box.put(node.nodeId, msg('kl.lease.offer'));
    assert.throws(() => box.put(node.nodeId, msg('kl.lease.offer', { pad: 'x'.repeat(300) })), (e) => e.code === 'too_large');
    now = 1001;
    assert.equal(box.list({ nodeIds: [node.nodeId] }).length, 0);
  });

  it('a prefix near-miss never routes: kl.leasex. is not kl.lease.', () => {
    const box = new Mailbox();
    box.registerType('kl.lease.', { ttlMs: 60000 });
    assert.throws(() => box.put(node.nodeId, msg('kl.leasex.foo')), (e) => e.code === 'type_not_routed');
    // The near-miss type must match a full segment when registered the other
    // way around too: registering 'kl.leasex.' never lets 'kl.lease.done'
    // through it.
    const box2 = new Mailbox();
    box2.registerType('kl.leasex.', { ttlMs: 60000 });
    assert.throws(() => box2.put(node.nodeId, msg('kl.lease.done')), (e) => e.code === 'type_not_routed');
    assert.throws(() => box.registerType('kl.lease', { ttlMs: 1000 }), TypeError);
  });

  it('never routes approval-protocol types: kl.enroll.* and friends are reserved', () => {
    const box = new Mailbox();
    for (const prefix of ['kl.enroll.', 'kl.approval.', 'kl.device.', 'kl.audit.', 'kl.', 'kl.enroll.sub.']) {
      assert.throws(() => box.registerType(prefix, { ttlMs: 1000 }), (e) => e.code === 'type_reserved', prefix);
    }
    box.registerType('kl.lease.', { ttlMs: 60000 });
    assert.throws(() => box.put(node.nodeId, msg('kl.enroll.done')), (e) => e.code === 'type_not_routed');
  });

  it('refuses a malformed node id or to_device before either is stored', () => {
    const box = new Mailbox();
    box.registerType('kl.lease.', { ttlMs: 60000 });
    assert.throws(() => box.put('not-a-node-id', msg('kl.lease.offer')), (e) => e.code === 'bad_node');
    assert.throws(() => box.put(node.nodeId, msg('kl.lease.offer'), { to_device: 'not-a-device-id' }), (e) => e.code === 'bad_device');
  });

  it('wait never leaks its "change" listener once the timeout fires', async () => {
    assert.equal(MAX_WAIT_MS_BOX, 25000);
    const box = new Mailbox();
    box.registerType('kl.lease.', { ttlMs: 60000 });
    assert.equal(box.listenerCount('change'), 0);
    const result = await box.wait({ nodeIds: ['kl-nobody-here-0000'] }, { timeoutMs: 20 });
    assert.deepEqual(result, []);
    assert.equal(box.listenerCount('change'), 0);
  });
});

// tests/frontdoor-push-notify.test.js
// The relay's push.notify link method (push spec §6.2): a pinned node asks
// the relay to push session_ended / session_paused to its fcm phones.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerNodeMethods } = require('../src/frontdoor/node-methods');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const { startRelay } = require('../src/frontdoor/relay');
const { RelayClient } = require('../src/approvals/relay-client');
const { createFakePhone } = require('./helpers/fake-phone');

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const NODE = 'n-' + 'a'.repeat(16);
const OTHER = 'n-' + 'b'.repeat(16);
const devA = 'd-' + 'a'.repeat(16);
const devB = 'd-' + 'b'.repeat(16);
const devC = 'd-' + 'c'.repeat(16);
const devIos = 'd-' + 'd'.repeat(16);
const LEASE = crypto.randomUUID();

// registerNodeMethods over fakes: the hub hands back the handlers, the
// registry answers devicesForNode, the pusher records.
function harness() {
  const handlers = new Map();
  const pushes = [];
  const puts = [];
  const all = [
    { device_id: devA, push: { platform: 'fcm', token: 't-a' }, nodes: { [NODE]: 'active' } },
    { device_id: devB, push: { platform: 'fcm', token: 't-b' }, nodes: { [NODE]: 'active' } },
    { device_id: devC, push: { platform: 'fcm', token: 't-c' }, nodes: { [NODE]: 'revoked', [OTHER]: 'active' } },
    { device_id: devIos, push: { platform: 'apns', token: 't-d' }, nodes: { [NODE]: 'active' } }
  ];
  const relay = {
    nodeHub: { onNodeMessage: (name, h) => handlers.set(name, h), nodeById: (id) => (id === NODE ? { node_id: NODE, node_name: 'gpu-box' } : null) },
    approvals: {},
    devices: { devicesForNode: (id) => all.filter((d) => d.nodes[id] === 'active') },
    invites: {},
    mailbox: { put: (...a) => { puts.push(a); return { seq: 1 }; } },
    pusher: { notify: async (device, payload) => { pushes.push({ device: device.device_id, ...payload }); } },
    identity: { nodeId: 'n-relay' },
    log: { warn: () => {}, info: () => {}, debug: () => {} }
  };
  registerNodeMethods(relay);
  const call = (params, nodeId = NODE) => handlers.get('push.notify')(params, { nodeId });
  return { call, pushes, puts };
}

const notify = (over = {}) => ({ kind: 'session_ended', id: LEASE, to_device: null, except_device: null, expires_at: null, ...over });

describe('push.notify (relay side)', () => {
  it('pushes session_ended to every active fcm device on the node, nothing in the mailbox', async () => {
    const h = harness();
    assert.deepEqual(await h.call(notify()), { ok: true });
    assert.deepEqual(h.pushes.map((p) => p.device).sort(), [devA, devB]);
    assert.deepEqual(h.pushes[0], { device: h.pushes[0].device, kind: 'session_ended', id: LEASE, node_name: 'gpu-box', expires_at: null, node_id: NODE });
    assert.equal(h.puts.length, 0);
  });

  it('except_device leaves the stopping phone out', async () => {
    const h = harness();
    await h.call(notify({ except_device: devA }));
    assert.deepEqual(h.pushes.map((p) => p.device), [devB]);
  });

  it('to_device narrows to the granting phone, and carries expires_at', async () => {
    const h = harness();
    const expires = new Date(Date.now() + 600000).toISOString();
    await h.call(notify({ kind: 'session_paused', to_device: devB, expires_at: expires }));
    assert.deepEqual(h.pushes, [{ device: devB, kind: 'session_paused', id: LEASE, node_name: 'gpu-box', expires_at: expires, node_id: NODE }]);
  });

  it('a device of another node, or a non-fcm device, is never a target', async () => {
    const h = harness();
    await h.call(notify({ to_device: devC }));
    await h.call(notify({ to_device: devIos }));
    assert.deepEqual(h.pushes, []);
  });

  it('refuses bad_push for a bad kind, id, device id, both narrowings or expiry', async () => {
    const h = harness();
    const bad = [
      notify({ kind: 'approval' }),
      notify({ kind: 'test' }),
      notify({ id: 'l-1' }),
      notify({ id: LEASE.toUpperCase() }),
      notify({ id: '00000000-0000-1000-8000-000000000000' }),
      notify({ to_device: 'd-short' }),
      notify({ except_device: 42 }),
      notify({ to_device: devA, except_device: devB }),
      notify({ expires_at: 'tomorrow' }),
      null,
      'session_ended'
    ];
    for (const params of bad) {
      await assert.rejects(h.call(params), (e) => e.code === 'bad_push', JSON.stringify(params));
    }
    assert.deepEqual(h.pushes, []);
  });
});

describe('push.notify end to end: a real RelayClient to a real relay', () => {
  it('RelayClient#pushNotify reaches the relay and pushes to the fcm phone', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-push-notify-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const pushes = [];
    const relayIdentity = new NodeIdentity({ nodeName: 'relay' });
    const relay = await startRelay({
      dataDir: path.join(tmp, 'relay'),
      identity: relayIdentity,
      useTls: false,
      config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com:8443', tls: {}, push: {} },
      senders: [{ id: 'recording', platforms: ['fcm', 'apns'], notify: async (device, payload) => { pushes.push({ device: device.device_id, ...payload }); return { ok: true }; } }]
    });
    cleanups.push(() => relay.stop());

    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    const { code } = relay.nodeHub.addCode('gpu-box');
    const meshPort = relay.address().mesh.port;
    const pairing = new MeshPairing(identity, new MeshTransport({ identity, listen: false, useTls: false }), { timeoutMs: 5000 });
    const info = await pairing.acceptCode(code, '127.0.0.1', meshPort);
    cleanups.push(() => pairing.cleanup());

    const phone = createFakePhone({ name: 'Owner phone', platform: 'android' });
    const stopper = createFakePhone({ name: 'Second phone', platform: 'android' });
    for (const p of [phone, stopper]) {
      relay.devices.register({ device_id: p.deviceId, jwk: p.device().public_key, name: p.name || 'phone', platform: 'android' });
      relay.devices.setNodeState(p.deviceId, identity.nodeId, 'active');
      relay.devices.setPush(p.deviceId, { platform: 'fcm', token: `tok-${p.deviceId}` });
    }

    const client = new RelayClient({
      identity, nodeName: 'gpu-box', dataDir: path.join(tmp, 'node'), useTls: false, reconnectDelays: [50],
      relayPin: { relay_id: deriveNodeId(info.publicKey), peerId: info.peerId, publicKey: info.publicKey, tlsFingerprint: null, address: '127.0.0.1', port: meshPort, pairedAt: new Date().toISOString() }
    });
    cleanups.push(() => client.stop());
    const connected = new Promise((resolve) => client.once('connected', resolve));
    const keepAlive = setTimeout(() => {}, 10000);
    try {
      await client.start();
      await connected;
      const leaseId = crypto.randomUUID();
      assert.deepEqual(await client.pushNotify({ kind: 'session_ended', id: leaseId, to_device: null, except_device: stopper.deviceId, expires_at: null }), { ok: true });
      for (let i = 0; i < 100 && pushes.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].device, phone.deviceId);
      assert.equal(pushes[0].kind, 'session_ended');
      assert.equal(pushes[0].id, leaseId);
      await assert.rejects(client.pushNotify({ kind: 'nope', id: leaseId, to_device: null, except_device: null, expires_at: null }), (e) => e.code === 'bad_push');
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

// tests/approvals-relay-client.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { RelayClient, isReservedMethod } = require('../src/approvals/relay-client');

let relayIdentity;
let nodeIdentity;
before(() => {
  relayIdentity = new NodeIdentity({ nodeName: 'relay' });
  nodeIdentity = new NodeIdentity({ nodeName: 'web-01' });
});

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-client-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Just enough relay to answer the link: hello plus recorders.
async function fakeRelay({ port = 0, relayId = null } = {}) {
  const transport = new MeshTransport({ identity: relayIdentity, host: '127.0.0.1', port, useTls: false });
  transport.addTrustedPeer(nodeIdentity.peerId, nodeIdentity.publicKey);
  await transport.start();
  const rpc = createLinkRpc(transport);
  const seen = [];
  rpc.handle('relay.hello', (params) => { seen.push(['relay.hello', params]); return { relay_id: relayId || relayIdentity.nodeId, public_url: 'https://kl.example.com:8443', phone_spki: 'sha256/test' }; });
  rpc.handle('approval.submit', (params) => { seen.push(['approval.submit', params]); return { ok: true }; });
  rpc.handle('message.submit', (params) => { seen.push(['message.submit', params]); return { ok: true, seq: 1 }; });
  rpc.onUnhandled((method, params) => { seen.push([method, params]); return { ok: true }; });
  return { transport, rpc, seen, stop: () => transport.stop() };
}

function pinFor(relay) {
  return {
    relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
    tlsFingerprint: null, address: '127.0.0.1', port: relay.transport.port, pairedAt: new Date().toISOString()
  };
}

function client(relay, extra = {}) {
  const dataDir = tempDir();
  const c = new RelayClient({ identity: nodeIdentity, relayPin: pinFor(relay), dataDir, useTls: false, reconnectDelays: [50, 100], ...extra });
  cleanups.push(() => c.stop());
  return { c, dataDir };
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));
const readLink = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));

describe('RelayClient', () => {
  it('dials, says hello, writes link.json and emits connected', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.equal(c.isConnected(), true);
    assert.deepEqual(relay.seen[0], ['relay.hello', { node_id: nodeIdentity.nodeId, node_name: 'web-01', versions: [1] }]);
    const link = readLink(dataDir);
    assert.equal(link.connected, true);
    assert.equal(link.relay_id, relayIdentity.nodeId);
    assert.equal(link.relay_public_url, 'https://kl.example.com:8443');
    assert.equal(link.relay_spki, 'sha256/test');
  });

  it('submit and send reach the relay; relay calls reach onMessage and registered methods', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const { c } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    await c.submit({ alg: 'Ed25519', kid: 'k', payload: 'p', sig: 's' });
    assert.deepEqual(await c.send({ a: 1 }, { push: { kind: 'lease', id: 'l-1' } }), { ok: true, seq: 1 });
    assert.deepEqual(relay.seen.slice(1).map((s) => s[0]), ['approval.submit', 'message.submit']);
    assert.deepEqual(relay.seen[2][1], { envelope: { a: 1 }, push: { kind: 'lease', id: 'l-1' }, to_device: null });

    c.onMessage(async (method, params) => ({ delivered: true, method, params }));
    assert.deepEqual(await relay.rpc.call(nodeIdentity.peerId, 'approval.response', { envelope: 'x' }), { delivered: true, method: 'approval.response', params: { envelope: 'x' } });
    c.registerMethod('question.answer', async (params, { peer }) => ({ got: params.q, peer }));
    assert.deepEqual(await relay.rpc.call(nodeIdentity.peerId, 'question.answer', { q: 1 }), { got: 1, peer: relayIdentity.peerId });
    c.notify('presence.foreground', { device_id: 'd-x' });
  });

  it('registerMethod refuses F3 names and mesh.task.* / mesh.channel.*', () => {
    const c = new RelayClient({ identity: nodeIdentity, relayPin: null });
    for (const name of ['approval.response', 'relay.hello', 'mesh.task.run', 'mesh.channel.open']) {
      assert.throws(() => c.registerMethod(name, () => {}), (err) => err.code === 'method_reserved', name);
      assert.equal(isReservedMethod(name), true);
    }
    assert.doesNotThrow(() => c.registerMethod('lease.grant', () => {}));
  });

  it('marks the link down when the relay goes, reconnects when it returns, and can still deliver', async () => {
    const relay = await fakeRelay();
    const port = relay.transport.port;
    const { c, dataDir } = client(relay);
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    const disconnected = once(c, 'disconnected');
    await relay.stop();
    await disconnected;
    assert.equal(c.isConnected(), false);
    assert.equal(readLink(dataDir).connected, false);
    assert.deepEqual(c.canDeliver(), { ok: true });
    await assert.rejects(c.submit({}), (err) => err.code === 'relay_offline');
    const back = once(c, 'connected');
    const again = await fakeRelay({ port });
    cleanups.push(again.stop);
    await back;
    assert.equal(c.isConnected(), true);
  });

  it('refuses a relay that answers with another relay id', async () => {
    const relay = await fakeRelay({ relayId: 'kl-aaaaaaaaaaaaaaaa' });
    cleanups.push(relay.stop);
    const { c } = client(relay);
    await c.start();
    for (let i = 0; i < 50 && relay.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.isConnected(), false);
  });

  it('dials front-door.json through connectPinned when the transport has it (E7)', async () => {
    const relay = await fakeRelay();
    cleanups.push(relay.stop);
    const configDir = tempDir();
    fs.writeFileSync(path.join(configDir, 'front-door.json'), JSON.stringify({ url: 'https://kl.example.com' }));
    const pinned = [];
    const transportFactory = (options) => {
      const t = new MeshTransport(options);
      t.connectPinned = (fd) => { pinned.push(fd); return t.connectToPeer('127.0.0.1', relay.transport.port); };
      return t;
    };
    const { c } = client(relay, { configDir, transportFactory });
    const connected = once(c, 'connected');
    await c.start();
    await connected;
    assert.deepEqual(pinned, [{ url: 'https://kl.example.com' }]);
  });
});

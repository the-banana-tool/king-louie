// tests/approvals-link-rpc.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { createLinkRpc } = require('../src/approvals/link-rpc');

// A minimal stand-in for MeshTransport that lets these tests inject
// peerMessage/peerDisconnected events directly and inspect what call() sent,
// without a real socket pair.
class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.online = new Set();
  }
  send(peerId, payload) {
    if (!this.online.has(peerId)) throw new Error(`not connected: ${peerId}`);
    this.sent.push({ peerId, payload });
  }
}

let relayId;
let nodeId;
before(() => {
  relayId = new NodeIdentity({ nodeName: 'relay' });
  nodeId = new NodeIdentity({ nodeName: 'web-01' });
});

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

// A listening "relay" transport and a dial-out-only "node" transport that
// trust each other, connected.
async function linked() {
  const relay = new MeshTransport({ identity: relayId, host: '127.0.0.1', port: 0, useTls: false });
  await relay.start();
  const node = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
  await node.start();
  cleanups.push(() => node.stop(), () => relay.stop());
  relay.addTrustedPeer(nodeId.peerId, nodeId.publicKey);
  node.addTrustedPeer(relayId.peerId, relayId.publicKey, { address: '127.0.0.1', port: relay.port });
  const relayConnected = new Promise((resolve) => relay.once('peerConnected', resolve));
  await node.connectToPeer('127.0.0.1', relay.port);
  await relayConnected;
  return { relay, node, relayRpc: createLinkRpc(relay), nodeRpc: createLinkRpc(node, { defaultTimeoutMs: 300 }) };
}

describe('MeshTransport listen: false', () => {
  it('starts without binding a port', async () => {
    const t = new MeshTransport({ identity: nodeId, listen: false, useTls: false, port: 0 });
    await t.start();
    cleanups.push(() => t.stop());
    assert.equal(t.server, null);
    assert.equal(t.running, true);
  });
});

describe('createLinkRpc', () => {
  it('calls a handler on the other side and returns its result', async () => {
    const { relayRpc, nodeRpc } = await linked();
    relayRpc.handle('relay.hello', async (params, { peerId }) => ({ echo: params.node_id, peerId }));
    assert.deepEqual(await nodeRpc.call(relayId.peerId, 'relay.hello', { node_id: nodeId.nodeId }), { echo: nodeId.nodeId, peerId: nodeId.peerId });
  });

  it('carries a handler error code back, and unknown methods', async () => {
    const { relayRpc, nodeRpc } = await linked();
    relayRpc.handle('message.submit', async () => { throw Object.assign(new Error('no such type'), { code: 'type_not_routed' }); });
    await assert.rejects(nodeRpc.call(relayId.peerId, 'message.submit', {}), (err) => err.code === 'type_not_routed');
    await assert.rejects(nodeRpc.call(relayId.peerId, 'nothing.here', {}), (err) => err.code === 'unknown_method');
  });

  it('times out, and delivers notifications and unhandled methods to the fallback', async () => {
    const { relayRpc, nodeRpc } = await linked();
    relayRpc.handle('slow', () => new Promise(() => {}));
    await assert.rejects(nodeRpc.call(relayId.peerId, 'slow', {}, { timeoutMs: 50 }), (err) => err.code === 'timeout');
    const got = [];
    relayRpc.onUnhandled((method, params) => { got.push([method, params]); return { ok: true }; });
    nodeRpc.notify(relayId.peerId, 'device.state', { device_id: 'd-x', state: 'active' });
    assert.deepEqual(await nodeRpc.call(relayId.peerId, 'lease.open', { a: 1 }), { ok: true });
    assert.deepEqual(got, [['device.state', { device_id: 'd-x', state: 'active' }], ['lease.open', { a: 1 }]]);
  });

  it('rejects a call to a peer that is not connected', async () => {
    const t = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
    const rpc = createLinkRpc(t);
    await assert.rejects(rpc.call('mesh-nobody', 'x', {}), (err) => err.code === 'offline');
  });
});

describe('MeshPairing additions', () => {
  it('addCode pairs a node whose name matches, returns meta, and refuses another name', async () => {
    const relay = new MeshTransport({ identity: relayId, host: '127.0.0.1', port: 0, useTls: false });
    await relay.start();
    cleanups.push(() => relay.stop());
    const relayPairing = new MeshPairing(relayId, relay, { timeoutMs: 5000 });
    let paired = null;
    relay.onPairingRequest = (ws, msg) => { paired = relayPairing.handlePairingRequest(ws, msg); };

    const node = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
    const nodePairing = new MeshPairing(nodeId, node, { timeoutMs: 5000 });
    const { code, expiresAt } = relayPairing.addCode('Abandon Ability Able About Above Absent', { nodeName: 'web-01' });
    assert.equal(code, 'abandon ability able about above absent');
    assert.ok(expiresAt > Date.now());
    const info = await nodePairing.acceptCode(code, '127.0.0.1', relay.port);
    assert.equal(info.nodeId, relayId.nodeId);
    assert.equal(paired.nodeName, 'web-01');
    assert.deepEqual(paired.meta, { nodeName: 'web-01' });

    const other = new NodeIdentity({ nodeName: 'gpu-box' });
    const otherPairing = new MeshPairing(other, new MeshTransport({ identity: other, listen: false, useTls: false }), { timeoutMs: 5000 });
    relayPairing.addCode('bacon badge balance bamboo banana banner', { nodeName: 'web-01' });
    await assert.rejects(otherPairing.acceptCode('bacon badge balance bamboo banana banner', '127.0.0.1', relay.port), /name_mismatch/);
    relayPairing.cleanup();
  });
});

describe('createLinkRpc hardening', () => {
  it("an answer from a different peer than the call was made to is ignored, not matched by id alone", () => {
    const transport = new FakeTransport();
    transport.online.add('peer-a');
    const rpc = createLinkRpc(transport, { defaultTimeoutMs: 5000 });
    const pending = rpc.call('peer-a', 'do.thing', {});
    const { id } = transport.sent[0].payload;

    // Peer B answers with peer A's call id: must not settle the call.
    transport.emit('peerMessage', { from: 'peer-b', payload: { rpc: 1, id, result: 'stolen' } });
    // The real peer answers: this is the one that must settle it.
    transport.emit('peerMessage', { from: 'peer-a', payload: { rpc: 1, id, result: 'legit' } });

    return pending.then((result) => assert.equal(result, 'legit'));
  });

  it('every pending call settles on close(), even to different peers', async () => {
    const transport = new FakeTransport();
    transport.online.add('peer-a');
    transport.online.add('peer-b');
    const rpc = createLinkRpc(transport, { defaultTimeoutMs: 5000 });
    const a = rpc.call('peer-a', 'x', {});
    const b = rpc.call('peer-b', 'y', {});
    rpc.close();
    await assert.rejects(a, (err) => err.code === 'closed');
    await assert.rejects(b, (err) => err.code === 'closed');
  });

  it('an oversized id or method name is dropped rather than matched or dispatched', async () => {
    const transport = new FakeTransport();
    transport.online.add('peer-a');
    const rpc = createLinkRpc(transport, { defaultTimeoutMs: 50 });
    let unhandledHits = 0;
    rpc.onUnhandled(() => { unhandledHits += 1; return { ok: true }; });

    // A notification with a huge method name must not reach the fallback.
    transport.emit('peerMessage', { from: 'peer-a', payload: { rpc: 1, method: 'x'.repeat(10000), params: {} } });
    assert.equal(unhandledHits, 0);

    // A call whose id is absurdly long must be dropped rather than answered.
    let handlerCalled = false;
    rpc.handle('short.method', () => { handlerCalled = true; return { ok: true }; });
    transport.emit('peerMessage', { from: 'peer-a', payload: { rpc: 1, id: 'i'.repeat(10000), method: 'short.method', params: {} } });
    assert.equal(handlerCalled, false);
    assert.equal(transport.sent.length, 0);
  });

  it('a malformed rpc payload (missing method, non-object) is dropped rather than crashing the transport', () => {
    const transport = new FakeTransport();
    const rpc = createLinkRpc(transport, { defaultTimeoutMs: 50 });
    assert.doesNotThrow(() => {
      transport.emit('peerMessage', { from: 'peer-a', payload: { rpc: 1 } });
      transport.emit('peerMessage', { from: 'peer-a', payload: { rpc: 1, id: 'abc' } });
      transport.emit('peerMessage', { from: 'peer-a', payload: null });
      transport.emit('peerMessage', { from: 'peer-a', payload: 'not-an-object' });
      transport.emit('peerMessage', { from: 'peer-a', payload: { rpc: 2, method: 'x' } });
    });
    rpc.close();
  });

  it('a peer disconnecting settles only that peer\'s pending calls', async () => {
    const transport = new FakeTransport();
    transport.online.add('peer-a');
    transport.online.add('peer-b');
    const rpc = createLinkRpc(transport, { defaultTimeoutMs: 5000 });
    const a = rpc.call('peer-a', 'x', {});
    const b = rpc.call('peer-b', 'y', {});
    transport.emit('peerDisconnected', { peerId: 'peer-a' });
    await assert.rejects(a, (err) => err.code === 'peer_disconnected');
    transport.emit('peerMessage', { from: 'peer-b', payload: { rpc: 1, id: transport.sent[1].payload.id, result: 'ok' } });
    assert.equal(await b, 'ok');
    rpc.close();
  });
});

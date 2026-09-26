// tests/frontdoor-relay-external.test.js — fleet stage 4 §3.1 (E1, E3), §3.11.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { startRelay } = require('../src/frontdoor/relay');
const { NodeHub } = require('../src/frontdoor/node-hub');
const { FrontDoorSelfLink } = require('../src/frontdoor/self-link');
const { MeshTransport, CLOSE_CODES } = require('../src/mesh/mesh-transport');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { derivePeerId } = require('../src/mesh/mesh-identity');
const { buildEnrollOpen, buildEnrollDone } = require('../src/approvals/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-ext-')); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// M11: connectToPeer resolves when the dialer promotes, before the listener
// has; wait (bounded) for the listener's side of the link, as Task 6's
// linked() does.
async function linked(transport, peerId) {
  for (let i = 0; i < 300 && !transport.getPeer(peerId); i++) await sleep(10);
  assert.ok(transport.getPeer(peerId), 'the listener promoted the link');
}

async function externalRelay() {
  const fd = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
  const transport = new MeshTransport({ identity: fd, listen: false, useTls: false });
  const relay = await startRelay({
    dataDir: tmp(), identity: fd, listeners: 'external', transport, phoneSpki: 'sha256/aaaa',
    config: { publicUrl: 'https://mcp.kl.example.com', push: {} }
  });
  cleanups.push(() => relay.stop());
  const server = http.createServer(relay.phoneApiHandler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { fd, relay, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, method, pathWithQuery, { body = null, headers = {} } = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  const res = await fetch(`${base}${pathWithQuery}`, { method, body: body === null ? undefined : text, headers: { 'content-type': 'application/json', ...headers } });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

function rowFor(id, name) {
  return { peerId: id.peerId, publicKeyHex: id.publicKey.toString('hex'), name, tlsFingerprint: null, nodeId: id.nodeId };
}

// A NodeHub behind a plain ws:// listener with an F4-style peer source.
async function hubWithSource(hubId, rows) {
  const source = Object.assign(new EventEmitter(), { items: rows });
  source.list = () => source.items;
  const transport = new MeshTransport({ identity: hubId, host: '127.0.0.1', port: 0, useTls: false });
  const hub = new NodeHub({ identity: hubId, transport, pairing: new MeshPairing(hubId, transport), registryFile: path.join(tmp(), 'nodes.json'), peerSource: source });
  await hub.start({ listen: true });
  cleanups.push(() => hub.stop());
  return { hub, transport, source };
}

async function dialerFor(id, hubId) {
  const dialer = new MeshTransport({ identity: id, listen: false, useTls: false });
  await dialer.start();
  cleanups.push(() => dialer.stop());
  dialer.addTrustedPeer(hubId.peerId, hubId.publicKey);
  return dialer;
}

function attachFd(hub, fd, dispatch = async () => null) {
  hub.attachLocalNode({ nodeId: fd.nodeId, nodeName: 'frontdoor', publicKeyHex: fd.publicKey.toString('hex'), dispatch });
}

describe('startRelay with an external listener', () => {
  it('binds nothing, needs the transport, and reports the phone pin it is given', async () => {
    const { relay } = await externalRelay();
    assert.deepEqual(relay.address(), { phone: null, mesh: null });
    assert.equal(relay.phoneSpki, 'sha256/aaaa');
    relay.setPhoneSpki('sha256/bbbb');
    assert.equal(relay.phoneSpki, 'sha256/bbbb');
    await assert.rejects(startRelay({ dataDir: tmp(), identity: testNodeIdentity(), listeners: 'external', config: { publicUrl: 'https://x.example.com' } }), /needs the front door's transport/);
  });

  it('relay.hello reports the pin set by setPhoneSpki', async () => {
    const { fd, relay } = await externalRelay();
    attachFd(relay.nodeHub, fd);
    relay.setPhoneSpki('sha256/cccc');
    const hello = await relay.nodeHub.callLocal('relay.hello', { node_id: fd.nodeId, node_name: 'frontdoor', versions: [1] });
    assert.deepEqual(hello, { relay_id: fd.nodeId, public_url: 'https://mcp.kl.example.com', phone_spki: 'sha256/cccc' });
  });

  it("'own' still refuses a public mesh host, with or without a transport", async () => {
    const own = { publicUrl: 'https://relay.example.com', push: {}, phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '0.0.0.0', port: 0 } };
    await assert.rejects(startRelay({ dataDir: tmp(), identity: testNodeIdentity(), listeners: 'own', useTls: false, config: own }), /mesh/i);
    const transport = new MeshTransport({ identity: testNodeIdentity(), listen: false, useTls: false });
    await assert.rejects(startRelay({ dataDir: tmp(), identity: testNodeIdentity(), listeners: 'own', useTls: false, config: own, transport }), /mesh/i);
  });
});

describe('the front door as its own node', () => {
  it('runs F3 console enrollment against the front door and serves its history', async () => {
    const { fd, relay, base } = await externalRelay();
    const calls = [];
    relay.nodeHub.attachLocalNode({
      nodeId: fd.nodeId, nodeName: 'frontdoor', publicKeyHex: fd.publicKey.toString('hex'),
      dispatch: async (method, params) => {
        calls.push([method, params]);
        if (method === 'enroll.claim') return { delivered: true };
        if (method === 'audit.slice') return { envelope: { alg: 'Ed25519', kid: fd.nodeId, payload: 'e30', sig: 'AA' } };
        return null;
      }
    });
    assert.equal(relay.nodeHub.nodeById(fd.nodeId).node_id, fd.nodeId);
    assert.deepEqual(relay.nodeHub.nodes(), [], 'the local node is not listed as a paired node');

    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    await relay.nodeHub.callLocal('enroll.open', { envelope: buildEnrollOpen({ identity: fd, codeId, expiresAt: Date.now() + 600000 }) });
    const phone = createFakePhone({ seed: 'A' });
    const claim = phone.enroll({ codeId, code });
    const posted = await request(base, 'POST', `/v1/enroll/${codeId}`, { body: claim });
    assert.equal(posted.status, 202);
    assert.equal(calls[0][0], 'enroll.claim');
    await relay.nodeHub.callLocal('enroll.done', { envelope: buildEnrollDone({ identity: fd, codeId, enroll: claim }) });
    assert.deepEqual(relay.devices.nodesForDevice(phone.deviceId), [{ node_id: fd.nodeId, state: 'active' }]);

    const history = `/v1/nodes/${fd.nodeId}/history?limit=5`;
    const got = await request(base, 'GET', history, { headers: phone.signApi('GET', history) });
    assert.equal(got.status, 200);
    assert.equal(calls.at(-1)[0], 'audit.slice');
  });

  it('FrontDoorSelfLink writes link.json and relays node → relay calls locally', async () => {
    const { fd, relay } = await externalRelay();
    relay.nodeHub.attachLocalNode({ nodeId: fd.nodeId, nodeName: 'frontdoor', publicKeyHex: fd.publicKey.toString('hex'), dispatch: async () => null });
    const dataDir = tmp();
    const link = new FrontDoorSelfLink({ nodeHub: relay.nodeHub, dataDir, frontdoorId: fd.nodeId, publicUrl: 'https://mcp.kl.example.com', spki: () => relay.phoneSpki });
    link.writeLink();
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));
    assert.deepEqual({ connected: written.connected, relay_id: written.relay_id, relay_public_url: written.relay_public_url, relay_spki: written.relay_spki },
      { connected: true, relay_id: fd.nodeId, relay_public_url: 'https://mcp.kl.example.com', relay_spki: 'sha256/aaaa' });
    assert.equal(link.isConnected(), true);
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.deepEqual(await link.call('enroll.open', { envelope: buildEnrollOpen({ identity: fd, codeId, expiresAt: Date.now() + 600000 }) }), { ok: true });
  });

  it('callLocal needs an attached local node and a known method', async () => {
    const { fd, relay } = await externalRelay();
    await assert.rejects(relay.nodeHub.callLocal('relay.hello', { node_id: fd.nodeId }), { code: 'no_local_node' });
    attachFd(relay.nodeHub, fd);
    await assert.rejects(relay.nodeHub.callLocal('no.such.method', {}), { code: 'unknown_method' });
  });

  it('a remote peer that claims the front door id is refused', async () => {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const impostor = new NodeIdentity({ nodeName: 'gpu-box' });
    // The peer source lists another key under the front door's node id.
    const { hub, transport } = await hubWithSource(hubId, [{ ...rowFor(impostor, 'gpu-box'), nodeId: hubId.nodeId }]);
    const dispatched = [];
    attachFd(hub, hubId, async (method) => { dispatched.push(method); return null; });
    const handled = [];
    hub.onNodeMessage('device.state', (params, ctx) => { handled.push(ctx.nodeId); return { ok: true }; });
    assert.equal(transport.trustedPeers.has(impostor.peerId), false, 'the row is not trusted');
    assert.equal(hub.nodeById(hubId.nodeId).local, true, 'the front door id resolves to the local node only');
    assert.equal(hub.nodeByPeer(impostor.peerId), null);
    assert.deepEqual(hub.nodes(), []);
    const dialer = await dialerFor(impostor, hubId);
    await assert.rejects(dialer.connectToPeer('127.0.0.1', transport.port));
    assert.deepEqual(handled, []);
    assert.deepEqual(dispatched, []);
  });

  it('a row claiming the front door id that arrives after attachLocalNode is dropped too', async () => {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const impostor = new NodeIdentity({ nodeName: 'gpu-box' });
    const { hub, transport, source } = await hubWithSource(hubId, []);
    attachFd(hub, hubId);
    source.items = [{ ...rowFor(impostor, 'gpu-box'), nodeId: hubId.nodeId }];
    source.emit('change');
    assert.equal(transport.trustedPeers.has(impostor.peerId), false);
    assert.equal(hub.nodeById(hubId.nodeId).local, true);
  });

  it('a remote key cannot pair under the front door id', async () => {
    const { fd, relay } = await externalRelay();
    attachFd(relay.nodeHub, fd);
    const publicKey = fd.publicKey.toString('hex');
    assert.equal(relay.nodeHub._admitPairing({ peerId: derivePeerId(publicKey), publicKey }, { nodeName: 'web-01' }), 'already_paired');
  });
});

describe('peer source changes', { timeout: 15000 }, () => {
  it('a node dropped from the peer source is closed with 4003', async () => {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const nodeId = new NodeIdentity({ nodeName: 'gpu-box' });
    const { transport, source } = await hubWithSource(hubId, [rowFor(nodeId, 'gpu-box')]);
    const dialer = await dialerFor(nodeId, hubId);
    await dialer.connectToPeer('127.0.0.1', transport.port);
    await linked(transport, nodeId.peerId);
    const closed = once(dialer, 'peerDisconnected');
    source.items = [];
    source.emit('change');
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.keyRemoved);
    assert.equal(transport.trustedPeers.has(nodeId.peerId), false);
  });

  it('a removed node cannot reconnect; the nodes still listed keep their trust', async () => {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const nodeId = new NodeIdentity({ nodeName: 'gpu-box' });
    const other = new NodeIdentity({ nodeName: 'web-01' });
    const { hub, transport, source } = await hubWithSource(hubId, [rowFor(nodeId, 'gpu-box'), rowFor(other, 'web-01')]);
    const dialer = await dialerFor(nodeId, hubId);
    await dialer.connectToPeer('127.0.0.1', transport.port);
    await linked(transport, nodeId.peerId);
    const closed = once(dialer, 'peerDisconnected');
    source.items = [rowFor(other, 'web-01')];
    source.emit('change');
    await closed;
    await assert.rejects(dialer.connectToPeer('127.0.0.1', transport.port));
    assert.equal(transport.getPeer(nodeId.peerId), null);
    assert.equal(hub.nodeByPeer(nodeId.peerId), null);
    const stays = await dialerFor(other, hubId);
    await stays.connectToPeer('127.0.0.1', transport.port);
    await linked(transport, other.peerId);
  });
});

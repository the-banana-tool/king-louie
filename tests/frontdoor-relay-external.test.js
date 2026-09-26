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
const { trackDeviceStates } = require('../src/approvals/service-wiring');
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
// Real-shaped phone pins (relaySpkiPin: sha256/ + 43 base64url characters).
const pin = (seed) => `sha256/${crypto.createHash('sha256').update(seed).digest('base64url')}`;
const PIN_A = pin('a');
const PIN_B = pin('b');
const PIN_C = pin('c');

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
    dataDir: tmp(), identity: fd, listeners: 'external', transport, phoneSpki: PIN_A, testOnlyAllowPlainTransport: true,
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
    assert.equal(relay.phoneSpki, PIN_A);
    relay.setPhoneSpki(PIN_B);
    assert.equal(relay.phoneSpki, PIN_B);
    await assert.rejects(startRelay({ dataDir: tmp(), identity: testNodeIdentity(), listeners: 'external', config: { publicUrl: 'https://x.example.com' } }), /needs the front door's transport/);
  });

  it('relay.hello reports the pin set by setPhoneSpki', async () => {
    const { fd, relay } = await externalRelay();
    attachFd(relay.nodeHub, fd);
    relay.setPhoneSpki(PIN_C);
    const hello = await relay.nodeHub.callLocal('relay.hello', { node_id: fd.nodeId, node_name: 'frontdoor', versions: [1] });
    assert.deepEqual(hello, { relay_id: fd.nodeId, public_url: 'https://mcp.kl.example.com', phone_spki: PIN_C });
  });

  it("'external' needs the relay's own identity on a pinned TLS transport, and a well-formed pin", async () => {
    const fd = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
    const base = { dataDir: tmp(), identity: fd, listeners: 'external', config: { publicUrl: 'https://mcp.kl.example.com', push: {} } };
    const other = new MeshTransport({ identity: testNodeIdentity(), listen: false, useTls: false });
    await assert.rejects(startRelay({ ...base, transport: other, testOnlyAllowPlainTransport: true }), /relay's own identity/);
    const plain = new MeshTransport({ identity: fd, listen: false, useTls: false });
    await assert.rejects(startRelay({ ...base, transport: plain }), /TLS and pinned client certificates/);
    const tlsNoPin = new MeshTransport({ identity: fd, listen: false, useTls: true });
    await assert.rejects(startRelay({ ...base, transport: tlsNoPin }), /TLS and pinned client certificates/);
    await assert.rejects(startRelay({ ...base, transport: plain, testOnlyAllowPlainTransport: true, phoneSpki: 'sha256/aaaa' }), TypeError);
    const { relay } = await externalRelay();
    for (const bad of ['sha256/aaaa', `sha1/${PIN_A.slice(7)}`, `${PIN_A}=`, null, 42]) assert.throws(() => relay.setPhoneSpki(bad), TypeError);
    assert.equal(relay.phoneSpki, PIN_A, 'a refused pin leaves the old one');
  });

  it('a front door without a certificate yet starts with no pin', async () => {
    const fd = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
    const relay = await startRelay({ dataDir: tmp(), identity: fd, listeners: 'external', testOnlyAllowPlainTransport: true,
      transport: new MeshTransport({ identity: fd, listen: false, useTls: false }), config: { publicUrl: 'https://mcp.kl.example.com', push: {} } });
    cleanups.push(() => relay.stop());
    assert.equal(relay.phoneSpki, null);
  });

  it("'own' ignores a passed transport and phoneSpki", async () => {
    const own = { publicUrl: 'https://relay.example.com', push: {}, phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 } };
    const id = testNodeIdentity();
    const transport = new MeshTransport({ identity: id, listen: false, useTls: false });
    const relay = await startRelay({ dataDir: tmp(), identity: id, listeners: 'own', useTls: false, config: own, transport, phoneSpki: PIN_A });
    cleanups.push(() => relay.stop());
    assert.equal(relay.phoneSpki, null);
    assert.notEqual(relay.nodeHub.transport, transport);
    assert.ok(relay.address().mesh.port > 0, "'own' binds its own mesh listener");
  });

  it("'own' still refuses a public mesh host, with or without a transport", async () => {
    const own = { publicUrl: 'https://relay.example.com', push: {}, phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '0.0.0.0', port: 0 } };
    await assert.rejects(startRelay({ dataDir: tmp(), identity: testNodeIdentity(), listeners: 'own', useTls: false, config: own }), /mesh/i);
    const transport = new MeshTransport({ identity: testNodeIdentity(), listen: false, useTls: false });
    await assert.rejects(startRelay({ dataDir: tmp(), identity: testNodeIdentity(), listeners: 'own', useTls: false, config: own, transport }), /mesh/i);
  });
});

describe('the front door as its own node', { timeout: 15000 }, () => {
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
      { connected: true, relay_id: fd.nodeId, relay_public_url: 'https://mcp.kl.example.com', relay_spki: PIN_A });
    assert.equal(link.isConnected(), true);
    const codeId = crypto.randomBytes(16).toString('base64url');
    assert.deepEqual(await link.call('enroll.open', { envelope: buildEnrollOpen({ identity: fd, codeId, expiresAt: Date.now() + 600000 }) }), { ok: true });
  });

  it('trackDeviceStates on the self-link makes a device applied while the front door was stopped active', async () => {
    const { fd, relay, base } = await externalRelay();
    attachFd(relay.nodeHub, fd, async (method) => (method === 'enroll.claim' ? { delivered: true } : null));
    // A device enrolled on the front door earlier, whose column the relay
    // lost (it was applied by the admin while the front door was stopped).
    const codeId = crypto.randomBytes(16).toString('base64url');
    await relay.nodeHub.callLocal('enroll.open', { envelope: buildEnrollOpen({ identity: fd, codeId, expiresAt: Date.now() + 600000 }) });
    const phone = createFakePhone({ seed: 'B' });
    const claim = phone.enroll({ codeId, code: crypto.randomBytes(32).toString('base64url') });
    assert.equal((await request(base, 'POST', `/v1/enroll/${codeId}`, { body: claim })).status, 202);
    await relay.nodeHub.callLocal('enroll.done', { envelope: buildEnrollDone({ identity: fd, codeId, enroll: claim }) });
    relay.devices.setNodeState(phone.deviceId, fd.nodeId, 'revoked');
    const states = () => relay.devices.nodesForDevice(phone.deviceId);
    assert.deepEqual(states(), [{ node_id: fd.nodeId, state: 'revoked' }]);

    const link = new FrontDoorSelfLink({ nodeHub: relay.nodeHub, dataDir: tmp(), frontdoorId: fd.nodeId, publicUrl: 'https://mcp.kl.example.com', spki: () => relay.phoneSpki });
    const approverStore = { list: () => [{ device_id: phone.deviceId }], isAdminApplied: () => true, refresh() {} };
    const stop = trackDeviceStates({ approverStore, relayClient: link, intervalMs: 60000 });
    cleanups.push(async () => stop());
    for (let i = 0; i < 200 && states()[0].state !== 'active'; i++) await sleep(10);
    assert.deepEqual(states(), [{ node_id: fd.nodeId, state: 'active' }]);
  });

  it('a local rpc honours timeoutMs', async () => {
    const { fd, relay } = await externalRelay();
    attachFd(relay.nodeHub, fd, () => new Promise(() => {}));
    await assert.rejects(relay.nodeHub.rpc(fd.nodeId, 'audit.head', {}, { timeoutMs: 50 }), (err) => err.name === 'LinkRpcError' && err.code === 'timeout');
    attachFd(relay.nodeHub, fd, async () => ({ ok: 1 }));
    assert.deepEqual(await relay.nodeHub.rpc(fd.nodeId, 'audit.head', {}, { timeoutMs: 50 }), { ok: 1 });
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

  it('an impostor linked before attachLocalNode is closed with 4003', async () => {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const impostor = new NodeIdentity({ nodeName: 'gpu-box' });
    const { hub, transport } = await hubWithSource(hubId, [{ ...rowFor(impostor, 'gpu-box'), nodeId: hubId.nodeId }]);
    const dialer = await dialerFor(impostor, hubId);
    await dialer.connectToPeer('127.0.0.1', transport.port);
    await linked(transport, impostor.peerId);
    const closed = once(dialer, 'peerDisconnected');
    attachFd(hub, hubId);
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.keyRemoved);
    assert.equal(transport.trustedPeers.has(impostor.peerId), false);
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

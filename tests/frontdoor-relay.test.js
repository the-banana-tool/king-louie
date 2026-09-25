// tests/frontdoor-relay.test.js
//
// An in-process relay, real nodes (startApprovals with a RelayClient) and a
// fake phone over plain HTTP and WS (no TLS).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const { startRelay } = require('../src/frontdoor/relay');
const { assertPrivateMeshHost } = require('../src/frontdoor/net');
const { startApprovals } = require('../src/approvals/service-wiring');
const { FileCourier } = require('../src/approvals/courier');
const { ApproverAdmin } = require('../src/approvals/approver-admin');
const { verifyConsoleEnrollment } = require('../src/approvals/verify-device');
const { buildEnrollOpen, buildEnrollDone } = require('../src/approvals/messages');
const { open, seal, nodeSigner } = require('../src/approvals/envelope');
const { verifyAuditSlice } = require('../src/audit/audit-ledger');
const { createFakePhone } = require('./helpers/fake-phone');
const https = require('https');
const net = require('net');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { buildRequest, toolAction } = require('../src/approvals/messages');
const { relaySpkiPin } = require('../src/frontdoor/tls');
const { createPhoneServer, PHONE_LISTENER } = require('../src/frontdoor/relay');
const { addSink } = require('../src/logging');
const { MAX_LOG_LINES } = require('../src/frontdoor/device-registry');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
const cleanups = [];
const logLines = [];
cleanups.push(addSink((record) => { logLines.push(record.line); }));
after(async () => { for (const c of cleanups.reverse()) await c(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

let relay;
let relayIdentity;
const pushes = [];
const base = () => `http://127.0.0.1:${relay.address().phone.port}`;

async function phoneCall(phone, method, p, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = phone ? { ...phone.signApi(method, p, text), 'content-type': 'application/json' } : { 'content-type': 'application/json' };
  const res = await fetch(base() + p, { method, headers, body: method === 'GET' ? undefined : text });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

// A node: its own data and admin config dirs, paired with the relay, running
// startApprovals, with a service.pid naming this process so couriers work.
async function startNode(name, approverRecords = []) {
  const baseDir = tempDir(`kl-relay-node-${name}-`);
  const dataDir = path.join(baseDir, 'data');
  const configDir = path.join(baseDir, 'config');
  fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(dataDir, { recursive: true });
  if (POSIX) for (const d of [baseDir, configDir, path.join(configDir, 'approvers')]) fs.chmodSync(d, 0o755);
  for (const r of approverRecords) fs.writeFileSync(path.join(configDir, 'approvers', `${r.device_id}.json`), JSON.stringify(r), { mode: 0o644 });
  fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));

  const identity = new NodeIdentity({ nodeName: name });
  const { code } = relay.nodeHub.addCode(name);
  const meshPort = relay.address().mesh.port;
  const pairing = new MeshPairing(identity, new MeshTransport({ identity, listen: false, useTls: false }), { timeoutMs: 5000 });
  const info = await pairing.acceptCode(code, '127.0.0.1', meshPort);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data' });
  store.set('approvals.relay', { relay_id: deriveNodeId(info.publicKey), peerId: info.peerId, publicKey: info.publicKey, tlsFingerprint: null, address: '127.0.0.1', port: meshPort, pairedAt: new Date().toISOString() });

  const approvals = await startApprovals({
    dataDir, configDir, nodeConfig: { name, approvers: { relay: `wss://127.0.0.1:${meshPort}`, requestTtlS: 300 }, policy: {} },
    ports: { store, cipher: createAesGcmCipher(crypto.randomBytes(32)) }, identity, useTls: false, approverStoreOptions: storeOptions, reconnectDelays: [50]
  });
  cleanups.push(() => approvals.stop());
  await until(() => approvals.relayClient.isConnected(), `${name} to link`);
  return { name, identity, dataDir, configDir, approvals };
}

before(async () => {
  relayIdentity = new NodeIdentity({ nodeName: 'relay' });
  const relayData = tempDir('kl-relay-data-');
  relay = await startRelay({
    dataDir: relayData,
    identity: relayIdentity,
    useTls: false,
    config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com:8443', tls: {}, push: {} },
    senders: [{ id: 'recording', platforms: ['apns'], notify: async (device, payload) => { pushes.push({ device: device.device_id, ...payload }); return { ok: true }; } }],
    extensions: [(r) => r.mailbox.registerType('kl.test.', { ttlMs: 60000 })]
  });
  cleanups.push(() => relay.stop());
});

describe('relay end to end', () => {
  const owner = createFakePhone({ name: 'Owner phone', platform: 'ios' });
  const second = createFakePhone({ name: 'Second phone' });
  let web;

  it('console enrollment: code opened by the node, claimed by the phone, confirmed at the console', async () => {
    web = await startNode('web-01');
    const courier = new FileCourier({ dataDir: web.dataDir, identity: web.identity, pollMs: 20 }).start();
    cleanups.push(() => courier.stop());
    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    await courier.call('enroll.open', { envelope: buildEnrollOpen({ identity: web.identity, codeId, expiresAt: Date.now() + 600000 }) });
    const claimed = new Promise((resolve) => courier.onMessage(async (method, params) => { if (method === 'enroll.claim') resolve(params); }));
    const posted = await phoneCall(null, 'POST', `/v1/enroll/${codeId}`, owner.enroll({ codeId, code }));
    assert.deepEqual(posted, { status: 202, body: { state: 'waiting' } });
    const claim = await claimed;
    const check = verifyConsoleEnrollment(claim.envelope, { codeId, code });
    assert.equal(check.ok, true);
    const admin = new ApproverAdmin({ dir: path.join(web.configDir, 'approvers'), stagedDir: path.join(web.dataDir, 'approvals', 'staged'), ...storeOptions });
    admin.writeApprover({ ...owner.approverRecord({ enrollment: claim.envelope }), enrolled_at: new Date().toISOString() });
    await courier.call('enroll.done', { envelope: buildEnrollDone({ identity: web.identity, codeId, enroll: claim.envelope }) });
    assert.deepEqual((await phoneCall(null, 'GET', `/v1/enroll/${codeId}`)).body, { state: 'done', node: { node_id: web.identity.nodeId, node_name: 'web-01' } });
    web.approvals.approverStore.refresh();
    assert.equal(web.approvals.approverStore.isActive(owner.deviceId), true);
  });

  it('request → push → response → status, with long-poll wait', async () => {
    assert.equal((await phoneCall(owner, 'PUT', '/v1/push-token', { platform: 'apns', token: 'tok-owner' })).status, 204);
    await phoneCall(owner, 'GET', '/v1/approvals?wait=0');
    const started = Date.now();
    const idle = await phoneCall(owner, 'GET', '/v1/approvals?wait=1');
    assert.ok(Date.now() - started >= 900, 'nothing new: the call waited');
    assert.equal(idle.status, 200);

    const polling = phoneCall(owner, 'GET', '/v1/approvals?wait=10');
    const approved = web.approvals.phoneApprover.requestApproval('Bash', { command: 'systemctl restart site' }, { workingDirectory: '/srv/site' });
    const list = await polling;
    assert.equal(list.body.length, 1);
    const { envelope } = list.body[0];
    assert.ok(list.body[0].expires_in_ms > 290000);
    assert.equal(open(envelope).message.action.params.command, 'systemctl restart site');
    await until(() => pushes.length > 0, 'the push');
    assert.deepEqual(pushes[0], { device: owner.deviceId, kind: 'approval', id: open(envelope).message.request_id, node_name: 'web-01', expires_at: open(envelope).message.expires_at });

    const requestId = open(envelope).message.request_id;
    const res = await phoneCall(owner, 'POST', `/v1/approvals/${requestId}/response`, owner.respond(envelope, 'approve'));
    assert.deepEqual(res, { status: 202, body: { delivered: true, accepted: true, reason: null } });
    assert.equal(await approved, true);
    const after = await until(async () => {
      const r = await phoneCall(owner, 'GET', `/v1/approvals/${requestId}`);
      return r.body.status ? r : null;
    }, 'the status');
    assert.equal(open(after.body.status).message.state, 'approved');
    assert.equal((await phoneCall(owner, 'POST', `/v1/approvals/${crypto.randomUUID()}/response`, owner.respond(envelope, 'approve'))).status, 410);
  });

  it('signed enrollment and revocation are relayed, logged and staged on the node', async () => {
    const enrolled = await phoneCall(owner, 'POST', '/v1/devices/enroll', owner.enroll({ device: second.device() }));
    assert.deepEqual(enrolled.body, { nodes: [{ node_id: web.identity.nodeId, state: 'staged' }] });
    const revoked = await phoneCall(owner, 'POST', '/v1/devices/revoke', owner.revoke(second.deviceId));
    assert.deepEqual(revoked.body, { nodes: [{ node_id: web.identity.nodeId, state: 'revoked-pending-apply' }] });
    assert.equal(relay.devices.log().length, 2);
    assert.equal(fs.readdirSync(path.join(web.dataDir, 'approvals', 'staged')).filter((n) => n.endsWith('.json')).length, 2);
    const devicesList = await phoneCall(owner, 'GET', '/v1/devices');
    assert.ok(devicesList.body.some((d) => d.device_id === second.deviceId));
  });

  it('replays the device log to a node that pairs later', async () => {
    const gpu = await startNode('gpu-box', [owner.approverRecord()]);
    const staged = path.join(gpu.dataDir, 'approvals', 'staged');
    await until(() => fs.existsSync(staged) && fs.readdirSync(staged).filter((n) => n.endsWith('.json')).length === 2, 'the replayed log');
  });

  it('serves node-signed history slices', async () => {
    const res = await phoneCall(owner, 'GET', `/v1/nodes/${web.identity.nodeId}/history?limit=5`);
    const check = verifyAuditSlice(res.body, web.identity.publicKey.toString('hex'));
    assert.equal(check.ok, true);
    assert.ok(check.message.entries.length > 0 && check.message.entries.length <= 5);
    const nodes = await phoneCall(owner, 'GET', '/v1/nodes');
    assert.ok(nodes.body.every((n) => n.public_key === undefined), 'no keys in the node list');
  });

  it('message.submit reaches a registered type and refuses an unregistered one', async () => {
    const signer = nodeSigner(web.identity);
    const ok = await web.approvals.relayClient.send(seal({ v: 1, type: 'kl.test.ping', node_id: web.identity.nodeId, nonce: 'n'.repeat(43) }, signer), { push: { kind: 'lease', id: 'l-1' } });
    assert.equal(ok.ok, true);
    assert.equal(relay.mailbox.list({ nodeIds: [web.identity.nodeId] }).length, 1);
    await assert.rejects(web.approvals.relayClient.send(seal({ v: 1, type: 'kl.other.ping', node_id: web.identity.nodeId }, signer)), (err) => err.code === 'type_not_routed');
  });

  it('registerRoute replaces an earlier route, and registerMethod refuses reserved names', async () => {
    relay.phoneApi.registerRoute('POST', '/v1/pairing-codes', { auth: 'device', handler: async () => ({ body: { replaced: true } }) });
    assert.deepEqual((await phoneCall(owner, 'POST', '/v1/pairing-codes', { node_name: 'x' })).body, { replaced: true });
    assert.throws(() => web.approvals.relayClient.registerMethod('device.enroll', () => {}), (err) => err.code === 'method_reserved');
  });
});

describe('relay mesh listener exposure (ruling 8)', () => {
  it('accepts loopback and private IP literals only', () => {
    for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.10', '100.64.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) assert.doesNotThrow(() => assertPrivateMeshHost(ok), ok);
    for (const bad of ['0.0.0.0', '::', '8.8.8.8', '172.32.0.1', 'relay.example.com', '2001:db8::1', '']) {
      assert.throws(() => assertPrivateMeshHost(bad), /must be a loopback or private IP address until the stage 4 mesh hardening lands/, bad);
    }
  });
});

// ── Trust rules carried from earlier reviews ─────────────────────────────────
// A second relay (its own phone API rate buckets) and hand-driven "nodes": a
// paired mesh link with a bare link-rpc, so each test says exactly what the
// node sends and answers.
describe('relay trust rules', () => {
  let r;
  let trustData;
  const secrets = new Set();
  const trustBase = () => `http://127.0.0.1:${r.address().phone.port}`;
  async function call(phone, method, p, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = phone ? { ...phone.signApi(method, p, text), 'content-type': 'application/json' } : { 'content-type': 'application/json' };
    if (phone) secrets.add(headers['X-KL-Signature']);
    const res = await fetch(trustBase() + p, { method, headers, body: method === 'GET' ? undefined : text });
    const raw = await res.text();
    return { status: res.status, body: raw ? JSON.parse(raw) : null };
  }

  async function fakeNode(name, handlers = {}, relayUnderTest = r) {
    const identity = new NodeIdentity({ nodeName: name });
    const { code } = relayUnderTest.nodeHub.addCode(name);
    secrets.add(code);
    const meshPort = relayUnderTest.address().mesh.port;
    const transport = new MeshTransport({ identity, listen: false, useTls: false });
    const pairing = new MeshPairing(identity, transport, { timeoutMs: 5000 });
    const info = await pairing.acceptCode(code, '127.0.0.1', meshPort);
    const rpc = createLinkRpc(transport);
    for (const [method, fn] of Object.entries(handlers)) rpc.handle(method, fn);
    await transport.start();
    await transport.connectToPeer('127.0.0.1', meshPort);
    cleanups.push(async () => { rpc.close(); pairing.cleanup(); await transport.stop(); });
    await until(() => relayUnderTest.nodeHub.nodes().some((n) => n.node_name === name && n.online), `${name} online`);
    return {
      identity,
      call: (method, params) => rpc.call(info.peerId, method, params, { timeoutMs: 3000 }),
      notify: (method, params) => rpc.notify(info.peerId, method, params)
    };
  }

  const claims = [];
  let a;
  let b;
  const phone = createFakePhone({ name: 'Lab phone' });
  const other = createFakePhone({ name: 'Other phone' });

  const openCode = async (node, ms = 600000) => {
    const codeId = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(32).toString('base64url');
    secrets.add(codeId);
    secrets.add(code);
    await node.call('enroll.open', { envelope: buildEnrollOpen({ identity: node.identity, codeId, expiresAt: Date.now() + ms }) });
    return { codeId, code };
  };

  before(async () => {
    trustData = tempDir('kl-relay-trust-');
    r = await startRelay({
      dataDir: trustData,
      identity: new NodeIdentity({ nodeName: 'relay' }),
      useTls: false,
      config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com', tls: {}, push: {} },
      extensions: [(x) => x.mailbox.registerType('kl.test.', { ttlMs: 60000 })]
    });
    cleanups.push(() => r.stop());
    const answers = {
      'enroll.claim': (params) => { claims.push(params); return { delivered: true }; },
      // A node answering with a truthy non-true value must not read as accepted.
      'approval.response': () => ({ delivered: true, accepted: 'yes', reason: null })
    };
    a = await fakeNode('lab-a', answers);
    b = await fakeNode('lab-b', answers);
  });

  it('only enroll.done from the opening node, for the claim the relay saw, registers a device', async () => {
    const { codeId, code } = await openCode(a);
    // Another node cannot re-open (hijack) a code id that is already open.
    await assert.rejects(b.call('enroll.open', { envelope: buildEnrollOpen({ identity: b.identity, codeId, expiresAt: Date.now() + 600000 }) }), (e) => e.code === 'code_taken');

    const claim = phone.enroll({ codeId, code });
    assert.deepEqual(await call(null, 'POST', `/v1/enroll/${codeId}`, claim), { status: 202, body: { state: 'waiting' } });
    assert.equal(claims.length, 1);
    assert.equal(r.devices.get(phone.deviceId), null, 'a claim alone registers nothing');
    // A second, different claim for the same code is refused; the same one is a retry.
    assert.equal((await call(null, 'POST', `/v1/enroll/${codeId}`, other.enroll({ codeId, code }))).status, 409);
    assert.equal((await call(null, 'POST', `/v1/enroll/${codeId}`, claim)).status, 202);

    await assert.rejects(b.call('enroll.done', { envelope: buildEnrollDone({ identity: b.identity, codeId, enroll: claim }) }), (e) => e.code === 'unknown_code');
    await assert.rejects(a.call('enroll.done', { envelope: buildEnrollDone({ identity: a.identity, codeId, enroll: other.enroll({ codeId, code }) }) }), (e) => e.code === 'claim_mismatch');
    assert.equal(r.devices.get(phone.deviceId), null);

    assert.deepEqual(await a.call('enroll.done', { envelope: buildEnrollDone({ identity: a.identity, codeId, enroll: claim }) }), { ok: true });
    assert.equal(r.devices.get(phone.deviceId).device_id, phone.deviceId);
    assert.deepEqual(r.devices.nodesForDevice(phone.deviceId), [{ node_id: a.identity.nodeId, state: 'active' }]);

    // Closed: still visible, but nothing acts on it any more.
    assert.equal((await call(null, 'POST', `/v1/enroll/${codeId}`, claim)).status, 410);
    assert.equal((await call(null, 'GET', `/v1/enroll/${codeId}`)).body.state, 'done');
    await assert.rejects(a.call('enroll.done', { envelope: buildEnrollDone({ identity: a.identity, codeId, enroll: claim }) }), (e) => e.code === 'code_closed');
    await assert.rejects(a.call('enroll.open', { envelope: buildEnrollOpen({ identity: a.identity, codeId, expiresAt: Date.now() + 600000 }) }), (e) => e.code === 'code_taken');
    assert.equal(claims.length, 2, 'nothing more reached the node');
  });

  it('an expired code stays visible but refuses a claim and enroll.done', async () => {
    const { codeId, code } = await openCode(a, 300);
    await sleep(400);
    const claim = other.enroll({ codeId, code });
    assert.equal((await call(null, 'POST', `/v1/enroll/${codeId}`, claim)).status, 410);
    assert.equal((await call(null, 'GET', `/v1/enroll/${codeId}`)).body.state, 'expired');
    await assert.rejects(a.call('enroll.done', { envelope: buildEnrollDone({ identity: a.identity, codeId, enroll: claim }) }), (e) => e.code === 'code_closed');
    assert.equal(r.devices.get(other.deviceId), null);
  });

  it('an invite claim registers nothing, and a device active on no node cannot enroll another', async () => {
    const invite = await call(phone, 'POST', '/v1/devices/invites', {});
    secrets.add(invite.body.invite_id);
    const claimant = createFakePhone({ name: 'Claimant' });
    assert.equal((await call(null, 'POST', `/v1/devices/invites/${invite.body.invite_id}/claim`, { device: claimant.device(), mac: 'm'.repeat(43) })).status, 202);
    assert.equal(r.devices.get(claimant.deviceId), null);

    // lab-a has no device.enroll handler, so `other` is registered but active nowhere.
    const enrolled = await call(phone, 'POST', '/v1/devices/enroll', phone.enroll({ device: other.device() }));
    assert.deepEqual(enrolled.body, { nodes: [{ node_id: a.identity.nodeId, state: 'offline' }] });
    assert.equal(r.devices.get(other.deviceId).device_id, other.deviceId);
    const third = createFakePhone({ name: 'Third' });
    assert.equal((await call(other, 'POST', '/v1/devices/enroll', other.enroll({ device: third.device() }))).status, 403);
    assert.equal(r.devices.get(third.deviceId), null);
  });

  it('reports accepted only when the node answers exactly true', async () => {
    const { envelope } = buildRequest({ identity: a.identity, action: toolAction('Bash', { command: 'uptime' }, '/srv'), origin: { client: 'agent' }, ttlMs: 60000 });
    assert.deepEqual(await a.call('approval.submit', { envelope }), { ok: true });
    const requestId = open(envelope).message.request_id;
    const res = await call(phone, 'POST', `/v1/approvals/${requestId}/response`, phone.respond(envelope, 'approve'));
    assert.deepEqual(res, { status: 202, body: { delivered: true, accepted: null, reason: null } });
    // A response for another request is not forwarded.
    const { envelope: second } = buildRequest({ identity: a.identity, action: toolAction('Bash', { command: 'id' }, '/srv'), origin: { client: 'agent' }, ttlMs: 60000 });
    await a.call('approval.submit', { envelope: second });
    assert.equal((await call(phone, 'POST', `/v1/approvals/${open(second).message.request_id}/response`, phone.respond(envelope, 'approve'))).status, 400);
  });

  it('refuses node envelopes not signed by the node on the link, or naming another node', async () => {
    const { envelope: bRequest } = buildRequest({ identity: b.identity, action: toolAction('Bash', { command: 'id' }, null), origin: { client: 'agent' }, ttlMs: 60000 });
    await assert.rejects(a.call('approval.submit', { envelope: bRequest }), (e) => e.code === 'bad_signature');
    const signer = nodeSigner(a.identity);
    await assert.rejects(a.call('message.submit', { envelope: seal({ v: 1, type: 'kl.test.ping', node_id: b.identity.nodeId }, signer) }), (e) => e.code === 'wrong_node');
    await assert.rejects(a.call('message.submit', { envelope: seal({ v: 1, type: 'kl.test.ping' }, signer) }), (e) => e.code === 'wrong_node');
    assert.equal(r.mailbox.list({ nodeIds: [a.identity.nodeId, b.identity.nodeId] }).length, 0);
    await assert.rejects(a.call('relay.hello', { node_id: b.identity.nodeId }), (e) => e.code === 'wrong_node');
    await assert.rejects(a.call('device.state', { device_id: phone.deviceId, state: 'staged' }), (e) => e.code === 'malformed');
  });

  it('never routes approval-protocol types through the mailbox', async () => {
    for (const prefix of ['kl.enroll.', 'kl.', 'kl.approval.', 'kl.device.', 'kl.audit.']) {
      assert.throws(() => r.mailbox.registerType(prefix, { ttlMs: 1000 }), (e) => e.code === 'type_reserved', prefix);
    }
    const signer = nodeSigner(a.identity);
    const openMessage = { v: 1, type: 'kl.enroll.open', node_id: a.identity.nodeId, code_id: 'c'.repeat(22), expires_at: new Date(Date.now() + 60000).toISOString(), nonce: 'n'.repeat(43) };
    await assert.rejects(a.call('message.submit', { envelope: seal(openMessage, signer) }), (e) => e.code === 'type_not_routed');
  });

  it('refuses a mesh listener on a public or wildcard address before binding anything', async () => {
    for (const host of ['0.0.0.0', '8.8.8.8', 'relay.example.com']) {
      await assert.rejects(startRelay({
        dataDir: tempDir('kl-relay-host-'),
        identity: new NodeIdentity({ nodeName: 'relay' }),
        useTls: false,
        config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host, port: 0 }, publicUrl: 'https://kl.example.com', tls: {}, push: {} }
      }), /must be a loopback or private IP address/, host);
    }
  });

  it('bounds the phone listener: a non-zero request timeout and a connection cap', () => {
    const server = createPhoneServer({ useTls: false, handler: () => {} });
    assert.ok(server.requestTimeout > 0 && server.requestTimeout === PHONE_LISTENER.requestTimeoutMs);
    assert.ok(server.headersTimeout > 0 && server.headersTimeout <= server.requestTimeout);
    assert.ok(Number.isInteger(server.maxConnections) && server.maxConnections > 0 && server.maxConnections === PHONE_LISTENER.maxConnections);
  });

  it('serves the phone API over TLS and pins the certificate key', async () => {
    const identity = new NodeIdentity({ nodeName: 'relay' });
    const dir = tempDir('kl-relay-tls-');
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    fs.writeFileSync(certFile, identity.tlsCert);
    fs.writeFileSync(keyFile, identity.tlsKey);
    const pin = relaySpkiPin(identity.tlsCert);
    assert.match(pin, /^sha256\/[A-Za-z0-9_-]{43}$/);
    const spki = new crypto.X509Certificate(identity.tlsCert).publicKey.export({ type: 'spki', format: 'der' });
    assert.equal(pin, `sha256/${crypto.createHash('sha256').update(spki).digest('base64url')}`);
    const tlsRelay = await startRelay({
      dataDir: path.join(dir, 'data'),
      identity,
      config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com', tls: { certFile, keyFile }, push: {} }
    });
    cleanups.push(() => tlsRelay.stop());
    assert.equal(tlsRelay.phoneSpki, pin);
    const body = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: tlsRelay.address().phone.port, path: '/v1/time', rejectUnauthorized: false }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(JSON.parse(text)));
      }).on('error', reject);
    });
    assert.ok(Date.parse(body.server_time) > 0);
  });

  it('picks up `relay code` files within a second and drops bad ones quietly (M3, M8)', async () => {
    const codesDir = path.join(trustData, 'relay', 'codes');
    const code = 'alpha bravo cactus dawn eagle frost';
    secrets.add(code);
    const warnings = [];
    const removeSink = addSink((rec) => { if (rec.level === 'warn' && rec.subsystem === 'frontdoor/node-hub') warnings.push(rec.message); });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      fs.mkdirSync(path.join(codesDir, 'folder.json'));
      fs.writeFileSync(path.join(codesDir, 'bad.json'), `{"code": "${code}", oops`);
      fs.writeFileSync(path.join(codesDir, 'big.json'), JSON.stringify({ code, node_name: 'lab-big', expires_at: new Date(Date.now() + 60000).toISOString(), pad: 'x'.repeat(5000) }));
      let linked = false;
      fs.writeFileSync(path.join(trustData, 'outside.json'), JSON.stringify({ code, node_name: 'lab-link', expires_at: new Date(Date.now() + 60000).toISOString() }));
      try {
        fs.symlinkSync(path.join(trustData, 'outside.json'), path.join(codesDir, 'link.json'));
        linked = true;
      } catch (err) {
        if (err.code !== 'EPERM') throw err; // Windows without the symlink privilege
      }
      fs.writeFileSync(path.join(codesDir, 'good.json'), JSON.stringify({ code, node_name: 'lab-c', expires_at: new Date(Date.now() + 60000).toISOString() }));
      await until(() => fs.readdirSync(codesDir).filter((n) => n !== 'folder.json').length === 0, 'the code files to be picked up', 3000);
      await sleep(2200); // two more polls: the directory is still only warned about once
      assert.ok(fs.existsSync(path.join(codesDir, 'folder.json')), 'a directory is left alone');
      assert.ok(fs.existsSync(path.join(trustData, 'outside.json')), 'a symlink target is never removed');
      assert.equal(warnings.filter((w) => w === 'ignoring a directory in the pairing code folder').length, 1);
      assert.ok(warnings.includes('ignoring a pairing code file: unreadable'));
      assert.ok(warnings.includes('ignoring a pairing code file: too large'));
      if (linked) assert.ok(warnings.includes('ignoring a pairing code file: not a regular file'));
      assert.ok(warnings.every((w) => !w.includes(code)));
    } finally {
      console.warn = originalWarn;
      removeSink();
    }
    const identity = new NodeIdentity({ nodeName: 'lab-c' });
    const transport = new MeshTransport({ identity, listen: false, useTls: false });
    const pairing = new MeshPairing(identity, transport, { timeoutMs: 5000 });
    cleanups.push(async () => { pairing.cleanup(); await transport.stop(); });
    await pairing.acceptCode(code, '127.0.0.1', r.address().mesh.port);
    await until(() => r.nodeHub.nodeByName('lab-c'), 'lab-c to be paired');
    assert.equal(r.nodeHub.nodeByName('lab-big'), null);
    assert.equal(r.nodeHub.nodeByName('lab-link'), null);
  });

  it('refuses a pairing with pair:reject before trusting or accepting it', async () => {
    const first = r.nodeHub.addCode('lab-x');
    const second = r.nodeHub.addCode('lab-x');
    secrets.add(first.code);
    secrets.add(second.code);
    const pairWith = async (code) => {
      const identity = new NodeIdentity({ nodeName: 'lab-x' });
      const transport = new MeshTransport({ identity, listen: false, useTls: false });
      const pairing = new MeshPairing(identity, transport, { timeoutMs: 5000 });
      cleanups.push(async () => { pairing.cleanup(); await transport.stop(); });
      return pairing.acceptCode(code, '127.0.0.1', r.address().mesh.port);
    };
    await pairWith(first.code);
    await until(() => r.nodeHub.nodeByName('lab-x'), 'lab-x paired');
    const count = r.nodeHub.nodes().length;
    await assert.rejects(pairWith(second.code), /name_taken/);
    assert.equal(r.nodeHub.nodes().length, count);
  });

  it('keeps each device to its own nodes: no view of, answer to or poll of another node\'s requests', async () => {
    const { envelope } = buildRequest({ identity: b.identity, action: toolAction('Bash', { command: 'whoami' }, '/srv'), origin: { client: 'agent' }, ttlMs: 60000 });
    await b.call('approval.submit', { envelope });
    const requestId = open(envelope).message.request_id;
    assert.equal((await call(phone, 'GET', `/v1/approvals/${requestId}`)).status, 404);
    assert.equal((await call(phone, 'POST', `/v1/approvals/${requestId}/response`, phone.respond(envelope, 'approve'))).status, 403);
    const list = await call(phone, 'GET', '/v1/approvals?wait=0');
    assert.ok(list.body.every((e) => open(e.envelope).message.node_id !== b.identity.nodeId));
    assert.equal((await call(phone, 'GET', `/v1/nodes/${b.identity.nodeId}/history`)).status, 404);
  });

  it('refuses a replayed signed call', async () => {
    const p = '/v1/nodes';
    const headers = phone.signApi('GET', p, '');
    secrets.add(headers['X-KL-Signature']);
    assert.equal((await fetch(trustBase() + p, { headers })).status, 200);
    const again = await fetch(trustBase() + p, { headers });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, 'replay');
  });

  it('validates push hints: unknown kind or a bad expiry is refused before anything is stored', async () => {
    const signer = nodeSigner(a.identity);
    const before_ = r.mailbox.list({ nodeIds: [a.identity.nodeId] }).length;
    const ping = () => seal({ v: 1, type: 'kl.test.ping', node_id: a.identity.nodeId, nonce: crypto.randomBytes(32).toString('base64url') }, signer);
    await assert.rejects(a.call('message.submit', { envelope: ping(), push: { kind: 'bogus', id: 'x' } }), (e) => e.code === 'bad_push');
    await assert.rejects(a.call('message.submit', { envelope: ping(), push: { kind: 'lease', id: 'x', expires_at: 'tomorrow' } }), (e) => e.code === 'bad_push');
    assert.equal(r.mailbox.list({ nodeIds: [a.identity.nodeId] }).length, before_);
    assert.equal((await a.call('message.submit', { envelope: ping(), push: { kind: 'lease', id: 'x', expires_at: new Date(Date.now() + 60000).toISOString() } })).ok, true);
  });

  it('device.state touches only the calling node\'s column, and only known devices', async () => {
    await b.call('device.state', { device_id: phone.deviceId, state: 'revoked', node_id: a.identity.nodeId });
    const states = Object.fromEntries(r.devices.nodesForDevice(phone.deviceId).map((n) => [n.node_id, n.state]));
    assert.equal(states[a.identity.nodeId], 'active');
    assert.equal(states[b.identity.nodeId], 'revoked');
    await assert.rejects(b.call('device.state', { device_id: createFakePhone().deviceId, state: 'active' }), (e) => e.code === 'unknown_device');
  });

  it('logs one revocation per signer and target, still forwarding each, and refuses self-revocation', async () => {
    const target = createFakePhone({ name: 'Lost phone' });
    await call(phone, 'POST', '/v1/devices/enroll', phone.enroll({ device: target.device() }));
    assert.equal((await call(phone, 'POST', '/v1/devices/revoke', phone.revoke(target.deviceId))).status, 200);
    assert.equal((await call(phone, 'POST', '/v1/devices/revoke', phone.revoke(target.deviceId, { reason: 'again' }))).status, 200);
    const revokes = r.devices.log().filter((e) => { const { message } = open(e); return message.type === 'kl.device.revoke' && message.device_id === target.deviceId; });
    assert.equal(revokes.length, 1);
    // A device cannot revoke itself (it takes another device), so a thief's
    // self-revocation never reaches the log.
    const self = await call(phone, 'POST', '/v1/devices/revoke', phone.revoke(phone.deviceId));
    assert.equal(self.status, 403);
    assert.ok(!r.devices.log().some((e) => { const { message } = open(e); return message.type === 'kl.device.revoke' && message.device_id === phone.deviceId; }));
  });

  it('with the device log full, refuses a new enrollment but forwards and logs a revocation', async () => {
    const dataDir = tempDir('kl-relay-full-');
    const owner_ = createFakePhone({ name: 'Owner' });
    const lost = createFakePhone({ name: 'Lost' });
    const filler = `${JSON.stringify(owner_.enroll({ device: createFakePhone().device() }))}\n`;
    fs.mkdirSync(path.join(dataDir, 'relay'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'relay', 'device-log.jsonl'), filler.repeat(MAX_LOG_LINES));
    const full = await startRelay({
      dataDir,
      identity: new NodeIdentity({ nodeName: 'relay' }),
      useTls: false,
      config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com', tls: {}, push: {} }
    });
    cleanups.push(() => full.stop());
    const revokes = [];
    const node = await fakeNode('lab-full', {
      'device.revoke': (params) => { revokes.push(params); return { state: 'revoked-pending-apply' }; },
      'device.enroll': () => ({ state: 'staged' })
    }, full);
    // Test setup only: both phones known and active on the node.
    for (const p_ of [owner_, lost]) {
      full.devices.register({ device_id: p_.deviceId, jwk: p_.jwk, name: p_.name, platform: 'android' });
      full.devices.setNodeState(p_.deviceId, node.identity.nodeId, 'active');
    }
    const sendAs = async (ph, p_, body) => {
      const text = JSON.stringify(body);
      const res = await fetch(`http://127.0.0.1:${full.address().phone.port}${p_}`, { method: 'POST', headers: { ...ph.signApi('POST', p_, text), 'content-type': 'application/json' }, body: text });
      return { status: res.status, body: await res.json() };
    };
    const newcomer = createFakePhone({ name: 'Newcomer' });
    const enrolled = await sendAs(owner_, '/v1/devices/enroll', owner_.enroll({ device: newcomer.device() }));
    assert.equal(enrolled.status, 503);
    assert.equal(enrolled.body.error, 'log_full');
    assert.equal(full.devices.get(newcomer.deviceId), null, 'nothing registered when the log refuses');
    const revoked = await sendAs(owner_, '/v1/devices/revoke', owner_.revoke(lost.deviceId));
    assert.deepEqual(revoked, { status: 200, body: { nodes: [{ node_id: node.identity.nodeId, state: 'revoked-pending-apply' }] } });
    assert.equal(revokes.length, 1);
    assert.equal(full.devices.log().length, MAX_LOG_LINES + 1);
  });

  it('runs one device-log replay per node at a time', async () => {
    let calls = 0;
    const slow = async () => { calls += 1; await sleep(50); return { state: 'duplicate' }; };
    const node = await fakeNode('lab-r', { 'device.enroll': slow, 'device.revoke': slow });
    await Promise.all([node.call('relay.hello', { node_id: node.identity.nodeId }), node.call('relay.hello', { node_id: node.identity.nodeId })]);
    const entries = r.devices.log().length;
    await until(() => calls >= entries, 'the replay', 5000);
    await sleep(200);
    assert.equal(calls, entries, 'a second hello during a replay does not start another pass');
  });

  it('a device active on no node loses every relay-wide power', async () => {
    await a.call('device.state', { device_id: phone.deviceId, state: 'revoked' });
    await until(() => !r.devices.nodesForDevice(phone.deviceId).some((n) => n.state === 'active'), 'phone revoked everywhere');
    try {
      assert.equal((await call(phone, 'POST', '/v1/pairing-codes', { node_name: 'lab-z' })).status, 403);
      assert.equal((await call(phone, 'POST', '/v1/devices/invites', {})).status, 403);
      assert.equal((await call(phone, 'GET', `/v1/devices/invites/${crypto.randomBytes(16).toString('base64url')}`)).status, 403);
      assert.equal((await call(phone, 'POST', '/v1/devices/revoke', phone.revoke(other.deviceId))).status, 403);
      assert.equal((await call(phone, 'GET', '/v1/devices')).status, 403);
      // Nor does it keep the list of every node behind the relay.
      const nodes = await call(phone, 'GET', '/v1/nodes');
      assert.equal(nodes.status, 403);
      assert.equal(nodes.body.error, 'forbidden');
      assert.equal((await call(phone, 'POST', '/v1/devices/enroll', phone.enroll({ device: createFakePhone().device() }))).status, 403);
    } finally {
      await a.call('device.state', { device_id: phone.deviceId, state: 'active' });
    }
  });

  it('caps connections per IP on the phone listener', async () => {
    const server = createPhoneServer({ useTls: false, handler: (req, res) => { res.end('ok'); } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sockets = [];
    try {
      const connect = () => new Promise((resolve, reject) => {
        const sock = net.connect(server.address().port, '127.0.0.1', () => resolve(sock));
        sock.on('error', () => {});
        sockets.push(sock);
        setTimeout(() => reject(new Error('connect timeout')), 2000).unref();
      });
      for (let i = 0; i < PHONE_LISTENER.perIpConnections; i++) await connect();
      await sleep(100);
      const extra = await connect();
      const closed = await new Promise((resolve) => { extra.once('close', () => resolve(true)); setTimeout(() => resolve(false), 1500).unref(); });
      assert.equal(closed, true, 'the connection over the cap is dropped');
      assert.equal(sockets.slice(0, PHONE_LISTENER.perIpConnections).every((sk) => !sk.destroyed), true);
    } finally {
      for (const sk of sockets) sk.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a shared address with many phones is not refused at the old cap of 16 sockets (final review I1)', async () => {
    // Phones behind one NAT each hold a long poll plus request sockets; the
    // per-IP cap must leave room for dozens of them. 64 concurrent sockets
    // from one address are all kept.
    const server = createPhoneServer({ useTls: false, handler: (req, res) => { res.end('ok'); } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sockets = [];
    try {
      for (let i = 0; i < 64; i++) {
        sockets.push(await new Promise((resolve, reject) => {
          const sock = net.connect(server.address().port, '127.0.0.1', () => resolve(sock));
          sock.on('error', () => {});
          setTimeout(() => reject(new Error('connect timeout')), 2000).unref();
        }));
      }
      await sleep(200);
      assert.equal(sockets.filter((sk) => sk.destroyed).length, 0, 'no socket from the shared address was dropped');
      assert.ok(PHONE_LISTENER.perIpConnections < PHONE_LISTENER.maxConnections, 'one address still cannot take every connection');
    } finally {
      for (const sk of sockets) sk.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('caps long polls per device, and stop() returns promptly with polls parked', async () => {
    const pollRelay = await startRelay({
      dataDir: tempDir('kl-relay-poll-'),
      identity: new NodeIdentity({ nodeName: 'relay' }),
      useTls: false,
      config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com', tls: {}, push: {} }
    });
    let stopped = false;
    cleanups.push(() => (stopped ? null : pollRelay.stop()));
    const poller = createFakePhone({ name: 'Poller' });
    // Test setup only: an active device without a node behind it.
    pollRelay.devices.register({ device_id: poller.deviceId, jwk: poller.jwk, name: 'Poller', platform: 'android' });
    pollRelay.devices.setNodeState(poller.deviceId, 'kl-aaaaaaaaaaaaaaaa', 'active');
    const url = (p) => `http://127.0.0.1:${pollRelay.address().phone.port}${p}`;
    const get = (p) => fetch(url(p), { headers: poller.signApi('GET', p, '') });
    assert.equal((await get('/v1/approvals?wait=0')).status, 200);
    const parked = [get('/v1/approvals?wait=25&n=1').catch(() => null), get('/v1/approvals?wait=25&n=2').catch(() => null)];
    await sleep(300);
    const started = Date.now();
    const third = await get('/v1/approvals?wait=25&n=3');
    assert.equal(third.status, 429);
    assert.ok(Date.now() - started < 2000, 'answered at once');
    const stopAt = Date.now();
    await pollRelay.stop();
    stopped = true;
    assert.ok(Date.now() - stopAt < 3000, `stop() took ${Date.now() - stopAt} ms`);
    await Promise.all(parked);
  });

  it('logs no code ids, codes, invite ids, push tokens or signatures', () => {
    secrets.add('tok-owner');
    const leaks = logLines.filter((line) => [...secrets].some((s) => s && line.includes(s)));
    assert.deepEqual(leaks, []);
  });
});

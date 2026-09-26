// tests/frontdoor-phone-routes.test.js — fleet stage 4 §3.11–3.13, §4.9.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createPhoneApi } = require('../src/frontdoor/phone-api');
const { DeviceRegistry } = require('../src/frontdoor/device-registry');
const { registerFrontDoorRoutes } = require('../src/frontdoor/phone-routes');
const { createApproverNotifier } = require('../src/frontdoor/notify');
const { PairingService } = require('../src/frontdoor/pairing/pairing-service');
const { NodeRegistry } = require('../src/frontdoor/router/node-registry');
const { AuditMirror } = require('../src/frontdoor/audit/mirror');
const { AlertCenter } = require('../src/frontdoor/alerts');
const { Challenges } = require('../src/frontdoor/protocol/challenges');
const { buildNodePair, buildRelayRepin, rawEd25519 } = require('../src/frontdoor/protocol/messages');
const { AuditLedger, verifyAuditSlice } = require('../src/audit/audit-ledger');
const { LinkRpcError } = require('../src/approvals/link-rpc');
const { open } = require('../src/approvals/envelope');
const { err } = require('../src/frontdoor/errors');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { selfSigned } = require('./helpers/test-certs');
const { request } = require('./helpers/oauth-test-client');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const FD = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
const A = createFakePhone({ seed: 'A', name: 'Owner phone' });
const C = createFakePhone({ seed: 'C', name: 'Not an approver' });
const R = createFakePhone({ name: 'Revoked approver' });
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

async function setup({ pairingStub = null } = {}) {
  const store = await approverStoreWith([
    A.approverRecord(),
    R.approverRecord({ revokedAt: '2026-09-24T00:00:00.000Z', revokedBy: A.deviceId })
  ], { allowTestKeys: true });
  cleanups.push(() => store.cleanup());
  const configDir = path.join(store.baseDir, 'config');
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const devices = new DeviceRegistry({ file: path.join(dataDir, 'relay', 'devices.json') });
  for (const p of [A, C, R]) devices.register({ device_id: p.deviceId, jwk: p.jwk, name: p.name, platform: 'android' });
  const alerts = new AlertCenter({ file: path.join(dataDir, 'frontdoor', 'alerts.json') });
  const audit = [];
  const auditLedger = { append: async (e) => { audit.push(e); return e; } };
  const registry = new NodeRegistry({ configDir, dataDir, approverStore: store, frontdoorId: FD.nodeId, alerts, adminUid: UID, geteuid: () => UID });
  registry.load();
  const pairing = new PairingService({
    file: path.join(dataDir, 'frontdoor', 'pairing.json'), registry, identity: FD, approverStore: store, frontdoorHost: 'mcp.kl.example.com',
    meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: () => 'c'.repeat(64), alerts, auditLedger
  });
  const mirror = new AuditMirror({ dir: path.join(dataDir, 'frontdoor', 'mirror'), alerts });
  const challenges = new Challenges();
  const ownLedger = new AuditLedger({ dir: path.join(dataDir, 'audit'), identity: FD, nodeId: FD.nodeId });
  await ownLedger.append({ kind: 'frontdoor.pairing.code_issued', data: { node_name: 'x', by: 'console' } });
  let repinEnvelope = null;
  const online = new Set();
  const nodeHub = {
    rpc: async (nodeId, method, params) => {
      if (method === 'audit.slice' && nodeId === FD.nodeId) return { envelope: ownLedger.slice(params) };
      if (!online.has(nodeId)) throw new LinkRpcError('offline', `${nodeId} is not connected`);
      throw new Error('unexpected');
    }
  };
  const phoneApi = createPhoneApi({ devices, rateLimits: { devicePerMin: 1000 } });
  registerFrontDoorRoutes(phoneApi, {
    approverStore: store, devices, nodeHub, registry, pairing: pairingStub || pairing, mirror, alerts, challenges, identity: FD, domain: 'kl.example.com',
    certificate: () => ({ notAfter: '2026-12-01T00:00:00.000Z' }), repin: () => repinEnvelope, ownLedger, auditLedger
  });
  const server = http.createServer(phoneApi.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Distinct timestamps give distinct signed requests (the API refuses a replay).
  const call = async (phone, method, p, body = null, { timestamp } = {}) => {
    const text = body === null ? '' : JSON.stringify(body);
    const res = await request(base, { method, path: p, headers: { ...phone.signApi(method, p, text, timestamp ? { timestamp } : {}), ...(body === null ? {} : { 'content-type': 'application/json' }) }, ...(body === null ? {} : { raw: text }) });
    return { status: res.status, body: res.json };
  };
  return { store, configDir, dataDir, devices, alerts, audit, registry, pairing, mirror, challenges, ownLedger, base, call, online, setRepin: (e) => { repinEnvelope = e; } };
}

function nodeKit(name = 'gpu-box') {
  const identity = testNodeIdentity({ nodeName: name });
  const cert = selfSigned({ commonName: name }).cert;
  return { identity, pair: (code) => buildNodePair({ identity, frontdoorHost: 'mcp.kl.example.com', code, profile: 'agent', capabilities: [], tlsCertPem: cert }) };
}

// Pairs and enrols a node through the real pairing service; → the kit.
async function enrolled(t, n = nodeKit()) {
  const { code } = await t.pairing.issue(n.identity.nodeName, { by: A.deviceId });
  const id = open(t.pairing.submit(n.pair(code)).envelope).message.pairing_id;
  await t.pairing.decide(id, A.enrollNode({ frontdoorId: FD.nodeId, pairing: t.pairing.pending().find((p) => p.pairing_id === id) }), { deviceId: A.deviceId });
  return n;
}

describe('front-door phone routes', () => {
  it('pairing codes, the pending list and the decision, for approvers only', async () => {
    const t = await setup();
    assert.equal((await t.call(C, 'POST', '/v1/pairing-codes', { node_name: 'gpu-box' })).status, 403);
    assert.equal((await t.call(A, 'POST', '/v1/pairing-codes', { node_name: 'bad name' })).status, 400);
    assert.equal((await t.call(A, 'POST', '/v1/pairing-codes', ['gpu-box'])).status, 400);
    const issued = await t.call(A, 'POST', '/v1/pairing-codes', { node_name: 'gpu-box' });
    assert.equal(issued.status, 200);
    assert.equal(issued.body.code.split(' ').length, 6);
    const n = nodeKit();
    const pairingId = open(t.pairing.submit(n.pair(issued.body.code)).envelope).message.pairing_id;
    const pending = await t.call(A, 'GET', '/v1/pairings/pending');
    assert.equal(pending.body.length, 1);
    assert.equal(pending.body[0].public_key, rawEd25519(n.identity.publicKey));
    assert.equal((await t.call(C, 'GET', '/v1/pairings/pending')).status, 403);
    const envelope = A.enrollNode({ frontdoorId: FD.nodeId, pairing: pending.body[0] });
    assert.deepEqual(await t.call(A, 'POST', `/v1/pairings/${pairingId}/decision`, envelope), { status: 200, body: { state: 'enrolled' } });
    const again = await t.call(A, 'POST', `/v1/pairings/${pairingId}/decision`, envelope);
    assert.deepEqual([again.status, again.body.error], [409, 'already_decided']);
    assert.equal((await t.call(A, 'POST', `/v1/pairings/pr_${'z'.repeat(22)}/decision`, envelope)).status, 410);
  });

  it('two concurrent decisions on one pairing: exactly one enrols', async () => {
    const t = await setup();
    const n = nodeKit();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id = open(t.pairing.submit(n.pair(code)).envelope).message.pairing_id;
    const envelope = A.enrollNode({ frontdoorId: FD.nodeId, pairing: t.pairing.pending()[0] });
    const stamp = (i) => ({ timestamp: new Date(Date.now() + i).toISOString() });
    const results = await Promise.all([1, 2].map((i) => t.call(A, 'POST', `/v1/pairings/${id}/decision`, envelope, stamp(i))));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(t.registry.list().length, 1);
  });

  it('a decision whose save fails answers a retryable 503, and the same envelope then succeeds', async () => {
    const t = await setup();
    const n = nodeKit();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id = open(t.pairing.submit(n.pair(code)).envelope).message.pairing_id;
    const deny = A.enrollNode({ frontdoorId: FD.nodeId, pairing: t.pairing.pending()[0], decision: 'deny' });
    const write = t.pairing.writeFile;
    t.pairing.writeFile = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    const failed = await t.call(A, 'POST', `/v1/pairings/${id}/decision`, deny);
    assert.deepEqual([failed.status, failed.body.error, failed.body.retry_after], [503, 'save_failed', 1]);
    t.pairing.writeFile = write;
    assert.deepEqual(await t.call(A, 'POST', `/v1/pairings/${id}/decision`, deny), { status: 200, body: { state: 'denied' } });
  });

  it('maps every decision refusal to its status and keeps the reason code', async () => {
    let code = null;
    const pairingStub = { issue: async () => ({}), pending: () => [], decide: async () => { throw err(code, `refused: ${code}`); } };
    const t = await setup({ pairingStub });
    const table = [
      ['unknown_pairing', 410], ['expired', 410],
      ['already_decided', 409], ['console_record', 409], ['replaces_changed', 409], ['key_enrolled_as_other_name', 409],
      ['save_failed', 503],
      ['revoked_device', 403], ['bad_decision', 400], ['bad_signature', 400], ['binding_mismatch', 400]
    ];
    for (const [reason, status] of table) {
      code = reason;
      const r = await t.call(A, 'POST', `/v1/pairings/pr_${'a'.repeat(22)}/decision`, { any: reason });
      assert.deepEqual([r.status, r.body.error], [status, reason], reason);
    }
  });

  it('GET /v1/nodes lists registry nodes with source, audit and presence', async () => {
    const t = await setup();
    const n = await enrolled(t);
    t.registry.markOnline(n.identity.nodeId, { capabilities: ['large-disk', 'bad cap‮', 7], boot_id: 'b' });
    const nodes = await t.call(A, 'GET', '/v1/nodes');
    assert.deepEqual(nodes.body.map(({ last_seen: seen, ...rest }) => ({ ...rest, seen: typeof seen })), [
      { node_id: n.identity.nodeId, node_name: 'gpu-box', online: true, profile: 'agent', capabilities: ['large-disk'], source: 'phone', audit: 'ok', seen: 'string' }
    ]);
    assert.equal((await t.call(C, 'GET', '/v1/nodes')).status, 403);
  });

  it('removes a phone-enrolled node with a challenge-bound kl.node.remove', async () => {
    const t = await setup();
    const n = await enrolled(t);
    const { challenge } = t.challenges.issue(A.deviceId, 'remove');
    const removal = A.removeNode({ frontdoorId: FD.nodeId, nodeId: n.identity.nodeId, challenge });
    assert.equal((await t.call(A, 'POST', `/v1/nodes/${n.identity.nodeId}/remove`, removal)).status, 204);
    assert.equal(t.registry.byId(n.identity.nodeId), null);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.node.removed' && e.data.node_id === n.identity.nodeId && e.data.saved === true));
    const replayed = await t.call(A, 'POST', `/v1/nodes/${n.identity.nodeId}/remove`, removal);
    assert.deepEqual([replayed.status, replayed.body.error], [400, 'challenge_reused']);
    // Replayed after the same node is enrolled again: still spent, nothing removed.
    await enrolled(t, n);
    const reused = await t.call(A, 'POST', `/v1/nodes/${n.identity.nodeId}/remove`, removal);
    assert.deepEqual([reused.status, reused.body.error], [400, 'challenge_reused']);
    assert.ok(t.registry.byId(n.identity.nodeId));
  });

  it('a removal naming another node, or on a challenge for another purpose, spends nothing and removes nothing', async () => {
    const t = await setup();
    const n = await enrolled(t);
    const other = await enrolled(t, nodeKit('web-01'));
    const { challenge } = t.challenges.issue(A.deviceId, 'remove');
    const removal = A.removeNode({ frontdoorId: FD.nodeId, nodeId: n.identity.nodeId, challenge });
    const wrong = await t.call(A, 'POST', `/v1/nodes/${other.identity.nodeId}/remove`, removal);
    assert.deepEqual([wrong.status, wrong.body.error], [400, 'bad_remove']);
    assert.ok(t.registry.byId(other.identity.nodeId));
    const revokeChallenge = t.challenges.issue(A.deviceId, 'revoke').challenge;
    const purpose = await t.call(A, 'POST', `/v1/nodes/${n.identity.nodeId}/remove`, A.removeNode({ frontdoorId: FD.nodeId, nodeId: n.identity.nodeId, challenge: revokeChallenge }));
    assert.deepEqual([purpose.status, purpose.body.error], [400, 'challenge_wrong_purpose']);
    assert.ok(t.registry.byId(n.identity.nodeId));
    assert.equal((await t.call(A, 'POST', `/v1/nodes/${n.identity.nodeId}/remove`, removal)).status, 204, 'the challenge was not spent');
  });

  it('two concurrent removals with one envelope: exactly one succeeds', async () => {
    const t = await setup();
    const n = await enrolled(t);
    const { challenge } = t.challenges.issue(A.deviceId, 'remove');
    const removal = A.removeNode({ frontdoorId: FD.nodeId, nodeId: n.identity.nodeId, challenge });
    const stamp = (i) => ({ timestamp: new Date(Date.now() + i).toISOString() });
    const results = await Promise.all([1, 2].map((i) => t.call(A, 'POST', `/v1/nodes/${n.identity.nodeId}/remove`, removal, stamp(i))));
    assert.deepEqual(results.map((r) => [r.status, r.body && r.body.error]).sort((x, y) => x[0] - y[0]), [[204, null], [400, 'challenge_reused']]);
    assert.equal(t.audit.filter((e) => e.kind === 'frontdoor.node.removed').length, 1);
  });

  it('a removal whose save fails is not a 204: the node is dropped in memory, audited, and a retry persists it', async () => {
    const t = await setup();
    const n = await enrolled(t);
    const id = n.identity.nodeId;
    const removedEvents = [];
    t.registry.on('removed', (e) => removedEvents.push(e.nodeId));
    const save = t.registry._savePhone;
    t.registry._savePhone = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    const first = A.removeNode({ frontdoorId: FD.nodeId, nodeId: id, challenge: t.challenges.issue(A.deviceId, 'remove').challenge });
    const failed = await t.call(A, 'POST', `/v1/nodes/${id}/remove`, first);
    assert.deepEqual([failed.status, failed.body.error, failed.body.retry_after], [503, 'save_failed', 1]);
    assert.equal(t.registry.byId(id), null, 'dropped in memory at once');
    assert.deepEqual(removedEvents, [id], 'the live link is closed even though the save failed');
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.node.removed' && e.data.node_id === id && e.data.saved === false));
    t.registry._savePhone = save;
    t.registry.load();
    assert.equal(t.registry.byId(id), null, 'a reload does not bring the node back');
    const retry = A.removeNode({ frontdoorId: FD.nodeId, nodeId: id, challenge: t.challenges.issue(A.deviceId, 'remove').challenge });
    assert.equal((await t.call(A, 'POST', `/v1/nodes/${id}/remove`, retry)).status, 204);
    const fresh = new NodeRegistry({ configDir: t.configDir, dataDir: t.dataDir, approverStore: t.store, frontdoorId: FD.nodeId, adminUid: UID, geteuid: () => UID });
    fresh.load();
    assert.equal(fresh.byId(id), null, 'the removal is on disk');
  });

  it('history: the node while it answers, else the mirror; audit-status; the front door serves its own', async () => {
    const t = await setup();
    const node = testNodeIdentity({ nodeName: 'gpu-box' });
    const ledger = new AuditLedger({ dir: path.join(t.dataDir, 'node-ledger'), identity: node, nodeId: node.nodeId });
    for (let i = 0; i < 3; i += 1) await ledger.append({ kind: 'test.event', data: { i } });
    await t.mirror.sync(node.nodeId, { fetchSlice: async (p) => ledger.slice(p), spkiHex: node.publicKey.toString('hex') });
    assert.equal((await t.call(A, 'GET', `/v1/nodes/${node.nodeId}/history`)).status, 404, 'not visible before the device is active there');
    t.devices.setNodeState(A.deviceId, node.nodeId, 'active');
    t.devices.setNodeState(A.deviceId, FD.nodeId, 'active');
    const offline = await t.call(A, 'GET', `/v1/nodes/${node.nodeId}/history?before_seq=4`);
    assert.equal(offline.status, 200);
    assert.equal(verifyAuditSlice(offline.body, node.publicKey.toString('hex')).ok, true);
    assert.deepEqual((await t.call(A, 'GET', `/v1/nodes/${node.nodeId}/audit-status`)).body, { head_seq: 3, anchor: { seq: 1, prev: null }, gaps: [], breaks: [] });
    const own = await t.call(A, 'GET', `/v1/nodes/${FD.nodeId}/history`);
    assert.equal(verifyAuditSlice(own.body, FD.publicKey.toString('hex')).ok, true);
    assert.deepEqual((await t.call(A, 'GET', `/v1/nodes/${FD.nodeId}/audit-status`)).body, { head_seq: 1, anchor: null, gaps: [], breaks: [] });
    const none = testNodeIdentity({ nodeName: 'empty' });
    t.devices.setNodeState(A.deviceId, none.nodeId, 'active');
    const missing = await t.call(A, 'GET', `/v1/nodes/${none.nodeId}/history`);
    assert.deepEqual([missing.status, missing.body.error], [503, 'node_offline']);
    for (const q of ['before_seq=4abc', 'before_seq=-1', 'limit=5&limit=6', 'before_seq=2&before_seq=3', 'limit=1e3']) {
      const bad = await t.call(A, 'GET', `/v1/nodes/${node.nodeId}/history?${q}`);
      assert.deepEqual([bad.status, bad.body.error], [400, 'bad_query'], q);
    }
  });

  it('audit-status returns break reasons as codes', async () => {
    const t = await setup();
    const node = testNodeIdentity({ nodeName: 'gpu-box' });
    t.devices.setNodeState(A.deviceId, node.nodeId, 'active');
    t.mirror.status = (id) => ({ head_seq: 5, anchor: null, gaps: [], breaks: [{ seq: 4, reason: 'withheld_entries', at: '2026-09-26T00:00:00.000Z', segment: 1 }], id });
    const r = await t.call(A, 'GET', `/v1/nodes/${node.nodeId}/audit-status`);
    assert.deepEqual(r.body, { head_seq: 5, anchor: null, gaps: [], breaks: [{ seq: 4, reason: 'withheld_entries', at: '2026-09-26T00:00:00.000Z', segment: 1 }] });
  });

  it('alerts: list since an id and ack (audited)', async () => {
    const t = await setup();
    const first = t.alerts.raise('dns_probe_failed', { subject: 'mesh.kl.example.com' });
    const second = t.alerts.raise('audit_gap', { subject: 'node:kl-aaaaaaaaaaaaaaaa' });
    assert.deepEqual((await t.call(A, 'GET', `/v1/alerts?since=${first.id}`)).body.map((a) => a.id), [second.id]);
    assert.equal((await t.call(A, 'GET', '/v1/alerts')).body.length, 2);
    assert.equal((await t.call(A, 'POST', `/v1/alerts/${first.id}/ack`)).status, 204);
    assert.equal(t.alerts.list()[0].acked, true);
    assert.equal((await t.call(A, 'POST', '/v1/alerts/999/ack')).status, 404);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.alert.ack' && e.data.id === first.id));
    assert.equal((await t.call(C, 'GET', '/v1/alerts')).status, 403);
    for (const q of ['since=abc', 'since=1&since=2', 'since=-1']) {
      const bad = await t.call(A, 'GET', `/v1/alerts?${q}`);
      assert.deepEqual([bad.status, bad.body.error], [400, 'bad_query'], q);
    }
  });

  it('GET /v1/frontdoor for any registered device; GET /v1/repin without auth', async () => {
    const t = await setup();
    assert.deepEqual((await t.call(C, 'GET', '/v1/frontdoor')).body, {
      frontdoor_id: FD.nodeId, public_key: rawEd25519(FD.publicKey), domain: 'kl.example.com', cert_not_after: '2026-12-01T00:00:00.000Z'
    });
    assert.equal((await request(t.base, { path: '/v1/repin' })).status, 404);
    const env = buildRelayRepin({ identity: FD, relay: 'https://mcp.kl.example.com', oldSpki: `sha256/${'a'.repeat(43)}`, newSpki: `sha256/${'b'.repeat(43)}` });
    t.setRepin(env);
    const got = await request(t.base, { path: '/v1/repin' });
    assert.deepEqual([got.status, got.json], [200, env]);
  });

  it('refuses 403 to every device that is not an active approver, on every route that acts on the front door', async () => {
    const t = await setup();
    const n = await enrolled(t);
    // Both are known to the relay's device registry and active on the nodes,
    // so only the approver check can refuse them.
    for (const p of [C, R]) for (const id of [n.identity.nodeId, FD.nodeId]) t.devices.setNodeState(p.deviceId, id, 'active');
    const alert = t.alerts.raise('audit_gap', { subject: 'node:x' });
    const decideCalls = [];
    const decide = t.pairing.decide.bind(t.pairing);
    t.pairing.decide = (...a) => { decideCalls.push(a); return decide(...a); };
    const routes = [
      ['POST', '/v1/pairing-codes', { node_name: 'web-01' }],
      ['GET', '/v1/pairings/pending', null],
      ['POST', `/v1/pairings/pr_${'a'.repeat(22)}/decision`, {}],
      ['POST', `/v1/nodes/${n.identity.nodeId}/remove`, {}],
      ['GET', '/v1/nodes', null],
      ['GET', `/v1/nodes/${n.identity.nodeId}/history`, null],
      ['GET', `/v1/nodes/${n.identity.nodeId}/audit-status`, null],
      ['GET', `/v1/nodes/${FD.nodeId}/history`, null],
      ['GET', `/v1/nodes/${FD.nodeId}/audit-status`, null],
      ['GET', '/v1/alerts', null],
      ['POST', `/v1/alerts/${alert.id}/ack`, null]
    ];
    for (const [who, phone] of [['not an approver', C], ['revoked approver', R]]) {
      for (const [method, p, body] of routes) {
        const r = await t.call(phone, method, p, body);
        assert.deepEqual([r.status, r.body && r.body.error], [403, 'forbidden'], `${who}: ${method} ${p}`);
      }
    }
    assert.equal(decideCalls.length, 0);
    assert.equal(t.alerts.list()[0].acked, false);
    assert.ok(t.registry.byId(n.identity.nodeId));
  });

  it('validates route ids before any lookup', async () => {
    const t = await setup();
    t.devices.setNodeState(A.deviceId, FD.nodeId, 'active');
    const lookups = [];
    const spy = (obj, name) => { const f = obj[name].bind(obj); obj[name] = (...a) => { lookups.push(`${name}:${a[0]}`); return f(...a); }; };
    spy(t.pairing, 'decide');
    spy(t.registry, 'byId');
    spy(t.mirror, 'history');
    spy(t.mirror, 'status');
    spy(t.alerts, 'ack');
    spy(t.devices, 'nodesForDevice');
    const bad = ['__proto__', 'constructor', '..%2F..%2Fetc', 'kl-AAAAAAAAAAAAAAAA', 'pr_..%2F..%2Fxxxxxxxxxxxxxxxxx', '%2E%2E%5Cx', '1%2F2'];
    const routes = [
      (id) => ['POST', `/v1/pairings/${id}/decision`, {}],
      (id) => ['POST', `/v1/nodes/${id}/remove`, {}],
      (id) => ['GET', `/v1/nodes/${id}/history`, null],
      (id) => ['GET', `/v1/nodes/${id}/audit-status`, null],
      (id) => ['POST', `/v1/alerts/${id}/ack`, null]
    ];
    for (const id of bad) {
      for (const make of routes) {
        const [method, p, body] = make(id);
        const r = await t.call(A, method, p, body);
        assert.equal(r.status, 404, `${method} ${p}`);
      }
    }
    assert.deepEqual(lookups, []);
  });

  it('refuses to register without the stores that decide who may act', () => {
    const fn = () => null;
    const deps = {
      approverStore: { isActive: fn, get: fn }, devices: { nodesForDevice: fn }, nodeHub: { rpc: fn }, registry: { removeSigned: fn, byId: fn },
      pairing: { issue: fn, decide: fn }, mirror: { history: fn }, alerts: { list: fn }, challenges: { take: fn }, identity: FD
    };
    assert.doesNotThrow(() => registerFrontDoorRoutes(createPhoneApi({ devices: { get: fn } }), deps));
    for (const k of Object.keys(deps)) {
      assert.throws(() => registerFrontDoorRoutes(createPhoneApi({ devices: { get: fn } }), { ...deps, [k]: undefined }), TypeError, k);
    }
  });
});

describe('createApproverNotifier', () => {
  it('pushes only { kind, id } to active front-door approvers with a push token', async () => {
    const t = await setup();
    t.devices.setPush(A.deviceId, { platform: 'fcm', token: 'tok-a' });
    t.devices.setPush(C.deviceId, { platform: 'fcm', token: 'tok-c' });
    t.devices.setPush(R.deviceId, { platform: 'fcm', token: 'tok-r' });
    const sent = [];
    const notify = createApproverNotifier({ approverStore: t.store, devices: t.devices, pusher: { notify: async (device, payload) => { sent.push([device.device_id, payload]); } } });
    notify('pairing', 'pr_x');
    notify('alert', '7');
    notify('grant', 'gr_x');
    notify('pairing', { secret: 'content' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [[A.deviceId, { kind: 'pairing', id: 'pr_x' }], [A.deviceId, { kind: 'alert', id: '7' }]]);
  });

  it('never throws: a failing pusher, device registry or approver store is logged', async () => {
    const t = await setup();
    t.devices.setPush(A.deviceId, { platform: 'fcm', token: 'tok-a' });
    const syncThrow = createApproverNotifier({ approverStore: t.store, devices: t.devices, pusher: { notify: () => { throw new Error('boom'); } } });
    const asyncThrow = createApproverNotifier({ approverStore: t.store, devices: t.devices, pusher: { notify: async () => { throw new Error('boom'); } } });
    const badDevices = createApproverNotifier({ approverStore: t.store, devices: { get: () => { throw new Error('boom'); } }, pusher: { notify: async () => {} } });
    const badStore = createApproverNotifier({ approverStore: { list: () => { throw new Error('boom'); }, isActive: () => true }, devices: t.devices, pusher: { notify: async () => {} } });
    for (const n of [syncThrow, asyncThrow, badDevices, badStore]) assert.doesNotThrow(() => n('alert', '1'));
    await new Promise((r) => setImmediate(r));
    assert.throws(() => createApproverNotifier({ devices: t.devices, pusher: { notify: () => {} } }), TypeError);
  });
});

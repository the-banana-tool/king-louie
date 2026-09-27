// tests/frontdoor-pairing.test.js — fleet stage 4 §3.11, §4.3, §4.4.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PairingService } = require('../src/frontdoor/pairing/pairing-service');
const { createPairHandler } = require('../src/frontdoor/pairing/pair-http');
const { NodeRegistry } = require('../src/frontdoor/router/node-registry');
const { buildNodePair, rawEd25519, pairingCodeHash } = require('../src/frontdoor/protocol/messages');
const { verifyPairAccept } = require('../src/frontdoor/protocol/checks');
const { open } = require('../src/approvals/envelope');
const { writeFileAtomic } = require('../src/approvals/approver-store');
const { WORDLIST } = require('../src/mesh/mesh-pairing');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { selfSigned, fingerprint } = require('./helpers/test-certs');
const { request } = require('./helpers/oauth-test-client');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const HOST = 'mcp.kl.example.com';
const FD = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
const A = createFakePhone({ seed: 'A' });
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

async function setup({ now = () => Date.now(), allowTestKeys = true, writeFile = undefined } = {}) {
  const store = await approverStoreWith([A.approverRecord()], { allowTestKeys });
  cleanups.push(() => store.cleanup());
  const configDir = path.join(store.baseDir, 'config');
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const raised = [];
  const alerts = { raise: (kind, opts) => { raised.push([kind, opts]); return {}; } };
  const audit = [];
  const auditLedger = { append: async (e) => { audit.push(e); return e; } };
  const notified = [];
  const registry = new NodeRegistry({ configDir, dataDir, approverStore: store, frontdoorId: FD.nodeId, alerts, adminUid: UID, geteuid: () => UID });
  registry.load();
  const pairing = new PairingService({
    file: path.join(dataDir, 'frontdoor', 'pairing.json'), registry, identity: FD, approverStore: store, frontdoorHost: HOST,
    meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: () => 'c'.repeat(64), alerts, auditLedger,
    notify: (kind, id) => notified.push([kind, id]), now, ...(writeFile ? { writeFile } : {})
  });
  return { store, configDir, dataDir, registry, pairing, raised, audit, notified };
}

function nodeKit(name = 'gpu-box', profile = 'agent') {
  const identity = testNodeIdentity({ nodeName: name });
  const cert = selfSigned({ commonName: name }).cert;
  return {
    identity,
    cert,
    pair: (code, extra = {}) => buildNodePair({ identity, frontdoorHost: HOST, code, profile, capabilities: ['large-disk'], tlsCertPem: cert, ...extra })
  };
}

const pendingView = (t, id) => t.pairing.pending().find((p) => p.pairing_id === id);

describe('PairingService', () => {
  it('issues a 6-word code, stores only its hash, and pairs a node the phone approves', async () => {
    const t = await setup();
    const { code, expires_at: expiresAt } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    assert.equal(code.split(' ').length, 6);
    assert.ok(code.split(' ').every((w) => WORDLIST.includes(w)));
    assert.ok(Date.parse(expiresAt) > Date.now());
    assert.ok(!fs.readFileSync(path.join(t.dataDir, 'frontdoor', 'pairing.json'), 'utf8').includes(code), 'the code itself is never stored');
    assert.deepEqual(t.audit[0], { kind: 'frontdoor.pairing.code_issued', data: { node_name: 'gpu-box', by: A.deviceId } });

    const n = nodeKit();
    const env = n.pair(`  ${code.toUpperCase()}  `);
    const r = t.pairing.submit(env);
    assert.equal(r.ok, true);
    const accept = verifyPairAccept(r.envelope, { nodeId: n.identity.nodeId, nonce: open(env).message.nonce });
    assert.equal(accept.ok, true, accept.reason);
    assert.equal(accept.frontdoorId, FD.nodeId);
    assert.equal(accept.message.mesh_cert_fingerprint, 'c'.repeat(64));
    const id = accept.message.pairing_id;
    assert.deepEqual(t.pairing.status(id), { state: 'pending' });
    assert.deepEqual(t.notified, [['pairing', id]]);
    const view = pendingView(t, id);
    assert.deepEqual({ ...view, expires_in_ms: typeof view.expires_in_ms }, {
      pairing_id: id, node_name: 'gpu-box', node_id: n.identity.nodeId, profile: 'agent', public_key: rawEd25519(n.identity.publicKey),
      tls_fingerprint: fingerprint(n.cert), replaces: null, expires_in_ms: 'number'
    });

    const enroll = A.enrollNode({ frontdoorId: FD.nodeId, pairing: view });
    assert.deepEqual(await t.pairing.decide(id, enroll, { deviceId: A.deviceId }), { state: 'enrolled' });
    assert.equal(t.registry.byName('gpu-box').node_id, n.identity.nodeId);
    assert.deepEqual(t.pairing.status(id), { state: 'enrolled' });
    assert.equal(pendingView(t, id), undefined);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.node.enrolled' && e.data.node_id === n.identity.nodeId));
    await assert.rejects(t.pairing.decide(id, enroll, { deviceId: A.deviceId }), (e) => e.code === 'already_decided');
  });

  it('a wrong code counts; after 5 even the right one is refused; a used code is gone', async () => {
    const t = await setup();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const n = nodeKit();
    for (let i = 0; i < 5; i += 1) assert.equal(t.pairing.submit(n.pair('abandon ability able about above absent')).reason, 'code_rejected');
    assert.deepEqual(t.pairing.submit(n.pair(code)), { ok: false, status: 429, reason: 'too_many_attempts' });

    const fresh = await t.pairing.issue('web-01', { by: A.deviceId });
    const web = nodeKit('web-01', 'runbook');
    assert.equal(t.pairing.submit(web.pair(fresh.code)).ok, true);
    assert.equal(t.pairing.submit(web.pair(fresh.code)).reason, 'code_rejected', 'single use');
    assert.equal(t.pairing.submit(nodeKit('other').pair(fresh.code)).reason, 'code_rejected', 'bound to the name');
  });

  it('refuses an expired code, a pairing for another host, and a decision after the 10 minutes', async () => {
    let now = Date.parse('2026-09-23T10:00:00.000Z');
    const t = await setup({ now: () => now });
    const n = nodeKit();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    assert.equal(t.pairing.submit(n.pair(code, { frontdoorHost: 'mcp.other.example.com' })).reason, 'wrong_host');
    now += 600001;
    assert.deepEqual(t.pairing.submit(n.pair(code)), { ok: false, status: 410, reason: 'expired' });

    const again = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const r = t.pairing.submit(n.pair(again.code));
    const id = open(r.envelope).message.pairing_id;
    const view = pendingView(t, id);
    now += 600001;
    assert.deepEqual(t.pairing.status(id), { state: 'expired' });
    await assert.rejects(t.pairing.decide(id, A.enrollNode({ frontdoorId: FD.nodeId, pairing: view }), { deviceId: A.deviceId }), (e) => e.code === 'expired');
    assert.equal(t.registry.byName('gpu-box'), null);
  });

  it('a deny writes nothing; a re-pair with a new key replaces the old record and alerts', async () => {
    const t = await setup();
    const first = nodeKit();
    const c1 = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id1 = open(t.pairing.submit(first.pair(c1.code)).envelope).message.pairing_id;
    assert.deepEqual(await t.pairing.decide(id1, A.enrollNode({ frontdoorId: FD.nodeId, pairing: pendingView(t, id1), decision: 'deny' }), { deviceId: A.deviceId }), { state: 'denied' });
    assert.equal(t.registry.byName('gpu-box'), null);

    const c2 = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id2 = open(t.pairing.submit(first.pair(c2.code)).envelope).message.pairing_id;
    await t.pairing.decide(id2, A.enrollNode({ frontdoorId: FD.nodeId, pairing: pendingView(t, id2) }), { deviceId: A.deviceId });

    const reinstalled = nodeKit();
    const c3 = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id3 = open(t.pairing.submit(reinstalled.pair(c3.code)).envelope).message.pairing_id;
    assert.equal(pendingView(t, id3).replaces, first.identity.nodeId);
    await t.pairing.decide(id3, A.enrollNode({ frontdoorId: FD.nodeId, pairing: pendingView(t, id3) }), { deviceId: A.deviceId });
    assert.equal(t.registry.byName('gpu-box').node_id, reinstalled.identity.nodeId);
    assert.equal(t.registry.byId(first.identity.nodeId), null);
    assert.deepEqual(t.raised.map(([k, o]) => [k, o.subject]), [['node_replaced', `node:${first.identity.nodeId}`]]);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.node.replaced' && e.data.old_node_id === first.identity.nodeId));
  });

  it('a decision must be signed by the calling phone', async () => {
    const t = await setup();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id = open(t.pairing.submit(nodeKit().pair(code)).envelope).message.pairing_id;
    await assert.rejects(t.pairing.decide(id, A.enrollNode({ frontdoorId: FD.nodeId, pairing: pendingView(t, id) }), { deviceId: 'd-someone-else' }), (e) => e.code === 'bad_decision');
    assert.deepEqual(t.pairing.status(id), { state: 'pending' });
  });

  it('a console code waits for the admin CLI: hidden from phones, enrolled once the console record exists', async () => {
    const t = await setup();
    const n = nodeKit('web-01', 'runbook');
    const { code } = await t.pairing.issue('web-01', { by: 'console' });
    const id = open(t.pairing.submit(n.pair(code)).envelope).message.pairing_id;
    assert.deepEqual(t.pairing.pending(), []);
    assert.deepEqual(t.notified, []);
    const p = t.pairing.consolePending('web-01');
    assert.equal(p.pairing_id, id);
    await assert.rejects(t.pairing.consoleConfirmed(id), (e) => e.code === 'no_console_record');
    NodeRegistry.writeConsoleRecord(t.configDir, {
      node_id: p.node_id, node_name: 'web-01', profile: 'runbook', public_key: p.public_key, tls_fingerprint: p.tls_fingerprint,
      source: 'console', accepted_at: new Date().toISOString(), signed: null, confirmed_by: 'console'
    });
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(t.configDir), 0o755);
    assert.deepEqual(await t.pairing.consoleConfirmed(id), { state: 'enrolled' });
    assert.equal(t.registry.byName('web-01').source, 'console');
    const phoneConfirmed = await t.pairing.issue('cache-01', { by: 'console', confirm: 'phone' });
    const id3 = open(t.pairing.submit(nodeKit('cache-01', 'runbook').pair(phoneConfirmed.code)).envelope).message.pairing_id;
    assert.deepEqual(t.pairing.pending().map((x) => x.pairing_id), [id3], 'a console code without --confirm waits for a phone');
    const declined = await t.pairing.issue('db-01', { by: 'console' });
    const id2 = open(t.pairing.submit(nodeKit('db-01', 'runbook').pair(declined.code)).envelope).message.pairing_id;
    t.pairing.consoleDeclined(id2);
    assert.deepEqual(t.pairing.status(id2), { state: 'denied' });
  });

  it('survives a restart: codes and pairings come back from pairing.json', async () => {
    const t = await setup();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const again = new PairingService({
      file: path.join(t.dataDir, 'frontdoor', 'pairing.json'), registry: t.registry, identity: FD, approverStore: t.store, frontdoorHost: HOST,
      meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: () => 'c'.repeat(64)
    });
    assert.equal(again.submit(nodeKit().pair(code)).ok, true);
  });
});

const fileOf = (t) => path.join(t.dataDir, 'frontdoor', 'pairing.json');
const reopen = (t) => new PairingService({
  file: fileOf(t), registry: t.registry, identity: FD, approverStore: t.store, frontdoorHost: HOST,
  meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: () => 'c'.repeat(64)
});
const WRONG = 'abandon ability able about above absent';

// A write that fails while `broken.on` is set, and writes atomically otherwise.
function breakableWrite() {
  const broken = { on: false };
  const writeFile = (file, text) => {
    if (broken.on) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    writeFileAtomic(file, text);
  };
  return { broken, writeFile };
}

async function listen(t) {
  const server = http.createServer(createPairHandler({ pairing: t.pairing }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('PairingService hardening', () => {
  it('fails closed: refuses to construct without its dependencies, and refuses bad issue input', async () => {
    const t = await setup();
    const base = { file: fileOf(t), registry: t.registry, identity: FD, approverStore: t.store, frontdoorHost: HOST, meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: () => 'c'.repeat(64) };
    for (const k of ['file', 'registry', 'identity', 'approverStore', 'frontdoorHost', 'meshUrl', 'meshCertFingerprint']) {
      assert.throws(() => new PairingService({ ...base, [k]: undefined }), TypeError, k);
    }
    await assert.rejects(t.pairing.issue('bad name!', { by: A.deviceId }), (e) => e.code === 'bad_node_name');
    await assert.rejects(t.pairing.issue('gpu-box', {}), (e) => e.code === 'bad_issuer');
    await assert.rejects(t.pairing.issue('gpu-box', { by: 'someone' }), (e) => e.code === 'bad_issuer');
    await assert.rejects(t.pairing.issue('gpu-box', { by: A.deviceId, confirm: 'nobody' }), (e) => e.code === 'bad_confirm');
  });

  it('refuses a published test node key unless the admin approver store allows test keys', async () => {
    const fixed = testNodeIdentity({ key: 'gpu-box', nodeName: 'gpu-box' });
    const cert = selfSigned({ commonName: 'gpu-box' }).cert;
    const pairWith = (code) => buildNodePair({ identity: fixed, frontdoorHost: HOST, code, profile: 'agent', tlsCertPem: cert });
    const strict = await setup({ allowTestKeys: false });
    const { code } = await strict.pairing.issue('gpu-box', { by: 'console' });
    assert.deepEqual(strict.pairing.submit(pairWith(code)), { ok: false, status: 400, reason: 'test_key' });
    const lax = await setup({ allowTestKeys: true });
    const c2 = await lax.pairing.issue('gpu-box', { by: 'console' });
    assert.equal(lax.pairing.submit(pairWith(c2.code)).ok, true);
  });

  it('a bad signature never counts toward the lockout', async () => {
    const t = await setup();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const n = nodeKit();
    for (let i = 0; i < 6; i += 1) {
      const forged = { ...n.pair(WRONG), sig: nodeKit().pair(WRONG).sig };
      assert.equal(t.pairing.submit(forged).reason, 'bad_signature');
    }
    assert.equal(t.pairing.submit(n.pair(code)).ok, true);
  });

  it('the lockout survives a restart', async () => {
    const t = await setup();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const n = nodeKit();
    for (let i = 0; i < 5; i += 1) t.pairing.submit(n.pair(WRONG));
    assert.equal(reopen(t).submit(n.pair(code)).reason, 'too_many_attempts');
  });

  it('two concurrent submits of the same good code: exactly one pairs', async () => {
    const t = await setup();
    const base = await listen(t);
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const answers = await Promise.all([nodeKit(), nodeKit()].map((k) => request(base, { method: 'POST', path: '/pair/v1', json: k.pair(code) })));
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 403]);
    assert.equal(answers.find((a) => a.status === 403).json.error, 'code_rejected');
    assert.equal(t.pairing.pending().length, 1);
  });

  it('two concurrent decisions: exactly one decides, the other is already_decided', async () => {
    const t = await setup();
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id = open(t.pairing.submit(nodeKit().pair(code)).envelope).message.pairing_id;
    const view = pendingView(t, id);
    const results = await Promise.allSettled([
      t.pairing.decide(id, A.enrollNode({ frontdoorId: FD.nodeId, pairing: view }), { deviceId: A.deviceId }),
      t.pairing.decide(id, A.enrollNode({ frontdoorId: FD.nodeId, pairing: view, decision: 'deny' }), { deviceId: A.deviceId })
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
    assert.deepEqual(results[0].value, { state: 'enrolled' });
    assert.equal(results[1].reason.code, 'already_decided');
    assert.deepEqual(t.pairing.status(id), { state: 'enrolled' });
  });

  it('refuses to enrol over a node the owner did not see being replaced', async () => {
    const t = await setup();
    const [one, two] = [nodeKit(), nodeKit()];
    const c1 = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id1 = open(t.pairing.submit(one.pair(c1.code)).envelope).message.pairing_id;
    const c2 = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const id2 = open(t.pairing.submit(two.pair(c2.code)).envelope).message.pairing_id;
    const view2 = pendingView(t, id2);
    assert.equal(view2.replaces, null);
    await t.pairing.decide(id1, A.enrollNode({ frontdoorId: FD.nodeId, pairing: pendingView(t, id1) }), { deviceId: A.deviceId });
    await assert.rejects(t.pairing.decide(id2, A.enrollNode({ frontdoorId: FD.nodeId, pairing: view2 }), { deviceId: A.deviceId }), (e) => e.code === 'replaces_changed');
    assert.equal(t.registry.byName('gpu-box').node_id, one.identity.nodeId);
    assert.deepEqual(t.pairing.status(id2), { state: 'pending' });
    assert.deepEqual(t.raised, []);
  });

  it('a console record that does not match the pairing does not enrol it', async () => {
    const t = await setup();
    const n = nodeKit('web-01', 'runbook');
    const { code } = await t.pairing.issue('web-01', { by: 'console' });
    const id = open(t.pairing.submit(n.pair(code)).envelope).message.pairing_id;
    const p = t.pairing.consolePending('web-01');
    NodeRegistry.writeConsoleRecord(t.configDir, {
      node_id: p.node_id, node_name: 'web-01', profile: 'runbook', public_key: p.public_key, tls_fingerprint: 'e'.repeat(64),
      source: 'console', accepted_at: new Date().toISOString(), signed: null, confirmed_by: 'console'
    });
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(t.configDir), 0o755);
    await assert.rejects(t.pairing.consoleConfirmed(id), (e) => e.code === 'console_record_mismatch');
    assert.deepEqual(t.pairing.status(id), { state: 'pending' });
  });

  it('pairing.json is untrusted: a corrupt file is moved aside, malformed entries are dropped, nothing throws', async () => {
    const t = await setup();
    const file = fileOf(t);
    const dir = path.dirname(file);
    const asides = () => fs.readdirSync(dir).filter((f) => f.startsWith('pairing.json.corrupt-')).length;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(reopen(t).pending(), []);
    assert.equal(asides(), 1);
    assert.equal(fs.existsSync(file), false);

    fs.writeFileSync(file, JSON.stringify({ v: 2, codes: [], pairings: [] }));
    reopen(t);
    assert.equal(fs.existsSync(file), false, 'an unknown version is moved aside too');

    const later = Date.now() + 600000;
    const goodCode = { code_hash: pairingCodeHash(WRONG), node_name: 'gpu-box', expires_at_ms: later, attempts: 0, by: A.deviceId, confirm: 'phone' };
    fs.writeFileSync(file, `{"v":1,"codes":[${[
      JSON.stringify(goodCode),
      '{"__proto__":{"polluted":true},"code_hash":"x","node_name":"web-01"}',
      JSON.stringify({ ...goodCode, node_name: 'web-01', attempts: -1 }),
      JSON.stringify({ ...goodCode, node_name: 'db-01', expires_at_ms: 'soon' }),
      JSON.stringify({ ...goodCode, node_name: 'dup-01' }),
      JSON.stringify({ ...goodCode, node_name: 'dup-01', code_hash: pairingCodeHash('other words here') }),
      'null', '"text"', '[]'
    ].join(',')}],"pairings":[{"pairing_id":"pr_bad","state":"enrolled"},{"__proto__":{"state":"pending"}},7]}`);
    const loaded = reopen(t);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(loaded.pending(), []);
    for (const name of ['web-01', 'db-01', 'dup-01']) assert.equal(loaded.submit(nodeKit(name).pair(WRONG)).reason, 'code_rejected', name);
    assert.equal(loaded.submit(nodeKit('gpu-box').pair(WRONG)).ok, true);
  });

  it('an oversize pairing.json is moved aside without being parsed', async () => {
    const t = await setup();
    const file = fileOf(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{"v":1,"codes":[],"pairings":[],"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`);
    reopen(t);
    assert.equal(fs.existsSync(file), false);
  });

  it('a failed save after a good code rolls back: the retry pairs, and the used code is gone after a restart', async () => {
    const { broken, writeFile } = breakableWrite();
    const t = await setup({ writeFile });
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const n = nodeKit();
    broken.on = true;
    assert.deepEqual(t.pairing.submit(n.pair(code)), { ok: false, status: 500, reason: 'internal' });
    assert.deepEqual(t.pairing.pending(), []);
    assert.deepEqual(t.notified, []);
    broken.on = false;
    assert.equal(t.pairing.submit(n.pair(code)).ok, true);
    assert.equal(reopen(t).submit(nodeKit().pair(code)).reason, 'code_rejected');
  });

  it('wrong codes still count when the save fails, and reach the file once saving works again', async () => {
    const { broken, writeFile } = breakableWrite();
    const t = await setup({ writeFile });
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const n = nodeKit();
    broken.on = true;
    for (let i = 0; i < 5; i += 1) assert.equal(t.pairing.submit(n.pair(WRONG)).reason, 'code_rejected');
    assert.equal(t.pairing.submit(n.pair(code)).reason, 'too_many_attempts');
    broken.on = false;
    t.pairing.sweep();
    assert.equal(reopen(t).submit(n.pair(code)).reason, 'too_many_attempts');
  });

  it('a failed issue save keeps the previous code; a deny whose save fails is refused, survives no restart, and the retry holds', async () => {
    const { broken, writeFile } = breakableWrite();
    const t = await setup({ writeFile });
    const first = await t.pairing.issue('gpu-box', { by: A.deviceId });
    broken.on = true;
    await assert.rejects(t.pairing.issue('gpu-box', { by: A.deviceId }), /disk full/);
    broken.on = false;
    const id = open(t.pairing.submit(nodeKit().pair(first.code)).envelope).message.pairing_id;
    broken.on = true;
    const deny = A.enrollNode({ frontdoorId: FD.nodeId, pairing: pendingView(t, id), decision: 'deny' });
    await assert.rejects(t.pairing.decide(id, deny, { deviceId: A.deviceId }), (e) => e.code === 'save_failed');
    assert.deepEqual(t.pairing.status(id), { state: 'pending' }, 'rolled back, not denied only in memory');
    assert.deepEqual(reopen(t).status(id), { state: 'pending' });
    broken.on = false;
    assert.deepEqual(await t.pairing.decide(id, deny, { deviceId: A.deviceId }), { state: 'denied' }, 'the same decision, retried');
    assert.deepEqual(reopen(t).status(id), { state: 'denied' });
  });

  it('a console decline whose save fails is refused and rolled back', async () => {
    const { broken, writeFile } = breakableWrite();
    const t = await setup({ writeFile });
    const { code } = await t.pairing.issue('db-01', { by: 'console' });
    const id = open(t.pairing.submit(nodeKit('db-01', 'runbook').pair(code)).envelope).message.pairing_id;
    broken.on = true;
    assert.throws(() => t.pairing.consoleDeclined(id), (e) => e.code === 'save_failed');
    assert.deepEqual(t.pairing.status(id), { state: 'pending' });
    broken.on = false;
    assert.equal(t.pairing.consoleDeclined(id), true);
    assert.deepEqual(reopen(t).status(id), { state: 'denied' });
  });

  // Ruling T28-rename: one key, one name. The registry keys records by node
  // id, so approving a known key under a new name would drop the old name.
  const renamedKit = (kit, name) => {
    const identity = { ...kit.identity, nodeName: name };
    return { identity, cert: kit.cert, pair: (code) => buildNodePair({ identity, frontdoorHost: HOST, code, profile: 'agent', capabilities: ['large-disk'], tlsCertPem: kit.cert }) };
  };
  async function enrolByPhone(t, kit) {
    const { code } = await t.pairing.issue(kit.identity.nodeName, { by: A.deviceId });
    const id = open(t.pairing.submit(kit.pair(code)).envelope).message.pairing_id;
    await t.pairing.decide(id, A.enrollNode({ frontdoorId: FD.nodeId, pairing: pendingView(t, id) }), { deviceId: A.deviceId });
  }

  it('a key enrolled under another name is refused at submit (409), over HTTP too, and the code is not spent', async () => {
    const t = await setup();
    const box = nodeKit('gpu-box');
    await enrolByPhone(t, box);
    const { code } = await t.pairing.issue('web-01', { by: A.deviceId });
    const r = t.pairing.submit(renamedKit(box, 'web-01').pair(code));
    assert.equal(r.ok, false);
    assert.deepEqual([r.status, r.reason], [409, 'key_enrolled_as_other_name']);
    assert.match(r.message, /remove gpu-box first/);
    const base = await listen(t);
    const posted = await request(base, { method: 'POST', path: '/pair/v1', json: renamedKit(box, 'web-01').pair(code) });
    assert.deepEqual([posted.status, posted.json.error], [409, 'key_enrolled_as_other_name']);
    assert.equal(t.registry.byName('gpu-box').node_id, box.identity.nodeId);
    assert.equal(t.pairing.submit(nodeKit('web-01').pair(code)).ok, true, 'the code still works for another key');
  });

  it('a key enrolled under another name after submit is refused when the phone approves', async () => {
    const t = await setup();
    const box = nodeKit('gpu-box');
    const { code } = await t.pairing.issue('web-01', { by: A.deviceId });
    const id = open(t.pairing.submit(renamedKit(box, 'web-01').pair(code)).envelope).message.pairing_id;
    const view = pendingView(t, id);
    await enrolByPhone(t, box);
    await assert.rejects(t.pairing.decide(id, A.enrollNode({ frontdoorId: FD.nodeId, pairing: view }), { deviceId: A.deviceId }), (e) => e.code === 'key_enrolled_as_other_name');
    assert.equal(t.registry.byName('gpu-box').node_id, box.identity.nodeId);
    assert.equal(t.registry.byName('web-01'), null);
    assert.deepEqual(t.pairing.status(id), { state: 'pending' });
  });

  it('a key enrolled under another name after submit is refused at console confirm', async () => {
    const t = await setup();
    const box = nodeKit('gpu-box');
    const { code } = await t.pairing.issue('web-01', { by: 'console' });
    const id = open(t.pairing.submit(renamedKit(box, 'web-01').pair(code)).envelope).message.pairing_id;
    await enrolByPhone(t, box);
    await assert.rejects(t.pairing.consoleConfirmed(id), (e) => e.code === 'key_enrolled_as_other_name');
    assert.equal(t.registry.byName('gpu-box').node_id, box.identity.nodeId);
    assert.deepEqual(t.pairing.status(id), { state: 'pending' });
  });

  it('a console confirm after a registry reload still raises node_replaced for the node the submit saw', async () => {
    const t = await setup();
    const old = nodeKit('gpu-box');
    await enrolByPhone(t, old);
    const fresh = nodeKit('gpu-box');
    const { code } = await t.pairing.issue('gpu-box', { by: 'console' });
    const id = open(t.pairing.submit(fresh.pair(code)).envelope).message.pairing_id;
    const p = t.pairing.consolePending('gpu-box');
    assert.equal(p.replaces, old.identity.nodeId);
    NodeRegistry.writeConsoleRecord(t.configDir, {
      node_id: p.node_id, node_name: 'gpu-box', profile: 'agent', public_key: p.public_key, tls_fingerprint: p.tls_fingerprint,
      source: 'console', accepted_at: new Date().toISOString(), signed: null, confirmed_by: 'console'
    });
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(t.configDir), 0o755);
    t.registry.load(); // SIGHUP before the admin CLI reports back
    assert.deepEqual(await t.pairing.consoleConfirmed(id), { state: 'enrolled' });
    // (the registry also flags the shadowed phone record: node_record_invalid)
    assert.deepEqual(t.raised.filter(([k]) => k === 'node_replaced').map(([k, o]) => [k, o.subject]), [['node_replaced', `node:${old.identity.nodeId}`]]);
    assert.ok(t.audit.some((e) => e.kind === 'frontdoor.node.replaced' && e.data.old_node_id === old.identity.nodeId && e.data.by === 'console'));
  });
});

describe('/pair/v1', () => {
  it('pairs over HTTP, reports state, and allows 10 requests a minute per IP', async () => {
    const t = await setup();
    const server = http.createServer(createPairHandler({ pairing: t.pairing }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { code } = await t.pairing.issue('gpu-box', { by: A.deviceId });
    const posted = await request(base, { method: 'POST', path: '/pair/v1', json: nodeKit().pair(code) });
    assert.equal(posted.status, 200);
    const id = open(posted.json).message.pairing_id;
    assert.deepEqual((await request(base, { path: `/pair/v1/${id}` })).json, { state: 'pending' });
    assert.equal((await request(base, { path: `/pair/v1/pr_${'x'.repeat(22)}` })).status, 404);
    const bad = await request(base, { method: 'POST', path: '/pair/v1', json: { not: 'an envelope' } });
    assert.deepEqual([bad.status, bad.json.error], [400, 'malformed']);
    let last;
    for (let i = 0; i < 6; i += 1) last = await request(base, { path: `/pair/v1/${id}` });
    assert.equal(last.status, 200, 'the tenth request still answers');
    const limited = await request(base, { path: `/pair/v1/${id}` });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  });

  it('refuses oversize and non-JSON bodies', async () => {
    const t = await setup();
    const base = await listen(t);
    const big = await request(base, { method: 'POST', path: '/pair/v1', raw: 'x'.repeat(65537), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413);
    const junk = await request(base, { method: 'POST', path: '/pair/v1', raw: 'not json', headers: { 'content-type': 'application/json' } });
    assert.deepEqual([junk.status, junk.json.error], [400, 'bad_json']);
  });

  // A request as the handler sees it: only the socket's peer address matters.
  function call(handler, ip, url = `/pair/v1/pr_${'x'.repeat(22)}`) {
    return new Promise((resolve) => {
      const req = { method: 'GET', url, headers: {}, socket: { remoteAddress: ip } };
      const res = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end() { resolve(this.status); } };
      handler(req, res);
    });
  }

  it('the per-IP limiter keys IPv6 by /64, tracks a bounded number of addresses and forgets idle ones', async () => {
    let now = 1000000;
    const pairing = { submit: () => ({ ok: false, status: 403, reason: 'code_rejected' }), status: () => null };
    const handler = createPairHandler({ pairing, perMin: 1, now: () => now, maxIps: 3 });
    assert.equal(await call(handler, '2001:db8:1:2::1'), 404);
    assert.equal(await call(handler, '2001:db8:1:2::ffff'), 429, 'same /64');
    assert.equal(await call(handler, '::ffff:192.0.2.1'), 404);
    assert.equal(await call(handler, '192.0.2.1'), 429, 'a v4-mapped address is its IPv4');
    assert.equal(await call(handler, '192.0.2.2'), 404);
    assert.equal(await call(handler, '192.0.2.3'), 404);
    assert.equal(handler.trackedIps(), 3, 'capped');
    assert.equal(await call(handler, '2001:db8:1:2::1'), 404, 'the oldest address was evicted');
    now += 61000;
    assert.equal(await call(handler, '192.0.2.4'), 404);
    assert.equal(handler.trackedIps(), 1, 'idle addresses swept');
  });

  it('a handler without a pairing service refuses to build', () => {
    assert.throws(() => createPairHandler({}), TypeError);
  });
});

describe('PairingService code limits (Task 30 fix round)', () => {
  const build = (t, extra = {}) => new PairingService({
    file: path.join(t.dataDir, 'frontdoor', 'pairing.json'), registry: t.registry, identity: FD, approverStore: t.store, frontdoorHost: HOST,
    meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: () => 'c'.repeat(64), ...extra
  });

  it('refuses a new code once the live-code cap is reached; re-issuing a name or an expiry frees room', async () => {
    let clock = Date.parse('2026-09-26T12:00:00.000Z');
    const t = await setup();
    const p = build(t, { now: () => clock, maxLiveCodes: 2 });
    await p.issue('n-1', { by: A.deviceId });
    clock += 60000;
    await p.issue('n-2', { by: A.deviceId });
    await assert.rejects(p.issue('n-3', { by: A.deviceId }), (e) => e.code === 'too_many_codes' && e.retryAfterS === 540);
    await p.issue('n-2', { by: A.deviceId }); // replaces its own code
    assert.deepEqual(p.codes.map((c) => c.node_name), ['n-1', 'n-2']);
    clock += 9 * 60000 + 1; // n-1 has expired
    await p.issue('n-3', { by: A.deviceId });
    assert.ok(p.codes.some((c) => c.node_name === 'n-3'));
  });

  it('console codes have their own cap: phones filling every phone slot never lock the console out (Task 30 carry)', async () => {
    const t = await setup();
    const p = build(t, { maxLiveCodes: 2, maxConsoleLiveCodes: 2 });
    await p.issue('n-1', { by: A.deviceId });
    await p.issue('n-2', { by: A.deviceId });
    await assert.rejects(p.issue('n-3', { by: A.deviceId }), (e) => e.code === 'too_many_codes');
    // Every phone slot is taken; the console still issues.
    const c1 = await p.issue('c-1', { by: 'console', confirm: 'console' });
    assert.match(c1.code, /^[a-z]+( [a-z]+){5}$/);
    await p.issue('c-2', { by: 'console', confirm: 'phone' });
    // The console's own pool is bounded too, and never eats phone slots.
    await assert.rejects(p.issue('c-3', { by: 'console' }), (e) => e.code === 'too_many_codes' && /console/.test(e.message));
    await assert.rejects(p.issue('n-3', { by: A.deviceId }), (e) => e.code === 'too_many_codes');
    assert.deepEqual(p.codes.map((c) => c.node_name).sort(), ['c-1', 'c-2', 'n-1', 'n-2']);
  });

  it('load keeps the newest codes when the file holds more than the cap', async () => {
    const t = await setup();
    const file = path.join(t.dataDir, 'frontdoor', 'pairing.json');
    const exp = Date.now() + 600000;
    const codes = [];
    for (let i = 0; i < 1001; i += 1) {
      codes.push({ code_hash: pairingCodeHash(`code ${i}`), node_name: `n-${i}`, expires_at_ms: exp, attempts: 0, by: 'console', confirm: 'console' });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, codes, pairings: [] }));
    const p = build(t);
    const names = new Set(p.codes.map((c) => c.node_name));
    assert.equal(names.size, 1000);
    assert.ok(!names.has('n-0'), 'the oldest is dropped');
    assert.ok(names.has('n-1000'), 'the newest is kept');
  });
});

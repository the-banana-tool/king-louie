// tests/frontdoor-registry.test.js — fleet stage 4 §3.6.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { once, EventEmitter } = require('events');
const { NodeRegistry, QUARANTINE_MAX_ENTRIES } = require('../src/frontdoor/router/node-registry');
const { MeshTransport, CLOSE_CODES, TAKEOVER_ALERT_COUNT } = require('../src/mesh/mesh-transport');
const { NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const { derivePeerId } = require('../src/mesh/mesh-identity');
const { rawEd25519 } = require('../src/frontdoor/protocol/messages');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { NodeHub } = require('../src/frontdoor/node-hub');
const { MeshPairing } = require('../src/mesh/mesh-pairing');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FD = testNodeIdentity({ key: 'relay' });
const A = createFakePhone({ seed: 'A' });
const B = createFakePhone({ seed: 'B' });
const alertsSink = () => ({ raised: [], raise(kind, opts) { this.raised.push([kind, opts]); return {}; } });

async function setup({ revokeB = null, allowTestKeys = true, phones = null } = {}) {
  const records = phones ? phones.map((p) => p.approverRecord()) : [A.approverRecord(), B.approverRecord(revokeB ? { revokedAt: revokeB, revokedBy: 'console' } : {})];
  const store = await approverStoreWith(records, { allowTestKeys });
  cleanups.push(() => store.cleanup());
  const configDir = path.join(store.baseDir, 'config');
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const alerts = alertsSink();
  const registry = new NodeRegistry({ configDir, dataDir, approverStore: store, frontdoorId: FD.nodeId, alerts, adminUid: UID, geteuid: () => UID });
  return { registry, configDir, dataDir, alerts, store };
}

function node(name, profile = 'agent', { key = null } = {}) {
  const id = testNodeIdentity({ nodeName: name, key });
  return { id, raw: rawEd25519(id.publicKey), tls: crypto.randomBytes(32).toString('hex'), name, profile };
}

function enrollBy(phone, n, { replaces = null, signedAt = '2026-09-19T12:00:00.000Z', decision = 'approve', frontdoorId = FD.nodeId } = {}) {
  return phone.enrollNode({
    frontdoorId, signedAt, decision,
    pairing: { pairing_id: `pr_${crypto.randomBytes(16).toString('base64url')}`, node_id: n.id.nodeId, node_name: n.name, profile: n.profile, public_key: n.raw, tls_fingerprint: n.tls, replaces }
  });
}

const consoleRecord = (n, extra = {}) => ({ node_id: n.id.nodeId, node_name: n.name, profile: n.profile, public_key: n.raw, tls_fingerprint: n.tls, source: 'console', accepted_at: '2026-09-20T00:00:00.000Z', signed: null, confirmed_by: 'console', ...extra });
const phoneRecord = (phone, n, acceptedAt = '2026-09-21T00:00:00.000Z', extra = {}, enrollOpts = {}) => ({ node_id: n.id.nodeId, node_name: n.name, profile: n.profile, public_key: n.raw, tls_fingerprint: n.tls, source: 'phone', accepted_at: acceptedAt, signed: enrollBy(phone, n, enrollOpts), ...extra });

function writePhoneFile(dataDir, nodes) {
  const file = path.join(dataDir, 'frontdoor', 'nodes.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, nodes }));
  return file;
}

// Writes a console record straight to disk, bypassing writeConsoleRecord's
// own checks (a hand-edited or planted file).
function plantConsoleFile(configDir, fileName, record) {
  const dir = NodeRegistry.consoleDir(configDir);
  fs.mkdirSync(dir, { recursive: true });
  if (POSIX) fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(record), { mode: 0o644 });
}

const rejectedList = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'frontdoor', 'nodes.rejected.json'), 'utf8'));

describe('NodeRegistry', () => {
  it('is the union of console and phone records, and feeds the hub hex peer ids', async () => {
    const { registry, configDir, dataDir } = await setup();
    const web = node('web-01', 'runbook');
    NodeRegistry.writeConsoleRecord(configDir, consoleRecord(web));
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(configDir), 0o755);
    const gpu = node('gpu-box');
    registry.load();
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    assert.deepEqual(registry.list().map((r) => [r.node_name, r.source]).sort(), [['gpu-box', 'phone'], ['web-01', 'console']]);
    const peers = registry.peers();
    const gpuPeer = peers.find((p) => p.nodeId === gpu.id.nodeId);
    assert.equal(gpuPeer.peerId, derivePeerId(gpu.id.publicKey.toString('hex')));
    assert.match(gpuPeer.peerId, /^kl-[0-9a-f]{12}$/);
    assert.equal(gpuPeer.publicKeyHex, gpu.id.publicKey.toString('hex'));
    assert.deepEqual([...registry.pinnedCertSet()].sort(), [gpu.tls, web.tls].sort());
    if (POSIX) assert.equal(fs.statSync(path.join(dataDir, 'frontdoor', 'nodes.json')).mode & 0o777, 0o600);

    const reloaded = new NodeRegistry({ configDir, dataDir: registry.dataDir, approverStore: registry.approverStore, frontdoorId: FD.nodeId, adminUid: UID, geteuid: () => UID });
    reloaded.load();
    assert.equal(reloaded.list().length, 2);
  });

  it('quarantines a phone record that no longer verifies, and alerts', async () => {
    const { registry, dataDir, alerts } = await setup();
    const gpu = node('gpu-box');
    registry.load();
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    const file = path.join(dataDir, 'frontdoor', 'nodes.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.nodes[gpu.id.nodeId].tls_fingerprint = 'f'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(stored));
    registry.load();
    assert.equal(registry.byId(gpu.id.nodeId), null);
    const rejected = rejectedList(dataDir);
    assert.equal(rejected[0].record.node_id, gpu.id.nodeId);
    assert.equal(rejected[0].reason, 'record_mismatch');
    assert.deepEqual(alerts.raised.at(-1), ['node_record_invalid', { subject: `node:${gpu.id.nodeId}`, detail: { reason: 'record_mismatch' } }]);
    // Quarantined once: the bad record left nodes.json.
    registry.load();
    assert.equal(rejectedList(dataDir).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).nodes, {});
  });

  it('keeps a record accepted before its signer was revoked, drops one accepted after (R25)', async () => {
    const { registry, dataDir } = await setup({ revokeB: '2026-09-22T00:00:00.000Z' });
    const early = node('early');
    const late = node('late');
    const same = node('same');
    writePhoneFile(dataDir, {
      [early.id.nodeId]: phoneRecord(B, early, '2026-09-21T00:00:00.000Z'),
      [late.id.nodeId]: phoneRecord(B, late, '2026-09-23T00:00:00.000Z'),
      [same.id.nodeId]: phoneRecord(B, same, '2026-09-22T00:00:00.000Z')
    });
    registry.load();
    assert.ok(registry.byId(early.id.nodeId));
    assert.equal(registry.byId(late.id.nodeId), null);
    assert.equal(registry.byId(same.id.nodeId), null, 'accepted_at equal to revoked_at is not before it');
    assert.deepEqual(rejectedList(dataDir).map((e) => e.reason).sort(), ['revoked_device', 'revoked_device']);
  });

  it('a re-pair with replaces swaps the pin; a phone cannot replace or remove a console node', async () => {
    const { registry, configDir } = await setup();
    registry.load();
    const oldKey = node('gpu-box');
    registry.addSigned(enrollBy(A, oldKey), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    const events = [];
    registry.on('replaced', (e) => events.push(e));
    const newKey = node('gpu-box');
    registry.addSigned(enrollBy(A, newKey, { replaces: oldKey.id.nodeId }), { acceptedAt: '2026-09-22T00:00:00.000Z' });
    assert.equal(registry.byName('gpu-box').node_id, newKey.id.nodeId);
    assert.equal(registry.byId(oldKey.id.nodeId), null);
    assert.deepEqual(events, [{ oldId: oldKey.id.nodeId, newId: newKey.id.nodeId }]);
    assert.ok(!registry.pinnedCertSet().has(oldKey.tls));

    const web = node('web-01', 'runbook');
    NodeRegistry.writeConsoleRecord(configDir, consoleRecord(web));
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(configDir), 0o755);
    registry.load();
    assert.throws(() => registry.addSigned(enrollBy(A, node('web-01', 'runbook'), { replaces: web.id.nodeId }), { acceptedAt: '2026-09-22T00:00:00.000Z' }), (err) => err.code === 'console_record');
    assert.throws(() => registry.addSigned(enrollBy(A, node('web-01', 'runbook')), { acceptedAt: '2026-09-22T00:00:00.000Z' }), (err) => err.code === 'console_record');
    assert.throws(() => registry.removeSigned({ node_id: web.id.nodeId }), (err) => err.code === 'console_record');
    assert.equal(NodeRegistry.removeConsoleRecord(configDir, 'web-01'), true);
  });

  it('records presence and says when boot_id changed', async () => {
    const { registry } = await setup();
    registry.load();
    const gpu = node('gpu-box');
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    assert.deepEqual(registry.markOnline(gpu.id.nodeId, { boot_id: 'a'.repeat(32) }), { bootChanged: false });
    assert.deepEqual(registry.markOnline(gpu.id.nodeId, { boot_id: 'a'.repeat(32) }), { bootChanged: false });
    assert.deepEqual(registry.markOnline(gpu.id.nodeId, { boot_id: 'b'.repeat(32) }), { bootChanged: true });
    registry.markOffline(gpu.id.nodeId);
    assert.equal(registry.presence(gpu.id.nodeId).online, false);
  });
});

describe('console records with one name (Task 33 fix round)', () => {
  it('two console records named alike: neither is trusted, and each raises node_record_invalid', async () => {
    const { registry, configDir, alerts } = await setup();
    const one = node('web-01');
    const two = node('web-01');
    const other = node('gpu-box');
    for (const n of [one, two, other]) NodeRegistry.writeConsoleRecord(configDir, consoleRecord(n));
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(configDir), 0o755);
    registry.load();
    assert.equal(registry.byName('web-01'), null);
    assert.equal(registry.byId(one.id.nodeId), null);
    assert.equal(registry.byId(two.id.nodeId), null);
    assert.equal(registry.byName('gpu-box').node_id, other.id.nodeId);
    assert.ok(!registry.pinnedCertSet().has(one.tls) && !registry.pinnedCertSet().has(two.tls));
    const dup = alerts.raised.filter(([k, o]) => k === 'node_record_invalid' && o.detail.reason === 'duplicate_console_name').map(([, o]) => o.subject).sort();
    assert.deepEqual(dup, [`node:${one.id.nodeId}`, `node:${two.id.nodeId}`].sort());
  });

  it('removeConsoleRecord removes every record of the name, and a failed delete throws instead of reading as "none"', async (t) => {
    const { configDir } = await setup();
    const one = node('web-01');
    const two = node('web-01');
    const other = node('gpu-box');
    for (const n of [one, two, other]) NodeRegistry.writeConsoleRecord(configDir, consoleRecord(n));
    assert.equal(NodeRegistry.removeConsoleRecord(configDir, 'web-01'), true);
    assert.deepEqual(fs.readdirSync(NodeRegistry.consoleDir(configDir)), [`${other.id.nodeId}.json`]);
    assert.equal(NodeRegistry.removeConsoleRecord(configDir, 'web-01'), false);
    t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
    assert.throws(() => NodeRegistry.removeConsoleRecord(configDir, 'gpu-box'), /EPERM/);
  });
});

describe('NodeRegistry trust rules', () => {
  it('a stored node_id that does not derive from the key is never trusted (phone and console)', async () => {
    const { registry, configDir, dataDir, alerts } = await setup();
    const real = node('gpu-box');
    const other = node('other');
    // A phone record whose signed envelope and fields are all for `real`,
    // but whose node_id is somebody else's.
    writePhoneFile(dataDir, { [other.id.nodeId]: phoneRecord(A, real, '2026-09-21T00:00:00.000Z', { node_id: other.id.nodeId }) });
    const web = node('web-01', 'runbook');
    plantConsoleFile(configDir, `${other.id.nodeId}.json`, consoleRecord(web, { node_id: other.id.nodeId }));
    registry.load();
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.peers(), []);
    assert.equal(registry.pinnedCertSet().size, 0);
    assert.deepEqual(rejectedList(dataDir).map((e) => e.reason), ['node_id_mismatch']);
    assert.deepEqual(alerts.raised.map(([kind, o]) => [kind, o.detail.reason]).sort(), [['node_record_invalid', 'node_id_mismatch'], ['node_record_invalid', 'node_id_mismatch']]);
    assert.throws(() => NodeRegistry.writeConsoleRecord(configDir, consoleRecord(web, { node_id: other.id.nodeId })), /node_id_mismatch/);
  });

  it('peers() derives nodeId and peerId from the key, whatever the record says', async () => {
    const { registry } = await setup();
    registry.load();
    const gpu = node('gpu-box');
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    const [peer] = registry.peers();
    assert.equal(peer.nodeId, deriveNodeId(gpu.id.publicKey));
    assert.equal(peer.peerId, derivePeerId(gpu.id.publicKey));
    // A record altered in memory after load is left out, not trusted under
    // the id it claims.
    registry.nodes.get(gpu.id.nodeId).node_id = node('other').id.nodeId;
    assert.deepEqual(registry.peers(), []);
    assert.deepEqual(registry.peerSource().list(), []);
  });

  it('the front door\'s own id and key are reserved', async () => {
    const { registry, configDir, dataDir } = await setup();
    const fdAsNode = { id: FD, raw: rawEd25519(FD.publicKey), tls: crypto.randomBytes(32).toString('hex'), name: 'impostor', profile: 'agent' };
    registry.load();
    assert.throws(() => registry.addSigned(enrollBy(A, fdAsNode), { acceptedAt: '2026-09-21T00:00:00.000Z' }), (err) => err.code === 'reserved_node_id');
    writePhoneFile(dataDir, { [FD.nodeId]: phoneRecord(A, fdAsNode) });
    plantConsoleFile(configDir, `${FD.nodeId}.json`, consoleRecord({ ...fdAsNode, name: 'impostor-2' }));
    registry.load();
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.peers(), []);
    assert.deepEqual(rejectedList(dataDir).map((e) => e.reason), ['reserved_node_id']);
  });

  it('refuses a denial, an unknown phone, and a test node key without allowTestKeys', async () => {
    const { registry } = await setup();
    registry.load();
    assert.throws(() => registry.addSigned(enrollBy(A, node('gpu-box'), { decision: 'deny' })), (err) => err.code === 'not_approved');
    const stranger = createFakePhone();
    assert.throws(() => registry.addSigned(enrollBy(stranger, node('gpu-box'))), (err) => err.code === 'unknown_device');
    assert.deepEqual(registry.list(), []);

    const real = createFakePhone();
    const strict = await setup({ allowTestKeys: false, phones: [real] });
    strict.registry.load();
    assert.throws(() => strict.registry.addSigned(enrollBy(real, node('gpu-box', 'agent', { key: 'gpu-box' }))), (err) => err.code === 'test_key');
    const ok = strict.registry.addSigned(enrollBy(real, node('gpu-box')));
    assert.equal(ok.source, 'phone');
  });

  it('never reads approvers from the data dir', async () => {
    const { store, configDir } = await setup();
    assert.throws(() => new NodeRegistry({ configDir, dataDir: path.dirname(store.dir), approverStore: store, frontdoorId: FD.nodeId }), /data dir/);
    assert.throws(() => new NodeRegistry({ configDir, dataDir: path.join(store.baseDir, 'data'), approverStore: null, frontdoorId: FD.nodeId }), /approver store/);
  });

  it('a console record the service account could have written is refused and alerted', { skip: !POSIX && 'POSIX modes' }, async () => {
    const { registry, configDir, alerts } = await setup();
    const web = node('web-01', 'runbook');
    NodeRegistry.writeConsoleRecord(configDir, consoleRecord(web));
    fs.chmodSync(NodeRegistry.consoleDir(configDir), 0o755);
    fs.chmodSync(path.join(NodeRegistry.consoleDir(configDir), `${web.id.nodeId}.json`), 0o666);
    registry.load();
    assert.equal(registry.byId(web.id.nodeId), null);
    assert.equal(alerts.raised.at(-1)[0], 'node_record_invalid');
    assert.equal(alerts.raised.at(-1)[1].subject, `node:${web.id.nodeId}`);
    // Owned by someone other than the administrator.
    fs.chmodSync(path.join(NodeRegistry.consoleDir(configDir), `${web.id.nodeId}.json`), 0o644);
    const other = new NodeRegistry({ configDir, dataDir: registry.dataDir, approverStore: registry.approverStore, frontdoorId: FD.nodeId, adminUid: UID + 1, geteuid: () => UID });
    other.load();
    assert.equal(other.byId(web.id.nodeId), null);
  });

  it('the quarantine file keeps only the newest entries', async () => {
    const { registry, dataDir } = await setup();
    const file = path.join(dataDir, 'frontdoor', 'nodes.rejected.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = Array.from({ length: QUARANTINE_MAX_ENTRIES }, (_, i) => ({ record: { node_id: `old-${i}` }, reason: 'malformed', at: '2026-09-01T00:00:00.000Z' }));
    fs.writeFileSync(file, JSON.stringify(old));
    const gpu = node('gpu-box');
    writePhoneFile(dataDir, { [gpu.id.nodeId]: phoneRecord(A, gpu, '2026-09-21T00:00:00.000Z', { profile: 'runbook' }) });
    registry.load();
    const list = rejectedList(dataDir);
    assert.equal(list.length, QUARANTINE_MAX_ENTRIES);
    assert.equal(list.at(-1).record.node_id, gpu.id.nodeId);
    assert.equal(list[0].record.node_id, 'old-1');
    if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('a malformed phone file is quarantined as a whole, never trusted', async () => {
    const { registry, dataDir } = await setup();
    const file = path.join(dataDir, 'frontdoor', 'nodes.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"v":1,"nodes":');
    assert.deepEqual(registry.load(), []);
    assert.equal(rejectedList(dataDir)[0].reason, 'unreadable');
  });

  it('a planted phone-signed denial is refused on load', async () => {
    const { registry, dataDir } = await setup();
    const gpu = node('gpu-box');
    writePhoneFile(dataDir, { [gpu.id.nodeId]: phoneRecord(A, gpu, '2026-09-21T00:00:00.000Z', {}, { decision: 'deny' }) });
    registry.load();
    assert.equal(registry.byId(gpu.id.nodeId), null);
    assert.deepEqual(rejectedList(dataDir).map((e) => e.reason), ['not_approved']);
  });

  it('an envelope for another front door is refused (wrong_frontdoor)', async () => {
    const { registry, dataDir } = await setup();
    const other = testNodeIdentity({ key: 'web-01' }).nodeId;
    registry.load();
    assert.throws(() => registry.addSigned(enrollBy(A, node('gpu-box'), { frontdoorId: other })), (err) => err.code === 'wrong_frontdoor');
    const gpu = node('gpu-box');
    writePhoneFile(dataDir, { [gpu.id.nodeId]: phoneRecord(A, gpu, '2026-09-21T00:00:00.000Z', {}, { frontdoorId: other }) });
    registry.load();
    assert.equal(registry.byId(gpu.id.nodeId), null);
    assert.deepEqual(rejectedList(dataDir).map((e) => e.reason), ['wrong_frontdoor']);
  });

  it('a phone enrollment of a console node\'s key under a new name is refused and leaves the console record', async () => {
    const { registry, configDir } = await setup();
    const web = node('web-01', 'runbook');
    NodeRegistry.writeConsoleRecord(configDir, consoleRecord(web));
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(configDir), 0o755);
    registry.load();
    const renamed = { ...web, name: 'web-02', tls: crypto.randomBytes(32).toString('hex') };
    assert.throws(() => registry.addSigned(enrollBy(A, renamed)), (err) => err.code === 'console_record');
    assert.throws(() => registry.removeSigned({ node_id: web.id.nodeId }), (err) => err.code === 'console_record');
    const kept = registry.byId(web.id.nodeId);
    assert.equal(kept.source, 'console');
    assert.equal(kept.node_name, 'web-01');
    assert.equal(kept.tls_fingerprint, web.tls);
    assert.equal(registry.byName('web-02'), null);
    assert.equal(registry.list().length, 1);
  });

  it('load refuses a phone record that collides with a console id or name, or with another phone record\'s name', async () => {
    const { registry, configDir, dataDir } = await setup();
    const web = node('web-01', 'runbook');
    NodeRegistry.writeConsoleRecord(configDir, consoleRecord(web));
    if (POSIX) fs.chmodSync(NodeRegistry.consoleDir(configDir), 0o755);
    const sameKey = { ...web, name: 'web-02' };
    const sameName = node('web-01', 'runbook');
    const gpu = node('gpu-box');
    const gpuTwin = node('gpu-box');
    writePhoneFile(dataDir, {
      [sameKey.id.nodeId]: phoneRecord(A, sameKey),
      [sameName.id.nodeId]: phoneRecord(A, sameName),
      [gpu.id.nodeId]: phoneRecord(A, gpu),
      [gpuTwin.id.nodeId]: phoneRecord(A, gpuTwin)
    });
    registry.load();
    assert.deepEqual(registry.list().map((r) => [r.node_id, r.node_name, r.source]).sort(), [[gpu.id.nodeId, 'gpu-box', 'phone'], [web.id.nodeId, 'web-01', 'console']].sort());
    assert.deepEqual(rejectedList(dataDir).map((e) => [e.record.node_id, e.reason]), [
      [sameKey.id.nodeId, 'shadowed_by_console'],
      [sameName.id.nodeId, 'shadowed_by_console'],
      [gpuTwin.id.nodeId, 'duplicate_name']
    ]);
  });

  it('writeConsoleRecord refuses the front door\'s own id when told it', async () => {
    const { configDir } = await setup();
    const fdAsNode = { id: FD, raw: rawEd25519(FD.publicKey), tls: crypto.randomBytes(32).toString('hex'), name: 'impostor', profile: 'agent' };
    assert.throws(() => NodeRegistry.writeConsoleRecord(configDir, consoleRecord(fdAsNode), { frontdoorId: FD.nodeId }), /reserved_node_id/);
    assert.equal(fs.existsSync(path.join(NodeRegistry.consoleDir(configDir), `${FD.nodeId}.json`)), false);
  });

  it('refuses an approver store without a dir', async () => {
    const { store, configDir, dataDir } = await setup();
    const noDir = { get: (id) => store.get(id), isActive: (id) => store.isActive(id) };
    assert.throws(() => new NodeRegistry({ configDir, dataDir, approverStore: noDir, frontdoorId: FD.nodeId }), /approver store/);
  });

  it('raises node_link_flapping when the transport reports repeated takeovers', async () => {
    const { registry, alerts } = await setup();
    registry.load();
    const gpu = node('gpu-box');
    registry.addSigned(enrollBy(A, gpu), { acceptedAt: '2026-09-21T00:00:00.000Z' });
    const transport = new EventEmitter();
    const unwatch = registry.watchTransport(transport);
    const peerId = derivePeerId(gpu.id.publicKey);
    transport.emit('peerTakeover', { peerId, count: 1, windowMs: 600000, flapping: false });
    assert.equal(alerts.raised.length, 0);
    transport.emit('peerTakeover', { peerId, count: TAKEOVER_ALERT_COUNT, windowMs: 600000, flapping: true });
    assert.deepEqual(alerts.raised.at(-1), ['node_link_flapping', { subject: `node:${gpu.id.nodeId}`, detail: { takeovers: TAKEOVER_ALERT_COUNT, window_s: 600 } }]);
    unwatch();
    transport.emit('peerTakeover', { peerId, count: TAKEOVER_ALERT_COUNT + 1, windowMs: 600000, flapping: true });
    assert.equal(alerts.raised.length, 1);
  });
});

describe('the registry as the hub\'s peer source', { timeout: 15000 }, () => {
  const meshNode = (name) => {
    const id = new NodeIdentity({ nodeName: name });
    return { id, raw: rawEd25519(id.publicKey), tls: crypto.randomBytes(32).toString('hex'), name, profile: 'agent' };
  };

  async function hubOver(registry) {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const transport = new MeshTransport({ identity: hubId, host: '127.0.0.1', port: 0, useTls: false, duplicatePingMs: 200 });
    const hub = new NodeHub({ identity: hubId, transport, pairing: new MeshPairing(hubId, transport), registryFile: path.join(registry.dataDir, 'hub-nodes.json'), peerSource: registry.peerSource() });
    await hub.start({ listen: true });
    cleanups.push(() => hub.stop());
    const link = async (n) => {
      const t = new MeshTransport({ identity: n.id, listen: false, useTls: false });
      await t.start();
      cleanups.push(() => t.stop());
      t.addTrustedPeer(hubId.peerId, hubId.publicKey);
      await t.connectToPeer('127.0.0.1', transport.port);
      for (let i = 0; i < 300 && !transport.getPeer(n.id.peerId); i += 1) await sleep(10); // M11
      assert.ok(transport.getPeer(n.id.peerId), 'linked');
      return t;
    };
    return { hub, transport, link };
  }

  it('removeSigned closes the live link with 4003', async () => {
    const { registry } = await setup();
    registry.load();
    const gpu = meshNode('gpu-box');
    registry.addSigned(enrollBy(A, gpu));
    const { transport, link } = await hubOver(registry);
    const dialer = await link(gpu);
    const closed = once(dialer, 'peerDisconnected');
    registry.removeSigned({ node_id: gpu.id.nodeId });
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.keyRemoved);
    assert.equal(transport.trustedPeers.has(gpu.id.peerId), false);
  });

  it('a replaces re-pair closes the old key\'s live link with 4003 and trusts the new key', async () => {
    const { registry } = await setup();
    registry.load();
    const oldKey = meshNode('gpu-box');
    registry.addSigned(enrollBy(A, oldKey));
    const { transport, link } = await hubOver(registry);
    const dialer = await link(oldKey);
    const closed = once(dialer, 'peerDisconnected');
    const newKey = meshNode('gpu-box');
    registry.addSigned(enrollBy(A, newKey, { replaces: oldKey.id.nodeId }));
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.keyRemoved);
    assert.equal(transport.trustedPeers.has(oldKey.id.peerId), false);
    await link(newKey);
  });
});

describe('one connection per node key', { timeout: 15000 }, () => {
  async function hubAndNode({ duplicatePingMs = 200 } = {}) {
    const hubId = new NodeIdentity({ nodeName: 'frontdoor' });
    const nodeId = new NodeIdentity({ nodeName: 'gpu-box' });
    const hub = new MeshTransport({ identity: hubId, host: '127.0.0.1', port: 0, useTls: false, duplicatePingMs });
    await hub.start();
    cleanups.push(() => hub.stop());
    hub.addTrustedPeer(nodeId.peerId, nodeId.publicKey);
    const dial = async () => {
      const t = new MeshTransport({ identity: nodeId, listen: false, useTls: false });
      await t.start();
      cleanups.push(() => t.stop());
      t.addTrustedPeer(hubId.peerId, hubId.publicKey);
      return t;
    };
    // M11: connectToPeer resolves when the dialer promotes, before the
    // listener has handled auth:complete.
    const promoted = async (notWs = null, tries = 300) => {
      for (let i = 0; i < tries && (!hub.getPeer(nodeId.peerId) || hub.getPeer(nodeId.peerId).ws === notWs); i += 1) await sleep(10);
      return hub.getPeer(nodeId.peerId);
    };
    // A dead link: it stops reading, so it never answers a ping. Ended at
    // cleanup, since it would never finish a close handshake either.
    const stall = (t) => {
      const ws = t.getPeer(hubId.peerId).ws;
      ws._socket.pause();
      cleanups.push(() => { try { ws.terminate(); } catch { /* gone */ } });
    };
    return { hub, hubId, nodeId, dial, promoted, stall };
  }

  it('a second link while the first answers pings is closed with 4009', async () => {
    const { hub, hubId, nodeId, dial, promoted, stall } = await hubAndNode();
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    const firstWs = (await promoted()).ws;
    const second = await dial();
    const closed = once(second, 'peerDisconnected');
    // The 4009 comes only after auth: the dial itself succeeds.
    await second.connectToPeer('127.0.0.1', hub.port);
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.alreadyConnected);
    assert.equal(hub.getPeer(nodeId.peerId).ws, firstWs, 'the first link stays');
    assert.ok(first.getPeer(hubId.peerId), 'the first link was not disturbed');
    assert.equal(hub.duplicates.size, 0);
  });

  it('a second link takes over when the old one does not answer, and what it sent meanwhile arrives', async () => {
    const { hub, hubId, nodeId, dial, promoted, stall } = await hubAndNode();
    const takeovers = [];
    hub.on('peerTakeover', (e) => takeovers.push(e));
    const received = [];
    hub.on('peerMessage', ({ from, payload }) => received.push([from, payload]));
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    const oldWs = (await promoted()).ws;
    stall(first);
    const second = await dial();
    await second.connectToPeer('127.0.0.1', hub.port);
    second.send(hubId.peerId, { hello: 1 }); // sent while the hub is still pinging the old link
    const now = await promoted(oldWs);
    assert.notEqual(now.ws, oldWs);
    for (let i = 0; i < 100 && received.length === 0; i += 1) await sleep(10);
    assert.deepEqual(received, [[nodeId.peerId, { hello: 1 }]]);
    assert.deepEqual(takeovers, [{ peerId: nodeId.peerId, count: 1, windowMs: 600000, flapping: false }]);
  });

  it('frames held through a ping as long as the stale-envelope grace still arrive on takeover', async () => {
    // The front door pings for 5000 ms, as long as STALE_GRACE_MS: frames
    // signed while the candidate waited must not look older than its auth.
    const { hub, hubId, nodeId, dial, promoted, stall } = await hubAndNode({ duplicatePingMs: 5200 });
    const received = [];
    hub.on('peerMessage', ({ from, payload }) => received.push([from, payload]));
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    const oldWs = (await promoted()).ws;
    stall(first);
    const second = await dial();
    await second.connectToPeer('127.0.0.1', hub.port);
    second.send(hubId.peerId, { hello: 'early' });
    assert.notEqual((await promoted(oldWs, 800)).ws, oldWs);
    for (let i = 0; i < 100 && received.length === 0; i += 1) await sleep(10);
    assert.deepEqual(received, [[nodeId.peerId, { hello: 'early' }]]);
  });

  it('repeated takeovers are reported as flapping', async () => {
    const { hub, hubId, nodeId, dial, promoted, stall } = await hubAndNode({ duplicatePingMs: 100 });
    const takeovers = [];
    hub.on('peerTakeover', (e) => takeovers.push(e));
    let current = await dial();
    await current.connectToPeer('127.0.0.1', hub.port);
    let ws = (await promoted()).ws;
    for (let i = 0; i < TAKEOVER_ALERT_COUNT; i += 1) {
      stall(current);
      current = await dial();
      await current.connectToPeer('127.0.0.1', hub.port);
      ws = (await promoted(ws)).ws;
    }
    assert.deepEqual(takeovers.map((t) => [t.count, t.flapping]), [[1, false], [2, false], [TAKEOVER_ALERT_COUNT, true]]);
  });

  it('a newer candidate supersedes one still waiting on the ping', async () => {
    const { hub, hubId, nodeId, dial, promoted, stall } = await hubAndNode({ duplicatePingMs: 400 });
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    const oldWs = (await promoted()).ws;
    stall(first);
    const second = await dial();
    const secondClosed = once(second, 'peerDisconnected');
    await second.connectToPeer('127.0.0.1', hub.port);
    for (let i = 0; i < 100 && hub.duplicates.size === 0; i += 1) await sleep(10);
    const third = await dial();
    await third.connectToPeer('127.0.0.1', hub.port);
    const [{ code }] = await secondClosed;
    assert.equal(code, CLOSE_CODES.alreadyConnected);
    await promoted(oldWs);
    assert.ok(third.getPeer(hubId.peerId), 'the newest link holds the slot');
    for (let i = 0; i < 100 && !hub.getPeer(nodeId.peerId); i += 1) await sleep(10);
    assert.equal(hub.duplicates.size, 0);
  });

  it('a candidate whose key is removed while it waits is closed with 4003', async () => {
    const { hub, hubId, nodeId, dial, promoted, stall } = await hubAndNode({ duplicatePingMs: 300 });
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    await promoted();
    stall(first);
    const second = await dial();
    const closed = once(second, 'peerDisconnected');
    await second.connectToPeer('127.0.0.1', hub.port);
    for (let i = 0; i < 100 && hub.duplicates.size === 0; i += 1) await sleep(10);
    hub.removeTrustedPeer(nodeId.peerId);
    const [{ code }] = await closed;
    assert.equal(code, CLOSE_CODES.keyRemoved);
    assert.equal(hub.getPeer(nodeId.peerId), null);
  });

  it('stop() closes a candidate that is still waiting', async () => {
    const { hub, hubId, dial, promoted, stall } = await hubAndNode({ duplicatePingMs: 5000 });
    const first = await dial();
    await first.connectToPeer('127.0.0.1', hub.port);
    await promoted();
    stall(first);
    const second = await dial();
    const closed = once(second, 'peerDisconnected');
    await second.connectToPeer('127.0.0.1', hub.port);
    for (let i = 0; i < 100 && hub.duplicates.size === 0; i += 1) await sleep(10);
    const t0 = Date.now();
    const stopping = hub.stop();
    await closed;
    assert.ok(Date.now() - t0 < 2000, 'closed by stop(), not by the 5 s ping timeout');
    assert.equal(hub.duplicates.size, 0);
    // The paused incumbent never answers a close handshake; end it so stop()
    // does not wait out ws's 30 s close timeout.
    first.getPeer(hubId.peerId).ws.terminate();
    await stopping;
  });
});

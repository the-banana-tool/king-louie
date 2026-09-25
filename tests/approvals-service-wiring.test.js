// tests/approvals-service-wiring.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { createLinkRpc } = require('../src/approvals/link-rpc');
const { startApprovals, startMcpApprovals, createRelayDispatcher, trackDeviceStates } = require('../src/approvals/service-wiring');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { parseRelayConfig, parseAuditConfig, loadServiceConfig } = require('../src/service/config');
const { loadNodeConfig } = require('../src/service/node-config');
const { addSink } = require('../src/logging');
const { createFakePhone } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

let nodeIdentity;
let relayIdentity;
before(() => {
  nodeIdentity = new NodeIdentity({ nodeName: 'web-01' });
  relayIdentity = new NodeIdentity({ nodeName: 'relay' });
});

// dataDir and a sibling admin config dir with approvers/ holding `records`.
function layout(records = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wiring-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(dataDir, { recursive: true });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); fs.chmodSync(path.join(configDir, 'approvers'), 0o755); }
  for (const r of records) fs.writeFileSync(path.join(configDir, 'approvers', `${r.device_id}.json`), JSON.stringify(r), { mode: 0o644 });
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data' });
  return { base, dataDir, configDir, ports: { store, cipher: createAesGcmCipher(crypto.randomBytes(32)) } };
}

const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };
const nodeConfig = (approvers = { relay: null, requestTtlS: 300 }) => ({ name: 'web-01', approvers, policy: {} });

async function fakeRelay() {
  const transport = new MeshTransport({ identity: relayIdentity, host: '127.0.0.1', port: 0, useTls: false });
  transport.addTrustedPeer(nodeIdentity.peerId, nodeIdentity.publicKey);
  await transport.start();
  cleanups.push(() => transport.stop());
  const rpc = createLinkRpc(transport);
  const notes = [];
  rpc.handle('relay.hello', () => ({ relay_id: relayIdentity.nodeId, public_url: 'https://kl.example.com:8443', phone_spki: 'sha256/x' }));
  rpc.handle('approval.submit', () => ({ ok: true }));
  rpc.handle('approval.status', () => ({ ok: true }));
  rpc.onUnhandled((method, params) => { notes.push([method, params]); return { ok: true }; });
  const connected = new Promise((resolve) => transport.once('peerConnected', resolve));
  return { transport, rpc, notes, connected };
}

describe('startApprovals', () => {
  it('without a relay: everything is built and requests are refused with the reason', async () => {
    const l = layout();
    const a = await startApprovals({ dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig(), ports: l.ports, identity: nodeIdentity, approverStoreOptions: storeOptions });
    cleanups.push(() => a.stop());
    assert.equal(a.relayClient, null);
    assert.equal(a.identity, nodeIdentity);
    assert.equal(a.phoneApprover.unavailableReason(), 'no relay is configured for this node (approvers.relay in node.yaml)');
    assert.equal((await a.auditLedger.append({ kind: 'x', data: {} })).seq, 1);
    assert.ok(fs.existsSync(path.join(l.dataDir, 'audit')));
  });

  it('with approvers.relay but no pairing: says to pair, and logs why', async () => {
    const l = layout();
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    let a;
    try {
      a = await startApprovals({ dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig({ relay: 'wss://127.0.0.1:18795', requestTtlS: 120 }), ports: l.ports, identity: nodeIdentity, approverStoreOptions: storeOptions });
    } finally {
      remove();
    }
    cleanups.push(() => a.stop());
    assert.match(a.phoneApprover.unavailableReason(), /not paired with its relay/);
    assert.equal(a.phoneApprover.ttlMs, 120000);
    assert.ok(warnings.some((w) => /not paired with its relay/.test(w)));
  });

  it('paired: links to the relay, answers audit and device calls, and accepts a phone response', async () => {
    const phone = createFakePhone();
    const l = layout([phone.approverRecord()]);
    const relay = await fakeRelay();
    l.ports.store.set('approvals.relay', {
      relay_id: relayIdentity.nodeId, peerId: relayIdentity.peerId, publicKey: relayIdentity.publicKey.toString('hex'),
      tlsFingerprint: null, address: '127.0.0.1', port: relay.transport.port, pairedAt: new Date().toISOString()
    });
    const a = await startApprovals({
      dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig({ relay: `wss://127.0.0.1:${relay.transport.port}`, requestTtlS: 300 }),
      ports: l.ports, identity: nodeIdentity, useTls: false, approverStoreOptions: storeOptions, reconnectDelays: [50]
    });
    cleanups.push(() => a.stop());
    await relay.connected;
    for (let i = 0; i < 100 && !a.relayClient.isConnected(); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(a.phoneApprover.isAvailable(), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(l.dataDir, 'approvals', 'link.json'), 'utf8')).connected, true);

    const head = await relay.rpc.call(nodeIdentity.peerId, 'audit.head', {});
    assert.equal(verifyEd25519(head.envelope, nodeIdentity.publicKey.toString('hex')), true);

    const newcomer = createFakePhone();
    const staged = await relay.rpc.call(nodeIdentity.peerId, 'device.enroll', { envelope: phone.enroll({ device: newcomer.device() }) });
    assert.deepEqual(staged, { state: 'staged' });
    await new Promise((r) => setImmediate(r));
    assert.ok(a.auditLedger.tail(5).some((e) => e.kind === 'device.staged' && e.data.device_id === newcomer.deviceId));

    const submitted = [];
    relay.rpc.handle('approval.submit', (params) => { submitted.push(params.envelope); return { ok: true }; });
    const pending = a.phoneApprover.requestApproval('Bash', { command: 'uptime' }, {});
    for (let i = 0; i < 100 && submitted.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    const answer = await relay.rpc.call(nodeIdentity.peerId, 'approval.response', { envelope: phone.respond(submitted[0], 'approve') });
    assert.deepEqual(answer, { delivered: true, accepted: true, reason: null });
    assert.equal(await pending, true);
    const slice = await relay.rpc.call(nodeIdentity.peerId, 'audit.slice', { limit: 10 });
    assert.ok(open(slice.envelope).message.entries.some((e) => e.kind === 'approval.response'));
  });

  // Fix round 1 (opus review, ruling I2): everything after the prune timer
  // is created runs in one try/catch that tears down exactly what `stop()`
  // would, then rethrows — a failed start must not leave a live relay link,
  // a live prune timer or a live device-state poll running. `relayClient.start()`
  // failing (a transport that never binds/dials) is the realistic failure
  // point inside that region; `ApproverStore.ready()` is designed to fail
  // closed rather than throw (an unreadable dir is an empty, untrusted set,
  // not an exception), so it has no organic way to exercise this path.
  it('a failing relayClient.start() tears everything down: the transport is stopped and no timer/listener is left running', async () => {
    const l = layout();
    l.ports.store.set('approvals.relay', {
      relay_id: 'kl-fake-relay', peerId: 'kl-fake-relay-peer', publicKey: relayIdentity.publicKey.toString('hex'),
      tlsFingerprint: null, address: '127.0.0.1', port: 1, pairedAt: new Date().toISOString()
    });
    let transportStopped = false;
    const failingTransportFactory = () => ({
      on() {},
      removeListener() {},
      addTrustedPeer() {},
      start: () => Promise.reject(new Error('bind failed')),
      stop: async () => { transportStopped = true; }
    });

    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const live = new Set();
    global.setInterval = (...args) => { const t = realSetInterval(...args); live.add(t); return t; };
    global.clearInterval = (t) => { live.delete(t); return realClearInterval(t); };
    try {
      await assert.rejects(
        startApprovals({
          dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig({ relay: 'wss://127.0.0.1:1', requestTtlS: 300 }),
          ports: l.ports, identity: nodeIdentity, approverStoreOptions: storeOptions, transportFactory: failingTransportFactory
        }),
        /bind failed/
      );
    } finally {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    }
    assert.equal(transportStopped, true);
    assert.equal(live.size, 0);
  });
});

describe('createRelayDispatcher: enroll.claim routing', () => {
  it('delivers only while the courierPump can still route it, and { delivered: false } once it cannot', async () => {
    let route = 'p-1-abcdef01';
    const delivered = [];
    const courierPump = {
      routeFor: (method) => (method === 'enroll.claim' ? route : null),
      deliver: (inbox, method, params) => { delivered.push([inbox, method, params]); return true; }
    };
    const dispatch = createRelayDispatcher({ phoneApprover: null, approverStore: null, auditLedger: null, courierPump });
    assert.deepEqual(await dispatch('enroll.claim', { code_id: 'x' }), { delivered: true, accepted: null, reason: null });
    assert.deepEqual(delivered, [['p-1-abcdef01', 'enroll.claim', { code_id: 'x' }]]);
    route = null; // expired or closed, per CourierPump.routeFor
    assert.deepEqual(await dispatch('enroll.claim', { code_id: 'x' }), { delivered: false });
  });
});

// Fix round 1 (opus review, minors): the audited type/device_id come from
// the envelope itself, never the rpc method name; a duplicate is never
// audited; device.rejected auditing is rate-capped.
describe('createRelayDispatcher: device.enroll and device.revoke auditing', () => {
  function fakeAuditLedger() {
    const entries = [];
    return { entries, append: async (entry) => { entries.push(entry); return { ...entry, seq: entries.length }; } };
  }

  it('audits a rejected device.enroll as device.rejected, typed from the envelope', async () => {
    const phone = createFakePhone();
    const auditLedger = fakeAuditLedger();
    const approverStore = { stage: () => ({ state: 'rejected', reason: 'bad_signature' }) };
    const dispatch = createRelayDispatcher({ phoneApprover: null, approverStore, auditLedger, courierPump: null });
    const envelope = phone.enroll({ device: createFakePhone().device() });
    const result = await dispatch('device.enroll', { envelope });
    assert.deepEqual(result, { state: 'rejected', reason: 'bad_signature' });
    assert.equal(auditLedger.entries.length, 1);
    assert.equal(auditLedger.entries[0].kind, 'device.rejected');
    assert.equal(auditLedger.entries[0].data.type, 'kl.device.enroll');
  });

  it('audits a staged device.revoke as device.staged, typed from the envelope (not the rpc method)', async () => {
    const phone = createFakePhone();
    const target = createFakePhone();
    const auditLedger = fakeAuditLedger();
    const approverStore = { stage: () => ({ state: 'revoked-pending-apply' }) };
    const dispatch = createRelayDispatcher({ phoneApprover: null, approverStore, auditLedger, courierPump: null });
    const envelope = phone.revoke(target.deviceId);
    const result = await dispatch('device.revoke', { envelope });
    assert.deepEqual(result, { state: 'revoked-pending-apply' });
    assert.equal(auditLedger.entries.length, 1);
    assert.equal(auditLedger.entries[0].kind, 'device.staged');
    assert.equal(auditLedger.entries[0].data.type, 'kl.device.revoke');
    assert.equal(auditLedger.entries[0].data.device_id, target.deviceId);
  });

  it('never audits a duplicate', async () => {
    const auditLedger = fakeAuditLedger();
    const approverStore = { stage: () => ({ state: 'duplicate' }) };
    const dispatch = createRelayDispatcher({ phoneApprover: null, approverStore, auditLedger, courierPump: null });
    const result = await dispatch('device.enroll', { envelope: {} });
    assert.deepEqual(result, { state: 'duplicate' });
    assert.deepEqual(auditLedger.entries, []);
  });

  it('audits the envelope type as null when the envelope is malformed, not the rpc method', async () => {
    const auditLedger = fakeAuditLedger();
    const approverStore = { stage: () => ({ state: 'rejected', reason: 'malformed' }) };
    const dispatch = createRelayDispatcher({ phoneApprover: null, approverStore, auditLedger, courierPump: null });
    await dispatch('device.enroll', { envelope: { not: 'an envelope' } });
    assert.equal(auditLedger.entries[0].data.type, null);
    assert.equal(auditLedger.entries[0].data.device_id, null);
  });

  it('caps device.rejected auditing at 20 per rolling minute and logs a summary line, without throwing or dropping the result', async () => {
    const auditLedger = fakeAuditLedger();
    const approverStore = { stage: () => ({ state: 'rejected', reason: 'bad_signature' }) };
    const dispatch = createRelayDispatcher({ phoneApprover: null, approverStore, auditLedger, courierPump: null });
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await dispatch('device.enroll', { envelope: {} });
        assert.deepEqual(result, { state: 'rejected', reason: 'bad_signature' });
      }
    } finally {
      remove();
    }
    assert.equal(auditLedger.entries.length, 20);
    assert.equal(warnings.filter((w) => /device\.rejected audit entries are being rate-limited/.test(w)).length, 1);
  });
});

describe('startMcpApprovals', () => {
  it('uses the courier: refused at once while the service is stopped, and audits as mcp', async () => {
    const phone = createFakePhone();
    const l = layout([phone.approverRecord()]);
    const m = await startMcpApprovals({ dataDir: l.dataDir, configDir: l.configDir, nodeConfig: nodeConfig(), ports: l.ports, identity: nodeIdentity, approverStoreOptions: storeOptions });
    cleanups.push(() => m.stop());
    assert.equal(m.approver.unavailableReason(), 'the King Louie service is not running on this node');
    assert.equal((await m.auditLedger.append({ kind: 'request.inbound', data: {} })).writer, 'mcp');
    fs.writeFileSync(path.join(l.dataDir, 'service.pid'), String(process.pid));
    fs.mkdirSync(path.join(l.dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(l.dataDir, 'approvals', 'link.json'), JSON.stringify({ connected: true }));
    assert.equal(m.approver.isAvailable(), true);
  });
});

describe('createRelayDispatcher', () => {
  it('routes a response for an out-of-process producer to its courier inbox', async () => {
    const delivered = [];
    const courierPump = { routeFor: (method) => (method === 'approval.response' ? 'p-1-abcdef01' : null), deliver: (inbox, method) => { delivered.push([inbox, method]); return true; } };
    const phoneApprover = { handleResponse: async () => { throw new Error('must not be called'); } };
    const dispatch = createRelayDispatcher({ phoneApprover, approverStore: null, auditLedger: null, courierPump });
    assert.deepEqual(await dispatch('approval.response', { envelope: {} }), { delivered: true, accepted: null, reason: null });
    assert.deepEqual(delivered, [['p-1-abcdef01', 'approval.response']]);
    await assert.rejects(dispatch('nothing.here', {}), (err) => err.code === 'unknown_method');
    assert.deepEqual(await dispatch('enroll.claim', { code_id: 'x' }), { delivered: false });
  });
});

describe('trackDeviceStates', () => {
  it('tells the relay when an admin applies or revokes a device', async () => {
    const a = createFakePhone();
    const b = createFakePhone();
    const store = await approverStoreWith([a.approverRecord()]);
    cleanups.push(() => store.cleanup());
    const relayClient = Object.assign(new EventEmitter(), { notes: [], notify(method, params) { this.notes.push([method, params]); } });
    const stop = trackDeviceStates({ approverStore: store, relayClient, intervalMs: 20 });
    cleanups.push(stop);
    relayClient.emit('connected');
    fs.writeFileSync(path.join(store.dir, `${b.deviceId}.json`), JSON.stringify(b.approverRecord()));
    fs.writeFileSync(path.join(store.dir, `${a.deviceId}.json`), JSON.stringify(a.approverRecord({ revokedAt: '2026-09-23T18:00:00.000Z', revokedBy: 'console' })));
    for (let i = 0; i < 100 && relayClient.notes.length < 3; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(relayClient.notes, [
      ['device.state', { device_id: a.deviceId, state: 'active' }],
      ['device.state', { device_id: b.deviceId, state: 'active' }],
      ['device.state', { device_id: a.deviceId, state: 'revoked' }]
    ]);
  });
});

describe('relay and audit configuration', () => {
  const file = 'service.json';
  const minimal = { tls: { cert_file: '/etc/king-louie/relay.crt', key_file: '/etc/king-louie/relay.key' }, mesh_listen: { host: '10.0.0.5' }, public_url: 'https://kl.example.com:8443' };

  it('normalizes the relay block with its defaults', () => {
    assert.deepEqual(parseRelayConfig(minimal, file), {
      phoneListen: { host: '0.0.0.0', port: 8443 },
      tls: { certFile: '/etc/king-louie/relay.crt', keyFile: '/etc/king-louie/relay.key' },
      meshListen: { host: '10.0.0.5', port: 18795 },
      publicUrl: 'https://kl.example.com:8443',
      push: {}
    });
    const withPush = parseRelayConfig({ ...minimal, push: { apns: { team_id: 'T', key_id: 'K', key_file: '/k.p8', topic: 'com.example.kinglouie' }, fcm: { service_account_file: '/sa.json' } } }, file);
    assert.deepEqual(withPush.push, { apns: { teamId: 'T', keyId: 'K', keyFile: '/k.p8', topic: 'com.example.kinglouie', environment: 'production' }, fcm: { serviceAccountFile: '/sa.json' } });
    assert.equal(parseRelayConfig(undefined, file), null);
  });

  it('rejects unknown keys (naming the path), a missing tls block and a non-https public_url', () => {
    assert.throws(() => parseRelayConfig({ ...minimal, extra: 1 }, file), /relay\.extra is not a known key/);
    assert.throws(() => parseRelayConfig({ ...minimal, mesh_listen: { host: '10.0.0.5', bind: 1 } }, file), /relay\.mesh_listen\.bind/);
    assert.throws(() => parseRelayConfig({ ...minimal, tls: undefined }, file), /relay\.tls/);
    assert.throws(() => parseRelayConfig({ ...minimal, public_url: 'http://kl.example.com' }, file), /https/);
    assert.throws(() => parseRelayConfig({ ...minimal, push: { apns: { team_id: 'T', key_id: 'K', key_file: 'f', topic: 't', environment: 'dev' } } }, file), /environment/);
  });

  it('audit.retention_days defaults to 365, must be at least 30 and at most 3650', () => {
    assert.deepEqual(parseAuditConfig(undefined, file), { retentionDays: 365 });
    assert.deepEqual(parseAuditConfig({ retention_days: 30 }, file), { retentionDays: 30 });
    assert.deepEqual(parseAuditConfig({ retention_days: 3650 }, file), { retentionDays: 3650 });
    assert.throws(() => parseAuditConfig({ retention_days: 29 }, file), /at least 30/);
    assert.throws(() => parseAuditConfig({ retention_days: 3651 }, file), /at least 30/);
  });

  it('rejects a public_url that is not a valid URL at all', () => {
    // new URL() itself refuses an empty or missing host for a special scheme
    // like https, so relay.public_url's own host check is a defensive
    // backstop rather than independently reachable — this only pins the
    // "not parseable at all" branch.
    assert.throws(() => parseRelayConfig({ ...minimal, public_url: 'https://' }, file), /public_url must be a valid URL/);
    assert.throws(() => parseRelayConfig({ ...minimal, public_url: 'not a url' }, file), /public_url must be a valid URL/);
  });

  it('reads relay only from the admin config, never from the data dir, and logs why', () => {
    const l = layout();
    fs.writeFileSync(path.join(l.dataDir, 'service.json'), JSON.stringify({ relay: minimal }));
    fs.writeFileSync(path.join(l.configDir, 'service.json'), JSON.stringify({ relay: { ...minimal, mesh_listen: { host: '127.0.0.1' } } }), { mode: 0o644 });
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    let cfg;
    try {
      cfg = loadServiceConfig(l.dataDir, {}, { adminConfigDir: l.configDir, geteuid: () => UID, adminUid: UID });
    } finally {
      remove();
    }
    assert.equal(cfg.relay.meshListen.host, '127.0.0.1');
    assert.ok(warnings.some((w) => /ignoring "relay"/.test(w)));
  });

  it('a relay set only in the data-dir service.json (no admin file at all) is ignored entirely', () => {
    const l = layout();
    fs.writeFileSync(path.join(l.dataDir, 'service.json'), JSON.stringify({ relay: minimal }));
    const cfg = loadServiceConfig(l.dataDir, {}, { adminConfigDir: l.configDir, geteuid: () => UID, adminUid: UID });
    assert.equal(cfg.relay, null);
  });

  it('node.yaml approvers: relay URL and request TTL, validated', () => {
    const l = layout();
    const write = (text) => fs.writeFileSync(path.join(l.configDir, 'node.yaml'), text, { mode: 0o644 });
    const load = () => loadNodeConfig({ adminConfigDir: l.configDir, geteuid: () => UID, adminUid: UID });
    write('name: web-01\napprovers:\n  relay: wss://10.0.0.5:18795\n  request_ttl_s: 120\n');
    assert.deepEqual(load().approvers, { relay: 'wss://10.0.0.5:18795', requestTtlS: 120 });
    write('name: web-01\n');
    assert.deepEqual(load().approvers, { relay: null, requestTtlS: 300 });
    write('approvers:\n  relay: https://kl.example.com\n');
    assert.throws(load, /approvers\.relay must be wss:\/\/host:port/);
    write('approvers:\n  relay: "wss://user:pass@10.0.0.5:18795"\n');
    assert.throws(load, /approvers\.relay must be wss:\/\/host:port/);
    write('approvers:\n  relay: wss://10.0.0.5\n'); // no explicit port
    assert.throws(load, /approvers\.relay must be wss:\/\/host:port/);
    write('approvers:\n  relay: "wss://10.0.0.5:99999"\n');
    assert.throws(load, /approvers\.relay must be wss:\/\/host:port/);
    write('approvers:\n  relay: "wss://[::1]:18795"\n');
    assert.deepEqual(load().approvers, { relay: 'wss://[::1]:18795', requestTtlS: 300 });
    write('approvers:\n  request_ttl_s: 600\n');
    assert.throws(load, /from 30 to 300/);
    write('approvers:\n  phone: yes\n');
    assert.throws(load, /approvers\.phone is not a known key/);
  });
});

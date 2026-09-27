// tests/fleet-node-link.test.js — fleet stage 4 §3.9, §3.14 (node side).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { NodeIdentity } = require('../src/mesh/node-identity');
const { MeshTransport } = require('../src/mesh/mesh-transport');
const { RelayClient } = require('../src/approvals/relay-client');
const { startApprovals } = require('../src/approvals/service-wiring');
const { readPin, writePin, relayPinFromFrontDoor, validatePin } = require('../src/fleet/front-door-pin');
const { frontDoorDelay, FRONT_DOOR_BACKOFF } = require('../src/fleet/backoff');
const { nodeFrontDoorChecks, probeMeshCertificate } = require('../src/fleet/doctor-checks');
const { rawEd25519 } = require('../src/frontdoor/protocol/messages');
const { addSink } = require('../src/logging');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

let fd;
let node;
before(() => {
  fd = new NodeIdentity({ nodeName: 'frontdoor' });
  node = new NodeIdentity({ nodeName: 'web-01' });
});

function configDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fd-pin-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'config');
  fs.mkdirSync(dir, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(dir, 0o755); }
  return { base, dir };
}

const pinFor = (identity = fd, extra = {}) => ({
  v: 1, frontdoor_id: identity.nodeId, frontdoor_public_key: rawEd25519(identity.publicKey), domain: 'kl.example.com',
  mesh_url: 'wss://mesh.kl.example.com/mesh/v1', mesh_cert_fingerprint: identity.tlsFingerprint, paired_at: '2026-09-23T18:00:00.000Z', ...extra
});

describe('front-door.json', () => {
  it('round-trips, derives the relay pin, and is readable by the service account', () => {
    const { dir } = configDir();
    writePin(dir, pinFor());
    const pin = readPin(dir, { geteuid: () => UID, adminUid: UID });
    assert.deepEqual(pin, pinFor());
    if (POSIX) assert.equal(fs.statSync(path.join(dir, 'front-door.json')).mode & 0o777, 0o644);
    const relay = relayPinFromFrontDoor(pin);
    assert.equal(relay.relay_id, fd.nodeId);
    assert.equal(relay.peerId, fd.peerId);
    assert.equal(relay.publicKey, fd.publicKey.toString('hex'));
    assert.equal(relay.tlsFingerprint, fd.tlsFingerprint);
    assert.equal(readPin(configDir().dir, { geteuid: () => UID, adminUid: UID }), null);
  });

  it('refuses a key that does not derive the id, a foreign mesh host, extra keys', () => {
    assert.throws(() => validatePin(pinFor(fd, { frontdoor_id: node.nodeId })), /does not derive/);
    assert.throws(() => validatePin(pinFor(fd, { mesh_url: 'wss://evil.example.com/mesh/v1' })), /mesh_url/);
    assert.throws(() => validatePin({ ...pinFor(), extra: 1 }), /keys/);
  });

  it('refuses a pin file the service account could have written', { skip: !POSIX && 'POSIX modes' }, () => {
    const { dir } = configDir();
    writePin(dir, pinFor());
    fs.chmodSync(path.join(dir, 'front-door.json'), 0o666);
    assert.throws(() => readPin(dir, { geteuid: () => UID, adminUid: UID }), /group- or world-writable/);
  });

  it('refuses a dangling front-door.json link instead of reading it as absent', { skip: !POSIX && 'POSIX symlinks' }, () => {
    const { dir } = configDir();
    fs.symlinkSync(path.join(dir, 'missing.json'), path.join(dir, 'front-door.json'));
    assert.throws(() => readPin(dir, { geteuid: () => UID, adminUid: UID }), /symlink/);
  });
});

describe('backoff', () => {
  it('min(60 s, 1 s × 2^n) × uniform(0.5, 1.0), with floors', () => {
    assert.equal(frontDoorDelay(0, { random: () => 0 }), 500);
    assert.equal(frontDoorDelay(0, { random: () => 1 }), 1000);
    assert.equal(frontDoorDelay(3, { random: () => 1 }), 8000);
    assert.equal(frontDoorDelay(20, { random: () => 1 }), 60000);
    assert.equal(frontDoorDelay(20, { random: () => 0 }), 30000);
    assert.equal(frontDoorDelay(0, { random: () => 0, minMs: FRONT_DOOR_BACKOFF.keyMismatchMinMs }), 60000);
    assert.equal(frontDoorDelay(0, { random: () => 0, minMs: FRONT_DOOR_BACKOFF.alreadyConnectedMinMs }), 5000);
  });
});

function pinnedTransportFactory(calls, { reject = null } = {}) {
  return (options) => {
    const t = new MeshTransport(options);
    t.connectPinned = (args) => { calls.push(args); return reject ? Promise.reject(reject()) : new Promise(() => {}); };
    return t;
  };
}

describe('RelayClient with a front-door pin', () => {
  it('dials connectPinned with the pin\'s URL, fingerprint and front door id', async () => {
    const calls = [];
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, transportFactory: pinnedTransportFactory(calls) });
    cleanups.push(() => c.stop());
    await c.start();
    assert.deepEqual(calls, [{ url: 'wss://mesh.kl.example.com/mesh/v1', pinnedFingerprint: fd.tlsFingerprint, frontdoorId: fd.nodeId }]);
    assert.equal(c.relayPeerId, fd.peerId);
  });

  it('a foreign certificate: frontdoor_key_mismatch, 60 s floor, one error log an hour', async () => {
    const errors = [];
    const remove = addSink((r) => { if (r.level === 'error' && /frontdoor_key_mismatch/.test(r.message)) errors.push(r.message); });
    let now = Date.parse('2026-09-23T18:00:00.000Z');
    const calls = [];
    const mismatch = () => Object.assign(new Error('frontdoor_key_mismatch: served x'), { code: 'frontdoor_key_mismatch' });
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, now: () => now, random: () => 0, transportFactory: pinnedTransportFactory(calls, { reject: mismatch }) });
    cleanups.push(() => c.stop());
    try {
      await c.start();
      await new Promise((r) => setImmediate(r));
      assert.ok(c.lastDelayMs >= 60000);
      for (let i = 0; i < 3; i += 1) {
        now += 60000;
        c._dial();
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(errors.length, 1);
      now += 3600000;
      c._dial();
      await new Promise((r) => setImmediate(r));
      assert.equal(errors.length, 2);
    } finally {
      remove();
    }
  });

  it('a 4009 close from the transport waits at least 5 s', async () => {
    const calls = [];
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, random: () => 0,
      transportFactory: pinnedTransportFactory(calls, { reject: () => new Error('unreachable') }) });
    cleanups.push(() => c.stop());
    await c.start();
    await new Promise((r) => setImmediate(r));
    assert.equal(c.dialing, false);
    c.dialAttempt = 0;
    c.transport.emit('peerDisconnected', { peerId: fd.peerId, code: 4009 });
    assert.equal(c.lastDelayMs, 5000);
  });

  it('every 4009 from a front door holding another link waits at least 5 s, even with a hello in flight', async () => {
    // A real front-door transport with the duplicate rule, and a live link
    // for this node's key that answers pings: each dial authenticates, sends
    // relay.hello, and is then closed with 4009 (never before auth).
    const hub = new MeshTransport({ identity: fd, host: '127.0.0.1', port: 0, useTls: false, duplicatePingMs: 200 });
    await hub.start();
    cleanups.push(() => hub.stop());
    hub.addTrustedPeer(node.peerId, node.publicKey);
    const incumbent = new MeshTransport({ identity: node, listen: false, useTls: false });
    await incumbent.start();
    cleanups.push(() => incumbent.stop());
    incumbent.addTrustedPeer(fd.peerId, fd.publicKey);
    await incumbent.connectToPeer('127.0.0.1', hub.port);
    for (let i = 0; i < 300 && !hub.getPeer(node.peerId); i += 1) await new Promise((r) => setTimeout(r, 10));
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, random: () => 0,
      transportFactory: (options) => {
        const t = new MeshTransport(options);
        t.connectPinned = () => t.connectToPeer('127.0.0.1', hub.port);
        return t;
      } });
    cleanups.push(() => c.stop());
    const delays = [];
    for (let round = 0; round < 3; round += 1) {
      c.lastDelayMs = null;
      if (round === 0) await c.start();
      else c._dial();
      for (let i = 0; i < 300 && c.lastDelayMs === null; i += 1) await new Promise((r) => setTimeout(r, 10));
      clearTimeout(c.retryTimer);
      await new Promise((r) => setImmediate(r)); // the in-flight hello settles
      delays.push(c.lastDelayMs);
    }
    assert.deepEqual(delays, [5000, 5000, 5000]);
    assert.ok(hub.getPeer(node.peerId) && incumbent.getPeer(fd.peerId), 'the incumbent link stays');
  });

  it('a relay_id mismatch on the front-door link waits at least 60 s', () => {
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, random: () => 0 });
    c._handleLinkDown('mismatch');
    assert.ok(c.lastDelayMs >= 60000, String(c.lastDelayMs));
    clearTimeout(c.retryTimer);
  });

  it('4009 waits at least 5 s; five minutes connected resets the backoff', () => {
    let now = 0;
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, now: () => now, random: () => 1 });
    c.stopped = false;
    c.dialAttempt = 0;
    c._handleLinkDown('already_connected');
    assert.equal(c.lastDelayMs, 5000);
    c.dialAttempt = 6;
    c.connectedAt = now;
    now += 300001;
    c._onDisconnected(null);
    assert.equal(c.lastDelayMs, 1000);
    clearTimeout(c.retryTimer);
  });

  it('a link that drops within five minutes of hello keeps backing off (n is not reset by hello)', async () => {
    let now = 0;
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, now: () => now, random: () => 1 });
    c.rpc = { call: async () => ({ relay_id: fd.nodeId }) };
    c.dialAttempt = 3;
    await c._onConnected();
    assert.equal(c.isConnected(), true);
    assert.equal(c.dialAttempt, 3);
    now += 1000;
    c._onDisconnected(null);
    assert.equal(c.lastDelayMs, 8000);
    assert.equal(c.dialAttempt, 4);
    clearTimeout(c.retryTimer);
  });

  it('fails closed: a pin that does not validate never reaches a dial', () => {
    const bad = [
      pinFor(fd, { mesh_cert_fingerprint: 'not-a-fingerprint' }),
      pinFor(fd, { mesh_url: 'ws://mesh.kl.example.com/mesh/v1' }),
      pinFor(fd, { mesh_url: 'wss://:secret@mesh.kl.example.com/mesh/v1' }),
      pinFor(fd, { frontdoor_id: node.nodeId }),
      { ...pinFor(), extra: 1 }
    ];
    for (const pin of bad) {
      const calls = [];
      assert.throws(() => new RelayClient({ identity: node, frontDoorPin: pin, useTls: false, transportFactory: pinnedTransportFactory(calls) }), /front-door\.json/);
      assert.deepEqual(calls, []);
    }
  });

  it('passes dnsLookup to connectPinned as lookup', async () => {
    const calls = [];
    const dnsLookup = () => {};
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false, dnsLookup, transportFactory: pinnedTransportFactory(calls) });
    cleanups.push(() => c.stop());
    await c.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].lookup, dnsLookup);
  });

  it('never lets mesh.task.* or mesh.channel.* ride the link', () => {
    const c = new RelayClient({ identity: node, frontDoorPin: pinFor(), useTls: false });
    assert.throws(() => c.registerMethod('mesh.task.dispatch', () => null), /method_reserved/);
    assert.throws(() => c.registerMethod('mesh.channel.send', () => null), /method_reserved/);
  });
});

describe('startApprovals with a front door', () => {
  function layout() {
    const { base, dir } = configDir();
    fs.mkdirSync(path.join(dir, 'approvers'), { mode: 0o755 });
    if (POSIX) fs.chmodSync(path.join(dir, 'approvers'), 0o755);
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data' });
    return { dataDir, configDir: dir, ports: { store, cipher: createAesGcmCipher(crypto.randomBytes(32)) } };
  }
  const storeOptions = { geteuid: () => UID, adminUid: UID, platform: 'linux' };

  it('front-door.json supersedes approvers.relay and the store pin', async () => {
    const l = layout();
    writePin(l.configDir, pinFor());
    l.ports.store.set('approvals.relay', { relay_id: 'kl-c2ubd6jjqumalzt5', peerId: 'kl-000000000000', publicKey: node.publicKey.toString('hex'), address: '127.0.0.1', port: 1 });
    const infos = [];
    const remove = addSink((r) => { if (r.level === 'info' && /superseded/.test(r.message)) infos.push(r.message); });
    const calls = [];
    let a;
    try {
      a = await startApprovals({
        dataDir: l.dataDir, configDir: l.configDir, nodeConfig: { name: 'web-01', approvers: { relay: 'wss://10.0.0.5:18795', requestTtlS: 300 }, policy: {} },
        ports: l.ports, identity: node, approverStoreOptions: storeOptions, useTls: false, transportFactory: pinnedTransportFactory(calls)
      });
    } finally {
      remove();
    }
    cleanups.push(() => a.stop());
    assert.equal(a.relayClient.pin.relay_id, fd.nodeId);
    assert.equal(calls[0].frontdoorId, fd.nodeId);
    assert.equal(infos.length, 1);
  });

  it('an invalid front-door.json is logged and the relay pin is used as before', async () => {
    const l = layout();
    fs.writeFileSync(path.join(l.configDir, 'front-door.json'), '{ not json', { mode: 0o644 });
    if (POSIX) fs.chmodSync(path.join(l.configDir, 'front-door.json'), 0o644);
    const relay = new NodeIdentity({ nodeName: 'relay' });
    const storePin = { relay_id: relay.nodeId, peerId: relay.peerId, publicKey: relay.publicKey.toString('hex'), tlsFingerprint: relay.tlsFingerprint, address: '127.0.0.1', port: 1 };
    l.ports.store.set('approvals.relay', storePin);
    const errors = [];
    const remove = addSink((r) => { if (r.level === 'error' && /front-door\.json/.test(r.message)) errors.push(r.message); });
    const calls = [];
    let a;
    try {
      a = await startApprovals({
        dataDir: l.dataDir, configDir: l.configDir, nodeConfig: { name: 'web-01', approvers: { relay: 'wss://10.0.0.5:18795', requestTtlS: 300 }, policy: {} },
        ports: l.ports, identity: node, approverStoreOptions: storeOptions, useTls: false, transportFactory: pinnedTransportFactory(calls)
      });
    } finally {
      remove();
    }
    cleanups.push(() => a.stop());
    assert.equal(errors.length, 1);
    assert.equal(a.relayClient.frontDoorPin, null);
    assert.deepEqual(a.relayClient.pin, storePin);
    assert.deepEqual(calls, []);
  });

  it('an invalid front-door.json and no relay: no link', async () => {
    const l = layout();
    fs.writeFileSync(path.join(l.configDir, 'front-door.json'), '{ not json', { mode: 0o644 });
    if (POSIX) fs.chmodSync(path.join(l.configDir, 'front-door.json'), 0o644);
    const a = await startApprovals({ dataDir: l.dataDir, configDir: l.configDir, nodeConfig: { name: 'web-01', approvers: { relay: null, requestTtlS: 300 }, policy: {} }, ports: l.ports, identity: node, approverStoreOptions: storeOptions });
    cleanups.push(() => a.stop());
    assert.equal(a.relayClient, null);
  });
});

describe('doctor on a node with front-door.json', () => {
  it('checks ownership, the superseded approvers.relay, and the served mesh certificate', async () => {
    const { dir } = configDir();
    writePin(dir, pinFor());
    const good = await nodeFrontDoorChecks({ configDir: dir, adminUid: UID, geteuid: () => UID, nodeConfig: { approvers: { relay: 'wss://10.0.0.5:18795' } }, probe: async () => fd.tlsFingerprint });
    assert.deepEqual(good.map((r) => [r.check, r.ok, Boolean(r.warn)]), [
      ['front-door.json is admin-owned and valid', true, false],
      ['approvers.relay', true, true],
      ['front door mesh certificate matches the pin', true, false]
    ]);
    const bad = await nodeFrontDoorChecks({ configDir: dir, adminUid: UID, geteuid: () => UID, nodeConfig: { approvers: { relay: null } }, probe: async () => 'f'.repeat(64) });
    assert.equal(bad.at(-1).ok, false);
    assert.match(bad.at(-1).detail, new RegExp(`pinned ${fd.tlsFingerprint}, served f{64}`));
    assert.deepEqual(await nodeFrontDoorChecks({ configDir: configDir().dir, adminUid: UID, geteuid: () => UID, probe: async () => null }), []);
  });
});

describe('doctor with a dangling front-door.json link', () => {
  it('reports it as a FAIL row', { skip: !POSIX && 'POSIX symlinks' }, async () => {
    const { runDoctor } = require('../src/service/doctor');
    const { base, dir } = configDir();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    fs.symlinkSync(path.join(dir, 'missing.json'), path.join(dir, 'front-door.json'));
    const rows = await runDoctor({ dataDir, platform: 'linux', adminUid: UID, configDir: dir });
    const row = rows.find((r) => r.check === 'front-door.json is admin-owned and valid');
    assert.ok(row, 'the front-door row is present');
    assert.equal(row.ok, false);
    assert.match(row.detail, /symlink/);
  });

  // Final review M-4 (T14 carry): any lstat failure but ENOENT is a FAIL
  // row, never a stack trace that ends the doctor run.
  it('an unreadable front-door.json path is a FAIL row, not a crash', async () => {
    const { runDoctor } = require('../src/service/doctor');
    const { base, dir } = configDir();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const real = fs.lstatSync;
    fs.lstatSync = function lstatSync(p, ...rest) {
      if (path.basename(String(p)) === 'front-door.json') throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
      return real.call(this, p, ...rest);
    };
    let rows;
    try {
      rows = await runDoctor({ dataDir, platform: 'linux', adminUid: UID, configDir: dir });
    } finally {
      fs.lstatSync = real;
    }
    const row = rows.find((r) => r.check === 'front-door.json is admin-owned and valid');
    assert.ok(row, 'the front-door row is present');
    assert.equal(row.ok, false);
    assert.match(row.detail, /EACCES/);
  });
});

describe('probeMeshCertificate', () => {
  it('returns the served certificate fingerprint, dialling mesh.<domain> through lookup', async () => {
    const tls = require('tls');
    const server = tls.createServer({ cert: fd.tlsCert, key: fd.tlsKey }, (socket) => socket.on('error', () => {}));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const seen = [];
    const lookup = (hostname, options, callback) => {
      seen.push(hostname);
      if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    };
    const pin = pinFor(fd, { mesh_url: `wss://mesh.kl.example.com:${server.address().port}/mesh/v1` });
    assert.equal(await probeMeshCertificate(pin, { lookup, timeoutMs: 5000 }), fd.tlsFingerprint);
    assert.deepEqual(seen, ['mesh.kl.example.com']);
  });
});

// The seal policy (sealed phones, R-SP-5): who a node seals to, and the latch
// that keeps a node that has sealed from ever going back to clear by itself.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { createSealPolicy, readLatch, writeLatch, latchFile, latchWriteProblem } = require('../src/approvals/seal-policy');
const { createRelayDispatcher } = require('../src/approvals/service-wiring');
const { ApproverStore } = require('../src/approvals/approver-store');
const { runDevice, DEVICE_HELP } = require('../src/service/commands/devices');
const { startMcpApprovals } = require('../src/approvals/service-wiring');
const { buildServicePorts } = require('../src/service/ports');
const { getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
const { main } = require('../src/service/cli');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

async function setup(records = []) {
  const store = await approverStoreWith(records);
  cleanups.push(store.cleanup);
  const dataDir = path.join(store.baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const identity = testNodeIdentity({ box: true });
  const put = (record) => {
    fs.writeFileSync(path.join(store.dir, `${record.device_id}.json`), JSON.stringify(record), { mode: 0o644 });
    store.refresh();
  };
  return { store, dataDir, identity, put, policy: createSealPolicy({ approverStore: store, identity, dataDir }) };
}

const boxPhone = () => createFakePhone({ boxKey: true });
const revoked = (phone) => phone.approverRecord({ boxKey: true, revokedAt: '2026-09-23T19:00:00.000Z', revokedBy: 'console' });

describe('recipients', () => {
  it('holds exactly the active records with a box key, plus the node', async () => {
    const [a, b] = [boxPhone(), boxPhone()];
    const noBox = createFakePhone();
    const gone = boxPhone();
    const demo = boxPhone();
    const { policy, identity } = await setup([
      a.approverRecord({ boxKey: true }), b.approverRecord({ boxKey: true }), noBox.approverRecord(), revoked(gone),
      { ...demo.approverRecord({ boxKey: true }), platform: 'demo' }
    ]);
    assert.deepEqual(policy.recipients(), { [a.deviceId]: a.boxJwk, [b.deviceId]: b.boxJwk, [identity.nodeId]: identity.box.jwk });
    assert.equal(policy.senderId, identity.nodeId);
    assert.deepEqual(policy.nodeBox, identity.box.jwk);
  });

  it('leaves out a device on the revoke overlay, at once', async () => {
    const [a, b] = [boxPhone(), boxPhone()];
    const { policy, store, identity } = await setup([a.approverRecord({ boxKey: true }), b.approverRecord({ boxKey: true })]);
    assert.ok(policy.recipients()[b.deviceId]);
    store.addToOverlay(b.deviceId);
    assert.deepEqual(policy.recipients(), { [a.deviceId]: a.boxJwk, [identity.nodeId]: identity.box.jwk });
  });

  it('an untrusted store gives nothing, not even the node', async () => {
    const a = boxPhone();
    const { policy, store } = await setup([a.approverRecord({ boxKey: true })]);
    store.untrusted = true;
    store.refresh();
    assert.deepEqual(policy.recipients(), {});
  });
});

describe('sealing and the latch', () => {
  it('stays off and writes nothing while no record holds a box key', async () => {
    const { policy, dataDir } = await setup([createFakePhone().approverRecord()]);
    assert.equal(policy.sealing(), false);
    assert.equal(policy.canSeal(), false);
    assert.equal(fs.existsSync(latchFile(dataDir)), false);
    assert.equal(readLatch(dataDir).latched, false);
  });

  it('flips with the first such record, and the latch is on disk by then, whichever is asked first', async () => {
    for (const ask of ['sealing', 'canSeal', 'recipients']) {
      const { policy, dataDir, put } = await setup();
      assert.equal(policy.sealing(), false);
      put(boxPhone().approverRecord({ boxKey: true }));
      policy[ask]();
      const latch = JSON.parse(fs.readFileSync(latchFile(dataDir), 'utf8'));
      assert.equal(latch.v, 1);
      assert.equal(typeof latch.latched_at, 'string');
      assert.equal(policy.sealing(), true);
      assert.equal(policy.canSeal(), true);
    }
  });

  it('writes the latch once, and leaves no temp file', async () => {
    const { policy, dataDir, put } = await setup();
    put(boxPhone().approverRecord({ boxKey: true }));
    policy.sealing();
    const stat = fs.statSync(latchFile(dataDir));
    const bytes = fs.readFileSync(latchFile(dataDir));
    policy.sealing();
    policy.canSeal();
    assert.equal(fs.statSync(latchFile(dataDir)).mtimeMs, stat.mtimeMs);
    assert.deepEqual(fs.readFileSync(latchFile(dataDir)), bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(latchFile(dataDir))), ['sealing.json']);
  });

  it('stays true with canSeal false when the record is revoked, on the overlay or for good', async () => {
    const a = boxPhone();
    const { policy, store, put } = await setup([a.approverRecord({ boxKey: true })]);
    assert.equal(policy.canSeal(), true);
    store.addToOverlay(a.deviceId);
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false);
    store.overlay.clear();
    put(revoked(a));
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false);
  });

  it('stays true with canSeal false when the store turns untrusted, and comes back with it', async () => {
    const a = boxPhone();
    const { policy, store } = await setup([a.approverRecord({ boxKey: true })]);
    assert.equal(policy.canSeal(), true);
    store.untrusted = true;
    store.refresh();
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false);
    store.untrusted = false;
    store.refresh();
    assert.equal(policy.canSeal(), true);
  });

  it('a restart keeps it, with no device in the set', async () => {
    const a = boxPhone();
    const { policy, dataDir, identity, put } = await setup([a.approverRecord({ boxKey: true })]);
    assert.equal(policy.sealing(), true);
    put(revoked(a));
    const restartedStore = await approverStoreWith([]);
    cleanups.push(restartedStore.cleanup);
    const restarted = createSealPolicy({ approverStore: restartedStore, identity, dataDir });
    assert.equal(restarted.sealing(), true);
    assert.equal(restarted.canSeal(), false);
  });

  it('no file is the only state that is not latched', async () => {
    const { store, dataDir, identity } = await setup();
    const policy = createSealPolicy({ approverStore: store, identity, dataDir });
    const file = latchFile(dataDir);
    assert.deepEqual(readLatch(dataDir), { state: 'none', latched: false });
    assert.equal(policy.sealing(), false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const text of ['', '{', 'null', '[]', '{"v":2}', '{"v":1}', '"latched"']) {
      fs.writeFileSync(file, text);
      assert.deepEqual(readLatch(dataDir), { state: 'bad', latched: true }, text);
      assert.equal(policy.sealing(), true, text);
      assert.equal(policy.canSeal(), false, text);
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'with no device, a bad file is left as it is');
    }
    fs.rmSync(file);
    // A read that fails for any reason but "no such file": here, a directory in its place.
    fs.mkdirSync(file);
    assert.deepEqual(readLatch(dataDir), { state: 'bad', latched: true });
    assert.equal(policy.sealing(), true);
    fs.rmdirSync(file);
    // The approvals dir itself is a file: ENOTDIR, not ENOENT.
    fs.rmdirSync(path.dirname(file));
    fs.writeFileSync(path.dirname(file), 'x');
    assert.deepEqual(readLatch(dataDir), { state: 'bad', latched: true });
    assert.equal(policy.sealing(), true);
  });

  it('a link in the latch\'s place counts as latched and is not followed', { skip: !POSIX }, async () => {
    const { dataDir } = await setup();
    const file = latchFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(path.join(dataDir, 'nowhere'), file);
    assert.deepEqual(readLatch(dataDir), { state: 'bad', latched: true });
  });

  it('a bad file is replaced once there is a device to seal to, and a failed replace seals nothing', async () => {
    const a = boxPhone();
    const { store, dataDir, identity } = await setup([a.approverRecord({ boxKey: true })]);
    const file = latchFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(file);
    const policy = createSealPolicy({ approverStore: store, identity, dataDir });
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false, 'a directory cannot be renamed over');
    fs.rmdirSync(file);
    fs.writeFileSync(file, 'garbage');
    assert.equal(policy.canSeal(), true);
    assert.equal(readLatch(dataDir).state, 'good');
  });

  it('a latch that cannot be written: sealing true, canSeal false, then true once it can', async () => {
    const a = boxPhone();
    const { store, dataDir, identity, put } = await setup([a.approverRecord({ boxKey: true })]);
    let fail = true;
    const writes = [];
    const policy = createSealPolicy({
      approverStore: store,
      identity,
      dataDir,
      writeLatchFile: (...args) => {
        writes.push(args);
        if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return writeLatch(...args);
      }
    });
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false);
    assert.equal(fs.existsSync(latchFile(dataDir)), false);
    assert.deepEqual(policy.recipients(), {}, 'no device key is handed out before the latch is on disk');
    assert.ok(writes.length >= 2, 'tried again at each read');
    // The device goes while the write still fails: never clear.
    put(revoked(a));
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false);
    fail = false;
    assert.equal(policy.sealing(), true);
    assert.equal(readLatch(dataDir).state, 'good');
    const b = boxPhone();
    put(b.approverRecord({ boxKey: true }));
    assert.equal(policy.canSeal(), true);
    assert.deepEqual(policy.recipients(), { [b.deviceId]: b.boxJwk, [identity.nodeId]: identity.box.jwk });
  });

  it('a bad file with no device hands out nothing, not even the node', async () => {
    const { policy, dataDir } = await setup();
    fs.mkdirSync(path.dirname(latchFile(dataDir)), { recursive: true });
    fs.writeFileSync(latchFile(dataDir), 'garbage');
    assert.deepEqual(policy.recipients(), {});
  });

  it('syncs the directory after the rename, where a directory can be synced', { skip: !POSIX }, async (t) => {
    const { dataDir } = await setup();
    const sync = t.mock.method(fs, 'fsyncSync');
    writeLatch(dataDir);
    assert.equal(sync.mock.callCount(), 2, 'the file, then its directory');
  });

  it('reports each path it creates, so a root process can hand them back at once', async () => {
    const a = boxPhone();
    const { store, dataDir, identity } = await setup([a.approverRecord({ boxKey: true })]);
    const paths = [];
    const policy = createSealPolicy({ approverStore: store, identity, dataDir, onPathWritten: (p) => paths.push(p) });
    assert.equal(policy.canSeal(), true);
    assert.deepEqual(paths, [path.dirname(latchFile(dataDir)), latchFile(dataDir)]);
    paths.length = 0;
    policy.canSeal();
    assert.deepEqual(paths, [], 'written once');
  });

  it('latchWriteProblem says why the latch could not be written, and leaves nothing', async () => {
    const { dataDir } = await setup();
    assert.equal(latchWriteProblem(dataDir), null);
    assert.deepEqual(fs.readdirSync(dataDir), []);
    const denied = { ...fs, existsSync: () => true, openSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    assert.equal(latchWriteProblem(dataDir, denied), 'EACCES');
  });

  it('a node identity with no box cannot seal, and fails closed', async () => {
    const a = boxPhone();
    const { store, dataDir } = await setup([a.approverRecord({ boxKey: true })]);
    const policy = createSealPolicy({ approverStore: store, identity: testNodeIdentity(), dataDir });
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false);
    assert.equal(policy.nodeBox, null);
    assert.deepEqual(policy.recipients(), { [a.deviceId]: a.boxJwk });
  });

  it('the policy has no way to clear the latch', async () => {
    const { policy } = await setup();
    assert.deepEqual(Object.keys(policy).sort(), ['canSeal', 'nodeBox', 'recipients', 'sealing', 'senderId', 'whyNot']);
  });
});

describe('a process that is not the service', () => {
  function standalone() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-standalone-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const dataDir = path.join(base, 'data');
    const configDir = path.join(base, 'config');
    fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
    fs.mkdirSync(dataDir, { recursive: true });
    if (POSIX) for (const d of [base, configDir, path.join(configDir, 'approvers')]) fs.chmodSync(d, 0o755);
    return { dataDir, configDir };
  }
  const options = { geteuid: () => UID, adminUid: UID, platform: 'linux' };

  it('standalone mcp fills nothing, cannot seal without a box, and reports what it writes', async () => {
    const { dataDir, configDir } = standalone();
    const a = boxPhone();
    fs.writeFileSync(path.join(configDir, 'approvers', `${a.deviceId}.json`), JSON.stringify(a.approverRecord({ boxKey: true })), { mode: 0o644 });
    const ports = buildServicePorts({ dataDir });
    getOrGenerateNodeIdentity(ports.store, ports.cipher, 'web-01');
    const before = ports.store.get('mesh.identity');
    const paths = [];
    const approvals = await startMcpApprovals({ dataDir, configDir, nodeConfig: { name: 'web-01' }, ports, approverStoreOptions: options, onPathWritten: (p) => paths.push(p) });
    assert.equal(approvals.identity.box, null);
    assert.deepEqual(ports.store.get('mesh.identity'), before);
    assert.equal(approvals.sealPolicy.sealing(), true, 'never clear with a device holding a box key');
    assert.equal(approvals.sealPolicy.canSeal(), false);
    assert.ok(paths.includes(latchFile(dataDir)));
    approvals.stop();
  });

  it('runMcp gives what it writes back at once, not when it returns', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'commands', 'mcp.js'), 'utf8');
    assert.match(source, /onPathWritten: \(p\) => restoreDataDirOwnership\(dataDir, \[p\], io\.ownership\)/);
  });

  it('device revoke on a node with no box key adds none', async () => {
    const n = node();
    const ports = buildServicePorts({ dataDir: n.dataDir });
    getOrGenerateNodeIdentity(ports.store, ports.cipher, 'web-01');
    const a = createFakePhone();
    n.put(a.approverRecord());
    assert.equal(await runDevice({ sub: 'revoke', arg: a.deviceId, flags: {}, dataDir: n.dataDir, configDir: n.configDir, io: streamIo(), deps }), 0);
    const record = JSON.parse(fs.readFileSync(path.join(n.dataDir, 'chat-data.json'), 'utf8')).mesh.identity;
    assert.equal(Object.hasOwn(record, 'encryptedBoxKey'), false);
  });
});

describe('nothing from the relay touches the latch', () => {
  const METHODS = ['approval.response', 'enroll.claim', 'device.enroll', 'device.revoke', 'device.read_key', 'device.box_key', 'audit.slice', 'audit.head', 'lease.list', 'unseal', 'device.unseal', 'sealing.clear'];

  it('no method changes it, a revoke of the last device included', async () => {
    const [a, b] = [boxPhone(), boxPhone()];
    const { policy, store, dataDir } = await setup([a.approverRecord({ boxKey: true }), b.approverRecord({ boxKey: true })]);
    assert.equal(policy.sealing(), true);
    const bytes = fs.readFileSync(latchFile(dataDir));
    const auditLedger = { append: async () => {}, slice: () => null, head: () => null };
    const phoneApprover = { handleResponse: async () => ({ accepted: false }) };
    const dispatch = createRelayDispatcher({ phoneApprover, approverStore: store, auditLedger });
    const envelopes = [a.revoke(b.deviceId), b.revoke(a.deviceId), a.boxStatement(), a.enroll({ device: createFakePhone().device() }), { garbage: true }];
    for (const method of METHODS) {
      for (const envelope of envelopes) {
        await dispatch(method, { envelope }).catch(() => {});
      }
    }
    assert.equal(store.isActive(a.deviceId), false);
    assert.equal(store.isActive(b.deviceId), false);
    assert.deepEqual(fs.readFileSync(latchFile(dataDir)), bytes);
    assert.equal(policy.sealing(), true);
    assert.equal(policy.canSeal(), false);
  });

  it('only the console command and the policy name the file or the clearing', () => {
    const root = path.join(__dirname, '..', 'src');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(root);
    const relative = (f) => path.relative(root, f).split(path.sep).join('/');
    const naming = (pattern) => files.filter((f) => pattern.test(fs.readFileSync(f, 'utf8'))).map(relative).sort();
    assert.deepEqual(naming(/sealing\.json/), ['approvals/seal-policy.js']);
    assert.deepEqual(naming(/clearLatch/), ['approvals/seal-policy.js', 'service/commands/devices.js']);
  });
});

function streamIo() {
  const text = { out: '', err: '' };
  return {
    stdin: new PassThrough(),
    stdout: { write: (s) => { text.out += String(s); return true; } },
    stderr: { write: (s) => { text.err += String(s); return true; } },
    text
  };
}

function node() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-unseal-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(dataDir, { recursive: true });
  if (POSIX) for (const d of [base, configDir, path.join(configDir, 'approvers')]) fs.chmodSync(d, 0o755);
  fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: web-01\n', { mode: 0o644 });
  const put = (record) => fs.writeFileSync(path.join(configDir, 'approvers', `${record.device_id}.json`), JSON.stringify(record), { mode: 0o644 });
  const latch = () => {
    fs.mkdirSync(path.join(dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(latchFile(dataDir), JSON.stringify({ v: 1, latched_at: '2026-11-04T10:00:00.000Z' }));
  };
  return { dataDir, configDir, put, latch };
}

const deps = { storeOptions: { geteuid: () => UID, adminUid: UID, platform: 'linux' } };

// The ledger's entries, read as the mirror reads them: each line one entry.
const entries = (n) => {
  const dir = path.join(n.dataDir, 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const unseal = (n, io, { flags = { yes: true }, extra = {} } = {}) => runDevice({ sub: 'unseal', flags, dataDir: n.dataDir, configDir: n.configDir, io, deps: { ...deps, ...extra } });

// Ref'd: the wait for a prompt is what keeps this test's loop alive.
const asked = (io) => new Promise((resolve) => {
  const t = setInterval(() => {
    if (io.text.out.includes('[y/N]')) {
      clearInterval(t);
      resolve();
    }
  }, 5);
});

describe('device unseal', () => {
  it('clears the latch when no record holds a box key, and audits it', async () => {
    const n = node();
    n.latch();
    n.put(revoked(boxPhone()));
    n.put(createFakePhone().approverRecord());
    const io = streamIo();
    assert.equal(await unseal(n, io), 0);
    assert.equal(readLatch(n.dataDir).latched, false);
    assert.match(io.text.out, /in clear/);
    const [entry] = entries(n).filter((e) => e.kind === 'device.unsealed');
    assert.ok(entry, 'audited device.unsealed');
    assert.equal(entry.data.by, 'console');
  });

  it('refuses while an active record holds a box key, and changes nothing', async () => {
    const n = node();
    n.latch();
    const a = boxPhone();
    n.put(a.approverRecord({ boxKey: true }));
    const io = streamIo();
    assert.equal(await unseal(n, io), 1);
    assert.match(io.text.err, new RegExp(a.deviceId));
    assert.equal(readLatch(n.dataDir).state, 'good');
    assert.deepEqual(entries(n), []);
  });

  it('refuses while a holder\'s revoke only waits for device apply', async () => {
    const n = node();
    n.latch();
    const [a, b] = [boxPhone(), createFakePhone()];
    n.put(a.approverRecord({ boxKey: true }));
    n.put(b.approverRecord());
    const stagedDir = path.join(n.dataDir, 'approvals', 'staged');
    const store = new ApproverStore({ dir: path.join(n.configDir, 'approvers'), stagedDir, ...deps.storeOptions, serviceProbe: false });
    await store.ready();
    assert.equal(store.stage(b.revoke(a.deviceId)).state, 'revoked-pending-apply');
    const io = streamIo();
    assert.equal(await unseal(n, io), 1);
    assert.match(io.text.err, /device apply/);
    assert.equal(readLatch(n.dataDir).state, 'good');
  });

  it('refuses on a set it cannot trust', { skip: !POSIX }, async () => {
    const n = node();
    n.latch();
    fs.chmodSync(path.join(n.configDir, 'approvers'), 0o777);
    const io = streamIo();
    const code = await unseal(n, io);
    fs.chmodSync(path.join(n.configDir, 'approvers'), 0o755);
    assert.equal(code, 1);
    assert.equal(readLatch(n.dataDir).state, 'good');
  });

  it('off a terminal it needs --yes, and reads nothing first', async () => {
    const n = node();
    n.latch();
    const io = streamIo();
    assert.equal(await unseal(n, io, { flags: {}, extra: { isTTY: () => false } }), 2);
    assert.match(io.text.err, /--yes/);
    assert.equal(readLatch(n.dataDir).state, 'good');
    assert.equal(fs.existsSync(path.join(n.dataDir, 'chat-data.json')), false);
  });

  it('on a terminal it prints what it does and asks: no keeps it, yes clears it', async () => {
    const n = node();
    n.latch();
    const tty = { flags: {}, extra: { isTTY: () => true } };
    let io = streamIo();
    let running = unseal(n, io, tty);
    await asked(io);
    assert.match(io.text.out, /web-01/);
    assert.match(io.text.out, /relay/);
    io.stdin.write('n\n');
    assert.equal(await running, 1);
    assert.equal(readLatch(n.dataDir).state, 'good');
    assert.deepEqual(entries(n), []);

    io = streamIo();
    running = unseal(n, io, tty);
    await asked(io);
    io.stdin.write('y\n');
    assert.equal(await running, 0);
    assert.equal(readLatch(n.dataDir).state, 'none');
  });

  it('a phone that gets a box key while it asks stops it', async () => {
    const n = node();
    n.latch();
    const io = streamIo();
    const running = unseal(n, io, { flags: {}, extra: { isTTY: () => true } });
    await asked(io);
    n.put(boxPhone().approverRecord({ boxKey: true }));
    io.stdin.write('y\n');
    assert.equal(await running, 1);
    assert.equal(readLatch(n.dataDir).state, 'good');
  });

  it('a non-file put at the latch path while it asks stops it, with no audit entry', async () => {
    const n = node();
    n.latch();
    const io = streamIo();
    const running = unseal(n, io, { flags: {}, extra: { isTTY: () => true } });
    await asked(io);
    fs.rmSync(latchFile(n.dataDir));
    fs.mkdirSync(latchFile(n.dataDir));
    io.stdin.write('y\n');
    assert.equal(await running, 1);
    assert.match(io.text.err, /not a file/);
    assert.equal(fs.statSync(latchFile(n.dataDir)).isDirectory(), true);
    assert.deepEqual(entries(n), []);
  });

  it('says when it takes effect, and that a running service with a holder latches again', async () => {
    const n = node();
    n.latch();
    const io = streamIo();
    assert.equal(await unseal(n, io), 0);
    assert.match(io.text.out, /next build/);
    assert.match(io.text.out, /latches again/);
  });

  it('refuses a non-file at the latch path before any audit entry', async () => {
    const n = node();
    fs.mkdirSync(latchFile(n.dataDir), { recursive: true });
    const io = streamIo();
    assert.equal(await unseal(n, io), 1);
    assert.match(io.text.err, /not a file/);
    assert.equal(fs.statSync(latchFile(n.dataDir)).isDirectory(), true);
    assert.deepEqual(entries(n), []);
  });

  it('runs the owner check on Windows: an approvers dir of another owner refuses', async () => {
    const n = node();
    n.latch();
    const readOwners = () => ({ approvers: 'S-1-5-21-1-2-3-1001', config: 'S-1-5-32-544' });
    const io = streamIo();
    assert.equal(await unseal(n, io, { extra: { storeOptions: { ...deps.storeOptions, platform: 'win32', readOwners } } }), 1);
    assert.match(io.text.err, /cannot be trusted/);
    assert.equal(readLatch(n.dataDir).state, 'good');
    const fine = () => ({ approvers: 'S-1-5-32-544', config: 'S-1-5-32-544' });
    assert.equal(await unseal(n, streamIo(), { extra: { storeOptions: { ...deps.storeOptions, platform: 'win32', readOwners: fine } } }), 0);
  });

  describe('under hosting: personal', () => {
    const personal = () => {
      const n = node();
      fs.writeFileSync(path.join(n.configDir, 'node.yaml'), 'name: web-01\nprofile: agent\nhosting: personal\n', { mode: 0o644 });
      n.latch();
      return n;
    };
    const owners = (me, owner = me) => ({ platform: 'win32', inspectOwners: (paths) => ({ me, entries: paths.map(() => ({ owner, link: false })) }) });

    it('refuses an elevated prompt', async () => {
      const n = personal();
      const io = streamIo();
      assert.equal(await unseal(n, io, { extra: { isAdmin: () => true, personalOwner: owners('PC\\owner') } }), 1);
      assert.match(io.text.err, /not elevated/);
      assert.equal(readLatch(n.dataDir).state, 'good');
    });

    it('refuses an account that does not own the dirs', async () => {
      const n = personal();
      const io = streamIo();
      assert.equal(await unseal(n, io, { extra: { isAdmin: () => false, personalOwner: owners('PC\\owner', 'PC\\other') } }), 1);
      assert.match(io.text.err, /PC\\other/);
      assert.equal(readLatch(n.dataDir).state, 'good');
    });

    it('goes ahead for the owner, unelevated', async () => {
      const n = personal();
      assert.equal(await unseal(n, streamIo(), { extra: { isAdmin: () => false, personalOwner: owners('PC\\owner') } }), 0);
      assert.equal(readLatch(n.dataDir).state, 'none');
    });
  });

  it('with no latch there is nothing to do, and nothing is audited', async () => {
    const n = node();
    const io = streamIo();
    assert.equal(await unseal(n, io), 0);
    assert.match(io.text.out, /Nothing to do/);
    assert.deepEqual(entries(n), []);
  });

  it('clears a malformed latch too: it is the way back from one', async () => {
    const n = node();
    fs.mkdirSync(path.join(n.dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(latchFile(n.dataDir), 'garbage');
    assert.equal(await unseal(n, streamIo()), 0);
    assert.equal(readLatch(n.dataDir).state, 'none');
  });

  it('refuses when the approvals dir is a link or junction, removing nothing through it', async () => {
    const n = node();
    const elsewhere = path.join(n.dataDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'sealing.json'), '{"v":1,"latched_at":"2026-11-04T10:00:00.000Z"}');
    fs.symlinkSync(elsewhere, path.join(n.dataDir, 'approvals'), 'junction');
    const io = streamIo();
    assert.equal(await unseal(n, io), 1);
    assert.equal(fs.existsSync(path.join(elsewhere, 'sealing.json')), true);
    assert.deepEqual(entries(n), []);
  });

  it('is in the usage text and is the only new command taking --yes', async () => {
    assert.match(DEVICE_HELP, /device unseal \[--yes\]/);
    const n = node();
    const help = streamIo();
    assert.equal(await main(['help'], help), 0);
    assert.match(help.text.out, /device list\|revoke <device-id>\|apply\|unseal/);
    const io = streamIo();
    assert.equal(await main(['device', 'list', '--yes', '--data-dir', n.dataDir], io), 2);
    assert.match(io.text.err, /"--yes" is only valid for "desktop pair", "device apply", "device unseal", "identity record"/);
    const other = streamIo();
    assert.equal(await main(['device', 'nonsense', '--data-dir', n.dataDir], other), 2);
    assert.match(other.text.err, /device unseal/);
  });
});

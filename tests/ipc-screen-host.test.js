// tests/ipc-screen-host.test.js — boot-node-tray Task 7: King Louie serves its
// personal node's screen from the owner's session. No Electron, no real
// backend, no real helper file outside a temp dir.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once, EventEmitter } = require('events');
const { startScreenHost } = require('../src/ipc/screen-host');
const { startAttachedHost } = require('../src/ipc/attached-host');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { HelperChannel } = require('../src/gui/helper-channel');
const { writePersonalHelperFile } = require('../src/gui/personal-screen-host');
const { setLogLevel } = require('../src/logging');
const { holdEventLoop } = require('./helpers/hold-event-loop');

setLogLevel('fatal');
const release = holdEventLoop();
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });
const tmp = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-screen-host-')));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const NODE_ID = 'kl-hnef32472qzibi5r';
const USER = os.userInfo().username;
const REPORT = { capabilities: ['gui.launch', 'gui.input'], probes: [], displays: [], limits: [], locked: false };

function fakeBackend() {
  const calls = [];
  let pid = 4000;
  return {
    calls,
    probe: async () => REPORT,
    locked: async () => false,
    recordStart: async (o) => { calls.push(['recordStart', o.takeId]); pid += 1; return { pid, startedAt: 't', path: 'C:\\r\\take.mp4' }; },
    recordStop: async (o) => { calls.push(['recordStop', o]); return { stopped: true }; },
    stopRecordings: async () => { calls.push(['stopRecordings']); return []; },
    stop: async () => { calls.push(['stop']); }
  };
}

const quiet = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; } };

describe('startScreenHost', () => {
  it('startScreenHost passes profileRoot <dataDir>\\browser-profiles and attachLog false', async () => {
    let given;
    const host = startScreenHost({
      dataDir: 'C:\\Users\\a\\AppData\\Local\\KingLouie\\node\\data', platform: 'win32', log: quiet,
      deps: { backend: null, runSessionHelper: async (opts) => { given = opts; await new Promise((r) => opts.signal.addEventListener('abort', r)); return 0; } }
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(given.deps.profileRoot, 'C:\\Users\\a\\AppData\\Local\\KingLouie\\node\\data\\browser-profiles');
    assert.equal(given.deps.attachLog, false);
    assert.equal(given.platform, 'win32');
    assert.equal(typeof given.deps.readCopy, 'function');
    assert.equal(typeof given.deps.wrapOp, 'function');
    await host.stop();
    assert.equal(given.signal.aborted, true);
  });

  it('readCopy reads <dataDir>\\session\\personal-helper.json before each connect', async () => {
    const dataDir = tmp();
    let given;
    const host = startScreenHost({
      dataDir, platform: process.platform, log: quiet,
      deps: { backend: null, runSessionHelper: async (opts) => { given = opts; await new Promise((r) => opts.signal.addEventListener('abort', r)); return 0; } }
    });
    await new Promise((r) => setImmediate(r));
    await assert.rejects(given.deps.readCopy(), (e) => e.code === 'ENOENT');
    const written = writePersonalHelperFile({ dataDir, nodeId: NODE_ID, user: USER });
    const copy = await given.deps.readCopy();
    assert.deepEqual(Object.keys(copy).sort(), ['endpoint', 'nodeId', 'secret']);
    assert.equal(copy.endpoint, written.endpoint);
    assert.equal(copy.nodeId, NODE_ID);
    assert.ok(Buffer.from(copy.secret).equals(written.secret));
    await host.stop();
  });

  it('recording() follows record_start / record_stop', async () => {
    let given;
    const host = startScreenHost({
      dataDir: 'C:\\kl\\data', platform: 'win32', log: quiet,
      deps: { backend: null, runSessionHelper: async (opts) => { given = opts; await new Promise((r) => opts.signal.addEventListener('abort', r)); return 0; } }
    });
    await new Promise((r) => setImmediate(r));
    const changes = [];
    host.on('change', (s) => changes.push(s.recording));
    const backend = fakeBackend();
    const base = async (op, p) => {
      if (op === 'record_start') return backend.recordStart({ takeId: p.take_id });
      if (op === 'record_stop') return backend.recordStop(p);
      if (op === 'screenshot') return { ok: true };
      throw new Error('unknown');
    };
    const handle = given.deps.wrapOp(base);
    assert.equal(host.recording(), false);
    await handle('screenshot', {});
    assert.equal(host.recording(), false);
    const a = await handle('record_start', { take_id: 'tk-a' });
    assert.equal(host.recording(), true);
    await handle('record_stop', { pid: a.pid });
    assert.equal(host.recording(), false);
    // By take id (a record_start whose answer the service never got).
    await handle('record_start', { take_id: 'tk-b' });
    assert.equal(host.recording(), true);
    await handle('record_stop', { take_id: 'tk-b' });
    assert.equal(host.recording(), false);
    // A record_start that fails never counts.
    const failing = given.deps.wrapOp(async () => { throw new Error('recorder_missing'); });
    await assert.rejects(failing('record_start', { take_id: 'tk-c' }));
    assert.equal(host.recording(), false);
    assert.deepEqual(changes, [true, false, true, false]);
    await host.stop();
  });

  it('the helper stopping every recording itself (30 s without the node) ends recording()', async () => {
    let given;
    const backend = fakeBackend();
    const host = startScreenHost({
      dataDir: 'C:\\kl\\data', platform: 'win32', log: quiet,
      deps: { backend, runSessionHelper: async (opts) => { given = opts; await new Promise((r) => opts.signal.addEventListener('abort', r)); return 0; } }
    });
    await new Promise((r) => setImmediate(r));
    const handle = given.deps.wrapOp(async (op, p) => given.deps.backend.recordStart({ takeId: p.take_id }));
    await handle('record_start', { take_id: 'tk-a' });
    assert.equal(host.recording(), true);
    await given.deps.backend.stopRecordings();
    assert.equal(host.recording(), false);
    assert.deepEqual(backend.calls.at(-1), ['stopRecordings']);
    await host.stop();
  });

  it('connected() and change follow the helper\'s session state', async () => {
    let given;
    const host = startScreenHost({
      dataDir: 'C:\\kl\\data', platform: 'win32', log: quiet,
      deps: { backend: null, runSessionHelper: async (opts) => { given = opts; await new Promise((r) => opts.signal.addEventListener('abort', r)); return 0; } }
    });
    await new Promise((r) => setImmediate(r));
    const changes = [];
    host.on('change', (s) => changes.push(s.connected));
    assert.equal(host.connected(), false);
    given.deps.onState({ connected: true });
    assert.equal(host.connected(), true);
    given.deps.onState({ connected: true });
    given.deps.onState({ connected: false });
    assert.equal(host.connected(), false);
    assert.deepEqual(changes, [true, false]);
    await host.stop();
  });

  it('shutdown stops it (signal aborted, recordings stopped)', async () => {
    // The real loop against a real HelperChannel on the node's file.
    const dataDir = tmp();
    const written = writePersonalHelperFile({ dataDir, nodeId: NODE_ID, user: USER });
    if (process.platform !== 'win32') {
      // The file names a Windows pipe; off Windows serve a socket instead.
      written.endpoint = path.join(dataDir, 'h.sock');
    }
    const channel = new HelperChannel({ endpoint: written.endpoint, readSecret: () => written, pingMs: 60000 });
    await channel.start();
    cleanups.push(() => channel.stop());
    const backend = fakeBackend();
    const ready = once(channel, 'ready');
    const host = startScreenHost({
      dataDir, platform: process.platform, log: quiet,
      deps: {
        backend,
        helperDeps: { delays: [20, 20, 20] },
        readPersonalHelperFile: () => written
      }
    });
    await ready;
    assert.equal(host.connected(), true);
    const started = await channel.request('record_start', { take_id: 'tk-z' });
    assert.ok(started.pid);
    assert.equal(host.recording(), true);
    await host.stop();
    assert.equal(host.connected(), false);
    assert.equal(host.recording(), false);
    const names = backend.calls.map((c) => c[0]);
    assert.ok(names.includes('stopRecordings'), 'the helper stops its recordings');
    assert.ok(names.indexOf('stopRecordings') < names.indexOf('stop'), 'before the backend');
  });
});

// The attached host starts the screen host only for the local personal record.
function attachedSetup({ platform, service = {}, kind, stopHangs = false, screenHostStopMs } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  const userDataDir = tmp();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => Buffer.from(b).toString() };
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) });
  state.setMode('attached');
  state.setPairing({
    deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk',
    ...(kind ? { kind } : {}),
    service: { nodeId: 'kl-abcdefghijklmnop', publicKey: 'aa', port: 18796, pairedAt: '2026-09-23T14:02:11Z', ...service }
  });
  const client = new EventEmitter();
  client.close = () => {};
  const controller = {
    createClient: () => client, setClient() {}, startAttached: async () => {}, dispose() {}, finishedForNow: () => false
  };
  const started = [];
  const hosts = [];
  const screenHostFactory = (opts) => {
    started.push(opts);
    const h = { stopped: false, stop() { h.stopped = true; return stopHangs ? new Promise(() => {}) : Promise.resolve(); }, recording: () => false, connected: () => false, on() {} };
    hosts.push(h);
    return h;
  };
  const app = { getPath: () => userDataDir, relaunch() {}, exit() {}, quit() {} };
  const host = startAttachedHost({
    app, ipcMain, safeStorage, dialog: {}, getWindow: () => null, state, env: {}, platform,
    controllerFactory: () => controller, screenHostFactory, ...(screenHostStopMs ? { screenHostStopMs } : {})
  });
  return { host, started, hosts };
}

describe('attached host and the screen host', () => {
  const personal = { hosting: 'personal', dataDir: 'C:\\Users\\a\\AppData\\Local\\KingLouie\\node\\data' };

  it('attached host starts the screen host only for a personal record on win32, and not for a fleet or remote tab', async () => {
    const yes = attachedSetup({ platform: 'win32', service: personal });
    yes.host.start();
    assert.deepEqual(yes.started, [{ dataDir: personal.dataDir, platform: 'win32' }]);
    yes.host.start();
    assert.equal(yes.started.length, 1, 'once');

    for (const s of [
      attachedSetup({ platform: 'win32' }), // a fleet record
      attachedSetup({ platform: 'win32', service: { hosting: 'personal' } }), // no data dir
      attachedSetup({ platform: 'linux', service: personal }),
      attachedSetup({ platform: 'win32', service: personal, kind: 'remote' })
    ]) {
      s.host.start();
      assert.deepEqual(s.started, []);
      await s.host.shutdown();
    }
    await yes.host.shutdown();
  });

  it('shutdown stops the screen host', async () => {
    const s = attachedSetup({ platform: 'win32', service: personal });
    s.host.start();
    assert.equal(s.hosts[0].stopped, false);
    await s.host.shutdown();
    assert.equal(s.hosts[0].stopped, true);
    assert.equal(s.host.screenHost(), null);
  });

  it('a screen host that never stops does not hold up quit past its bound', async () => {
    const s = attachedSetup({ platform: 'win32', service: personal, stopHangs: true, screenHostStopMs: 50 });
    s.host.start();
    const t0 = Date.now();
    await s.host.shutdown();
    assert.equal(s.hosts[0].stopped, true);
    assert.ok(Date.now() - t0 < 5000);
  });
});

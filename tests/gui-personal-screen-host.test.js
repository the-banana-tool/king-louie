// tests/gui-personal-screen-host.test.js
// A personal node started at boot (`run --screen-host app`, boot-node-tray
// plan D-2, D-3): the GUI subsystem serves the screen through the King Louie
// app over the kl-session-v1 HelperChannel on an owner-only pipe, whose name
// and key it writes to <dataDir>/session/personal-helper.json.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { createGuiSubsystem } = require('../src/gui');
const { HelperChannel } = require('../src/gui/helper-channel');
const { InProcessChannel } = require('../src/gui/in-process-channel');
const { parseGuiConfig } = require('../src/gui/config');
const { ToolRegistry } = require('../src/tools/tool-registry');
const { connectToService, createOpHandler } = require('../src/session/connection');
const {
  PERSONAL_HELPER_FILE, helperFilePath, writePersonalHelperFile, readPersonalHelperFile, removePersonalHelperFile
} = require('../src/gui/personal-screen-host');
const { setLogLevel } = require('../src/logging');
const { testNodeIdentity } = require('./helpers/fake-phone');
const { holdEventLoop } = require('./helpers/hold-event-loop');

setLogLevel('fatal');
const release = holdEventLoop();
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });

const WIN = process.platform === 'win32';
const identity = testNodeIdentity({ key: 'gpu-box' });
const USER = os.userInfo().username;
const MISSING = 'King Louie is not running in your session: log in, or open King Louie';

function dataDirFor() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-screen-host-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  return dataDir;
}

class FakeRelay extends EventEmitter {
  constructor() { super(); this.methods = new Map(); }
  isConnected() { return true; }
  async send() { return { ok: true }; }
  registerMethod(name, fn) { this.methods.set(name, fn); }
}
const approvals = () => ({ identity, approverStore: { get: () => null }, relayClient: new FakeRelay(), phoneApprover: { isAvailable: () => true }, auditLedger: { append: async () => {} } });
const nodeConfig = () => ({
  name: 'gpu-box', profile: 'agent', hosting: 'personal', capabilities: [], policy: { allowed_roots: [], remote_sessions: { always_confirm: [], deny: [] }, max_concurrent_jobs: 2 },
  gui: parseGuiConfig({ enabled: true, apps: { calculator: { path: 'C:\\Windows\\System32\\calc.exe' } } }, { profile: 'agent' })
});

// A screen-host node; deps reach createGuiSubsystem's deps.
function appHost(deps = {}, extra = {}) {
  const dataDir = dataDirFor();
  const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, approvals: approvals(), platform: 'win32', hosting: 'personal', screenHost: 'app', deps, ...extra });
  return { gui, dataDir };
}

// A net module whose server records listen options and answers at once.
function fakeNet() {
  const listened = [];
  return {
    listened,
    createServer() {
      const server = new EventEmitter();
      server.listen = (options, cb) => { listened.push(options); setImmediate(cb); };
      server.close = (cb) => setImmediate(cb);
      return server;
    }
  };
}

const connect = (record, extra = {}) => connectToService({
  endpoint: record.endpoint, secret: record.secret, nodeId: record.nodeId, user: USER, platform: 'win32', helperVersion: 'test',
  probeReport: { capabilities: ['gui.launch', 'gui.screenshot'], probes: [], displays: [], limits: [], locked: false },
  handleOp: createOpHandler({ probe: async () => ({}), foreground: async () => null }), ...extra
});

describe('screenHost app: the GUI subsystem', { skip: !WIN && 'the screen host is Windows only' }, () => {
  it('with hosting personal and screenHost app, uses a HelperChannel on the file\'s endpoint, not InProcessChannel', async () => {
    const { gui, dataDir } = appHost();
    assert.ok(gui);
    assert.equal(gui.unavailable, null);
    assert.ok(gui.channel instanceof HelperChannel);
    assert.ok(!(gui.channel instanceof InProcessChannel));
    assert.equal(gui.leases.identityProbe, null, 'personal hosting runs no identity probe');
    await gui.start();
    cleanups.push(() => gui.stop());
    assert.equal(gui.unavailable, null);
    const record = readPersonalHelperFile({ dataDir });
    assert.equal(gui.channel.endpoint, record.endpoint);
    assert.match(record.endpoint, /^\\\\\.\\pipe\\king-louie-personal-[0-9a-f]{16}$/);
    await gui.stop();
  });

  it('the channel listens without readableAll/writableAll (shared:false)', async () => {
    const net = fakeNet();
    const { gui, dataDir } = appHost({ netImpl: net });
    await gui.start();
    cleanups.push(() => gui.stop());
    assert.equal(gui.unavailable, null);
    assert.deepEqual(net.listened, [{ path: readPersonalHelperFile({ dataDir }).endpoint }]);
    await gui.stop();
    // A fleet channel still opens its pipe to every account.
    const fleetNet = fakeNet();
    const fleet = new HelperChannel({ endpoint: '\\\\.\\pipe\\x', platform: 'win32', readSecret: () => null, netImpl: fleetNet });
    await fleet.start();
    assert.deepEqual(fleetNet.listened, [{ path: '\\\\.\\pipe\\x', readableAll: true, writableAll: true }]);
    await fleet.stop();
  });

  it('writes personal-helper.json at start with a fresh secret and endpoint each start, and removes it at stop', async () => {
    const { gui, dataDir } = appHost();
    assert.equal(fs.existsSync(helperFilePath(dataDir)), false, 'nothing is written before start');
    await gui.start();
    const first = readPersonalHelperFile({ dataDir });
    assert.equal(first.nodeId, identity.nodeId);
    assert.equal(first.sessionUser, USER);
    assert.equal(first.secret.length, 32);
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, ...PERSONAL_HELPER_FILE.split('/')), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['endpoint', 'node_id', 'secret', 'user', 'v']);
    assert.equal(raw.v, 1);
    await gui.stop();
    assert.equal(fs.existsSync(helperFilePath(dataDir)), false, 'stop removes it');
    await gui.start();
    cleanups.push(() => gui.stop());
    const second = readPersonalHelperFile({ dataDir });
    assert.notEqual(second.endpoint, first.endpoint);
    assert.ok(!second.secret.equals(first.secret));
    await gui.stop();
    assert.equal(fs.existsSync(helperFilePath(dataDir)), false);
  });

  it('readSecret returns the file\'s secret, node id and user, so the existing handshake admits the app', async () => {
    const { gui, dataDir } = appHost();
    await gui.start();
    cleanups.push(() => gui.stop());
    const record = readPersonalHelperFile({ dataDir });
    const fromChannel = gui.channel.readSecret();
    assert.ok(fromChannel.secret.equals(record.secret));
    assert.equal(fromChannel.nodeId, record.nodeId);
    assert.equal(fromChannel.sessionUser, record.sessionUser);

    // A wrong key is refused; the file's key is admitted.
    await assert.rejects(connect({ ...record, secret: crypto.randomBytes(32) }), (err) => err.code === 'auth_failed');
    assert.equal(gui.capability().available, false);
    const ready = once(gui.channel, 'ready');
    const session = await connect(record);
    cleanups.push(() => session.close());
    await ready;
    const cap = gui.capability();
    assert.equal(cap.available, true);
    assert.equal(cap.reason, undefined);
    assert.equal(cap.user, USER);
    const closed = once(gui.channel, 'closed');
    session.close();
    await closed;
    assert.equal(gui.capability().reason, 'screen_host_not_connected');
    await gui.stop();
  });

  it('without screenHost, personal hosting keeps InProcessChannel (a node run by hand)', () => {
    const fake = new EventEmitter();
    const dataDir = dataDirFor();
    const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, approvals: approvals(), platform: 'win32', hosting: 'personal', deps: { channel: fake } });
    assert.equal(gui.channel, fake, 'the in-process path (deps.channel stands in for it)');
    const built = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, approvals: approvals(), platform: 'win32', hosting: 'personal', screenHost: null });
    assert.ok(built.channel instanceof InProcessChannel);
    assert.ok(!(built.channel instanceof HelperChannel));
  });

  it('before a screen host connects, a GUI tool refuses capability_unavailable naming that King Louie is not running in your session', async () => {
    const { gui } = appHost();
    await gui.start();
    cleanups.push(() => gui.stop());
    const cap = gui.capability();
    assert.equal(cap.available, false);
    assert.equal(cap.reason, 'screen_host_not_connected');
    assert.equal(cap.message, MISSING);
    const registry = new ToolRegistry();
    gui.registerTools(registry);
    const out = await registry.get('Screenshot').execute({}, { origin: { client: 'x', session: 'c1', job_id: null } });
    assert.equal(out.ok, false);
    assert.equal(out.error, `capability_unavailable: gui (${MISSING})`);
    await gui.stop();
  });

  it('a screen host is refused off personal hosting or off Windows: the GUI is off, never in-process', () => {
    const dataDir = dataDirFor();
    const fleet = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, approvals: approvals(), platform: 'win32', hosting: 'service', screenHost: 'app' });
    assert.equal(fleet.unavailable.reason, 'gui_start_failed');
    assert.match(fleet.unavailable.detail, /hosting: personal/);
    const linux = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, approvals: approvals(), platform: 'linux', hosting: 'personal', screenHost: 'app' });
    assert.equal(linux.unavailable.reason, 'gui_start_failed');
  });

  it('a file that cannot be written makes start() fail the normal way (gui_start_failed), never throwing', async () => {
    const { gui, dataDir } = appHost({ randomBytes: () => Buffer.alloc(3) });
    await gui.start();
    cleanups.push(() => gui.stop());
    assert.equal(gui.unavailable.reason, 'gui_start_failed');
    assert.equal(gui.capability().reason, 'gui_start_failed');
    assert.equal(fs.existsSync(helperFilePath(dataDir)), false);
    await gui.stop();
  });
});

describe('personal-helper.json', () => {
  const write = (dataDir) => writePersonalHelperFile({ dataDir, nodeId: identity.nodeId, user: 'alice' });

  it('round-trips, 0o600 where modes exist, with a 32-byte key in hex', () => {
    const dataDir = dataDirFor();
    const written = write(dataDir);
    const read = readPersonalHelperFile({ dataDir });
    assert.equal(read.endpoint, written.endpoint);
    assert.ok(read.secret.equals(written.secret));
    assert.equal(read.nodeId, identity.nodeId);
    assert.equal(read.sessionUser, 'alice');
    assert.match(JSON.parse(fs.readFileSync(helperFilePath(dataDir), 'utf8')).secret, /^[0-9a-f]{64}$/);
    if (!WIN) assert.equal(fs.statSync(helperFilePath(dataDir)).mode & 0o777, 0o600);
    removePersonalHelperFile({ dataDir });
    assert.equal(fs.existsSync(helperFilePath(dataDir)), false);
    removePersonalHelperFile({ dataDir });
  });

  it('readPersonalHelperFile refuses a link, a non-file, extra keys and >4096 bytes', (t) => {
    const dataDir = dataDirFor();
    const file = helperFilePath(dataDir);
    write(dataDir);
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    const refused = (pattern) => assert.throws(() => readPersonalHelperFile({ dataDir }), (err) => err.code === 'PERSONAL_HELPER_FILE_INVALID' && pattern.test(err.message));

    fs.writeFileSync(file, JSON.stringify({ ...good, extra: 1 }));
    refused(/exactly/);
    const short = { ...good };
    delete short.user;
    fs.writeFileSync(file, JSON.stringify(short));
    refused(/exactly/);
    fs.writeFileSync(file, JSON.stringify({ ...good, user: 'a'.repeat(5000) }));
    refused(/4096/);
    fs.writeFileSync(file, JSON.stringify({ ...good, secret: 'zz' }));
    refused(/key/);
    fs.writeFileSync(file, JSON.stringify({ ...good, endpoint: '\\\\.\\pipe\\someone-else' }));
    refused(/pipe/);

    fs.rmSync(file);
    fs.mkdirSync(file);
    refused(/not a regular file/);
    fs.rmdirSync(file);

    const target = path.join(path.dirname(file), 'real.json');
    fs.writeFileSync(target, JSON.stringify(good));
    try {
      fs.symlinkSync(target, file, 'file');
    } catch (err) {
      if (err.code === 'EPERM') { t.diagnostic('symlinks need a privilege here; link case not checked'); return; }
      throw err;
    }
    refused(/link/);
  });
});

// tests/service-run-personal.test.js
// The agent profile under `hosting: personal` (spec 2026-10-25 §6): the owner
// check at start, no identity record, the GUI over an in-process channel, the
// owner's admin dirs denied to the file tools; a fleet node is unchanged.
const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const net = require('net');
const { loadProfile, runService } = require('../src/service/run');
const { ensureServicePaths, ensurePrivateDir, desktopProfileDirs } = require('../src/platform/paths');
const { readGuiStatusRecord } = require('../src/gui/status');
const { isDeniedPath, clearDeniedDirs } = require('../src/tools/utils');
const { IDENTITY_RECORD_TEST_OPTIONS } = require('./helpers/identity-record');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const ME = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-1-2-3-1002';
const OFF = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };
const INFO = { user: 'alice', platform: process.platform, pid: process.pid, capabilities: ['gui.launch', 'gui.screenshot', 'gui.input'], probes: [], displays: [], limits: [], locked: false, since: '2026-10-25T10:00:00.000Z' };

// The broker's channel surface (tests/gui-broker.test.js), with start/stop.
class FakeChannel extends EventEmitter {
  constructor() { super(); this.connected = false; this.info = null; this.started = 0; this.stopped = 0; }
  async start() { this.started += 1; this.connected = true; this.info = { ...INFO }; this.emit('ready', this.info); }
  async stop() { this.stopped += 1; this.connected = false; }
  async request(op) { const e = new Error(op); e.code = 'unknown_op'; throw e; }
}

// checkPersonalOwner's Windows path, answered in place (no PowerShell).
function inspect(me, owners) {
  return (paths) => ({ me, entries: paths.map((p) => (owners[p] ? { owner: owners[p], link: false } : null)) });
}

const temps = [];
after(() => { closeOpenHistoryStores(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
afterEach(() => clearDeniedDirs());

function layout(nodeYaml) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-personal-run-'));
  temps.push(base);
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  fs.writeFileSync(path.join(configDir, 'node.yaml'), nodeYaml, { mode: 0o644 });
  ensureServicePaths(dataDir);
  const workspace = path.join(dataDir, 'workspace');
  ensurePrivateDir(workspace);
  // readGuiStatusRecord trusts status.json only from the running service's pid.
  fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
  return { dataDir, configDir, workspace };
}

const GUI_YAML = `gui:\n  enabled: true\n  apps:\n    chrome:\n      name: Chrome\n      path: ${JSON.stringify(process.execPath)}\n`;
const PERSONAL_YAML = `name: n\nprofile: agent\nhosting: personal\n${GUI_YAML}`;
const SERVICE_YAML = `name: n\nprofile: agent\n${GUI_YAML}`;

// The node identity the store holds (mesh.identity in chat-data.json), if any.
function storedIdentity(dataDir) {
  const file = path.join(dataDir, 'chat-data.json');
  if (!fs.existsSync(file)) return undefined;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data && data.mesh ? data.mesh.identity : undefined;
}

// A record nobody can use: `invalid`, which a fleet node refuses to start on.
function writeBadRecord(configDir) {
  fs.mkdirSync(path.join(configDir, 'identity'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'identity', 'node.json'), '{}');
}

function start(l, deps) {
  return loadProfile('agent').start({ dataDir: l.dataDir, configDir: l.configDir, adminUid: EUID, features: OFF, ports: {}, workspace: l.workspace, audit: {}, deps });
}

function personalDeps(l, owners, extra = {}) {
  return { personalOwner: { platform: 'win32', inspectOwners: inspect(ME, owners) }, gui: { channel: new FakeChannel() }, ...extra };
}

describe('loadProfile("agent") under hosting: personal', { timeout: 120000 }, () => {
  it('starts with no identity record and no helper file; the GUI is on over the injected channel; status.json says hosting personal', async () => {
    const l = layout(PERSONAL_YAML);
    const deps = personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME });
    const running = await start(l, deps);
    try {
      assert.ok(running.gui, 'the GUI is built without a helper file');
      assert.equal(running.gui.unavailable, null);
      assert.equal(running.gui.channel, deps.gui.channel, 'over the injected channel');
      assert.equal(deps.gui.channel.started, 1);
      const status = readGuiStatusRecord({ dataDir: l.dataDir });
      assert.equal(status.hosting, 'personal');
      assert.equal(status.available, true);
      // What the refusal test's sentinels look for does exist after a start.
      assert.ok(storedIdentity(l.dataDir), 'the node identity is in the store');
    } finally {
      await running.stop();
    }
    assert.equal(deps.gui.channel.stopped, 1, 'stop() closes the channel');
  });

  it('a record that cannot be used does not stop a personal node', async () => {
    const l = layout(PERSONAL_YAML);
    writeBadRecord(l.configDir);
    const running = await start(l, personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME }, { identityRecord: IDENTITY_RECORD_TEST_OPTIONS }));
    try {
      assert.equal(running.gui.unavailable, null);
    } finally {
      await running.stop();
    }
  });

  it('Review Focus 2: personal on dirs another account owns refuses PERSONAL_NOT_OWNER before approvals', async () => {
    const l = layout(PERSONAL_YAML);
    const asked = [];
    const inspectOwners = (paths) => { asked.push(paths); return inspect(ME, { [l.dataDir]: ME, [l.configDir]: OTHER })(paths); };
    const deps = { personalOwner: { platform: 'win32', inspectOwners }, gui: { channel: new FakeChannel() } };
    await assert.rejects(start(l, deps), (err) => {
      assert.equal(err.code, 'PERSONAL_NOT_OWNER');
      assert.match(err.message, new RegExp(`owned by ${OTHER}`));
      return true;
    });
    assert.deepEqual(asked, [[l.dataDir, l.configDir]]);
    // Refused before the node identity was made, which every start does
    // before startApprovals (the first test shows it is stored after one).
    assert.equal(storedIdentity(l.dataDir), undefined, 'no node identity was made, so approvals never started');
    assert.equal(deps.gui.channel.started, 0);
  });

  it('personal registers the config dir and both spellings of the desktop profile as denied dirs', async () => {
    const l = layout(PERSONAL_YAML);
    // A fixed profile base under the temp dir, whatever the host's own.
    const roaming = path.join(path.dirname(l.dataDir), 'roaming');
    const env = { APPDATA: roaming, HOME: roaming };
    const expected = [l.configDir, ...desktopProfileDirs({ platform: process.platform, env })];
    assert.equal(expected.length, 3);
    assert.ok(expected.slice(1).every((d) => d.startsWith(roaming)));
    const running = await start(l, personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME }, { env }));
    try {
      for (const dir of expected) assert.equal(isDeniedPath(path.join(dir, 'chat-data.json')), true, dir);
      assert.equal(isDeniedPath(path.join(l.configDir, 'approvers', 'phone.json')), true);
      assert.equal(isDeniedPath(path.join(roaming, 'some-other-app', 'x.json')), false, 'only the profile folders');
      assert.equal(isDeniedPath(path.join(l.workspace, 'notes.txt')), false, 'the workspace is not denied');
    } finally {
      await running.stop();
    }
  });
});

describe('loadProfile("agent") under hosting: service (default)', { timeout: 120000 }, () => {
  it('an identity record is still required when gui is enabled; nothing changed', async () => {
    const l = layout(SERVICE_YAML);
    // No helper file and no record: desktop apps are off (no GUI subsystem),
    // whatever deps.gui says, and no owner check is run.
    let ownerAsked = false;
    const deps = { personalOwner: { platform: 'win32', inspectOwners: () => { ownerAsked = true; return { me: '', entries: [] }; } }, gui: { channel: new FakeChannel() }, identityRecord: IDENTITY_RECORD_TEST_OPTIONS };
    const running = await start(l, deps);
    try {
      assert.equal(running.gui, null, 'a fleet node needs the helper file; no in-process channel');
      assert.equal(deps.gui.channel.started, 0);
      assert.equal(ownerAsked, false);
      assert.equal(isDeniedPath(path.join(l.configDir, 'node.yaml')), false, 'no denied dirs on a fleet node');
    } finally {
      await running.stop();
    }
    // A record that cannot be used still refuses the start.
    const l2 = layout(SERVICE_YAML);
    writeBadRecord(l2.configDir);
    await assert.rejects(start(l2, { identityRecord: IDENTITY_RECORD_TEST_OPTIONS }), (err) => err.code === 'NODE_IDENTITY_RECORD_INVALID');
  });
});

// Attach stage 2: a personal node's window is the only way in, so channels,
// webhooks and app discovery default on there; a fleet node's defaults stay
// off; an explicit admin value wins; and with nothing configured nothing binds.
describe('feature defaults by hosting (the real runService path)', { timeout: 120000 }, () => {
  const cwd = process.cwd();
  after(() => process.chdir(cwd));

  // A free loopback port, closed again.
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  const listening = (port) => new Promise((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port });
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
  const serviceJson = (l, body) => fs.writeFileSync(path.join(l.configDir, 'service.json'), JSON.stringify(body));
  const QUIET_YAML = 'name: n\nprofile: agent\nhosting: personal\ngui:\n  enabled: false\n';

  // runService with the profile's start replaced: what would it start with?
  async function startedWith(l) {
    const ac = new AbortController();
    let seen = null;
    await runService({
      dataDir: l.dataDir, adminUid: EUID, signal: ac.signal, stdout: { write: () => true },
      deps: { startProfile: async (opts) => { seen = opts; setImmediate(() => ac.abort()); return { masterKeySource: 'test', stop: async () => {} }; } }
    });
    return seen;
  }

  it('personal: channels, webhooks and appDiscovery on; gateway, mesh and the bridge stay off', async () => {
    const seen = await startedWith(layout(QUIET_YAML));
    assert.deepEqual(seen.features, { gateway: false, webhooks: true, mesh: false, channels: true, appDiscovery: true, desktopBridge: false });
    assert.equal(seen.webhooksOnDemand, true);
  });

  it('fleet: every default stays off, and nothing is on demand', async () => {
    const seen = await startedWith(layout('name: n\nprofile: agent\n'));
    assert.deepEqual(seen.features, OFF);
    assert.ok(!seen.webhooksOnDemand);
  });

  it('personal: an explicit admin value wins, either way', async () => {
    const l = layout(QUIET_YAML);
    serviceJson(l, { features: { channels: false, webhooks: false, appDiscovery: false } });
    const off = await startedWith(l);
    assert.deepEqual(off.features, OFF);
    assert.ok(!off.webhooksOnDemand);
    serviceJson(l, { features: { webhooks: true } });
    fs.rmSync(path.join(l.dataDir, 'service.pid'), { force: true });
    const on = await startedWith(l);
    assert.equal(on.features.webhooks, true);
    assert.ok(!on.webhooksOnDemand, 'switched on by hand: bound at start, and refused when it cannot');
  });

  // The real start. appDiscovery is off here only so no `where` child runs.
  function realRun(l, deps) {
    const ac = new AbortController();
    let ready;
    const up = new Promise((resolve) => { ready = resolve; });
    const stdout = { write: (t) => { if (String(t).includes('"ready"')) ready(); return true; } };
    fs.rmSync(path.join(l.dataDir, 'service.pid'), { force: true });
    const done = runService({ dataDir: l.dataDir, adminUid: EUID, signal: ac.signal, stdout, deps });
    return { up: Promise.race([up, done]), stop: async () => { ac.abort(); await done; }, done };
  }

  it('nothing configured: the node starts and nothing listens on the webhook port', async () => {
    const keepAlive = setTimeout(() => {}, 100000);
    const l = layout(QUIET_YAML);
    const port = await freePort();
    serviceJson(l, { features: { appDiscovery: false }, ports: { webhook: port } });
    const run = realRun(l, personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME }));
    try {
      await run.up;
      assert.equal(await listening(port), false, 'no listener until something is configured');
    } finally {
      await run.stop();
      clearTimeout(keepAlive);
    }
  });

  it('nothing configured and the webhook port taken: the node still starts', async () => {
    const keepAlive = setTimeout(() => {}, 100000);
    const l = layout(QUIET_YAML);
    const squatter = net.createServer();
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    serviceJson(l, { features: { appDiscovery: false }, ports: { webhook: squatter.address().port } });
    const run = realRun(l, personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME }));
    try {
      await run.up;
    } finally {
      await run.stop();
      await new Promise((resolve) => squatter.close(resolve));
      clearTimeout(keepAlive);
    }
  });

  // The on-demand listener, on the profile's own start.
  const onDemand = (l, port, deps) => loadProfile('agent').start({
    dataDir: l.dataDir, configDir: l.configDir, adminUid: EUID, workspace: l.workspace, audit: {}, deps,
    features: { ...OFF, webhooks: true, channels: true }, ports: { webhook: port }, webhooksOnDemand: true
  });

  it('the first webhook binds on loopback; a stored one binds at the next start; a taken port then refuses', async () => {
    const l = layout(QUIET_YAML);
    const deps = () => personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME });
    const port = await freePort();
    const first = await onDemand(l, port, deps());
    try {
      assert.equal(await listening(port), false);
      first.core.context.getWebhookRegistry().register({ name: 'hook' });
      await first.core.whenListenersSettled();
      assert.equal(first.core.getWebhookServer().httpServer.address().address, '127.0.0.1');
      assert.equal(await listening(port), true);
    } finally {
      await first.stop();
    }
    const second = await onDemand(l, port, deps());
    try {
      assert.equal(await listening(port), true, 'a stored webhook binds at start');
    } finally {
      await second.stop();
    }
    const squatter = net.createServer();
    await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      await assert.rejects(onDemand(l, port, deps()), /refusing to run without webhooks/);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('a fleet start with webhooks on still binds at once, with none configured', async () => {
    const l = layout('name: n\nprofile: agent\n');
    const port = await freePort();
    const running = await loadProfile('agent').start({
      dataDir: l.dataDir, configDir: l.configDir, adminUid: EUID, workspace: l.workspace, audit: {},
      features: { ...OFF, webhooks: true }, ports: { webhook: port }
    });
    try {
      assert.equal(await listening(port), true);
    } finally {
      await running.stop();
    }
  });

  it('channels on and no token: /llm telegram no longer says channels are off, and nothing starts', async () => {
    const l = layout(QUIET_YAML);
    const port = await freePort();
    const running = await onDemand(l, port, personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME }));
    try {
      const out = await running.core.context.runLlmCommand('/llm telegram status');
      assert.doesNotMatch(JSON.stringify(out), /Channels are off/);
      const add = await running.core.context.runLlmCommand('/llm telegram add');
      assert.doesNotMatch(JSON.stringify(add), /Channels are off/);
      assert.equal(await listening(port), false);
    } finally {
      await running.stop();
    }
  });
});

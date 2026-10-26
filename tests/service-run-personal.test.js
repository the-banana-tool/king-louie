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
const { loadProfile } = require('../src/service/run');
const { ensureServicePaths, ensurePrivateDir, desktopProfileDir } = require('../src/platform/paths');
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
    // Nothing of approvals ran: no staged dir, no node identity made.
    assert.equal(fs.existsSync(path.join(l.dataDir, 'approvals')), false, 'startApprovals never ran');
    assert.equal(deps.gui.channel.started, 0);
  });

  it('personal registers the config dir and the desktop profile as denied dirs', async () => {
    const l = layout(PERSONAL_YAML);
    const running = await start(l, personalDeps(l, { [l.dataDir]: ME, [l.configDir]: ME }));
    try {
      assert.equal(isDeniedPath(path.join(l.configDir, 'node.yaml')), true);
      assert.equal(isDeniedPath(path.join(l.configDir, 'approvers', 'phone.json')), true);
      const profile = desktopProfileDir();
      if (profile) assert.equal(isDeniedPath(path.join(profile, 'chat-data.json')), true);
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

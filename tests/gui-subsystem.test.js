// tests/gui-subsystem.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { once } = require('events');
const { createGuiSubsystem, isJobOpen } = require('../src/gui');
const { parseGuiConfig } = require('../src/gui/config');
const S = require('../src/gui/session-secret');
const { connectToService, createOpHandler } = require('../src/session/connection');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { ToolRegistry } = require('../src/tools/tool-registry');
const { readGuiStatus, readGuiStatusRecord } = require('../src/gui/status');
const { runSessionCommand } = require('../src/service/commands/session');
const { runDoctor } = require('../src/service/doctor');
const { FleetToolHandler } = require('../src/fleet/fleet-tools');
const { setLogLevel } = require('../src/logging');
const { testNodeIdentity } = require('./helpers/fake-phone');
const { holdEventLoop } = require('./helpers/hold-event-loop');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

setLogLevel('fatal');
const release = holdEventLoop();
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cipher = createAesGcmCipher(crypto.randomBytes(32));
const identity = testNodeIdentity({ key: 'gpu-box' });

function dirs() {
  // Native realpath: session-secret.js requires the config dir to be its own
  // native realpath, and a Windows CI TEMP is an 8.3 short path.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-sub-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const configDir = path.join(base, 'config');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(configDir, { mode: 0o755 });
  fs.mkdirSync(dataDir, { mode: 0o700 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
  return { base, configDir, dataDir };
}

function endpoint(base) {
  return POSIX ? path.join(base, 'h.sock') : `\\\\.\\pipe\\kl-gui-sub-${crypto.randomBytes(6).toString('hex')}`;
}

class FakeRelay extends EventEmitter {
  constructor() { super(); this.methods = new Map(); }
  isConnected() { return true; }
  async send() { return { ok: true }; }
  registerMethod(name, fn) { this.methods.set(name, fn); }
}

const nodeConfig = (gui = {}, profile = 'agent') => ({
  name: 'gpu-box', profile, capabilities: [], policy: { allowed_roots: [], remote_sessions: { always_confirm: [], deny: [] }, max_concurrent_jobs: 2 },
  gui: parseGuiConfig({ enabled: true, apps: { calculator: { path: POSIX ? '/usr/bin/gnome-calculator' : 'C:\\Windows\\System32\\calc.exe' } }, ...gui }, { profile })
});

function install(configDir, { nodeId = identity.nodeId } = {}) {
  const { secret, endpointId } = S.mintSessionSecret();
  S.writeCanonical({ configDir, cipher, secret, endpointId, nodeId, sessionUser: 'alice', sessionSid: POSIX ? null : 'S-1-5-21-1-2-3-1001', sessionUid: POSIX ? UID : null });
  return secret;
}

// A logger that keeps what it was told, by level.
function spyLog() {
  const lines = { info: [], warn: [], error: [] };
  const text = (message, meta) => `${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
  return {
    info: (m, meta) => lines.info.push(text(m, meta)), warn: (m, meta) => lines.warn.push(text(m, meta)), error: (m, meta) => lines.error.push(text(m, meta)),
    debug: () => {}, errors: lines.error, all: () => [...lines.info, ...lines.warn, ...lines.error].join('\n')
  };
}

const approvals = () => ({ identity, approverStore: { get: () => null }, relayClient: new FakeRelay(), phoneApprover: { isAvailable: () => true }, auditLedger: { append: async () => {} } });

describe('createGuiSubsystem', () => {
  it('is null when gui is off, on a runbook node or when not installed (and that is not an error)', () => {
    const { configDir, dataDir } = dirs();
    const log = spyLog();
    const common = { dataDir, configDir, cipher, approvals: approvals(), adminUid: UID, geteuid: () => UID, log };
    assert.equal(createGuiSubsystem({ ...common, nodeConfig: nodeConfig({ enabled: false }) }), null);
    assert.equal(createGuiSubsystem({ ...common, nodeConfig: nodeConfig({}, 'runbook') }), null);
    assert.equal(createGuiSubsystem({ ...common, nodeConfig: nodeConfig() }), null, 'no helper-secret.json yet');
    assert.deepEqual(log.errors, []);
  });

  // R-F5-14 (owner ruling, 2026-10-13): installing the helper enables
  // nothing. Only "gui: enabled: true" in node.yaml does.
  it('R-F5-14: an installed helper with no "enabled: true" in node.yaml starts nothing; status and doctor say what to add', async () => {
    const { configDir, dataDir } = dirs();
    install(configDir);
    const apps = { calculator: { path: POSIX ? '/usr/bin/gnome-calculator' : 'C:\\Windows\\System32\\calc.exe' } };
    for (const raw of [undefined, {}, { apps }, { enabled: false, apps }]) {
      const log = spyLog();
      const a = approvals();
      const config = { ...nodeConfig(), gui: parseGuiConfig(raw, { profile: 'agent' }) };
      assert.equal(createGuiSubsystem({ nodeConfig: config, dataDir, configDir, cipher, approvals: a, adminUid: UID, geteuid: () => UID, log }), null, JSON.stringify(raw));
      assert.equal(a.relayClient.methods.size, 0);
      assert.deepEqual(log.errors, []);
      assert.match(log.all(), /enabled: true/);
    }
    const io = () => { const out = []; return { out, io: { stdout: { write: (t) => out.push(String(t)) }, stderr: { write: () => {} }, stdin: null } }; };
    const status = async () => { const t = io(); assert.equal(await runSessionCommand({ sub: 'status', flags: {}, dataDir, io: t.io, deps: { configDir, platform: process.platform, adminUid: UID } }), 0); return t.out.join(''); };
    const helperRows = async () => (await runDoctor({ dataDir, adminUid: UID, configDir })).filter((r) => /session helper/.test(r.check));

    // No node.yaml, then one that lists apps but does not enable them.
    for (const yaml of [null, 'name: gpu-box\n', `name: gpu-box\ngui:\n  apps:\n    calculator: '${apps.calculator.path}'\n`]) {
      if (yaml !== null) fs.writeFileSync(path.join(configDir, 'node.yaml'), yaml, { mode: 0o644 });
      const said = await status();
      assert.match(said, /installed but not enabled in node\.yaml/);
      assert.match(said, /gui:\n\s+enabled: true/);
      const rows = await helperRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ok, true);
      assert.equal(rows[0].warn, true);
      assert.match(rows[0].detail, /installed but not enabled in node\.yaml/);
      assert.match(rows[0].detail, /enabled: true/);
    }
    // Enabled: neither says it.
    fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: gpu-box\ngui:\n  enabled: true\n', { mode: 0o644 });
    assert.doesNotMatch(await status(), /not enabled/);
    const rows = await helperRows();
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].warn);
    assert.doesNotMatch(rows[0].detail, /not enabled/);
  });

  // Second security review, finding 13: doctor prints what the running
  // service wrote to status.json and a name from the helper file; neither
  // goes to the administrator's terminal raw.
  it('finding 13: doctor shows the service\'s reason and detail, and the installed user\'s name, as clean single lines', async () => {
    const { writeGuiStatus } = require('../src/gui/status');
    const DANGEROUS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/;
    const { configDir, dataDir } = dirs();
    install(configDir);
    fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: gpu-box\ngui:\n  enabled: true\n', { mode: 0o644 });
    fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
    writeGuiStatus(dataDir, {
      v: 1, pid: process.pid, available: false, reason: 'gui_start_failed\u001b[2J', detail: 'EADDRINUSE\n[ok] node config‮',
      user: null, platform: null, capabilities: [], probes: [], limits: [], apps: [], since: null, updated_at: new Date().toISOString(), lease: null
    });
    const rows = (await runDoctor({ dataDir, adminUid: UID, configDir })).filter((r) => /desktop apps|session helper/.test(r.check));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ok, false);
    assert.ok(!DANGEROUS.test(rows[0].detail), JSON.stringify(rows[0].detail));
    assert.match(rows[0].detail, /^off, gui_start_failed\[2J \[hidden or control characters removed\]: EADDRINUSE \[ok\] node config \[hidden or control characters removed\]\. To fix it, /);
    // The installed user's name comes from the helper file.
    fs.rmSync(path.join(dataDir, 'session'), { recursive: true, force: true });
    const file = require('../src/gui/session-secret').canonicalPath(configDir);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, session_user: 'alice\u001b[2K\rroot' }), { mode: 0o640 });
    const named = (await runDoctor({ dataDir, adminUid: UID, configDir })).filter((r) => /session helper/.test(r.check));
    assert.equal(named.length, 1);
    assert.ok(!DANGEROUS.test(named[0].detail), JSON.stringify(named[0].detail));
    assert.match(named[0].detail, /^installed for alice\[2K root \[hidden or control characters removed\]; /);
  });

  // R-F5-11 (owner ruling, 2026-10-12): a helper file that is there but
  // cannot be used turns desktop apps off, with a reason; it never throws
  // (the service still starts) and is never accepted.
  const SECRET_HEX = 'ab'.repeat(32);
  const badFiles = {
    'is not JSON': (file) => fs.writeFileSync(file, '{ "secret": "klc1:not json'),
    'does not decrypt': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...raw, secret: createAesGcmCipher(crypto.randomBytes(32)).encryptString(SECRET_HEX) }));
    },
    'is malformed (no endpoint id)': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete raw.endpoint_id;
      fs.writeFileSync(file, JSON.stringify(raw));
    },
    'holds no valid secret': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...raw, secret: cipher.encryptString('nope') }));
    },
    'was written for another node': (file) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...raw, node_id: 'kl-c2ubd6jjqumalzt5' }));
    },
    'is a directory': (file) => { fs.unlinkSync(file); fs.mkdirSync(file); }
  };
  // The owner check is a uid comparison, which Windows does not have.
  if (POSIX) badFiles['is not owned by the administrator'] = () => 'wrong-admin';

  for (const [name, damage] of Object.entries(badFiles)) {
    it(`R-F5-11: a helper file that ${name} turns the GUI off with session_file_invalid; nothing throws, no channel opens, every tool refuses`, async () => {
      const { configDir, dataDir } = dirs();
      install(configDir);
      const file = S.canonicalPath(configDir);
      const wrongAdmin = damage(file) === 'wrong-admin';
      if (POSIX && !wrongAdmin && fs.statSync(file).isFile()) fs.chmodSync(file, 0o640);
      const log = spyLog();
      const a = approvals();
      const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, configDir, cipher, approvals: a, adminUid: wrongAdmin ? UID + 1 : UID, geteuid: () => UID, log });
      assert.ok(gui, 'the subsystem exists so that its tools can say why they refuse');
      assert.equal(gui.unavailable.reason, 'session_file_invalid');
      assert.equal(gui.channel, null, 'no helper channel');
      assert.equal(gui.broker, null);
      assert.equal(gui.leases, null, 'and no lease manager');
      assert.equal(a.relayClient.methods.size, 0, 'no lease link method is registered');
      const cap = gui.capability();
      assert.equal(cap.available, false);
      assert.equal(cap.reason, 'session_file_invalid');
      assert.deepEqual(cap.capabilities, []);
      // Logged once, at error level, with the remedy and nothing of the file's contents.
      assert.equal(log.errors.length, 1, log.errors.join('\n'));
      assert.match(log.errors[0], /desktop apps are off/);
      assert.match(log.errors[0], /session uninstall --user NAME/);
      assert.ok(!log.all().includes('klc1:') && !log.all().includes(SECRET_HEX), 'no secret material in any log line');

      const registry = new ToolRegistry();
      gui.registerTools(registry);
      assert.equal(registry.list().length, 10);
      for (const tool of registry.list()) {
        const out = await registry.get(tool.name).execute({}, { origin: { client: 'x', session: 'c1', job_id: null } });
        assert.equal(out.ok, false, tool.name);
        assert.match(out.error, /^capability_unavailable: gui \(session_file_invalid: /, tool.name);
        assert.match(out.error, /session install --user NAME/, tool.name);
      }

      await gui.start();
      cleanups.push(() => gui.stop());
      assert.equal(readGuiStatus({ dataDir }).available, false);
      const record = readGuiStatusRecord({ dataDir });
      assert.equal(record.available, false);
      assert.equal(record.reason, 'session_file_invalid');
      assert.ok(!JSON.stringify(record).includes('klc1:'));

      // "session status" and "doctor" say so, with the remedy.
      const out = [];
      const io = { stdout: { write: (t) => out.push(String(t)) }, stderr: { write: () => {} }, stdin: null };
      assert.equal(await runSessionCommand({ sub: 'status', flags: {}, dataDir, io, deps: { configDir, platform: process.platform } }), 0);
      assert.match(out.join(''), /helper: off \(session_file_invalid\)/);
      assert.match(out.join(''), /session uninstall --user NAME/);
      const rows = await runDoctor({ dataDir, adminUid: wrongAdmin ? UID + 1 : UID, configDir });
      const bad = rows.filter((r) => /session helper|desktop apps/.test(r.check) && r.ok === false);
      assert.equal(bad.length, 1, JSON.stringify(rows.filter((r) => /session helper|desktop apps/.test(r.check))));
      assert.match(bad[0].detail, /session_file_invalid/);
      assert.match(bad[0].detail, /session uninstall --user NAME/);
      await gui.stop();
    });
  }

  // Security review finding 2: not only a bad file. Nothing in building or
  // starting the GUI may stop the service: it is off, with a reason.
  // Something else already holds the helper endpoint: another process's pipe
  // on Windows; elsewhere a directory, which the channel cannot replace.
  async function takeEndpoint(base) {
    const net = require('net');
    const ep = endpoint(base);
    if (POSIX) {
      fs.mkdirSync(ep);
      fs.writeFileSync(path.join(ep, 'x'), '');
      return ep;
    }
    const squatter = net.createServer(() => {});
    await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(ep, resolve); });
    cleanups.push(() => new Promise((resolve) => squatter.close(() => resolve())));
    return ep;
  }

  it('finding 2: a start that fails (the endpoint is already taken) leaves the GUI off with gui_start_failed; start() does not throw', async () => {
    const { base, configDir, dataDir } = dirs();
    install(configDir);
    const ep = await takeEndpoint(base);
    const log = spyLog();
    const a = approvals();
    const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, configDir, cipher, approvals: a, adminUid: UID, geteuid: () => UID, log, deps: { endpoint: ep } });
    assert.ok(gui && !gui.unavailable, 'built normally');
    const registry = new ToolRegistry();
    gui.registerTools(registry);
    await gui.start();
    cleanups.push(() => gui.stop());
    assert.equal(gui.unavailable.reason, 'gui_start_failed');
    assert.equal(log.errors.length, 1, log.errors.join('\n'));
    assert.match(log.errors[0], /desktop apps are off/);
    const cap = gui.capability();
    assert.equal(cap.available, false);
    assert.equal(cap.reason, 'gui_start_failed');
    assert.equal(gui.channel.server, null, 'nothing is listening');
    // The tools the core registered before the start refuse with the reason.
    for (const tool of registry.list()) {
      const out = await registry.get(tool.name).execute(tool.name === 'RequestLease' ? { apps: ['calculator'], reason: 'x' } : {}, { origin: { client: 'x', session: 'c1', job_id: null } });
      assert.equal(out.ok, false, tool.name);
      if (['ListApps', 'RequestLease'].includes(tool.name)) assert.match(out.error, /^capability_unavailable: gui \(gui_start_failed: /, tool.name);
    }
    assert.equal(readGuiStatusRecord({ dataDir }).reason, 'gui_start_failed');
    assert.equal(readGuiStatus({ dataDir }).available, false);
    // A helper cannot change that: nothing of this subsystem listens.
    await gui.stop();
    await gui.stop();
  });

  it('finding 2: a build that throws gives a subsystem that is off with gui_start_failed, not an exception', async () => {
    const { base, configDir, dataDir } = dirs();
    install(configDir);
    const log = spyLog();
    const a = approvals();
    a.relayClient.registerMethod = () => { throw new Error('the relay client is not what it should be'); };
    const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, configDir, cipher, approvals: a, adminUid: UID, geteuid: () => UID, log, deps: { endpoint: endpoint(base) } });
    assert.ok(gui);
    assert.equal(gui.unavailable.reason, 'gui_start_failed');
    assert.equal(gui.channel, null);
    assert.equal(gui.leases, null);
    assert.equal(log.errors.length, 1);
    const registry = new ToolRegistry();
    gui.registerTools(registry);
    const out = await registry.get('ListApps').execute({}, {});
    assert.match(out.error, /^capability_unavailable: gui \(gui_start_failed: /);
    await gui.start();
    await gui.stop();
    // Even a node config that cannot be read at all does not throw.
    const broken = createGuiSubsystem({ nodeConfig: null, dataDir, configDir, cipher, approvals: approvals(), adminUid: UID, geteuid: () => UID, log: spyLog() });
    assert.equal(broken.unavailable.reason, 'gui_start_failed');
  });

  it('R-F5-11: doctor is quiet about a helper that is not installed and passes one that is', async () => {
    const { configDir, dataDir } = dirs();
    let rows = await runDoctor({ dataDir, adminUid: UID, configDir });
    assert.deepEqual(rows.filter((r) => /session helper|desktop apps/.test(r.check)), []);
    install(configDir);
    rows = await runDoctor({ dataDir, adminUid: UID, configDir });
    const row = rows.filter((r) => /session helper/.test(r.check));
    assert.equal(row.length, 1);
    assert.equal(row[0].ok, true);
  });

  it('builds the channel, broker, leases and live view; registers the tools and the lease link methods', async () => {
    const { base, configDir, dataDir } = dirs();
    const secret = install(configDir);
    const a = approvals();
    const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, configDir, cipher, approvals: a, adminUid: UID, geteuid: () => UID, deps: { endpoint: endpoint(base) } });
    assert.ok(gui);
    assert.deepEqual([...a.relayClient.methods.keys()], ['lease.grant', 'lease.revoke', 'lease.watch', 'lease.list']);
    // R-F5-20: lease.list takes the phone's nonce; a device this node does not know gets no listing, with or without one.
    assert.deepEqual(await a.relayClient.methods.get('lease.list')({ device_id: 'd-aaaaaaaaaaaaaaaa', nonce: 'n'.repeat(43) }), { statuses: [] });
    assert.deepEqual(await a.relayClient.methods.get('lease.list')(), { statuses: [] });
    const registry = new ToolRegistry();
    gui.registerTools(registry);
    assert.equal(registry.list().length, 10);

    await gui.start();
    cleanups.push(() => gui.stop());
    assert.equal(gui.capability().available, false);
    const ready = once(gui.channel, 'ready');
    const backend = { probe: async () => ({}), foreground: async () => null };
    const session = await connectToService({
      endpoint: gui.channel.endpoint, secret, nodeId: identity.nodeId, user: 'alice', platform: process.platform, helperVersion: 'test',
      probeReport: { capabilities: ['gui.launch'], probes: [], displays: [], limits: [], locked: false }, handleOp: createOpHandler(backend)
    });
    cleanups.push(() => session.close());
    await ready;
    assert.equal(gui.capability().available, true);
    assert.deepEqual(readGuiStatus({ dataDir }).capabilities, ['gui.launch']);
    const closed = once(gui.channel, 'closed');
    session.close();
    await closed;
    assert.equal(readGuiStatus({ dataDir }).available, false);
  });

  // Security review finding 6 (the test the reviewer listed as missing): a
  // rotation against a running channel.
  it('finding 6: after a rotation that keeps the endpoint, the running service drops the old helper and takes the new secret, with no restart', async () => {
    const { base, configDir, dataDir } = dirs();
    const oldSecret = install(configDir);
    const first = S.readCanonical({ configDir, cipher, adminUid: UID, geteuid: () => UID });
    const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, configDir, cipher, approvals: approvals(), adminUid: UID, geteuid: () => UID, deps: { endpoint: endpoint(base) } });
    await gui.start();
    cleanups.push(() => gui.stop());
    const backend = { probe: async () => ({}), foreground: async () => null };
    const connect = (secret) => connectToService({
      endpoint: gui.channel.endpoint, secret, nodeId: identity.nodeId, user: 'alice', platform: process.platform, helperVersion: 'test',
      probeReport: { capabilities: ['gui.launch'], probes: [], displays: [], limits: [], locked: false }, handleOp: createOpHandler(backend)
    });
    let ready = once(gui.channel, 'ready');
    const helper = await connect(oldSecret);
    cleanups.push(() => helper.close());
    await ready;
    assert.equal(gui.capability().available, true);

    // "session install" again for the same user: a new secret, the same endpoint.
    const { secret: newSecret } = S.mintSessionSecret();
    await new Promise((r) => setTimeout(r, 20)); // a later mtime, also on a coarse filesystem clock
    S.writeCanonical({ configDir, cipher, secret: newSecret, endpointId: first.endpointId, nodeId: identity.nodeId, sessionUser: 'alice' });
    assert.notEqual(S.canonicalMtime(configDir), first.mtimeMs);

    // The service notices at its next check of the connection and drops it.
    const closed = once(gui.channel, 'closed');
    gui.channel._tick(gui.channel.current);
    await closed;
    assert.equal(gui.capability().available, false);
    // The old secret no longer gets in; the new one does, on the same endpoint.
    await assert.rejects(connect(oldSecret));
    ready = once(gui.channel, 'ready');
    const again = await connect(newSecret);
    cleanups.push(() => again.close());
    await ready;
    assert.equal(gui.capability().available, true);
  });

  it('R-F5-7: isJobOpen fails closed', () => {
    // JobManager#getJob answers null for a job it does not have.
    const jobManager = { getJob: (id) => (['job-run', 'job-done'].includes(id) ? { job_id: id } : null), isTerminal: (id) => id === 'job-done' };
    const chats = new Set(['c1']);
    const deps = { jobManager, chatExists: (id) => chats.has(id) };
    assert.equal(isJobOpen(deps, 'job-run'), true);
    assert.equal(isJobOpen(deps, 'job-done'), false, 'terminal');
    assert.equal(isJobOpen(deps, 'job-forgotten'), false, 'a job the JobManager does not know is not open');
    assert.equal(isJobOpen(deps, 'chat:c1'), true);
    assert.equal(isJobOpen(deps, 'chat:gone'), false, 'no such chat');
    assert.equal(isJobOpen(deps, 'chat:'), false);
    assert.equal(isJobOpen({ jobManager: null, chatExists: () => true }, 'job-run'), false, 'no fleet node yet');
    assert.equal(isJobOpen({ jobManager }, 'chat:c1'), false, 'no chat lookup given');
    assert.equal(isJobOpen({ jobManager, chatExists: () => { throw new Error('store unavailable'); } }, 'chat:c1'), false);
    assert.equal(isJobOpen({ jobManager, chatExists: () => 'yes' }, 'chat:c1'), false, 'only true is open');
    for (const bad of [null, undefined, '', 7]) assert.equal(isJobOpen(deps, bad), false, String(bad));
    assert.equal(isJobOpen(undefined, 'job-run'), false);
  });

  it('with no jobOpen from its host, the subsystem holds no lease', async () => {
    const { base, configDir, dataDir } = dirs();
    install(configDir);
    const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, configDir, cipher, approvals: approvals(), adminUid: UID, geteuid: () => UID, deps: { endpoint: endpoint(base) } });
    await assert.rejects(gui.leases.request({ jobId: 'job-1', origin: null, appIds: ['calculator'], minutes: 5, reason: 'x' }), (e) => e.code === 'job_closed');
  });
});

describe('host wiring', () => {
  it('FleetToolHandler lists gui as a capability only while it is available', async () => {
    const handler = new FleetToolHandler({
      nodeConfig: { name: 'gpu-box', profile: 'agent', capabilities: ['cuda'], policy: { allowed_roots: [] } },
      jobManager: { maxConcurrentJobs: 2, jobs: new Map() },
      gui: () => ({ available: true, capabilities: ['gui.launch'], apps: [{ id: 'calculator', name: 'Calculator' }], limits: [], lease: null })
    });
    const [row] = await handler.call('list_machines', {});
    assert.deepEqual(row.capabilities, ['cuda', 'gui']);
    assert.deepEqual(row.gui.apps, [{ id: 'calculator', name: 'Calculator' }]);
    const off = new FleetToolHandler({
      nodeConfig: { name: 'gpu-box', profile: 'agent', capabilities: ['cuda'], policy: { allowed_roots: [] } },
      jobManager: { maxConcurrentJobs: 2, jobs: new Map() },
      gui: () => ({ available: false, capabilities: [], apps: [], limits: [], lease: null })
    });
    assert.deepEqual((await off.call('list_machines', {}))[0].capabilities, ['cuda']);
    const described = await handler.call('describe_machine', { machine: 'gpu-box' });
    assert.deepEqual(described.capabilities, ['cuda', 'gui']);
    assert.ok(!JSON.stringify(described.gui).includes('calc.exe'), 'never paths');
  });

  it('R-F5-3: refuseUnsafe reaches the GUI tools through ToolExecutor', async () => {
    const ToolExecutor = require('../src/execution/tool-executor');
    const { toolRegistry } = require('../src/tools');
    const { buildGuiTools, GUI_TOOL_NAMES } = require('../src/gui/tools');
    const { shouldRefuseUnsafe } = require('../src/fleet/delegate-sessions');
    const { REFUSE_UNSAFE_MESSAGE } = require('../src/approvals/executor-options');

    // What DelegateSessions computes for a turn (M19), from the caller's origin.
    const node = { name: 'gpu-box' };
    const frontDoor = (scopes) => ({ kind: 'frontdoor', client_id: 'c-1', client_name: 'Example Client', grant_id: 'g-1', scopes });
    assert.equal(shouldRefuseUnsafe(frontDoor(['fleet:delegate']), node), true);
    assert.equal(shouldRefuseUnsafe(frontDoor(['fleet:delegate', 'fleet:unsafe;machines=web-01']), node), true, 'fleet:unsafe for another machine does not count');
    assert.equal(shouldRefuseUnsafe(frontDoor(['fleet:delegate', 'fleet:unsafe']), node), false);
    assert.equal(shouldRefuseUnsafe({ kind: 'stdio', client: 'stdio-mcp', session: null }, node), false, 'the node\'s own MCP client');
    assert.equal(shouldRefuseUnsafe({ kind: 'service-chat' }, node), false, 'the service\'s own chat');

    // The tools, on the shared registry, with a lease manager that must not be reached.
    const reached = [];
    const leases = { available: () => true, request: async (r) => { reached.push(r); throw new Error('the lease manager was reached'); } };
    const launched = [];
    const broker = { require: () => {}, launch: async (r) => { launched.push(r); return { app_id: r.appId, pid: 1, tier: r.tier, launched_at: 'x' }; } };
    for (const t of buildGuiTools({ broker, leases, guiConfig: nodeConfig().gui, getPolicy: () => ({}) })) toolRegistry.register(t);
    cleanups.push(() => { for (const n of GUI_TOOL_NAMES) toolRegistry.unregister(n); });

    // The run a front-door delegate turn without fleet:unsafe gets.
    const origin = { client: 'Example Client', session: 'mcp-1', job_id: 'job-1' };
    const asked = [];
    const refusing = new ToolExecutor({
      requireApproval: false, refuseUnsafe: true, origin, extraToolOptions: { origin },
      approvalRequester: async (...args) => { asked.push(args); return true; }
    });
    assert.deepEqual(await refusing.execute('RequestLease', { apps: ['calculator'], reason: 'x' }), { ok: false, error: REFUSE_UNSAFE_MESSAGE });
    const exe = process.execPath;
    assert.deepEqual(await refusing.execute('LaunchApp', { app: exe }), { ok: false, error: REFUSE_UNSAFE_MESSAGE }, 'not allowlisted, so unsafe');
    // R-F5-13: the reading tools and an allowlisted launch are refused the same way.
    for (const [name, params] of [['ListApps', {}], ['Screenshot', {}], ['LaunchApp', { app: 'calculator' }], ['CloseApp', { app: 'calculator' }], ['Key', { keys: 'a' }]]) {
      assert.deepEqual(await refusing.execute(name, params), { ok: false, error: REFUSE_UNSAFE_MESSAGE }, name);
    }
    assert.deepEqual(reached, []);
    assert.deepEqual(launched, []);
    assert.deepEqual(asked, [], 'the phone was never asked');

    // The same call from a run the node started itself goes on to the lease manager.
    const local = new ToolExecutor({ requireApproval: false, origin, extraToolOptions: { origin } });
    const out = await local.execute('RequestLease', { apps: ['calculator'], reason: 'x' });
    assert.equal(reached.length, 1);
    assert.match(out.error, /the lease manager was reached/);
  });

  it('createCore exposes getGuiBroker and registers the GUI tools at start', async () => {
    const { createCore } = require('../src/core');
    const { JsonFileStore } = require('../src/platform/json-file-store');
    const { createHeadlessPrompter } = require('../src/platform/prompter');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-core-'));
    // On Windows an open history.sqlite keeps its folder from being deleted.
    cleanups.push(() => { closeOpenHistoryStores(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const broker = { marker: true };
    let registered = 0;
    const fakeGui = { broker, registerTools: (registry) => { registered += 1; assert.ok(typeof registry.register === 'function'); } };
    const deps = {
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher, prompter: createHeadlessPrompter(), ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      gui: fakeGui
    };
    const core = createCore(deps);
    assert.equal(core.context.getGuiBroker(), broker);
    await core.start();
    assert.equal(registered, 1);
    await core.shutdown();
    const bare = createCore({ ...deps, gui: undefined });
    assert.equal(bare.context.getGuiBroker(), null);
  });
});

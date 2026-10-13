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
const { readGuiStatus } = require('../src/gui/status');
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
  gui: parseGuiConfig({ apps: { calculator: { path: POSIX ? '/usr/bin/gnome-calculator' : 'C:\\Windows\\System32\\calc.exe' } }, ...gui }, { profile })
});

function install(configDir, { nodeId = identity.nodeId } = {}) {
  const { secret, endpointId } = S.mintSessionSecret();
  S.writeCanonical({ configDir, cipher, secret, endpointId, nodeId, sessionUser: 'alice' });
  return secret;
}

const approvals = () => ({ identity, approverStore: { get: () => null }, relayClient: new FakeRelay(), phoneApprover: { isAvailable: () => true }, auditLedger: { append: async () => {} } });

describe('createGuiSubsystem', () => {
  it('is null when gui is off, on a runbook node, when not installed, or installed for another node', () => {
    const { configDir, dataDir } = dirs();
    const common = { dataDir, configDir, cipher, approvals: approvals(), adminUid: UID, geteuid: () => UID };
    assert.equal(createGuiSubsystem({ ...common, nodeConfig: nodeConfig({ enabled: false }) }), null);
    assert.equal(createGuiSubsystem({ ...common, nodeConfig: nodeConfig({}, 'runbook') }), null);
    assert.equal(createGuiSubsystem({ ...common, nodeConfig: nodeConfig() }), null, 'no helper-secret.json yet');
    install(configDir, { nodeId: 'kl-c2ubd6jjqumalzt5' });
    assert.equal(createGuiSubsystem({ ...common, nodeConfig: nodeConfig() }), null, 'installed for another node');
  });

  it('builds the channel, broker, leases and live view; registers the tools and the lease link methods', async () => {
    const { base, configDir, dataDir } = dirs();
    const secret = install(configDir);
    const a = approvals();
    const gui = createGuiSubsystem({ nodeConfig: nodeConfig(), dataDir, configDir, cipher, approvals: a, adminUid: UID, geteuid: () => UID, deps: { endpoint: endpoint(base) } });
    assert.ok(gui);
    assert.deepEqual([...a.relayClient.methods.keys()], ['lease.grant', 'lease.revoke', 'lease.watch']);
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

// tests/fleet-node-host.test.js — fleet stage 4 §3.7, R24.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { setLogLevel, addSink } = require('../src/logging');
const { loadProfile } = require('../src/service/run');
const { FileCourier } = require('../src/approvals/courier');
const { CourierFleetClient } = require('../src/fleet/courier-client');
const { ToolError } = require('../src/fleet/fleet-tools');
const { acquireInstanceLock } = require('../src/service/pidfile');
const { holdEventLoop } = require('./helpers/hold-event-loop');

setLogLevel('warn');
const release = holdEventLoop();
const temps = [];
after(() => { release(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;

function layout({ runbooks = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fleet-host-'));
  temps.push(base);
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(configDir, 'runbooks'), { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); fs.chmodSync(path.join(configDir, 'runbooks'), 0o755); }
  fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: web-01\nprofile: runbook\npolicy:\n  max_concurrent_jobs: 1\n', { mode: 0o644 });
  for (const [name, yaml] of Object.entries(runbooks)) fs.writeFileSync(path.join(configDir, 'runbooks', `${name}.yaml`), yaml, { mode: 0o644 });
  return { base, dataDir, configDir };
}

const SLEEPY = `name: site.sleep
description: Sleep a while
tier: read
steps:
  - run: ["${process.execPath.replace(/\\/g, '\\\\')}", "-e", "setTimeout(() => {}, 1500)"]
`;

describe('startFleetNode on the runbook profile', () => {
  it('hosts the engine and JobManager with no front door configured', async () => {
    const l = layout({ runbooks: { 'site.sleep': SLEEPY } });
    const running = await loadProfile('runbook').start({ dataDir: l.dataDir, configDir: l.configDir, adminUid: EUID });
    try {
      assert.ok(running.fleet, 'the runbook profile hosts the fleet node');
      assert.ok(running.fleet.runbookEngine.getRunbook('site.sleep'));
      assert.equal(running.fleet.jobManager.maxConcurrentJobs, 1);
      assert.equal(running.fleet.delegateSessions, null);
      assert.equal(running.fleet.fleetService, null, 'no relay link, no fleet link methods');
    } finally {
      await running.stop();
    }
  });

  it('mcp through the courier shares the service\'s one max_concurrent_jobs', async () => {
    const l = layout({ runbooks: { 'site.sleep': SLEEPY } });
    const lock = acquireInstanceLock(l.dataDir);
    const running = await loadProfile('runbook').start({ dataDir: l.dataDir, configDir: l.configDir, adminUid: EUID });
    const courier = new FileCourier({ dataDir: l.dataDir, pollMs: 20 }).start();
    try {
      const client = new CourierFleetClient({ courier, nodeConfig: { name: 'web-01' } });
      const first = await client.call('run_runbook', { machine: 'web-01', runbook: 'site.sleep' });
      assert.equal(first.status, 'queued');
      assert.ok(running.fleet.jobManager.getJob(first.job_id), 'the job lives in the service');
      await assert.rejects(client.call('run_runbook', { machine: 'web-01', runbook: 'site.sleep' }),
        (err) => err instanceof ToolError && err.code === 'max_concurrent_jobs');
      const direct = running.fleet.handler;
      await assert.rejects(direct.call('run_runbook', { machine: 'web-01', runbook: 'site.sleep' }), (err) => err.code === 'max_concurrent_jobs');
    } finally {
      courier.stop();
      await running.stop();
      lock.release();
    }
  });

  it('callService refuses at once when no service runs', async () => {
    const l = layout();
    const courier = new FileCourier({ dataDir: l.dataDir }).start();
    try {
      await assert.rejects(courier.callService('fleet.get_state', { args: {} }), (err) => err.code === 'unavailable' && /not running/.test(err.message));
    } finally {
      courier.stop();
    }
  });
});

describe('mcp without a service', () => {
  it('runs standalone with its own engine and says so once', async () => {
    const l = layout();
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    const { runMcp } = require('../src/service/commands/mcp');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = [];
    stdout.on('data', (d) => out.push(String(d)));
    runMcp({ dataDir: l.dataDir, io: { stdin, stdout, stderr: new PassThrough() }, deps: { configDir: l.configDir, adminUid: EUID } }).catch(() => {});
    try {
      for (let i = 0; i < 200 && !warnings.some((m) => m.includes('no service is running')); i += 1) await new Promise((r) => setTimeout(r, 10));
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_state', arguments: {} } })}\n`);
      for (let i = 0; i < 200 && !out.join('').includes('"id":1'); i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.ok(out.join('').includes('web-01'));
      assert.equal(warnings.filter((m) => m.includes(`no service is running on ${l.dataDir}: this mcp process enforces its own max_concurrent_jobs and rate limits`)).length, 1);
    } finally {
      remove();
      stdin.end();
    }
  });
});

describe('the courier RPC path', () => {
  const { courierRpcHandler, startFleetNode } = require('../src/fleet/start');
  const { CourierPump } = require('../src/approvals/courier');
  const { STDIO_ORIGIN } = require('../src/fleet/fleet-tools');
  const FAKE_IDENTITY = { publicKey: Buffer.alloc(32), nodeId: 'node-test' };

  it('always calls the handler as the local stdio client, whatever origin the request file names', async () => {
    const seen = [];
    const rpc = courierRpcHandler({ call: async (name, args, opts) => { seen.push({ name, args, opts }); return { ok: true }; } });
    const forged = { kind: 'frontdoor', grant_id: 'g-1', client_id: 'dcr_x', scopes: ['fleet:unsafe'] };
    const reply = await rpc('fleet.get_state', { args: { machine: 'web-01' }, origin: forged });
    assert.deepEqual(reply, { result: { ok: true } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, 'get_state');
    assert.deepEqual(seen[0].args, { machine: 'web-01' });
    assert.equal(seen[0].opts.origin, STDIO_ORIGIN);
  });

  it('answers a tool error as data and refuses anything that is not fleet.*', async () => {
    const rpc = courierRpcHandler({ call: async () => { throw new ToolError('unknown_machine', 'nope', { hint: 1 }); } });
    assert.deepEqual(await rpc('fleet.get_state', {}), { tool_error: { code: 'unknown_machine', message: 'nope', data: { hint: 1 } } });
    await assert.rejects(rpc('approval.submit', {}), (err) => err.code === 'unknown_method');
  });

  it('a pump with no relay answers signed methods relay_offline and forwards nothing', async () => {
    const l = layout();
    const pump = new CourierPump({ dataDir: l.dataDir, relayClient: null, identity: FAKE_IDENTITY });
    const replies = [];
    pump._reply = (to, body) => replies.push(body);
    await pump._handle({ method: 'approval.submit', params: { envelope: {} }, reply_to: { inbox: 'p-1-abcdef01', key: 'a'.repeat(16) } });
    assert.deepEqual(replies, [{ error: { code: 'relay_offline', message: 'no relay is paired with this node' } }]);
  });

  it('stop() takes the handler off a shared pump and cancels the node\'s jobs', async () => {
    const l = layout();
    const pump = new CourierPump({ dataDir: l.dataDir, relayClient: null, identity: FAKE_IDENTITY });
    const nodeConfig = { name: 'web-01', profile: 'runbook', runbooksDir: path.join(l.configDir, 'runbooks'), policy: { allowed_roots: [], max_concurrent_jobs: 2 } };
    const fleet = await startFleetNode({
      dataDir: l.dataDir, nodeConfig, adminUid: EUID, deps: { readGuiStatus: null },
      approvals: { courierPump: pump, identity: FAKE_IDENTITY, relayClient: null, phoneApprover: null, auditLedger: null }
    });
    assert.equal(fleet.courierPump, pump, 'startApprovals\' pump is reused, not a second one');
    assert.equal(typeof pump.rpcHandler, 'function');
    const job = fleet.jobManager.createJob({ machine: 'web-01', runbook: 'x', params: {}, tier: 'read', status: 'awaiting_approval' });
    await fleet.stop();
    assert.equal(pump.rpcHandler, null, 'nothing reaches the handler once the node has stopped');
    assert.equal(fleet.jobManager.getJob(job.job_id).status, 'cancelled');
  });
});

// Fix round 1 (Task 13 review).
describe('fleet node shutdown and startup failure (review items 2, 5, 6)', () => {
  const { startFleetNode } = require('../src/fleet/start');
  const { ensureServicePaths, ensurePrivateDir } = require('../src/platform/paths');
  const FAKE_IDENTITY = { publicKey: Buffer.alloc(32), nodeId: 'node-test' };
  const allOff = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };

  function agentLayout() {
    const l = layout();
    fs.writeFileSync(path.join(l.configDir, 'node.yaml'), 'name: web-01\nprofile: agent\npolicy:\n  max_concurrent_jobs: 1\n', { mode: 0o644 });
    ensureServicePaths(l.dataDir);
    const workspace = path.join(l.dataDir, 'workspace');
    ensurePrivateDir(workspace);
    return { ...l, workspace };
  }

  function fakeRelay({ failRegister = false } = {}) {
    return {
      registerMethod: () => { if (failRegister) throw new Error('register boom'); },
      on: () => {},
      off: () => {},
      call: async () => ({})
    };
  }

  function stubCore(order) {
    return {
      start: async () => {},
      whenListenersSettled: async () => {},
      getGatewayServer: () => ({ wss: null }),
      getWebhookServer: () => ({ httpServer: null }),
      shutdown: async () => { order.push('core.shutdown'); },
      context: { getAgentExecutorAdapter: () => ({ execute: async () => ({}) }), getAgent: () => ({ id: 'main' }), listAgents: () => [{ id: 'main' }] }
    };
  }

  // Replaces src/core and startApprovals for one agent-profile start, and
  // tracks every interval created while it runs.
  async function withStubs(order, { relay }, fn) {
    const coreEntry = require.resolve('../src/core');
    const wiringEntry = require.resolve('../src/approvals/service-wiring');
    const saved = { core: require.cache[coreEntry], wiring: require.cache[wiringEntry] };
    require.cache[coreEntry] = { id: coreEntry, filename: coreEntry, loaded: true, exports: { createCore: () => stubCore(order) } };
    require.cache[wiringEntry] = {
      id: wiringEntry, filename: wiringEntry, loaded: true,
      exports: {
        startApprovals: async () => ({
          phoneApprover: null, auditLedger: null, relayClient: relay, approverStore: null, identity: FAKE_IDENTITY, courierPump: null,
          stop: async () => { order.push('approvals.stop'); }
        })
      }
    };
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const live = new Set();
    global.setInterval = (...args) => { const t = realSetInterval(...args); live.add(t); return t; };
    global.clearInterval = (t) => { live.delete(t); return realClearInterval(t); };
    try {
      await fn();
    } finally {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      for (const [entry, key] of [[coreEntry, 'core'], [wiringEntry, 'wiring']]) {
        if (saved[key]) require.cache[entry] = saved[key]; else delete require.cache[entry];
      }
    }
    return live;
  }

  it('the agent profile stops the fleet node (link methods first) before the core shuts down', async () => {
    const l = agentLayout();
    const order = [];
    const live = await withStubs(order, { relay: fakeRelay() }, async () => {
      const running = await loadProfile('agent').start({ dataDir: l.dataDir, features: allOff, ports: {}, workspace: l.workspace, adminUid: EUID, configDir: l.configDir });
      assert.ok(running.fleet.fleetService, 'a relay link hosts the fleet link methods');
      assert.ok(running.fleet.delegateSessions, 'the agent profile hosts delegate sessions');
      const fleetService = running.fleet.fleetService;
      const stopService = fleetService.stop.bind(fleetService);
      fleetService.stop = () => { order.push('fleetService.stop'); stopService(); };
      await running.stop();
      assert.equal(fleetService.stopped, true);
    });
    assert.deepEqual(order, ['fleetService.stop', 'core.shutdown', 'approvals.stop']);
    assert.equal(live.size, 0, 'no interval (delegate sweep, courier pump) outlives stop()');
  });

  it('a fleet node that fails to start leaves nothing running, and the agent profile still stops the core and approvals', async () => {
    const l = agentLayout();
    const order = [];
    const live = await withStubs(order, { relay: fakeRelay({ failRegister: true }) }, async () => {
      await assert.rejects(
        loadProfile('agent').start({ dataDir: l.dataDir, features: allOff, ports: {}, workspace: l.workspace, adminUid: EUID, configDir: l.configDir }),
        /register boom/
      );
    });
    assert.deepEqual(order, ['core.shutdown', 'approvals.stop']);
    assert.equal(live.size, 0, 'the delegate sweep and any pump are stopped by startFleetNode itself');
  });

  function directNode(l, extra = {}) {
    const pump = new CourierPump({ dataDir: l.dataDir, relayClient: null, identity: FAKE_IDENTITY });
    const nodeConfig = { name: 'web-01', profile: 'runbook', runbooksDir: path.join(l.configDir, 'runbooks'), policy: { allowed_roots: [], max_concurrent_jobs: 2 } };
    return startFleetNode({
      dataDir: l.dataDir, nodeConfig, adminUid: EUID, deps: { readGuiStatus: null, ...extra },
      approvals: { courierPump: pump, identity: FAKE_IDENTITY, relayClient: null, phoneApprover: null, auditLedger: null }
    });
  }
  const { CourierPump } = require('../src/approvals/courier');

  it('stop() waits for running job executions to settle', async () => {
    const l = layout();
    const fleet = await directNode(l);
    let settled = false;
    fleet.handler.jobRuns.set('job-x', new Promise((r) => setTimeout(r, 150)).then(() => { settled = true; }));
    await fleet.stop();
    assert.equal(settled, true);
  });

  it('stop() gives up waiting after its bound and says so', async () => {
    const l = layout();
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      const fleet = await directNode(l, { stopWaitMs: 50 });
      fleet.handler.jobRuns.set('job-x', new Promise(() => {}));
      const t0 = Date.now();
      await fleet.stop();
      assert.ok(Date.now() - t0 < 2000);
      assert.ok(warnings.some((m) => /still running after 50 ms/.test(m)), warnings.join('\n'));
    } finally {
      remove();
    }
  });
});

describe('CourierFleetClient transport errors (review item 4)', () => {
  const { CourierError } = require('../src/approvals/courier');
  const client = (err) => new CourierFleetClient({ courier: { callService: async () => { throw err; } } });

  it('maps unavailable and closed to service_unavailable, timeout to a coded timeout with retry_after', async () => {
    for (const code of ['unavailable', 'closed']) {
      await assert.rejects(client(new CourierError(code, 'x')).call('get_state', {}), (err) => err instanceof ToolError && err.code === 'service_unavailable');
    }
    await assert.rejects(client(new CourierError('timeout', 'x')).call('get_state', {}),
      (err) => err instanceof ToolError && err.code === 'timeout' && err.data.retry_after === 5);
    await assert.rejects(client(new CourierError('unknown_method', 'x')).call('get_state', {}), (err) => err instanceof ToolError && err.code === 'unknown_method');
    await assert.rejects(client(new Error('C:\\secret\\path')).call('get_state', {}),
      (err) => err instanceof ToolError && err.code === 'internal' && !/secret/.test(err.message));
  });

  it('the service answers a handler\'s plain error as a coded internal error without its text', async () => {
    const { courierRpcHandler } = require('../src/fleet/start');
    const rpc = courierRpcHandler({ call: async () => { throw new Error('ENOENT /etc/secret'); } });
    assert.deepEqual(await rpc('fleet.get_state', { args: {} }), { tool_error: { code: 'internal', message: 'internal error', data: {} } });
  });
});

describe('mcp run as root (review item 7)', () => {
  const { assertCourierDirsSafe } = require('../src/service/commands/mcp');
  const asRoot = { getuid: () => 0 };
  const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

  function courierDirs(l) {
    for (const d of ['approvals', 'approvals/inbox', 'approvals/outbox']) fs.mkdirSync(path.join(l.dataDir, d), { recursive: true, mode: 0o700 });
  }

  it('is a no-op when not root', () => {
    const l = layout();
    assertCourierDirsSafe(l.dataDir, { getuid: () => 1000 });
  });

  it('as root, refuses missing courier directories and accepts real ones owned by the data dir owner', () => {
    const l = layout();
    assert.throws(() => assertCourierDirsSafe(l.dataDir, asRoot), /refusing to run mcp as root: .*approvals.* does not exist/);
    courierDirs(l);
    assertCourierDirsSafe(l.dataDir, asRoot);
  });

  it('as root, refuses an outbox that is a link or junction', () => {
    const l = layout();
    courierDirs(l);
    const outbox = path.join(l.dataDir, 'approvals', 'outbox');
    fs.rmSync(outbox, { recursive: true });
    const elsewhere = path.join(l.base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, outbox, 'junction');
    assert.throws(() => assertCourierDirsSafe(l.dataDir, asRoot), /outbox is not a real directory/);
  });

  it('as root, refuses a courier directory owned by someone other than the data dir owner', { skip: !IS_ROOT && 'needs POSIX root to chown' }, () => {
    const l = layout();
    courierDirs(l);
    fs.chownSync(l.dataDir, 1000, 1000);
    fs.chownSync(path.join(l.dataDir, 'approvals'), 1000, 1000);
    fs.chownSync(path.join(l.dataDir, 'approvals', 'inbox'), 1000, 1000);
    assert.throws(() => assertCourierDirsSafe(l.dataDir), /outbox is owned by uid 0, not the data dir's owner \(uid 1000\)/);
  });

  it('as root, runMcp refuses before writing anything when the courier directories are unsafe', async () => {
    const l = layout();
    fs.writeFileSync(path.join(l.dataDir, 'service.pid'), String(process.pid));
    const { runMcp } = require('../src/service/commands/mcp');
    await assert.rejects(
      runMcp({ dataDir: l.dataDir, io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }, deps: { configDir: l.configDir, adminUid: EUID, proc: { getuid: () => 0 } } }),
      /refusing to run mcp as root/
    );
    assert.equal(fs.existsSync(path.join(l.dataDir, 'approvals')), false, 'nothing was created');
  });

  // Runs `mcp` (courier branch: the pidfile names the child) in a child
  // process, because dropping privileges changes the whole process; the
  // child reports its uid/euid/gid and what it created, then exits.
  function runMcpChild(l) {
    const { execFileSync } = require('child_process');
    const script = `
      const fs = require('fs');
      const path = require('path');
      const { PassThrough } = require('stream');
      const dataDir = process.env.KL_T_DATA_DIR;
      fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
      const { runMcp } = require('./src/service/commands/mcp');
      const stdin = new PassThrough();
      runMcp({ dataDir, io: { stdin, stdout: new PassThrough(), stderr: new PassThrough() },
        deps: { configDir: process.env.KL_T_CONFIG_DIR, adminUid: 0 } })
        .catch((err) => { process.stdout.write(JSON.stringify({ error: err.message })); process.exit(0); });
      setTimeout(() => stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_state', arguments: {} } }) + '\\n'), 100);
      setTimeout(() => {
        const outbox = path.join(dataDir, 'approvals', 'outbox');
        const inboxRoot = path.join(dataDir, 'approvals', 'inbox');
        const owners = (dir) => fs.readdirSync(dir).map((n) => ({ name: n, uid: fs.lstatSync(path.join(dir, n)).uid }));
        process.stdout.write(JSON.stringify({ uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), groups: process.getgroups(), outbox: owners(outbox), inbox: owners(inboxRoot) }));
        process.exit(0);
      }, 800);
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, KL_T_DATA_DIR: l.dataDir, KL_T_CONFIG_DIR: l.configDir, KING_LOUIE_LOG_LEVEL: 'silent' }
    }).toString();
    return JSON.parse(out);
  }

  function serviceOwnedLayout(uid = 1000, gid = 1000) {
    const l = layout();
    courierDirs(l);
    for (const d of ['', 'approvals', 'approvals/inbox', 'approvals/outbox']) fs.chownSync(path.join(l.dataDir, d), uid, gid);
    return l;
  }

  it('as root, mcp becomes the data dir owner before any courier write, and its request files are that owner\'s with no chown', { skip: !IS_ROOT && 'needs POSIX root' }, () => {
    const l = serviceOwnedLayout(1000, 1001);
    const r = runMcpChild(l);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.uid, 1000);
    assert.equal(r.euid, 1000);
    assert.equal(r.gid, 1001);
    assert.ok(!r.groups.includes(0), `supplementary groups cleared: ${JSON.stringify(r.groups)}`);
    const requests = r.outbox.filter((f) => /^\d+-[a-f0-9]{8}\.json$/.test(f.name));
    assert.equal(requests.length, 1, JSON.stringify(r.outbox));
    assert.equal(requests[0].uid, 1000, 'created by the data dir owner');
    assert.equal(r.inbox.length, 1);
    assert.equal(r.inbox[0].uid, 1000);
  });

  it('as root, a root-owned data dir is refused', { skip: !IS_ROOT && 'needs POSIX root' }, () => {
    const l = layout();
    courierDirs(l);
    const r = runMcpChild(l);
    assert.match(r.error || '', /refusing to run mcp as root: .* is owned by root/);
  });

  describe('dropToDataDirOwner (any platform, injected process)', () => {
    const { dropToDataDirOwner } = require('../src/service/commands/mcp');
    function fakeProc({ uid = 0, failSetuid = false, sticky = false } = {}) {
      const calls = [];
      const p = {
        calls, uid, euid: uid,
        getuid: () => p.uid,
        geteuid: () => p.euid,
        setgroups: (g) => calls.push(['setgroups', g]),
        setgid: (g) => calls.push(['setgid', g]),
        setuid: (u) => { calls.push(['setuid', u]); if (failSetuid) throw new Error('EPERM'); if (!sticky) { p.uid = u; p.euid = u; } }
      };
      return p;
    }
    const fakeFs = (uid, gid, { dir = true, link = false } = {}) => ({ lstatSync: () => ({ uid, gid, isDirectory: () => dir, isSymbolicLink: () => link }) });

    it('clears groups, then sets gid, then uid, and verifies', () => {
      const proc = fakeProc();
      assert.deepEqual(dropToDataDirOwner('/d', { proc, fsImpl: fakeFs(1000, 1001) }), { uid: 1000, gid: 1001 });
      assert.deepEqual(proc.calls, [['setgroups', []], ['setgid', 1001], ['setuid', 1000]]);
    });

    it('does nothing when not root', () => {
      const proc = fakeProc({ uid: 1000 });
      assert.equal(dropToDataDirOwner('/d', { proc, fsImpl: fakeFs(1000, 1000) }), null);
      assert.deepEqual(proc.calls, []);
    });

    it('refuses a root-owned or linked data dir, a failed setuid, and a drop that did not take', () => {
      assert.throws(() => dropToDataDirOwner('/d', { proc: fakeProc(), fsImpl: fakeFs(0, 0) }), /owned by root/);
      assert.throws(() => dropToDataDirOwner('/d', { proc: fakeProc(), fsImpl: fakeFs(1000, 1000, { link: true }) }), /not a real directory/);
      assert.throws(() => dropToDataDirOwner('/d', { proc: fakeProc({ failSetuid: true }), fsImpl: fakeFs(1000, 1000) }), /could not become/);
      assert.throws(() => dropToDataDirOwner('/d', { proc: fakeProc({ sticky: true }), fsImpl: fakeFs(1000, 1000) }), /still running as uid 0\/0/);
    });
  });
});

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

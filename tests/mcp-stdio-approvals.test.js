// tests/mcp-stdio-approvals.test.js
//
// Unsafe runbooks through the phone (spec §3.8). The server is driven through
// executeToolCall, the same entry point the stdio transport uses.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const StdioMcpServer = require('../src/mcp/stdio-server');
const { RunbookEngine } = require('../src/runbooks/runbook-engine');
const { actionHash } = require('../src/approvals/messages');
const { PhoneApprover } = require('../src/approvals/phone-approver');
const { FileCourier } = require('../src/approvals/courier');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');

const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mcp-approvals-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  for (const d of ['a', 'b']) fs.mkdirSync(path.join(root, d), { recursive: true });
  // A junction on Windows needs no privilege; elsewhere it is a plain symlink.
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  return { base, root };
}

// A real engine with runbooks set in memory (loading from disk needs a
// root-owned directory on POSIX). The step writes a marker into the target.
function engineFor(root, extra = {}) {
  const engine = new RunbookEngine({ runbooksDir: null, allowedRoots: [root] });
  const step = { run: [process.execPath, '-e', "require('fs').writeFileSync(process.argv[1], 'ran')", '{{target}}/marker.txt'] };
  engine.runbooks.set('site.touch', { name: 'site.touch', description: '', tier: 'unsafe', params: { target: { type: 'path' } }, steps: [step], timeout_s: 30, rate_limit: null, ...extra });
  engine.runbooks.set('site.status', { name: 'site.status', description: '', tier: 'read', params: {}, steps: [{ run: [process.execPath, '-e', '0'] }], timeout_s: 30, rate_limit: null });
  return engine;
}

function recordingLedger() {
  const ledger = { entries: [], failKinds: new Set() };
  ledger.append = async (entry) => {
    if (ledger.failKinds.has(entry.kind)) throw new Error('audit_unavailable: disk full');
    ledger.entries.push(entry);
    return entry;
  };
  return ledger;
}

// A ledger whose append() for a chosen kind does not resolve until the test
// calls the release function `hold(kind)` returns, so a test can land
// cancel_job while that append is still pending.
function gatedLedger() {
  const ledger = { entries: [], gates: new Map() };
  ledger.append = async (entry) => {
    const gate = ledger.gates.get(entry.kind);
    if (gate) await gate;
    ledger.entries.push(entry);
    return entry;
  };
  ledger.hold = (kind) => {
    let release;
    ledger.gates.set(kind, new Promise((resolve) => { release = resolve; }));
    return release;
  };
  return ledger;
}

// An approver whose answer the test decides.
function scriptedApprover(decide) {
  const approver = {
    calls: [],
    unavailableReason: () => null,
    async requestAction(action, options) {
      approver.calls.push({ action, origin: options.origin });
      return decide({ action, ...options });
    }
  };
  return approver;
}

const approve = ({ action }) => ({ decision: 'approve', request_id: 'r-1', device_id: 'd-aaaaaaaaaaaaaaaa', action_hash: actionHash(action), reason: null });
const NODE = { name: 'web-01', profile: 'runbook', capabilities: [], policy: { max_concurrent_jobs: 2 } };

async function settle(server, jobId) {
  await (server.jobRuns.get(jobId) || Promise.resolve());
  return server.jobManager.getJob(jobId);
}

function server({ root, approver, auditLedger = recordingLedger(), engine = engineFor(root), nodeConfig = NODE, workingDirectory }) {
  return new StdioMcpServer({ nodeConfig, runbookEngine: engine, approver, auditLedger, workingDirectory });
}

describe('run_runbook with a phone approver', () => {
  it('waits in awaiting_approval, runs after approval with the job id in origin, and audits it', async () => {
    const { root } = sandbox();
    const ledger = recordingLedger();
    const approver = scriptedApprover(approve);
    const s = server({ root, approver, auditLedger: ledger });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    assert.deepEqual(res, { job_id: res.job_id, status: 'awaiting_approval' });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'succeeded');
    assert.equal(fs.readFileSync(path.join(root, 'a', 'marker.txt'), 'utf8'), 'ran');
    assert.deepEqual(approver.calls[0].origin, { client: 'stdio-mcp', session: null, job_id: res.job_id });
    assert.deepEqual(approver.calls[0].action.steps[0].slice(-1), [`${path.join(root, 'a')}/marker.txt`]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ledger.entries.map((e) => e.kind), ['request.inbound', 'exec.start', 'exec.result']);
    assert.equal(ledger.entries[2].data.ok, true);
  });

  it('deny, expire and unavailable never run', async () => {
    for (const [decision, status] of [['deny', 'denied'], ['expired', 'expired'], ['unavailable', 'denied'], ['error', 'denied']]) {
      const { root } = sandbox();
      const s = server({ root, approver: scriptedApprover(() => ({ decision, request_id: null, device_id: null, action_hash: null, reason: 'test' })) });
      const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
      assert.equal((await settle(s, res.job_id)).status, status, decision);
      assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false, decision);
    }
  });

  it('cancel_job while awaiting withdraws the request and nothing runs', async () => {
    const { root } = sandbox();
    const approver = scriptedApprover(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ decision: 'withdrawn', request_id: 'r-1', device_id: null, action_hash: null, reason: null }));
    }));
    const s = server({ root, approver });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const cancelled = await s.executeToolCall('cancel_job', { job_id: res.job_id });
    assert.equal(cancelled.success, true);
    assert.equal((await settle(s, res.job_id)).status, 'cancelled');
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  it('a realpath swapped after approval is refused at the pre-run re-check', async () => {
    const { root } = sandbox();
    const link = path.join(root, 'link');
    const approver = scriptedApprover((opts) => {
      const outcome = approve(opts);
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(path.join(root, 'b'), link, process.platform === 'win32' ? 'junction' : 'dir');
      return outcome;
    });
    const s = server({ root, approver });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: link } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'failed');
    assert.match(job.result, /^action_changed/);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'b', 'marker.txt')), false);
  });

  // Context beyond the brief (Task 4's ruling): runbookAction's 4th argument,
  // `cwd`, is part of the hashed action. The server resolves its own working
  // directory fresh at request time and again at the pre-run re-check
  // (resolveCwd()), so a directory that moves underneath a *stable path*
  // (here, a symlink swapped between request and re-check, exactly like the
  // realpath case above but on the node's cwd rather than a path parameter)
  // is caught the same way: nothing in the params changes, only cwd does.
  it('a working directory swapped after approval is refused at the pre-run re-check', async () => {
    const { root } = sandbox();
    const link = path.join(root, 'link');
    const approver = scriptedApprover((opts) => {
      const outcome = approve(opts);
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(path.join(root, 'b'), link, process.platform === 'win32' ? 'junction' : 'dir');
      return outcome;
    });
    const s = server({ root, approver, workingDirectory: link });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.equal(approver.calls[0].action.cwd, fs.realpathSync(path.join(root, 'a')));
    assert.equal(job.status, 'failed');
    assert.match(job.result, /^action_changed/);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'b', 'marker.txt')), false);
  });

  it('runs the validated values without validating again', async () => {
    const { root } = sandbox();
    const engine = engineFor(root);
    let executing = false;
    let validationsWhileExecuting = 0;
    const validate = engine.validateParameters.bind(engine);
    engine.validateParameters = (...args) => { if (executing) validationsWhileExecuting += 1; return validate(...args); };
    const execute = engine.executeRunbook.bind(engine);
    engine.executeRunbook = async (...args) => { executing = true; try { return await execute(...args); } finally { executing = false; } };
    const s = server({ root, approver: scriptedApprover(approve), engine });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    assert.equal((await settle(s, res.job_id)).status, 'succeeded');
    assert.equal(validationsWhileExecuting, 0);
  });

  it('an approved job that finds no free slot at the transition fails', async () => {
    const { root } = sandbox();
    const s = server({ root, approver: scriptedApprover(approve), nodeConfig: { ...NODE, policy: { max_concurrent_jobs: 1 } } });
    s.jobManager.createJob({ machine: 'web-01', runbook: 'site.status', tier: 'read' });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'failed');
    assert.match(job.result, /^max_concurrent_jobs/);
  });

  it('fails closed when exec.start cannot be audited', async () => {
    const { root } = sandbox();
    const ledger = recordingLedger();
    ledger.failKinds.add('exec.start');
    const s = server({ root, approver: scriptedApprover(approve), auditLedger: ledger });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.deepEqual([job.status, job.result], ['failed', 'Audit ledger unavailable; nothing ran.']);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  it('audits request.inbound for every tier, including refusals', async () => {
    const { root } = sandbox();
    const ledger = recordingLedger();
    const s = server({ root, approver: scriptedApprover(approve), auditLedger: ledger });
    const read = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.status' });
    await settle(s, read.job_id);
    await assert.rejects(s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'nope' }));
    const unsafe = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    await settle(s, unsafe.job_id);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ledger.entries.filter((e) => e.kind === 'request.inbound').map((e) => e.data.name), ['site.status', 'nope', 'site.touch']);
    assert.ok(ledger.entries.every((e) => e.kind !== 'request.inbound' || e.data.client === 'stdio-mcp'));
  });

  // Fix round 1, Important (plan-mandated, reproduced): a cancel_job that
  // lands while the awaited exec.start ledger append is still pending must
  // not bring the job back to 'running' or let anything spawn once the
  // append finally resolves — the audit entry can land (it already happened
  // before the cancellation was known), but the run itself must not.
  it('cancel_job during a pending exec.start append leaves the job cancelled and nothing spawns', async () => {
    const { root } = sandbox();
    const ledger = gatedLedger();
    const release = ledger.hold('exec.start');
    const s = server({ root, approver: scriptedApprover(approve), auditLedger: ledger });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    // Let every already-resolved microtask run (approval, rate check,
    // transition, the pre-run re-check) so the flow is parked on the held
    // exec.start append before cancel_job is sent.
    await new Promise((r) => setImmediate(r));
    const cancelled = await s.executeToolCall('cancel_job', { job_id: res.job_id });
    assert.equal(cancelled.success, true);
    assert.equal(s.jobManager.getJob(res.job_id).status, 'cancelled');
    release();
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.started_at, null);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
    assert.equal(ledger.entries.some((e) => e.kind === 'exec.result'), false);
  });

  // Fix round 1, minor: a throw building the live action for the pre-run
  // re-check is a mismatch on its own, never compared against a stale hash.
  it('a thrown pre-run re-check is refused as action_changed', async () => {
    const { root } = sandbox();
    const engine = engineFor(root);
    const validateParameters = engine.validateParameters.bind(engine);
    let calls = 0;
    // Call 1 is runRunbook's own validation; call 2 is the pre-run re-check.
    engine.validateParameters = (...args) => {
      calls += 1;
      if (calls > 1) throw new Error('boom-validate');
      return validateParameters(...args);
    };
    const s = server({ root, approver: scriptedApprover(approve), engine });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'failed');
    assert.match(job.result, /^action_changed/);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  // Fix round 1, minor: outcome.action_hash must be a string. Without this,
  // a thrown re-check (liveHash forced to null by the catch) would
  // coincidentally "match" an outcome whose action_hash is also null.
  it('a non-string action_hash is refused even when it would coincidentally match a thrown re-check', async () => {
    const { root } = sandbox();
    const engine = engineFor(root);
    const validateParameters = engine.validateParameters.bind(engine);
    let calls = 0;
    engine.validateParameters = (...args) => {
      calls += 1;
      if (calls > 1) throw new Error('boom-validate');
      return validateParameters(...args);
    };
    const approver = scriptedApprover(() => ({ decision: 'approve', request_id: 'r-1', device_id: 'd-aaaaaaaaaaaaaaaa', action_hash: null, reason: null }));
    const s = server({ root, approver, engine });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'failed');
    assert.match(job.result, /^action_changed/);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  // Fix round 1, minor: the job actually runs with the cwd it was approved
  // with — a relative-path step only lands its marker in the right place if
  // this.workingDirectory really reached engine.executeRunbook's options.cwd.
  it('runs in the approved working directory: a relative-path step lands its marker there', async () => {
    const { root } = sandbox();
    const engine = new RunbookEngine({ runbooksDir: null, allowedRoots: [root] });
    const step = { run: [process.execPath, '-e', "require('fs').writeFileSync('marker.txt', 'ran')"] };
    engine.runbooks.set('site.touch', { name: 'site.touch', description: '', tier: 'unsafe', params: {}, steps: [step], timeout_s: 30, rate_limit: null });
    const s = server({ root, approver: scriptedApprover(approve), engine, workingDirectory: path.join(root, 'a') });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: {} });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'succeeded');
    assert.equal(fs.readFileSync(path.join(root, 'a', 'marker.txt'), 'utf8'), 'ran');
  });

  // Fix round 1, minor: the withdrawn branch on its own (not through
  // cancel_job), and the exact reason text for deny/expired/unavailable/error.
  it('withdrawn (not via cancel_job) cancels with no reason set', async () => {
    const { root } = sandbox();
    const approver = scriptedApprover(() => ({ decision: 'withdrawn', request_id: 'r-1', device_id: null, action_hash: null, reason: null }));
    const s = server({ root, approver });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.reason, null);
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  it('reason text follows the phone when it gives one', async () => {
    for (const [decision, status, reason] of [
      ['deny', 'denied', 'denied: the battery is low'],
      ['unavailable', 'denied', 'denied_by_policy: the battery is low'],
      ['error', 'denied', 'denied_by_policy: the battery is low']
    ]) {
      const { root } = sandbox();
      const approver = scriptedApprover(() => ({ decision, request_id: null, device_id: null, action_hash: null, reason: 'the battery is low' }));
      const s = server({ root, approver });
      const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
      const job = await settle(s, res.job_id);
      assert.equal(job.status, status, decision);
      assert.equal(job.reason, reason, decision);
    }
  });

  it('falls back to fixed reason text when the phone gives none', async () => {
    for (const [decision, status, reason] of [
      ['deny', 'denied', 'denied: the phone denied it'],
      ['expired', 'expired', 'expired: no phone answered in time'],
      ['unavailable', 'denied', 'denied_by_policy: unavailable'],
      ['error', 'denied', 'denied_by_policy: error']
    ]) {
      const { root } = sandbox();
      const approver = scriptedApprover(() => ({ decision, request_id: null, device_id: null, action_hash: null, reason: null }));
      const s = server({ root, approver });
      const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
      const job = await settle(s, res.job_id);
      assert.equal(job.status, status, decision);
      assert.equal(job.reason, reason, decision);
    }
  });

  // Fix round 1, minor: an approved job that hits its rate limit at the
  // final check, and one whose rate-limit check throws — both must fail
  // the job, and the throw must never leave it stuck in awaiting_approval.
  it('an approved job that then hits its rate limit fails without running', async () => {
    const { root } = sandbox();
    const engine = engineFor(root);
    const checkRateLimit = engine.checkRateLimit.bind(engine);
    engine.checkRateLimit = (name) => (name === 'site.touch' ? { allowed: false, retryAfterSeconds: 42 } : checkRateLimit(name));
    const s = server({ root, approver: scriptedApprover(approve), engine });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.equal(job.status, 'failed');
    assert.equal(job.result, 'rate_limited: retry after 42s');
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  it('a checkRateLimit throw fails the job instead of leaving it awaiting_approval', async () => {
    const { root } = sandbox();
    const engine = engineFor(root);
    engine.checkRateLimit = () => { throw new Error('boom-rate-limit'); };
    const s = server({ root, approver: scriptedApprover(approve), engine });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    const job = await settle(s, res.job_id);
    assert.notEqual(job.status, 'awaiting_approval');
    assert.equal(job.status, 'failed');
    assert.equal(job.result, 'boom-rate-limit');
    assert.equal(fs.existsSync(path.join(root, 'a', 'marker.txt')), false);
  });

  it('unavailable immediately with the service-not-running reason', async () => {
    const { root, base } = sandbox();
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir);
    const phone = createFakePhone();
    const store = await approverStoreWith([phone.approverRecord()]);
    cleanups.push(() => store.cleanup());
    const approver = new PhoneApprover({ identity: testNodeIdentity(), approverStore: store, link: new FileCourier({ dataDir }), auditLedger: recordingLedger() });
    const s = server({ root, approver });
    const res = await s.executeToolCall('run_runbook', { machine: 'web-01', runbook: 'site.touch', params: { target: path.join(root, 'a') } });
    assert.equal(res.status, 'denied');
    assert.equal(res.reason, 'denied_by_policy: the King Louie service is not running on this node');
  });
});

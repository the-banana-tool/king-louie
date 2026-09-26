// tests/fleet-delegate.test.js — fleet stage 4 §3.8.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const { JobManager } = require('../src/runbooks/runbook-engine');
const { DelegateSessions, shouldRefuseUnsafe } = require('../src/fleet/delegate-sessions');
const { ToolError, STDIO_ORIGIN } = require('../src/fleet/fleet-tools');
const { REFUSE_UNSAFE_MESSAGE } = require('../src/approvals/executor-options');
const { holdEventLoop } = require('./helpers/hold-event-loop');

const release = holdEventLoop();
after(release);

const FAKE = 'kl-test-delegate-fake';
const ROUTINE = 'KlDelegateRoutine';
const GATED = 'KlDelegateGated';
const SLOW = 'KlDelegateSlow';
const PLANNER = 'KlDelegatePlanner';
const BGSLOW = 'KlDelegateBgSlow';
let script = [];
let slowStarted = false;
// A run whose first user message is a key here reads its replies from that
// queue instead of `script` (sub-agents and background tasks run
// concurrently with their parent).
let byTask = new Map();
// Every tool result any run (parent, sub-agent, background task) saw.
let seen = [];
// One entry per BGSLOW call: { aborted } flips when its signal aborts.
let bgRuns = [];
let providerError = null;
class FakeProvider {
  async sendMessageWithTools(messages) {
    if (providerError) { const err = providerError; providerError = null; throw err; }
    const first = (messages || []).find((m) => m.role === 'user');
    const queue = first && byTask.get(first.content);
    if (queue) return queue.shift() || { type: 'text', content: 'child finished' };
    return script.shift() || { type: 'text', content: 'finished' };
  }
  buildToolMessages(response, toolResult, toolCallId) {
    seen.push({ tool: response.toolName, result: toolResult });
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}
const use = (toolName, parameters = {}) => ({ type: 'tool_use', toolName, toolUseId: crypto.randomUUID(), parameters });

before(() => {
  ProviderFactory.registerProvider(FAKE, FakeProvider);
  const reg = (name, execute) => { if (!toolRegistry.get(name)) toolRegistry.register(new Tool({ name, description: 'test', parameters: { type: 'object', properties: {} }, requiresApproval: false, execute })); };
  reg(ROUTINE, async () => ({ ok: true, value: 'r'.repeat(6000) }));
  reg(GATED, async () => ({ ok: true }));
  reg(PLANNER, async () => ({ ok: true, plan: 'p'.repeat(10000) }));
  reg(BGSLOW, (params, opts) => new Promise((resolve) => {
    const run = { aborted: false };
    bgRuns.push(run);
    opts.signal.addEventListener('abort', () => { run.aborted = true; resolve({ success: false, cancelled: true, error: 'aborted' }); }, { once: true });
  }));
  reg(SLOW, (params, opts) => new Promise((resolve) => {
    slowStarted = true;
    opts.signal.addEventListener('abort', () => resolve({ success: false, cancelled: true, error: 'aborted' }), { once: true });
  }));
});
after(() => { ProviderFactory._registry.delete(FAKE); });

const temps = [];
const running = [];
afterEach(async () => {
  while (running.length) await running.pop()();
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
  script = [];
  slowStarted = false;
  byTask = new Map();
  seen = [];
  bgRuns = [];
  providerError = null;
});

const waitFor = async (cond, what) => {
  for (let i = 0; i < 300 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out waiting for ${what}`);
};

async function setup({ maxSessions = 4, maxJobs = 2, idleCloseMs = 7200000, withNodePolicy = true, remoteApprovals = 'phone' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-delegate-'));
  temps.push(dataDir);
  const root = path.join(dataDir, 'work');
  fs.mkdirSync(root);
  const calls = [];
  const audit = [];
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals,
    phoneApprover: { ttlMs: 300000, isAvailable: () => true, requestApproval: async (tool, params, meta) => { calls.push({ tool, origin: meta.origin }); return true; } },
    auditLedger: { append: async (e) => { audit.push(e); return e; } },
    ...(withNodePolicy ? { nodePolicy: { allowed_roots: [root], remote_sessions: { always_confirm: [GATED], deny: [] } } } : {})
  });
  const tiers = { provider: FAKE, model: 'fake' };
  const settings = core.getSettings();
  core.context.setSettings({ ...settings, activeProvider: FAKE, inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } } });
  core.saveProviderToken(FAKE, 'fake-token-123456');
  await core.start();
  let now = Date.parse('2026-09-23T18:00:00.000Z');
  const ended = [];
  const nodeConfig = {
    name: 'gpu-box', profile: 'agent', capabilities: [],
    policy: { allowed_roots: [root], max_concurrent_jobs: maxJobs },
    delegate: { provider: null, model: null, agent: 'main', idleCloseMs, cwd: null, maxSessions }
  };
  const jobs = new JobManager({ maxConcurrentJobs: maxJobs });
  const sessions = new DelegateSessions({
    core, nodeConfig, jobManager: jobs, auditLedger: { append: async (e) => { audit.push(e); return e; } },
    leaseManager: { endForJob: (jobId, reason) => ended.push([jobId, reason]) },
    now: () => now, fullTranscriptTools: [PLANNER], sweepMs: 3600000
  });
  running.push(async () => { sessions.stop(); await core.shutdown(); });
  return { core, sessions, jobs, calls, audit, ended, root, dataDir, advance: (ms) => { now += ms; } };
}

const origin = (scopes) => ({ kind: 'frontdoor', client_id: 'dcr_x', client_name: 'Example Client', grant_id: 'gr_y', scopes, mcp_session: 'mcp-1' });

describe('DelegateSessions', () => {
  it('a routine tool call runs; the transcript, result and evidence summary are recorded', async () => {
    const t = await setup();
    script = [use(ROUTINE), { type: 'text', content: 'all done' }];
    const { job_id: jobId, status } = await t.sessions.start({ task: 'do the thing', origin: origin(['fleet:delegate']) });
    assert.equal(status, 'running');
    await t.sessions.turns.get(jobId);
    const job = t.jobs.getJob(jobId);
    assert.equal(job.status, 'running');
    assert.equal(job.session, 'idle');
    assert.equal(job.logs[0], '> user: do the thing');
    assert.match(job.logs[1], new RegExp(`^tool ${ROUTINE} \\{\\} → ok `));
    assert.match(job.logs[1], /\[cut at 4096 of \d+ bytes\]$/);
    assert.equal(job.logs.at(-1), '< assistant: all done');
    assert.equal(job.result, 'all done');
    assert.deepEqual(Object.keys(job.evidence.summary).sort(), ['editedPaths', 'hasEdits', 'hasFreshFailure', 'hasFullPass', 'hasTargetedPass']);
    assert.deepEqual(t.calls, []);
    assert.equal(t.jobs.activeJobCount(), 0, 'an idle session holds no slot');
  });

  it('an always_confirm call reaches the phone with the front door\'s origin when fleet:unsafe is granted', async () => {
    const t = await setup();
    script = [use(GATED)];
    const { job_id: jobId } = await t.sessions.start({ task: 'push', origin: origin(['fleet:delegate', 'fleet:unsafe']) });
    await t.sessions.turns.get(jobId);
    assert.deepEqual(t.calls, [{ tool: GATED, origin: { client: 'Example Client', session: 'mcp-1', job_id: jobId } }]);
  });

  it('without fleet:unsafe an unsafe call is refused and the phone is never asked', async () => {
    const t = await setup();
    script = [use(GATED)];
    const { job_id: jobId } = await t.sessions.start({ task: 'push', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    assert.deepEqual(t.calls, []);
    const line = t.jobs.getJob(jobId).logs.find((l) => l.startsWith(`tool ${GATED}`));
    assert.match(line, /→ error /);
    assert.ok(line.includes(REFUSE_UNSAFE_MESSAGE), line);
  });

  it('cwd must be under policy.allowed_roots', async () => {
    const t = await setup();
    await assert.rejects(t.sessions.start({ task: 'x', cwd: t.dataDir, origin: origin(['fleet:delegate']) }),
      (err) => err instanceof ToolError && err.code === 'invalid_params' && err.message === 'invalid_params: cwd must be under policy.allowed_roots');
    assert.equal(t.jobs.jobs.size, 0);
  });

  it('send_to_job: node_busy during a turn, not_accepted once cancelled; cancel aborts the running tool', async () => {
    const t = await setup();
    script = [use(SLOW)];
    const { job_id: jobId } = await t.sessions.start({ task: 'long', origin: origin(['fleet:delegate']) });
    for (let i = 0; i < 200 && !slowStarted; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(slowStarted);
    await assert.rejects(t.sessions.send(jobId, 'more', { origin: origin(['fleet:delegate']) }), (err) => err.code === 'node_busy' && err.data.retry_after === 5);
    const res = t.sessions.cancel(jobId);
    assert.equal(res.success, true);
    await t.sessions.turns.get(jobId);
    assert.equal(t.jobs.getJob(jobId).status, 'cancelled');
    assert.equal(t.jobs.getJob(jobId).session, 'cancelled');
    assert.equal(t.jobs.activeJobCount(), 0, 'a cancelled turn frees its slot');
    await assert.rejects(t.sessions.send(jobId, 'more', { origin: origin(['fleet:delegate']) }), (err) => err.code === 'not_accepted' && err.message === 'not_accepted: session is cancelled');
    assert.deepEqual(t.ended, [[jobId, 'job_closed']]);
    assert.ok(t.audit.some((e) => e.kind === 'exec.result' && e.data.name === 'delegate' && e.data.job_id === jobId && e.data.ok === false));
  });

  it('closes an idle session after idle_close; the job then succeeds', async () => {
    const t = await setup({ idleCloseMs: 300000 });
    const { job_id: jobId } = await t.sessions.start({ task: 'x', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    t.advance(299000);
    t.sessions.sweep();
    assert.equal(t.jobs.getJob(jobId).status, 'running');
    t.advance(2000);
    t.sessions.sweep();
    assert.equal(t.jobs.getJob(jobId).status, 'succeeded');
    await assert.rejects(t.sessions.send(jobId, 'again', { origin: origin(['fleet:delegate']) }), /not_accepted: session is closed/);
    assert.deepEqual(t.ended, [[jobId, 'job_closed']]);
  });

  it('a second turn carries the history; planner calls are kept in full', async () => {
    const t = await setup();
    script = [{ type: 'text', content: 'first' }];
    const { job_id: jobId } = await t.sessions.start({ task: 'one', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    script = [use(PLANNER), { type: 'text', content: 'second' }];
    await t.sessions.send(jobId, 'two', { origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    const logs = t.jobs.getJob(jobId).logs;
    assert.deepEqual(logs.filter((l) => l.startsWith('> user:')), ['> user: one', '> user: two']);
    const plan = logs.find((l) => l.startsWith(`tool ${PLANNER}`));
    assert.ok(plan.includes('p'.repeat(10000)), 'the planner result is not cut');
    assert.equal(t.jobs.getJob(jobId).result, 'second');
  });

  it('at most delegate.max_sessions open sessions', async () => {
    const t = await setup({ maxSessions: 1 });
    const { job_id: jobId } = await t.sessions.start({ task: 'a', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    await assert.rejects(t.sessions.start({ task: 'b', origin: origin(['fleet:delegate']) }), (err) => err.code === 'node_busy' && err.data.retry_after === 5);
  });

  it('refuses an unknown provider or agent at construction', async () => {
    const t = await setup();
    const base = { core: t.core, jobManager: new JobManager(), sweepMs: 3600000 };
    const cfg = (delegate) => ({ name: 'n', profile: 'agent', policy: { allowed_roots: [t.root] }, delegate: { provider: null, model: null, agent: 'main', idleCloseMs: 7200000, cwd: null, maxSessions: 4, ...delegate } });
    assert.throws(() => new DelegateSessions({ ...base, nodeConfig: cfg({ provider: 'nope' }) }), /delegate\.provider "nope" is not a known provider/);
    assert.throws(() => new DelegateSessions({ ...base, nodeConfig: cfg({ agent: 'nobody' }) }), /delegate\.agent "nobody" is not an agent/);
  });
  it('a machine-limited fleet:unsafe covers only the machines it names', async () => {
    const t = await setup();
    script = [use(GATED)];
    const other = await t.sessions.start({ task: 'push', origin: origin(['fleet:delegate', 'fleet:unsafe;machines=web-01']) });
    await t.sessions.turns.get(other.job_id);
    assert.deepEqual(t.calls, [], 'fleet:unsafe for web-01 does not reach the phone from gpu-box');
    const line = t.jobs.getJob(other.job_id).logs.find((l) => l.startsWith(`tool ${GATED}`));
    assert.ok(line.includes(REFUSE_UNSAFE_MESSAGE), line);

    script = [use(GATED)];
    const mine = await t.sessions.start({ task: 'push', origin: origin(['fleet:delegate', 'fleet:unsafe;machines=gpu-box,web-01']) });
    await t.sessions.turns.get(mine.job_id);
    assert.deepEqual(t.calls, [{ tool: GATED, origin: { client: 'Example Client', session: 'mcp-1', job_id: mine.job_id } }]);
  });

  it('a local stdio session (no scopes) refuses unsafe calls (M19 provisional)', async () => {
    const t = await setup();
    script = [use(GATED)];
    const { job_id: jobId } = await t.sessions.start({ task: 'push', origin: STDIO_ORIGIN });
    await t.sessions.turns.get(jobId);
    assert.deepEqual(t.calls, []);
    assert.equal(shouldRefuseUnsafe(STDIO_ORIGIN, { name: 'gpu-box' }), true);
    assert.equal(shouldRefuseUnsafe(origin(['fleet:unsafe']), { name: 'gpu-box' }), false);
  });

  it('a throw after the executor returns (a JobManager listener) leaks neither the slot nor the session', async () => {
    const t = await setup({ maxJobs: 1 });
    script = [{ type: 'text', content: 'done' }];
    let thrown = false;
    // The idle update that ends the turn (createDelegateJob's has no logs yet).
    t.jobs.on('update', (job) => {
      if (!thrown && job.session === 'idle' && job.logs.length > 0) { thrown = true; throw new Error('listener exploded'); }
    });
    const { job_id: jobId } = await t.sessions.start({ task: 'x', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    assert.equal(thrown, true);
    assert.equal(t.jobs.activeJobCount(), 0, 'no slot leaks');
    assert.equal(t.jobs.getJob(jobId).session, 'idle');
    // The session is not stuck in "turn": a second turn runs, in the one slot.
    script = [{ type: 'text', content: 'again' }];
    assert.deepEqual(await t.sessions.send(jobId, 'more', { origin: origin(['fleet:delegate']) }), { job_id: jobId, status: 'running', session: 'turn' });
    await t.sessions.turns.get(jobId);
    assert.equal(t.jobs.getJob(jobId).result, 'again');
    assert.equal(t.jobs.activeJobCount(), 0);
  });

  it('a provider error fails the session and frees its slot', async () => {
    const t = await setup({ maxJobs: 1 });
    providerError = new Error('provider exploded');
    const { job_id: jobId } = await t.sessions.start({ task: 'x', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    assert.equal(t.jobs.activeJobCount(), 0);
    assert.equal(t.jobs.getJob(jobId).status, 'failed');
    assert.ok(t.jobs.getJob(jobId).logs.some((l) => /^! error: .*provider exploded$/.test(l)));
    assert.ok(t.audit.some((e) => e.kind === 'exec.result' && e.data.name === 'delegate' && e.data.job_id === jobId && e.data.ok === false));
    await assert.rejects(t.sessions.send(jobId, 'again', { origin: origin(['fleet:delegate']) }), /not_accepted: session is failed/);
  });

  it('cancel stops a turn running inside SpawnAgent and frees the slot', async () => {
    const t = await setup();
    script = [use('SpawnAgent', { task: 'child work', agentId: 'main' })];
    byTask.set('child work', [use(SLOW)]);
    const { job_id: jobId } = await t.sessions.start({ task: 'delegate to a child', origin: origin(['fleet:delegate']) });
    await waitFor(() => slowStarted, 'the sub-agent\'s tool to start');
    assert.equal(t.jobs.activeJobCount(), 1);
    assert.equal(t.sessions.cancel(jobId).success, true);
    await t.sessions.turns.get(jobId);
    assert.ok(seen.some((x) => x.tool === SLOW && x.result && x.result.cancelled === true), 'the sub-agent\'s tool saw the abort');
    assert.equal(t.jobs.getJob(jobId).status, 'cancelled');
    assert.equal(t.jobs.activeJobCount(), 0);
  });

  it('cancel stops the BackgroundTask children of that session only', async () => {
    const t = await setup();
    script = [use('BackgroundTask', { task: 'bg one' }), { type: 'text', content: 'started one' }];
    byTask.set('bg one', [use(BGSLOW)]);
    const a = await t.sessions.start({ task: 'start bg one', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(a.job_id);
    await waitFor(() => bgRuns.length === 1, 'the first background task');
    script = [use('BackgroundTask', { task: 'bg two' }), { type: 'text', content: 'started two' }];
    byTask.set('bg two', [use(BGSLOW)]);
    const b = await t.sessions.start({ task: 'start bg two', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(b.job_id);
    await waitFor(() => bgRuns.length === 2, 'the second background task');
    assert.equal(t.jobs.getJob(a.job_id).session, 'idle', 'the turn ended; the background task outlives it');

    t.sessions.cancel(a.job_id);
    await waitFor(() => bgRuns[0].aborted, 'the first background task to stop');
    const bg = t.core.context.getBackgroundTaskManager();
    await waitFor(() => bg.list().some((x) => x.state === 'stopped'), 'the task to settle');
    assert.equal(bgRuns[1].aborted, false, 'the other session\'s background task keeps running');
    assert.deepEqual(bg.list().map((x) => x.state).sort(), ['running', 'stopped']);
  });

  for (const remoteApprovals of ['phone', 'allow']) {
    it(`without a node policy (${remoteApprovals}) the delegate reads inside its cwd and nothing outside`, async () => {
      const t = await setup({ withNodePolicy: false, remoteApprovals });
      fs.writeFileSync(path.join(t.root, 'inside.txt'), 'inside');
      fs.writeFileSync(path.join(t.dataDir, 'outside.txt'), 'outside');
      script = [
        use('Read', { file_path: path.join(t.root, 'inside.txt') }),
        use('Read', { file_path: path.join(t.dataDir, 'outside.txt') }),
        // A background task runs in the parent's cwd and inherits the gate
        // and its roots through the re-threaded requester.
        use('BackgroundTask', { task: 'child read' }),
        { type: 'text', content: 'read both' }
      ];
      byTask.set('child read', [use('Read', { file_path: path.join(t.root, 'inside.txt') }), use('Read', { file_path: path.join(t.dataDir, 'outside.txt') })]);
      const { job_id: jobId } = await t.sessions.start({ task: 'read files', origin: origin(['fleet:delegate']) });
      await t.sessions.turns.get(jobId);
      await waitFor(() => seen.filter((x) => x.tool === 'Read').length === 4, 'the background task\'s reads');
      const reads = seen.filter((x) => x.tool === 'Read');
      for (const i of [0, 2]) {
        assert.notEqual(reads[i].result.success, false, JSON.stringify(reads[i].result));
        assert.ok(JSON.stringify(reads[i].result).includes('inside'), 'Read inside the cwd runs');
      }
      for (const i of [1, 3]) {
        assert.equal(reads[i].result.success, false);
        assert.equal(reads[i].result.error, REFUSE_UNSAFE_MESSAGE);
      }
      assert.deepEqual(t.calls, []);
    });
  }
  it('a glob cannot reach outside the cwd: .. and absolute patterns are refused (T11-glob)', async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.dataDir, 'outside.txt'), 'MARKER outside');
    const abs = `${path.join(t.dataDir).replace(/\\/g, '/')}/*.txt`;
    script = [
      use('Grep', { pattern: 'MARKER', glob: '../*.txt' }),
      use('Glob', { pattern: '../*.txt' }),
      use('Glob', { pattern: abs }),
      use('Grep', { pattern: 'MARKER', glob: abs }),
      { type: 'text', content: 'done' }
    ];
    const { job_id: jobId } = await t.sessions.start({ task: 'look around', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    const calls = seen.filter((x) => x.tool === 'Grep' || x.tool === 'Glob');
    assert.equal(calls.length, 4);
    for (const c of calls) {
      assert.equal(c.result.success, false, JSON.stringify(c.result));
      assert.equal(c.result.error, REFUSE_UNSAFE_MESSAGE);
    }
    assert.ok(!JSON.stringify(t.jobs.getJob(jobId).logs).includes('MARKER outside'));
  });

  it('a junction or symlink inside the cwd does not lead Glob or Grep out of it (T11-glob)', async () => {
    const t = await setup();
    fs.writeFileSync(path.join(t.root, 'mine.txt'), 'MARKER inside');
    fs.mkdirSync(path.join(t.dataDir, 'elsewhere'));
    fs.writeFileSync(path.join(t.dataDir, 'elsewhere', 'linked.txt'), 'MARKER linked');
    fs.symlinkSync(path.join(t.dataDir, 'elsewhere'), path.join(t.root, 'out'), 'junction');
    script = [use('Glob', { pattern: '**/*.txt' }), use('Grep', { pattern: 'MARKER' }), { type: 'text', content: 'done' }];
    const { job_id: jobId } = await t.sessions.start({ task: 'look around', origin: origin(['fleet:delegate']) });
    await t.sessions.turns.get(jobId);
    const glob = seen.find((x) => x.tool === 'Glob').result;
    assert.equal(glob.ok, true, JSON.stringify(glob));
    assert.deepEqual(glob.files.map((x) => x.path), ['mine.txt']);
    const grep = seen.find((x) => x.tool === 'Grep').result;
    assert.equal(grep.ok, true, JSON.stringify(grep));
    assert.deepEqual(grep.matches.map((m) => m.line), ['MARKER inside']);
  });
});

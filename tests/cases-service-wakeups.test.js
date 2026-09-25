// tests/cases-service-wakeups.test.js
// createCore with service-style ports: no `ui`, so nothing is interactive.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { addSink } = require('../src/logging');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');

const tempDirs = [];
const savedEnv = process.env.KL_CASES_ROOT;
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedEnv;
});

function serviceDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-service-wakeups-'));
  tempDirs.push(dataDir);
  return {
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
  };
}

describe('cases:wakeups in a service-style core', () => {
  it('registers the protected system job on start and dispatches it to runDueWakeups', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const scheduler = core.context.getCronScheduler();
      const job = scheduler.store.get('cases:wakeups');
      assert.deepStrictEqual([job.system, job.enabled, job.schedule.everyMs, job.payload.system], [true, true, 60000, 'cases:wakeups']);
      // Let the scheduler's first tick (100 ms after start) finish.
      await new Promise((r) => setTimeout(r, 300));
      const runtime = core.context.getCaseRuntime();
      let seen = null;
      runtime.runDueWakeups = async (now) => { seen = now; return { ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0, probe: true }; };
      assert.deepStrictEqual(await scheduler.runNow('cases:wakeups'), { ok: true, ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0, probe: true });
      assert.ok(seen instanceof Date);
      await assert.rejects(scheduler.removeJob('cases:wakeups'), /system job managed by King Louie/);
    } finally {
      await core.shutdown();
    }
  });

  it('starts without crashing, logging an error, when ensureWakeupJob fails to persist (M4)', async () => {
    delete process.env.KL_CASES_ROOT;
    const deps = serviceDeps();
    // Preempt the cron store's own subdirectory with a plain file, so its
    // save() (mkdir-if-missing, then write inside it) fails — a real, not
    // simulated, ensureWakeupJob failure. (CronStore.add/update mutate its
    // in-memory map before the failing save(), so the job can still show up
    // in scheduler.store.list() in memory even though it never reached
    // disk — that's pre-existing CronStore behaviour, not this fix's
    // concern. What this fix guarantees is that start() doesn't reject and
    // the failure is logged, not silently swallowed or left to crash later.)
    fs.writeFileSync(path.join(deps.paths.dataDir, 'cron'), 'not a directory');
    const core = createCore(deps);
    const lines = [];
    const remove = addSink((r) => lines.push(r));
    try {
      await assert.doesNotReject(core.start());
      assert.ok(
        lines.some((r) => r.level === 'error' && /cases:wakeups/.test(r.message)),
        lines.map((r) => `${r.level}: ${r.message}`).join('\n')
      );
    } finally {
      remove();
      await core.shutdown();
    }
  });

  it('a question created there has no deliveries and logs the service-mode line', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const runtime = core.context.getCaseRuntime();
      const info = await runtime.createCase({ title: 'Lakeside lot' });
      const lines = [];
      const remove = addSink((r) => lines.push(r.line));
      let q;
      try {
        q = runtime.createQuestion(info.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
      } finally {
        remove();
      }
      assert.deepStrictEqual(q.deliveries, []);
      assert.ok(lines.some((l) => l.includes(`Case lakeside-lot asks ${q.id} (normal): Is the well shared?. No channel can deliver it until stage 4; it waits.`)), lines.join('\n'));
    } finally {
      await core.shutdown();
    }
  });

  it('passes denyAutoApproval and allowedToolNames through to the tool executor', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const env = { platform: process.platform };
      const confined = await core.context.createToolExecutorWithApprovals(null, env, null, { useSandbox: false, denyAutoApproval: true, allowedToolNames: new Set(['Ledger']) });
      assert.strictEqual(confined.denyAutoApproval, true);
      assert.deepStrictEqual(await confined.execute('Read', { file_path: __filename }), { success: false, error: 'Tool "Read" is not available in this turn.' });
      const open = await core.context.createToolExecutorWithApprovals(null, env, null, { useSandbox: false });
      assert.strictEqual(open.denyAutoApproval, false);
      assert.strictEqual(open.allowedToolNames, null);
    } finally {
      await core.shutdown();
    }
  });

  it('fails closed (empty Set, not "no limit") when allowedToolNames is neither a Set nor an Array (M3)', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const env = { platform: process.platform };
      const malformed = await core.context.createToolExecutorWithApprovals(null, env, null, { useSandbox: false, allowedToolNames: 'Ledger' });
      assert.deepStrictEqual(malformed.allowedToolNames, new Set());
      assert.deepStrictEqual(await malformed.execute('Ledger', { action: 'query' }), { success: false, error: 'Tool "Ledger" is not available in this turn.' });
      assert.deepStrictEqual(await malformed.execute('Read', { file_path: __filename }), { success: false, error: 'Tool "Read" is not available in this turn.' });
    } finally {
      await core.shutdown();
    }
  });

  it('does not run cases:wakeups twice concurrently when a tick fires while the previous run is still in flight', async () => {
    delete process.env.KL_CASES_ROOT;
    const core = createCore(serviceDeps());
    await core.start();
    try {
      const scheduler = core.context.getCronScheduler();
      const runtime = core.context.getCaseRuntime();
      let inFlight = 0;
      let maxConcurrent = 0;
      let calls = 0;
      let release;
      runtime.runDueWakeups = async () => {
        calls += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => { release = resolve; });
        inFlight -= 1;
        return { ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0 };
      };
      // Fire the job twice back to back, the way two overlapping scheduler
      // ticks would: the second call must be skipped or wait, never run
      // concurrently with the first.
      const first = scheduler.runNow('cases:wakeups');
      const second = scheduler.runNow('cases:wakeups');
      // Give the first call's synchronous prologue a turn to register itself
      // as running before we let it (and any legitimately serialized second
      // call) finish.
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(maxConcurrent, 1);
      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.strictEqual(calls, 1);
      assert.strictEqual(firstResult.ok, true);
      assert.strictEqual(secondResult.ok, false);
      assert.match(secondResult.error, /already running/);
    } finally {
      await core.shutdown();
    }
  });

  it('charges usage from a wake-up turn, including orient and a routed provider, to the case budget via onUsageRecorded (I2)', async () => {
    delete process.env.KL_CASES_ROOT;
    const deps = serviceDeps();
    const ORIENT_COST = 0.0100;
    const JUDGE_COST = 0.0246;
    // Real providers' plain sendMessage never carries llmMetrics (no usage
    // is ever reported on it), so this stub only implements
    // sendMessageWithTools — the path both orient and judge must use to be
    // charged at all — and tells the two calls apart by the model each
    // role's tier maps to, the same way a real provider call would differ.
    const stub = class {
      constructor(apiKey) { this.apiKey = apiKey; }
      getProviderName() { return 'stub'; }
      getDefaultModel() { return 'stub-default'; }
      async sendMessage() { throw new Error('sendMessage must not be used: it never reports usage.'); }
      async sendMessageWithTools(messages, tools, options) {
        if (options.model === 'stub-orient') {
          return {
            type: 'text',
            content: '{"changed": true, "why": "a due wake-up"}',
            llmMetrics: { provider: 'stub', model: options.model, inputTokens: 40, outputTokens: 10, totalTokens: 50, costUsd: ORIENT_COST }
          };
        }
        return {
          type: 'text',
          content: 'Nothing more to do.',
          llmMetrics: { provider: 'stub', model: options.model || 'stub-judge', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: JUDGE_COST }
        };
      }
    };
    ProviderFactory.registerProvider('stub', stub);
    try {
      deps.store.set('settings', {
        inference: {
          tierMap: {
            fast: { provider: 'stub', model: 'stub-orient' },
            smart: { provider: 'stub', model: 'stub-judge' }
          }
        }
      });
      const core = createCore(deps);
      core.saveProviderToken('stub', 'stub-token');
      await core.start();
      try {
        const runtime = core.context.getCaseRuntime();
        const info = await runtime.createCase({ title: 'Lakeside lot' });
        runtime.setStatus(info.id, 'active', { kind: 'gating' });
        runtime.wakeups(info.id).register({ kind: 'test-wakeup', at: new Date(runtime.now().getTime() - 1000).toISOString() });
        const before = runtime.budget(info.id).status().usd.spent;
        const counts = await runtime.runDueWakeups(runtime.now());
        assert.strictEqual(counts.ran, 1);
        const after = runtime.budget(info.id).status().usd.spent;
        assert.strictEqual(after, before + ORIENT_COST + JUDGE_COST);
      } finally {
        await core.shutdown();
      }
    } finally {
      ProviderFactory._registry.delete('stub');
    }
  });

  it('shutdown drains an in-flight wake-up before releasing its lock, and never starts a second case (I1)', async () => {
    delete process.env.KL_CASES_ROOT;
    const deps = serviceDeps();
    let releaseJudge;
    const judgeGate = new Promise((resolve) => { releaseJudge = resolve; });
    const stub = class {
      constructor(apiKey) { this.apiKey = apiKey; }
      getProviderName() { return 'stub'; }
      getDefaultModel() { return 'stub-default'; }
      async sendMessage() { throw new Error('unused'); }
      async sendMessageWithTools(messages, tools, options) {
        if (options.model === 'stub-orient') {
          return { type: 'text', content: '{"changed": true, "why": "go"}' };
        }
        // The judge call blocks here until the test releases it, so a
        // shutdown can be started while this case's turn is still open.
        await judgeGate;
        return { type: 'text', content: 'Done despite shutdown.' };
      }
    };
    ProviderFactory.registerProvider('stub', stub);
    try {
      deps.store.set('settings', {
        inference: { tierMap: { fast: { provider: 'stub', model: 'stub-orient' }, smart: { provider: 'stub', model: 'stub-judge' } } }
      });
      const core = createCore(deps);
      core.saveProviderToken('stub', 'stub-token');
      await core.start();
      let shutdownCalled = false;
      try {
        const runtime = core.context.getCaseRuntime();
        const a = await runtime.createCase({ title: 'Lot A' });
        const b = await runtime.createCase({ title: 'Lot B' });
        runtime.setStatus(a.id, 'active', { kind: 'gating' });
        runtime.setStatus(b.id, 'active', { kind: 'gating' });
        const past = new Date(runtime.now().getTime() - 1000).toISOString();
        runtime.wakeups(a.id).register({ kind: 'test-wakeup', at: past });
        runtime.wakeups(b.id).register({ kind: 'test-wakeup', at: past });

        // Instrumented so the test can prove the ordering directly: by the
        // time releaseAll() runs, case A's own endTurn must already have
        // released its lock — nothing should be left for releaseAll to force.
        const originalReleaseAll = runtime.releaseAll.bind(runtime);
        let aLockGoneBeforeReleaseAll = null;
        runtime.releaseAll = () => {
          aLockGoneBeforeReleaseAll = !fs.existsSync(path.join(a.dir, '.kl', 'lock'));
          return originalReleaseAll();
        };

        const scheduler = core.context.getCronScheduler();
        // Trigger the sweep through the scheduler (not runtime.runDueWakeups()
        // directly) so create-core's own handler tracks it as wakeupsInFlight,
        // the way a real periodic tick would.
        const sweepPromise = scheduler.runNow('cases:wakeups');
        // Let the sweep reach the blocked judge call on case A (its turn is
        // registered and its lock held by then).
        const deadline = Date.now() + 5000;
        while (!runtime.turns.has(a.id) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.strictEqual(runtime.turns.has(a.id), true, 'case A should be mid-turn, blocked in the judge call');
        assert.strictEqual(runtime.turns.has(b.id), false, 'the sweep should not have reached case B yet');

        const shutdownPromise = core.shutdown();
        shutdownCalled = true;
        let shutdownSettled = false;
        shutdownPromise.then(() => { shutdownSettled = true; });
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(shutdownSettled, false, 'shutdown must wait for the in-flight wake-up, not race it');

        releaseJudge();
        await shutdownPromise;
        await sweepPromise;

        assert.strictEqual(aLockGoneBeforeReleaseAll, true, 'endTurn must release the lock before releaseAll() runs');
        assert.strictEqual(fs.existsSync(path.join(a.dir, '.kl', 'lock')), false);
        assert.strictEqual(fs.existsSync(path.join(b.dir, '.kl', 'lock')), false);
        // Case B's wake-up was never picked up: runDueWakeups saw `closing`
        // before reaching it and stopped.
        // (active also auto-registers a daily-orientation wake-up, so check
        // the one this test actually cares about rather than the list length.)
        const testWakeup = runtime.wakeups(b.id).list().find((w) => w.kind === 'test-wakeup');
        assert.ok(testWakeup, 'case B should still have its test wake-up registered');
        assert.strictEqual(testWakeup.lastRunAt, null);
      } finally {
        // Whatever failed above, never leave a blocked judge call or a
        // running core behind for later tests to trip over.
        releaseJudge();
        if (!shutdownCalled) await core.shutdown().catch(() => {});
      }
    } finally {
      ProviderFactory._registry.delete('stub');
    }
  });
});

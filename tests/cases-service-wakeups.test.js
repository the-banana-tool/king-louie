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

  it('charges usage from a wake-up turn, including a routed provider, to the case budget via onUsageRecorded', async () => {
    delete process.env.KL_CASES_ROOT;
    const deps = serviceDeps();
    const stub = class {
      constructor(apiKey) { this.apiKey = apiKey; }
      getProviderName() { return 'stub'; }
      getDefaultModel() { return 'stub-default'; }
      async sendMessage() { return '{"changed": true, "why": "a due wake-up"}'; }
      async sendMessageWithTools(messages, tools, options) {
        return {
          type: 'text',
          content: 'Nothing more to do.',
          llmMetrics: {
            provider: 'stub', model: options.model || 'stub-judge',
            inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.0246
          }
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
        assert.strictEqual(after, before + 0.0246);
      } finally {
        await core.shutdown();
      }
    } finally {
      ProviderFactory._registry.delete('stub');
    }
  });
});

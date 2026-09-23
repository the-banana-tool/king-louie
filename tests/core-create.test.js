// tests/core-create.test.js
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { withTimeout, TIMED_OUT } = require('../src/core/with-timeout');

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-core-'));
  tempDirs.push(dataDir);
  const sent = [];
  return {
    sent,
    deps: {
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: (ch, p) => sent.push({ ch, p }) },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    }
  };
}

describe('createCore', () => {
  it('constructs synchronously and exposes settings and token helpers before start()', () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    assert.strictEqual(typeof core.getSettings().activeProvider, 'string');
    core.saveProviderToken('openai', 'sk-test');
    assert.ok(deps.store.get('apiTokens').openai.startsWith('klc1:'));
    core.vault.set('k', 'v');
    assert.strictEqual(core.vault.get('k'), 'v');
    assert.strictEqual(typeof core.context.getChats, 'function');
    assert.strictEqual(core.context.safeStorage, undefined);
  });

  it('starts headless with every optional feature off, then shuts down cleanly', async () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    await core.start();
    assert.ok(core.context.toolRegistry.getFunctionDefinitions().length > 10);
    assert.strictEqual(core.getMeshContext(), null);
    await core.shutdown();
  });

  it('finishes shutdown() within shutdownTimeoutMs when the SessionEnd hook never resolves', async () => {
    const { deps } = makeDeps();
    const handlerPath = path.join(deps.paths.dataDir, 'hang-hook.js');
    fs.writeFileSync(handlerPath, 'module.exports = () => new Promise(() => {});\n');
    const core = createCore({ ...deps, shutdownTimeoutMs: 50 });
    await core.start();
    // Seam: the started core's hook registry (exposed via context) feeds the
    // HookExecutor that runHookEvent uses, so a SessionEnd hook whose handler
    // never settles reproduces a hung user hook without spawning a shell.
    const registry = core.context.getHookRegistry();
    const original = registry.getByEvent.bind(registry);
    registry.getByEvent = (event) => (event === 'SessionEnd'
      ? [{ name: 'hang', event: 'SessionEnd', matcher: '*', enabled: true, handler: handlerPath }]
      : original(event));
    const startedAt = Date.now();
    await core.shutdown();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2000, `shutdown took ${elapsed}ms`);
  });
});

describe('createCore ports and listener failures', () => {
  it('uses the Electron ports by default (gateway 18789, webhook gateway + 1)', async () => {
    const { deps } = makeDeps();
    const saved = process.env.KL_TEST_MODE;
    delete process.env.KL_TEST_MODE;
    try {
      // Listeners are only constructed during start(); inspect them through a
      // started core with every listener feature off (nothing binds).
      const core = createCore(deps);
      await core.start();
      assert.strictEqual(core.context.getGatewayServer().port, 18789);
      assert.strictEqual(core.context.getWebhookServer().port, 18790);
      assert.strictEqual(core.context.getGatewayServer().authToken, null, 'no token is minted with the gateway off');
      await core.shutdown();
    } finally {
      if (saved === undefined) delete process.env.KL_TEST_MODE; else process.env.KL_TEST_MODE = saved;
    }
  });

  it('honours ports: { gateway, webhook }', async () => {
    const { deps } = makeDeps();
    const saved = process.env.KL_TEST_MODE;
    delete process.env.KL_TEST_MODE;
    try {
      const core = createCore({ ...deps, ports: { gateway: 18791, webhook: 18792 } });
      await core.start();
      assert.strictEqual(core.context.getGatewayServer().port, 18791);
      assert.strictEqual(core.context.getWebhookServer().port, 18792);
      await core.shutdown();
    } finally {
      if (saved === undefined) delete process.env.KL_TEST_MODE; else process.env.KL_TEST_MODE = saved;
    }
  });

  it('start() still resolves when the gateway and webhook ports are already taken', async () => {
    const http = require('http');
    const holders = [http.createServer(), http.createServer()];
    for (const h of holders) await new Promise((resolve) => h.listen(0, '127.0.0.1', resolve));
    const [gatewayPort, webhookPort] = holders.map((h) => h.address().port);
    const saved = process.env.KL_TEST_MODE;
    delete process.env.KL_TEST_MODE;
    try {
      const { deps } = makeDeps();
      const core = createCore({
        ...deps,
        features: { ...deps.features, gateway: true, webhooks: true },
        ports: { gateway: gatewayPort, webhook: webhookPort }
      });
      await core.start();
      // Give the fire-and-forget webhook start a tick to fail.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(core.context.getWebhookServer().httpServer, null);
      await core.shutdown();
    } finally {
      if (saved === undefined) delete process.env.KL_TEST_MODE; else process.env.KL_TEST_MODE = saved;
      for (const h of holders) await new Promise((resolve) => h.close(resolve));
    }
  });
});

describe('withTimeout', () => {
  function trackTimers() {
    const realSet = global.setTimeout;
    const realClear = global.clearTimeout;
    const created = [];
    const cleared = new Set();
    global.setTimeout = (...args) => { const t = realSet(...args); created.push(t); return t; };
    global.clearTimeout = (t) => { cleared.add(t); return realClear(t); };
    return { created, cleared, restore: () => { global.setTimeout = realSet; global.clearTimeout = realClear; } };
  }

  it('clears and unrefs its timer when the promise settles first', async () => {
    const timers = trackTimers();
    let result;
    try {
      result = await withTimeout(Promise.resolve('done'), 60_000, 'fast step');
    } finally {
      timers.restore();
    }
    assert.strictEqual(result, 'done');
    assert.strictEqual(timers.created.length, 1);
    assert.ok(timers.cleared.has(timers.created[0]), 'timer was not cleared');
    assert.strictEqual(timers.created[0].hasRef(), false);
  });

  it('clears its timer when the promise rejects first and passes the rejection through', async () => {
    const timers = trackTimers();
    try {
      await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 60_000, 'bad step'), /boom/);
    } finally {
      timers.restore();
    }
    assert.ok(timers.cleared.has(timers.created[0]), 'timer was not cleared');
  });

  it('resolves with TIMED_OUT and reports the label after the deadline', async () => {
    const seen = [];
    const result = await withTimeout(new Promise(() => {}), 20, 'slow step', (label, ms) => seen.push([label, ms]));
    assert.strictEqual(result, TIMED_OUT);
    assert.deepStrictEqual(seen, [['slow step', 20]]);
  });
});

// A6 — the agent's working directory is a dependency, not process-wide state.
// The service runs in <dataDir>/workspace so the ungated read tools do not
// treat the secret store as in-bounds; it used to get there with
// process.chdir(), which every other part of the process shares and can move.
describe('createCore workingDirectory', () => {
  it('defaults to process.cwd() so the Electron host is unchanged', async () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    const executor = await core.context.createToolExecutorWithApprovals(null);
    assert.strictEqual(fs.realpathSync(executor.workingDirectory), fs.realpathSync(process.cwd()));
  });

  it('uses the injected directory for the tool executor', async () => {
    const { deps } = makeDeps();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ws-'));
    tempDirs.push(workspace);
    const cwdBefore = process.cwd();
    const core = createCore({ ...deps, workingDirectory: workspace });

    const executor = await core.context.createToolExecutorWithApprovals(null);
    assert.strictEqual(fs.realpathSync(executor.workingDirectory), fs.realpathSync(workspace));
    assert.notStrictEqual(fs.realpathSync(executor.workingDirectory), fs.realpathSync(process.cwd()));
    // `process.cwd() === process.cwd()` used to stand here, which cannot fail
    // whatever createCore does. Capture it before the call instead: moving the
    // process is the host's decision (src/service/run.js does it deliberately),
    // never createCore's.
    assert.strictEqual(process.cwd(), cwdBefore, 'createCore must not chdir the process');
  });

  it('lets an explicit per-call workingDirectory still win', async () => {
    const { deps } = makeDeps();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ws-'));
    const perCall = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-call-'));
    tempDirs.push(workspace, perCall);
    const core = createCore({ ...deps, workingDirectory: workspace });

    const executor = await core.context.createToolExecutorWithApprovals(null, null, null, { workingDirectory: perCall });
    assert.strictEqual(fs.realpathSync(executor.workingDirectory), fs.realpathSync(perCall));
  });
});

// Copilot review comment C10 (PR #28): createCore starts the webhook listener
// fire-and-forget. `WebhookServer.start()` assigns `this.httpServer`
// synchronously and only nulls it when the bind rejects, so core.start() could
// return with a non-null handle and a doomed bind — and service mode's
// assertEnabledListenersBound, which reads exactly that handle, let the
// service report {"event":"ready"} with features.webhooks on and no listener.
describe('createCore: listener readiness', () => {
  const http = require('http');

  it('whenListenersSettled waits for a webhook bind that is going to fail', async () => {
    const squatter = http.createServer(() => {});
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const taken = squatter.address().port;

    const { deps } = makeDeps();
    const core = createCore({
      ...deps,
      features: { ...deps.features, webhooks: true },
      ports: { gateway: 18793, webhook: taken }
    });
    try {
      await core.start();
      // This is the state run.js used to judge: a handle that is not a bind.
      assert.notStrictEqual(core.getWebhookServer().httpServer, null);

      await core.whenListenersSettled();
      assert.strictEqual(core.getWebhookServer().httpServer, null, 'a refused bind must read as unbound');
    } finally {
      await core.shutdown();
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('whenListenersSettled resolves immediately when webhooks are off', async () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    await core.start();
    await core.whenListenersSettled();
    await core.shutdown();
  });
});

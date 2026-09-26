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

  it("appendMessageToChat generates id/timestamp itself; metadata cannot override them or the sender (minor fix, F5 review)", () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    core.context.setChats([{ id: 'chat-1', title: 'Chat', messages: [] }]);
    const updated = core.context.appendMessageToChat('chat-1', 'user', 'hi', {
      id: 'spoofed-id',
      sender: 'assistant',
      timestamp: '1999-01-01T00:00:00.000Z',
      channel: 'telegram'
    });
    const message = updated.messages[0];
    assert.notStrictEqual(message.id, 'spoofed-id');
    assert.strictEqual(message.sender, 'user');
    assert.notStrictEqual(message.timestamp, '1999-01-01T00:00:00.000Z');
    assert.strictEqual(message.text, 'hi');
    assert.strictEqual(message.channel, 'telegram', 'metadata keys other than id/sender/timestamp still apply');
  });

  it('migrateLegacyBridgeChatOrigins tags chats by title prefix, only user messages, and is idempotent (F5 re-review)', () => {
    const { deps } = makeDeps();
    deps.store.set('chats', [
      {
        id: 'chat-tg',
        title: '📱 Telegram: Alex (123)',
        messages: [
          { id: 'm1', sender: 'user', text: 'wire me $500' },
          { id: 'm2', sender: 'assistant', text: 'ok' }
        ]
      },
      { id: 'chat-dc', title: '👾 Discord: Sam (456)', messages: [{ id: 'm3', sender: 'user', text: 'hi' }] },
      { id: 'chat-plain', title: 'New Chat', messages: [{ id: 'm4', sender: 'user', text: 'hello' }] }
    ]);
    const core = createCore(deps);
    core.context.migrateLegacyBridgeChatOrigins();
    const chats = core.context.getChats();
    const tg = chats.find((c) => c.id === 'chat-tg');
    const dc = chats.find((c) => c.id === 'chat-dc');
    const plain = chats.find((c) => c.id === 'chat-plain');
    assert.strictEqual(tg.origin, 'telegram');
    assert.strictEqual(tg.messages[0].channel, 'telegram');
    assert.strictEqual(tg.messages[1].channel, undefined, 'the assistant message is left untagged');
    assert.strictEqual(dc.origin, 'discord');
    assert.strictEqual(dc.messages[0].channel, 'discord');
    assert.strictEqual(plain.origin, undefined);
    assert.strictEqual(plain.messages[0].channel, undefined);
    const before = JSON.stringify(core.context.getChats());
    core.context.migrateLegacyBridgeChatOrigins();
    assert.strictEqual(JSON.stringify(core.context.getChats()), before, 'a second run changes nothing further');
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

describe('createCore: contact host (cases stage 4)', () => {
  it('serves getContact() once started; desktop mode takes the owner from settings, service mode (deps.contactConfig) from the admin block', async () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    assert.strictEqual(core.context.getContact(), null, 'nothing before start()');
    await core.start();
    try {
      const contact = core.context.getContact();
      assert.ok(contact && contact.ladder && contact.presence && contact.router);
      assert.deepStrictEqual(contact.ladderState(), {});
    } finally {
      await core.shutdown();
    }
  });

  it('shutdown stops the contact host before the channels and the webhook server, under the shutdown timeout', async () => {
    const { deps } = makeDeps();
    const core = createCore({ ...deps, contactConfig: null, shutdownTimeoutMs: 50 });
    await core.start();
    const order = [];
    const { ladder } = core.context.getContact();
    const ladderStop = ladder.stop.bind(ladder);
    ladder.stop = async () => { order.push('contact'); await ladderStop(); return new Promise(() => {}); };
    const registry = core.context.getChannelRegistry();
    const shutdownAll = registry.shutdownAll.bind(registry);
    registry.shutdownAll = async () => { order.push('channels'); return shutdownAll(); };
    const webhook = core.getWebhookServer();
    const webhookStop = webhook.stop.bind(webhook);
    webhook.stop = async () => { order.push('webhook'); return webhookStop(); };
    // withTimeout's timer is unref'd and the contact stop never settles here.
    const release = require('./helpers/hold-event-loop').holdEventLoop();
    const startedAt = Date.now();
    try {
      await core.shutdown();
    } finally {
      release();
    }
    assert.deepStrictEqual(order.slice(0, 1), ['contact']);
    assert.ok(order.includes('channels') && order.includes('webhook'));
    assert.ok(Date.now() - startedAt < 2000, 'a hung contact stop does not hang quit');
  });
});

describe('createCore: a contact host that cannot start (ruling T13-start)', () => {
  it('logs it, leaves contact off, warns the owner once and starts everything else', async () => {
    const { deps } = makeDeps();
    // A cases root that is a file: the ladder's lease open throws ENOTDIR at start.
    fs.writeFileSync(path.join(deps.paths.dataDir, 'cases-file'), 'not a directory');
    // A relay, so the failed start has a poller and the push route to undo.
    deps.store.set('settings', {
      cases: { root: 'cases-file' },
      contact: { relays: { main: { baseUrl: 'https://relay.example.com', pollSec: 30 } } }
    });
    const { RelayPoller } = require('../src/channels/relay-client');
    const pollers = [];
    const pollerStart = RelayPoller.prototype.start;
    RelayPoller.prototype.start = function trackedStart() { pollers.push(this); return pollerStart.call(this); };
    const toasts = [];
    const core = createCore({ ...deps, features: { ...deps.features, channels: true }, uiToastChannel: { send: async (p) => { toasts.push(p); } } });
    try {
      await core.start();
    } finally {
      RelayPoller.prototype.start = pollerStart;
    }
    try {
      assert.strictEqual(core.context.getContact(), null, 'contact is off');
      assert.ok(core.context.toolRegistry.getFunctionDefinitions().length > 10, 'the rest of the core started');
      assert.strictEqual(toasts.length, 1);
      assert.match(toasts[0].body, /^Contact channels could not start: .+\. Cases will only reach you in the app\.$/);
      assert.strictEqual(core.getWebhookServer().contactRelayHandler, null, 'the relay push route is gone');
      assert.ok(pollers.length === 1, 'the relay poller had started');
      assert.ok(pollers.every((p) => !p.running && p.timer === null), 'and is stopped');
      // Bridge detach after a failed start: tests/contact-host.test.js
      // "T13-start: after a start failure…" (no bridge runs without a token here).
    } finally {
      await core.shutdown();
    }
  });
});

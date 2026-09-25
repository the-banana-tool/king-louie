// tests/desktop-bridge-dispatcher.test.js
// A real service core ('deny', like the service) behind the dispatcher.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
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
const { registerHandlers } = require('../src/ipc/register');
const { listIpcChannels } = require('../src/ipc/channel-inventory');
const { servedChannels } = require('../src/desktop-bridge/allowlist');
const { createBridgeDispatcher, approvalsStatus } = require('../src/desktop-bridge/bridge-dispatcher');
const { createConnection } = require('../src/desktop-bridge/connection');
const { isLocalDesktopEvent, localDesktopDeviceId } = require('../src/core/origin');

const PROBE = 'KlTestBridgeProbe';
let probeRuns = 0;
const realOpenAI = ProviderFactory._registry.get('openai');

class FakeProvider {
  constructor() { this.calls = 0; }
  async sendMessageWithTools() {
    this.calls += 1;
    if (this.calls === 1) return { type: 'tool_use', toolName: PROBE, toolUseId: 'call_1', parameters: {} };
    return { type: 'text', content: 'finished' };
  }
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}

let core;
let dataDir;
const cipher = createAesGcmCipher(crypto.randomBytes(32));

before(async () => {
  ProviderFactory.registerProvider('openai', FakeProvider);
  toolRegistry.register(new Tool({
    name: PROBE,
    description: 'Test-only tool that requires approval.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => { probeRuns += 1; return { ok: true }; }
  }));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dispatch-'));
  core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher,
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals: 'deny'
  });
  const tiers = { provider: 'openai', model: 'fake' };
  const settings = core.getSettings();
  core.context.setSettings({
    ...settings,
    activeProvider: 'openai',
    inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } }
  });
  core.saveProviderToken('openai', 'fake-token-123456');
  await core.start();
});

after(async () => {
  await core.shutdown().catch(() => {});
  if (realOpenAI) ProviderFactory.registerProvider('openai', realOpenAI);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function connection(label = 'desk a') {
  const sent = [];
  const conn = createConnection({ deviceId: `kld-${crypto.randomBytes(10).toString('hex').replace(/[^a-z2-7]/g, 'a').slice(0, 16).padEnd(16, 'a')}`, label, send: (f) => sent.push(f) });
  conn.sent = sent;
  return conn;
}

function makeDispatcher({ overrides = {}, coreOverride = null, approvals = null, createImporter = null } = {}) {
  let current = null;
  const dispatcher = createBridgeDispatcher({
    core: coreOverride || core,
    cipher,
    dataDir,
    approvals,
    account: 'LOCAL SERVICE',
    getServiceInfo: () => ({ version: '26.9.0' }),
    getConnection: () => current,
    registerHandlers: (ipc, ctx) => {
      registerHandlers(ipc, ctx);
      for (const [channel, fn] of Object.entries(overrides)) ipc.handle(channel, fn);
    },
    createImporter
  });
  return { dispatcher, use: (conn) => { current = conn; } };
}

const waitFor = async (fn, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('waitFor timed out');
};
const resultFor = (conn, id) => conn.sent.find((f) => f.t === 'result' && f.id === id);

describe('bridge dispatcher', () => {
  it('serves (inventory ∩ allowlist) − prestep', () => {
    const { dispatcher } = makeDispatcher();
    const expected = servedChannels(listIpcChannels());
    assert.deepStrictEqual(dispatcher.served, expected);
    assert.ok(dispatcher.served.handle.includes('chat:load'));
    assert.ok(!dispatcher.served.handle.includes('chat:pickWorkingDirectory'));
    assert.ok(!dispatcher.served.handle.includes('desktop:status'));
    assert.strictEqual(dispatcher.providersConfigured(), true);
  });

  it('never reaches the handler of a denied channel', async () => {
    let called = 0;
    const { dispatcher, use } = makeDispatcher({ overrides: { 'hooks:reload': async () => { called += 1; return { ok: true }; } } });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'invoke', id: 1, channel: 'hooks:reload', args: [] });
    assert.strictEqual(called, 0);
    assert.strictEqual(resultFor(a, 1).code, 'CHANNEL_NOT_PROXIED');
  });

  it('marks every event with the connection device id', async () => {
    let seen = null;
    const { dispatcher, use } = makeDispatcher({ overrides: { 'chat:load': async (event) => { seen = event; return { ok: true, data: [] }; } } });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'invoke', id: 2, channel: 'chat:load', args: [] });
    assert.strictEqual(isLocalDesktopEvent(seen), true);
    assert.strictEqual(localDesktopDeviceId(seen), a.deviceId);
    assert.deepStrictEqual(resultFor(a, 2).value, { ok: true, data: [] });
  });

  it('ignores a prompt answer from a connection the prompt was not issued to', async () => {
    const { dispatcher, use } = makeDispatcher();
    const a = connection('desk a');
    const b = connection('desk b');
    use(a);
    const before = probeRuns;
    const running = dispatcher.handleFrame(a, { t: 'invoke', id: 3, channel: 'tool:execute', args: [{ toolName: PROBE, parameters: {} }] });
    const prompt = await waitFor(() => a.sent.find((f) => f.t === 'event' && f.channel === 'tool:approvalRequired'));
    use(b);
    await dispatcher.handleFrame(b, { t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: true }] });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(probeRuns, before, 'B cannot answer A\'s prompt');
    use(a);
    await dispatcher.handleFrame(a, { t: 'send', channel: 'tool:approvalResponse', args: [{ approvalId: prompt.payload.approvalId, approved: true }] });
    await running;
    assert.strictEqual(probeRuns, before + 1);
    assert.strictEqual(resultFor(a, 3).value.ok, true);
  });

  it('on disconnect stops that connection\'s runs and denies its prompts', async () => {
    const stops = new Map();
    const stopped = [];
    const { dispatcher, use } = makeDispatcher({
      overrides: {
        'chat:sendMessage': async (_event, { chatId }) => new Promise((resolve) => stops.set(chatId, resolve)),
        'chat:stopResponse': async (_event, { chatId }) => { stopped.push(chatId); stops.get(chatId)({ ok: true, data: null }); return { ok: true }; }
      }
    });
    core.context.setChats([{ id: 'c-run', title: 'Run', createdAt: '2026-09-23T10:00:00Z', updatedAt: '2026-09-23T10:00:00Z', messages: [] }]);
    const a = connection();
    use(a);
    const chat = dispatcher.handleFrame(a, { t: 'invoke', id: 4, channel: 'chat:sendMessage', args: [{ chatId: 'c-run', message: 'go' }] });
    const tool = dispatcher.handleFrame(a, { t: 'invoke', id: 5, channel: 'tool:execute', args: [{ toolName: PROBE, parameters: {} }] });
    await waitFor(() => a.sent.find((f) => f.t === 'event' && f.channel === 'tool:approvalRequired'));
    const ask = dispatcher.bridgeContext.prompter.askUser({ question: 'Which folder?' });
    a.markGone();
    await dispatcher.onDisconnect(a);
    await Promise.all([chat, tool]);
    assert.deepStrictEqual(stopped, ['c-run']);
    // tool:execute's wrapHandler wraps the executor's refusal in { ok: true, data }.
    assert.strictEqual(resultFor(a, 5).value.data.deniedBy, 'user');
    assert.deepStrictEqual(await ask, { ok: false, error: 'The desktop disconnected.' });
    const messages = core.context.getChats().find((c) => c.id === 'c-run').messages;
    assert.strictEqual(messages[messages.length - 1].text, 'The desktop disconnected; the run was stopped.');
  });

  it('forwards ambient events except prompts', () => {
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    dispatcher.forwardAmbient('chat:updated', { chats: [] });
    dispatcher.forwardAmbient('tool:approvalRequired', { approvalId: 'x' });
    dispatcher.forwardAmbient('workflow:progress', {});
    assert.deepStrictEqual(a.sent.map((f) => f.channel), ['chat:updated']);
  });

  it('a desktop-added directory reaches a marked run\'s executor but not settings.allowedDirectories', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dispatch-dir-'));
    let captured = null;
    const spyCore = {
      ...core,
      context: {
        ...core.context,
        createToolExecutorWithApprovals: async (event, _env, _requester, options) => { captured = { event, options }; throw new Error('captured'); }
      }
    };
    const { dispatcher, use } = makeDispatcher({ coreOverride: spyCore });
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 6, method: 'bridge.addAllowedDirectory', params: { path: dir } });
    assert.ok(resultFor(a, 6).value.allowedDirectories.includes(dir));
    assert.ok(!core.context.getSettings().allowedDirectories.includes(dir));
    await dispatcher.handleFrame(a, { t: 'invoke', id: 7, channel: 'settings:load', args: [] });
    assert.ok(resultFor(a, 7).value.data.allowedDirectories.includes(dir));
    await dispatcher.handleFrame(a, { t: 'invoke', id: 8, channel: 'chat:create', args: ['Scoped'] });
    const chatId = resultFor(a, 8).value.data.id;
    await dispatcher.handleFrame(a, { t: 'invoke', id: 9, channel: 'chat:sendMessage', args: [{ chatId, message: 'hello' }] });
    assert.ok(captured, 'the chat turn built an executor');
    assert.ok(captured.options.allowedDirectories.includes(dir));
    assert.strictEqual(isLocalDesktopEvent(captured.event), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to remove a service-set deny rule', async () => {
    core.context.addPermissionRule({ tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'service' });
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'invoke', id: 10, channel: 'tool:removePermissionRule', args: [{ tool: 'Bash', pattern: 'rm *', action: 'deny' }] });
    assert.strictEqual(resultFor(a, 10).code, 'RULE_NOT_DESKTOP');
    assert.ok(core.context.getPermissionRules().some((r) => r.pattern === 'rm *' && r.action === 'deny'));
  });

  it('negative: a gateway agent.execute while a desktop is connected is denied and shows no prompt', async () => {
    const { use } = makeDispatcher();
    const a = connection();
    use(a);
    const before = probeRuns;
    const gateway = core.context.getGatewayServer();
    const session = core.context.getSessionManager().getOrCreateSession('bridge-negative', 'main', { channel: 'test', peer: 'p', label: 'test' });
    const handlerCalls = [];
    const response = new Promise((resolve) => gateway.once('agent:response', resolve));
    gateway.emit('agent:message', {
      agentId: 'main',
      sessionKey: session.key,
      message: { runId: 'run-neg', message: 'please run the probe', approvalHandler: async (req) => { handlerCalls.push(req.toolName); return true; } }
    });
    await response;
    assert.strictEqual(probeRuns, before);
    assert.deepStrictEqual(handlerCalls, []);
    assert.ok(!a.sent.some((f) => f.channel === 'tool:approvalRequired'));
  });

  it('sets a working directory only when the service can read it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dispatch-wd-'));
    core.context.setChats([{ id: 'c-wd', title: 'WD', createdAt: '2026-09-23T10:00:00Z', updatedAt: '2026-09-23T10:00:00Z', messages: [] }]);
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 11, method: 'bridge.setWorkingDirectory', params: { chatId: 'c-wd', path: path.join(dir, 'missing') } });
    assert.strictEqual(resultFor(a, 11).code, 'PATH_NOT_ACCESSIBLE');
    assert.match(resultFor(a, 11).error, /The service runs as LOCAL SERVICE and cannot read/);
    await dispatcher.handleFrame(a, { t: 'call', id: 12, method: 'bridge.setWorkingDirectory', params: { chatId: 'c-wd', path: dir } });
    assert.strictEqual(resultFor(a, 12).value.data.workingDirectory, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves only canvas requests issued to this connection', async () => {
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    let resolved = null;
    core.pendingCanvasJsResolvers.set('req-1', { resolve: (v) => { resolved = v; }, reject() {}, timeout: null });
    await dispatcher.handleFrame(a, { t: 'call', id: 13, method: 'bridge.canvasJsResult', params: { requestId: 'req-1', result: 42 } });
    assert.strictEqual(resultFor(a, 13).value.ok, false);
    a.prompts.canvas.add('req-1');
    await dispatcher.handleFrame(a, { t: 'call', id: 14, method: 'bridge.canvasJsResult', params: { requestId: 'req-1', result: 42 } });
    assert.deepStrictEqual(resolved, { action: 'execute_js', result: 42 });
  });

  // Fix round 1, M5: a pending canvas:executeJs request bound to the
  // disconnecting connection must be rejected immediately, not left to its
  // own 10s execution timeout in create-core.js (the only other thing that
  // would ever settle it) — never resolved, and removed from the map so
  // nothing later mistakes it for still-pending.
  it('rejects a pending canvas request on disconnect instead of leaving it pending', async () => {
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    let resolveCalled = false;
    let rejectedWith = null;
    const timeout = setTimeout(() => {}, 60000);
    timeout.unref?.();
    core.pendingCanvasJsResolvers.set('req-2', {
      resolve: () => { resolveCalled = true; },
      reject: (err) => { rejectedWith = err; },
      timeout
    });
    a.prompts.canvas.add('req-2');
    a.markGone();
    await dispatcher.onDisconnect(a);
    assert.strictEqual(resolveCalled, false, 'never resolved as if it had succeeded');
    assert.ok(rejectedWith instanceof Error);
    assert.strictEqual(rejectedWith.message, 'The desktop disconnected.');
    assert.strictEqual(core.pendingCanvasJsResolvers.has('req-2'), false, 'removed, not left pending');
  });

  it('reports approvals status, unavailable before fleet stage 3', async () => {
    assert.deepStrictEqual(approvalsStatus({ approvals: null, dataDir }), { available: false });
    fs.mkdirSync(path.join(dataDir, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'approvals', 'link.json'), JSON.stringify({ connected: true, since: '2026-09-23T10:00:00Z', relay_id: 'kl-relayrelayrelay1' }));
    const stub = {
      approverStore: { list: () => [{ device_id: 'd-phonephonephone1', name: 'Phone', platform: 'android' }], isActive: () => true },
      phoneApprover: { pending: () => [{ request_id: 'r-1', summary: 'Bash: ls', expires_at: '2026-09-23T10:05:00Z' }] },
      auditLedger: { tail: () => [{ seq: 12, at: '2026-09-23T10:01:00Z' }] }
    };
    assert.deepStrictEqual(approvalsStatus({ approvals: stub, dataDir }), {
      available: true,
      relay: { configured: true, connected: true, since: '2026-09-23T10:00:00Z', relay_id: 'kl-relayrelayrelay1' },
      devices: [{ device_id: 'd-phonephonephone1', name: 'Phone', platform: 'android', active: true }],
      pending: [{ request_id: 'r-1', summary: 'Bash: ls', expires_at: '2026-09-23T10:05:00Z' }],
      audit: { last_seq: 12, last_at: '2026-09-23T10:01:00Z' }
    });
    const { dispatcher, use } = makeDispatcher();
    const a = connection();
    use(a);
    await dispatcher.handleFrame(a, { t: 'call', id: 15, method: 'bridge.approvalsStatus', params: {} });
    assert.deepStrictEqual(resultFor(a, 15).value, { available: false });
    await dispatcher.handleFrame(a, { t: 'call', id: 16, method: 'import.plan', params: {} });
    assert.strictEqual(resultFor(a, 16).code, 'IMPORT_UNAVAILABLE');
  });

  // Task 11 fix round 1, I1: the old getImporter() checked `!importer` and
  // only assigned it after awaiting createImporter(...), so a second
  // import.plan/import.apply landing while that await was still in flight saw
  // `importer` still null and built its own DesktopImporter — and the real
  // DesktopImporter's constructor sweeps every `.import-*` staging dir on
  // construction, so the second instance would delete the first one's live
  // staging (Task 8 carry). getImporter now memoizes the PROMISE itself
  // before any await, so both calls share the one in-flight construction.
  it('builds exactly one importer when two import.plan calls race the construction', async () => {
    let constructions = 0;
    let cleanups = 0;
    // Every in-flight construction's release, not just the first: if the fix
    // regressed and a second DesktopImporter got built, this must still
    // settle both instead of hanging the test on a resolver a second
    // construction silently overwrote.
    const releases = [];
    const createImporter = async () => {
      constructions += 1;
      // Mirrors DesktopImporter's constructor: cleanupOrphanedStaging runs
      // synchronously as part of construction, before the slow async setup
      // (buildImportTargets does real file/store I/O) settles.
      cleanups += 1;
      await new Promise((resolve) => releases.push(resolve));
      return { plan: async () => ({ planId: 'p-1', items: [], counts: {} }) };
    };
    const { dispatcher, use } = makeDispatcher({ createImporter });
    const a = connection();
    use(a);
    const call1 = dispatcher.handleFrame(a, { t: 'call', id: 20, method: 'import.plan', params: {} });
    const call2 = dispatcher.handleFrame(a, { t: 'call', id: 21, method: 'import.plan', params: {} });
    await waitFor(() => releases.length > 0);
    releases.forEach((release) => release());
    await Promise.all([call1, call2]);
    assert.strictEqual(constructions, 1, 'exactly one DesktopImporter constructed');
    assert.strictEqual(cleanups, 1, 'exactly one cleanupOrphanedStaging sweep');
    assert.strictEqual(resultFor(a, 20).value.planId, 'p-1');
    assert.strictEqual(resultFor(a, 21).value.planId, 'p-1');
  });
});

// Final review I3: settings:runLlmCommand is proxied, but its channel
// actions are not (spec §8) — the dispatcher refuses them before the core
// sees them; and the core itself, with channels off, refuses a channel
// sub-action before it saves anything.
describe('runLlmCommand channel actions', () => {
  it('refuses discord, telegram and slack actions from the desktop, however they are spelled', async () => {
    const seen = [];
    const spyCore = { ...core, context: { ...core.context, runLlmCommand: async (command) => { seen.push(command); return { ok: true, output: 'ran' }; } } };
    const { dispatcher, use } = makeDispatcher({ coreOverride: spyCore });
    const a = connection();
    use(a);
    const refused = [
      '/llm telegram add 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      '/llm slack add xapp-1 xoxb-2',
      '/llm discord add token',
      '/llm "Discord" add token',
      '  /llm   TELEGRAM   remove',
      '/llm slack status'
    ];
    let id = 100;
    for (const command of refused) {
      id += 1;
      await dispatcher.handleFrame(a, { t: 'invoke', id, channel: 'settings:runLlmCommand', args: [{ command }] });
      assert.deepStrictEqual(resultFor(a, id).value, {
        ok: false, code: 'CHANNELS_NOT_PROXIED', error: 'Channels (Telegram, Slack, Discord) are managed on the service, not from the desktop.'
      }, command);
    }
    assert.deepStrictEqual(seen, [], 'no channel action reached the core');
    id += 1;
    await dispatcher.handleFrame(a, { t: 'invoke', id, channel: 'settings:runLlmCommand', args: [{ command: '/llm help' }] });
    assert.deepStrictEqual(resultFor(a, id).value, { ok: true, output: 'ran' });
    assert.deepStrictEqual(seen, ['/llm help']);
  });

  it('with channels off, the core refuses a channel sub-action before saving any token or setting', async () => {
    const off = { ok: false, error: 'Channels are off in this session.' };
    const slackBefore = JSON.stringify((core.getSettings().channels || {}).slack || null);
    assert.deepStrictEqual(await core.context.runLlmCommand('/llm telegram add 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ'), off);
    assert.deepStrictEqual(await core.context.runLlmCommand('/llm telegram test'), off);
    assert.deepStrictEqual(await core.context.runLlmCommand('/llm slack add xapp-1 xoxb-2'), off);
    assert.deepStrictEqual(await core.context.runLlmCommand('/llm slack test'), off);
    assert.deepStrictEqual(await core.context.runLlmCommand('/llm discord add token'), off);
    assert.deepStrictEqual(await core.context.runLlmCommand('/llm discord remove'), off);
    assert.strictEqual(JSON.stringify((core.getSettings().channels || {}).slack || null), slackBefore, 'slack settings untouched');
    const telegram = await core.context.runLlmCommand('/llm telegram status');
    assert.match(telegram.output, /- Token: missing/);
    const slack = await core.context.runLlmCommand('/llm slack status');
    assert.match(slack.output, /- App Token: missing/);
    assert.match(slack.output, /- Bot Token: missing/);
    const discord = await core.context.runLlmCommand('/llm discord status');
    assert.match(discord.output, /- Token: missing/);
  });
});

describe('desktop-scoped permission rules (final review I4)', () => {
  const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
  const { evaluateRules } = require('../src/tools/permission-rules');

  it('tags rules the desktop adds with origin desktop, and the core keeps only that origin', () => {
    const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-i4-'));
    try {
      const scope = createDesktopScope({ dataDir: scopeDir, context: core.context });
      assert.strictEqual(scope.addPermissionRule({ tool: 'Bash', pattern: 'kli4tag *', action: 'allow', source: 'approval-dialog' }), true);
      const added = core.context.getPermissionRules().find((r) => r.pattern === 'kli4tag *');
      assert.strictEqual(added.origin, 'desktop');
      core.context.addPermissionRule({ tool: 'Bash', pattern: 'kli4other *', action: 'allow', source: 'approval-dialog', origin: 'elsewhere' });
      assert.strictEqual(core.context.getPermissionRules().find((r) => r.pattern === 'kli4other *').origin, undefined);
      // The service re-adding the same key reclaims it: the origin is gone and
      // the desktop can neither remove it nor take it back.
      core.context.addPermissionRule({ tool: 'Bash', pattern: 'kli4tag *', action: 'allow', source: 'user' });
      assert.strictEqual(core.context.getPermissionRules().find((r) => r.pattern === 'kli4tag *').origin, undefined);
      assert.throws(() => scope.removePermissionRule('Bash', 'kli4tag *', 'allow'), (err) => err.code === 'RULE_NOT_DESKTOP');
      assert.strictEqual(scope.addPermissionRule({ tool: 'Bash', pattern: 'kli4tag *', action: 'allow' }), false);
    } finally {
      fs.rmSync(scopeDir, { recursive: true, force: true });
    }
  });

  it('a desktop allow plus a later hand-written deny evaluates to deny', () => {
    const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-i4-'));
    try {
      const scope = createDesktopScope({ dataDir: scopeDir, context: core.context });
      scope.addPermissionRule({ tool: 'Bash', pattern: 'kli4 *', action: 'allow', source: 'approval-dialog' });
      core.context.addPermissionRule({ tool: 'Bash', pattern: 'kli4 push*', action: 'deny', source: 'user' });
      const rules = core.context.getPermissionRules();
      assert.ok(rules.findIndex((r) => r.pattern === 'kli4 *') < rules.findIndex((r) => r.pattern === 'kli4 push*'), 'the desktop allow comes first in the list');
      assert.strictEqual(evaluateRules(rules, 'Bash', { command: 'kli4 push origin' }).action, 'deny');
      assert.strictEqual(evaluateRules(rules, 'Bash', { command: 'kli4 status' }).action, 'allow');
    } finally {
      fs.rmSync(scopeDir, { recursive: true, force: true });
    }
  });
});

// tests/egress-callers.test.js
// The model calls that never pass the router (spec
// 2026-10-13-local-inference-design.md §7.5, §7.7, §8.5; R-LI-8, R-LI-9,
// R-LI-22, R-LI-32, R-LI-33; the plan's question N1): each asks the egress
// policy. A real core, a fake local server on 127.0.0.1, an OpenAI key, and
// a fetch stub that records every request: it answers OpenAI's model list
// and its embeddings (both are what a chat that is not private may send)
// and fails the test's turn for anything else. Chats are marked through
// the store.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { egressPolicy } = require('../src/models/egress');
const IPC = require('../src/ipc/constants');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const { registerWorkflowHandlers } = require('../src/ipc/workflow-handlers');
const ToolExecutor = require('../src/execution/tool-executor');
const { PRIVATE_REFUSED_TOOLS, privateRefusal } = require('../src/tools/private-refusals');
const { FLEET_CHAT_TOOL_NAMES, FLEET_READ_TOOLS } = require('../src/tools/builtin/fleet-chat-tools');
const ImageGenerateTool = require('../src/tools/builtin/image-generate-tool');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const t = (provider, model, effort = null) => ({ provider, model, effort });
// "chat-model" answers every request with the same text, so a turn ends in
// one call; an owner override says it can call tools (the probe, which only
// ever gets that text back, would say it cannot).
const LOCAL = t('local', 'workstation/chat-model');
const LOCAL_TITLE = t('local', 'workstation/title-model');
const DOWN_TITLE = t('local', 'sleeper/title-model');
const HOSTED = t('openai', 'gpt-5.5');
const HOSTED_MINI = t('openai', 'gpt-5.4-mini');
const PRIVATE = egressPolicy({ reason: 'private-chat', chatId: 'chat-x' });

async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe('private refusals (src/tools/private-refusals.js)', () => {
  it('R-LI-32: the acting fleet tools are listed, the reading ones are not', () => {
    const acting = FLEET_CHAT_TOOL_NAMES.filter((name) => !FLEET_READ_TOOLS.includes(name));
    assert.ok(acting.includes('delegate'));
    for (const name of acting) assert.strictEqual(privateRefusal(name, {}).code, 'PRIVATE_NO_DELEGATE', name);
    for (const name of FLEET_READ_TOOLS) assert.strictEqual(privateRefusal(name, {}), null, name);
    assert.deepStrictEqual(
      Object.keys(PRIVATE_REFUSED_TOOLS).filter((name) => PRIVATE_REFUSED_TOOLS[name].code === 'PRIVATE_NO_DELEGATE').sort(),
      [...acting].sort()
    );
  });

  it('N1: Cron create and change, sessions_spawn and a remote dispatch are refused PRIVATE_NO_DETACHED_RUN', () => {
    for (const action of ['add', 'update']) assert.strictEqual(privateRefusal('Cron', { action }).code, 'PRIVATE_NO_DETACHED_RUN', action);
    for (const action of ['list', 'status', 'remove', 'run']) assert.strictEqual(privateRefusal('Cron', { action }), null, action);
    assert.strictEqual(privateRefusal('sessions_spawn', { agentId: 'main' }).code, 'PRIVATE_NO_DETACHED_RUN');
    assert.strictEqual(privateRefusal('RemoteDispatch', { action: 'dispatch', message: 'x' }).code, 'PRIVATE_NO_DETACHED_RUN');
    for (const action of ['peers', 'status', 'cancel']) assert.strictEqual(privateRefusal('RemoteDispatch', { action }), null, action);
    // An action the list does not know is refused: what cannot be decided does not run.
    for (const params of [{}, null, { action: 'ADD' }, { action: 'schedule' }, { action: 7 }]) {
      assert.strictEqual(privateRefusal('Cron', params).code, 'PRIVATE_NO_DETACHED_RUN');
      assert.strictEqual(privateRefusal('RemoteDispatch', params).code, 'PRIVATE_NO_DETACHED_RUN');
    }
  });

  it('R-LI-33: ImageGenerate is listed; R-LI-9: ordinary tools are not', () => {
    assert.strictEqual(privateRefusal('ImageGenerate', { prompt: 'x' }).code, 'PRIVATE_HOSTED_CALL');
    for (const name of ['WebSearch', 'WebFetch', 'Bash', 'Read', 'message', 'Browser', 'Executor', 'SpawnAgent', 'BackgroundTask', 'sessions_list', 'sessions_history', 'SearchHistory']) {
      assert.strictEqual(privateRefusal(name, {}), null, name);
    }
    assert.strictEqual(Object.isFrozen(PRIVATE_REFUSED_TOOLS), true);
    for (const entry of Object.values(PRIVATE_REFUSED_TOOLS)) {
      assert.strictEqual(Object.isFrozen(entry), true);
      assert.match(entry.code, /^PRIVATE_/);
      assert.ok(entry.message.length > 20);
    }
  });

  it('the executor refuses a listed tool before any hook, rule or prompt, and only under a policy', async () => {
    const asked = [];
    const hooks = [];
    const build = (options) => {
      const executor = new ToolExecutor({
        workingDirectory: os.tmpdir(),
        requireApproval: true,
        approvalRequester: async (toolName) => { asked.push(toolName); return { approved: false }; },
        hookExecutor: { run: async (name, payload) => { hooks.push([name, payload.toolName]); return { action: 'allow' }; } },
        ...options
      });
      const events = [];
      executor.on('postExecute', (e) => events.push(e));
      return { executor, events };
    };
    const marked = build({ turnModels: { egress: PRIVATE } });
    const refused = await marked.executor.execute('Cron', { action: 'add', job: { schedule: '* * * * *', payload: {} } });
    assert.strictEqual(refused.success, false);
    assert.strictEqual(refused.code, 'PRIVATE_NO_DETACHED_RUN');
    assert.strictEqual(refused.deniedBy, 'policy');
    assert.match(refused.error, /private/);
    assert.deepStrictEqual(marked.events.map((e) => e.result.code), ['PRIVATE_NO_DETACHED_RUN']);
    // A tool that is not even registered here is refused by name.
    assert.strictEqual((await marked.executor.execute('delegate', { task: 'x' })).code, 'PRIVATE_NO_DELEGATE');
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(hooks, []);
    // The policy may also come from the host, for a run with no snapshot; and
    // a value that is not a policy still restricts.
    assert.strictEqual((await build({ egress: PRIVATE }).executor.execute('sessions_spawn', {})).code, 'PRIVATE_NO_DETACHED_RUN');
    assert.strictEqual((await build({ egress: true }).executor.execute('sessions_spawn', {})).code, 'PRIVATE_NO_DETACHED_RUN');
    assert.strictEqual((await build({ turnModels: { egress: null }, egress: PRIVATE }).executor.execute('sessions_spawn', {})).code, 'PRIVATE_NO_DETACHED_RUN');
    // No policy: the rule refuses nothing.
    for (const options of [{}, { turnModels: { egress: null } }, { turnModels: { egress: null }, egress: null }]) {
      const open = build(options).executor;
      assert.strictEqual(open.privateRefusalFor('Cron', { action: 'add' }), null);
      assert.strictEqual(open.privateRefusalFor('delegate', {}), null);
      assert.strictEqual(open.privateRefusalFor('ImageGenerate', {}), null);
    }
    // A child's requester carries the policy on, with the snapshot.
    assert.strictEqual(marked.executor._rethreadedRequester().turnModels.egress, PRIVATE);
  });
});

describe('the callers that bypass the router, in a core', () => {
  let box;
  let downPort;
  let dataDir;
  let core;
  let ctx;
  const originalFetch = globalThis.fetch;
  const originalLookup = dns.promises.lookup;
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  const fetched = [];      // every request through the global fetch
  const embedded = [];     // every text sent to OpenAI's embeddings
  const hostedChat = () => fetched.filter((f) => /api\.openai\.com/.test(f.url) && f.method === 'POST' && !/\/embeddings$/.test(f.url));
  const toElsewhere = () => fetched.filter((f) => !/api\.openai\.com/.test(f.url));
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  before(async () => {
    box = await startFakeLlmServer();
    box.setReply('chat-model', 'Hello there');
    box.setReply('title-model', 'Fence plans');
    downPort = await closedPort();
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const href = String(url);
      fetched.push({ url: href, method });
      if (method === 'GET' && /api\.openai\.com\/v1\/models/.test(href)) return json({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4-mini' }] });
      if (method === 'POST' && href === 'https://api.openai.com/v1/embeddings') {
        const input = JSON.parse(init.body).input;
        embedded.push(...input);
        return json({ data: input.map((_text, i) => ({ embedding: [1, i % 7, 0.5] })) });
      }
      if (/duckduckgo\.com/.test(href) || /^https:\/\/203\.0\.113\.10\//.test(href)) {
        return new Response('<html><body><p>Nothing here.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      throw new Error(`no network in unit tests (${method} ${href})`);
    };
    // WebFetch resolves a host name before it fetches; no name is resolved here.
    dns.promises.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    delete process.env.KL_CASES_ROOT;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-egress-callers-'));
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    const server = (id, baseUrl) => ({
      id, name: id, kind: 'vllm', baseUrl, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
      pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT
    });
    const profile = (id, roles) => ({ id, name: id, kind: 'user', roles: { main: [], worker: [], utility: [], ...roles } });
    store.set('settings', {
      models: {
        localServers: [server('workstation', `${box.url}/vllm`), server('sleeper', `http://127.0.0.1:${downPort}`)],
        profiles: [
          // A local main, a local title model, each with a hosted model behind it.
          profile('p-local', { main: [LOCAL, HOSTED], utility: [LOCAL_TITLE, HOSTED_MINI] }),
          // The title model is on a server that is switched off.
          profile('p-title-down', { main: [LOCAL, HOSTED], utility: [DOWN_TITLE, HOSTED_MINI] }),
          // Only hosted models for titles: under a policy the role borrows main's local model.
          profile('p-title-hosted', { main: [LOCAL, HOSTED], utility: [HOSTED_MINI] })
        ],
        defaultProfileId: 'p-local',
        overrides: { 'local:workstation/chat-model': { toolCall: true } }
      }
    });
    core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }
    });
    core.saveProviderToken('openai', 'sk-test-openai-123456');
    await core.start();
    ctx = core.context;
    // The assembler's first index embeds the tool descriptions (no chat
    // text) in the background; let it finish before any turn is watched.
    await ctx.getContextAssembler().assemble('', {});
    assert.ok(embedded.length > 0 && embedded.every((text) => /^(tool|system section): /.test(text)), 'only tool and section descriptions were embedded at start');
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    dns.promises.lookup = originalLookup;
    if (core) await core.shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    await box.close();
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  beforeEach(() => { fetched.length = 0; embedded.length = 0; });

  let chatCount = 0;
  function newChat({ marked = false, profileId = null, title = 'New Chat' } = {}) {
    const id = `chat-${++chatCount}`;
    ctx.createChat({ id, title, createdAt: AT, updatedAt: AT, messages: [], ...(profileId ? { profileId } : {}) });
    if (marked) assert.strictEqual(ctx.getHistoryStore().markPrivate(id).marked, true);
    return id;
  }

  // The chat handlers over the core's context, with what a test replaces.
  // `routes` records every routed provider the handlers asked for and the
  // calls made on it, so a test can wait for the title call to settle.
  function chatHandlers(overrides = {}) {
    const routes = [];
    const pending = [];
    const view = Object.assign(Object.create(ctx), {
      routedProvider: (spec) => {
        const provider = ctx.routedProvider(spec);
        routes.push({ role: spec.meta?.role, egress: spec.egress, targets: spec.targets });
        if (spec.meta?.role !== 'utility') return provider;
        const streamMessage = provider.streamMessage;
        provider.streamMessage = (...args) => {
          const call = streamMessage(...args);
          pending.push(call.catch(() => {}));
          return call;
        };
        return provider;
      },
      ...overrides
    });
    const handlers = new Map();
    registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, view);
    const event = { sender: { send: () => {}, isDestroyed: () => false } };
    return {
      routes,
      send: async (chatId, message, extra = {}) => {
        const result = await handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId, message, agentMode: true, ...extra });
        assert.notStrictEqual(result?.ok, false, JSON.stringify(result));
        return result;
      },
      speakLast: (chatId, summary = false) => handlers.get(IPC.CHAT_SPEAK_LAST)(event, { chatId, summary }),
      // The title call is not awaited by the send; wait until it has settled.
      titleSettled: async () => {
        for (let i = 0; i < 200 && !routes.some((r) => r.role === 'utility'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        for (let i = 0; i < 200 && pending.length === 0 && routes.some((r) => r.role === 'utility'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        await Promise.all(pending);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
  }
  const lastReply = (chatId) => ctx.getLastAssistantMessage(chatId)?.text;
  const boxPosts = () => box.requests.filter((r) => r.method === 'POST');

  it('the chat\'s own turn hands its policy to the router, and answers from the local model', async () => {
    const marked = newChat({ marked: true, title: 'Fence' });
    const open = newChat({ title: 'Fence' });
    const { routes, send } = chatHandlers();
    await send(marked, 'Where is the side gate key?');
    assert.strictEqual(lastReply(marked), 'Hello there');
    assert.deepStrictEqual(routes[0].targets, [LOCAL]);
    assert.strictEqual(routes[0].egress.reason, 'private-chat');
    assert.deepStrictEqual(fetched, [], 'the private turn made no request through the global fetch at all');
    await send(open, 'Where is the side gate key?');
    assert.deepStrictEqual(routes[1].targets, [LOCAL, HOSTED]);
    assert.strictEqual(routes[1].egress, null);
    assert.deepStrictEqual(hostedChat(), []);
  });

  it('R-LI-8: the context assembler makes no embedding call', async () => {
    const assembler = ctx.getContextAssembler();
    assert.ok(assembler.embeddingProvider, 'an OpenAI key gives the assembler its direct embedding client');
    const mode = assembler.mode;
    assembler.mode = 'semantic';
    try {
      const { send } = chatHandlers();
      const marked = newChat({ marked: true, title: 'Fence' });
      await send(marked, 'The side gate code is 4417.');
      assert.strictEqual(lastReply(marked), 'Hello there');
      assert.deepStrictEqual(embedded, []);
      assert.deepStrictEqual(fetched, []);
      // The same turn in a chat that is not private does embed the message:
      // the path this test watches is live.
      const open = newChat({ title: 'Fence' });
      await send(open, 'The side gate code is 4417.');
      assert.deepStrictEqual(embedded, ['The side gate code is 4417.']);
    } finally {
      assembler.mode = mode;
    }
  });

  it('R-LI-8: compaction gets no embedding provider', async () => {
    const seen = [];
    const loops = [];
    const Loop = class extends ctx.AgentLoop {
      constructor(provider, executor, options) {
        seen.push(options.embeddingProvider);
        super(provider, executor, options);
        loops.push(this);
      }
    };
    const { send } = chatHandlers({ AgentLoop: Loop });
    await send(newChat({ marked: true, title: 'Fence' }), 'Check the fence line.');
    await send(newChat({ title: 'Fence' }), 'Check the fence line.');
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0], null);
    assert.strictEqual(seen[1], ctx.getContextAssembler().embeddingProvider);
    assert.deepStrictEqual(loops.map((loop) => loop.embeddingProvider), [null, seen[1]]);
    assert.deepStrictEqual(embedded, []);
    // The loop itself takes none under a policy, whoever builds it.
    const hosted = { embed: async () => { throw new Error('must not be called'); } };
    for (const egress of [PRIVATE, true]) {
      assert.strictEqual(new ctx.AgentLoop({}, {}, { embeddingProvider: hosted, egress }).embeddingProvider, null);
    }
    assert.strictEqual(new ctx.AgentLoop({}, {}, { embeddingProvider: hosted }).embeddingProvider, hosted);
    assert.strictEqual(new ctx.AgentLoop({}, {}, { embeddingProvider: hosted, egress: null }).embeddingProvider, hosted);
  });

  it('R-LI-22: a title is made on a local model', async () => {
    const { routes, send, titleSettled } = chatHandlers();
    const marked = newChat({ marked: true });
    await send(marked, 'Plan the fence repair.');
    await titleSettled();
    assert.strictEqual(ctx.getChat(marked, { messages: false }).title, 'Fence plans');
    const title = routes.find((r) => r.role === 'utility');
    assert.deepStrictEqual(title.targets, [LOCAL_TITLE]);
    assert.strictEqual(title.egress.reason, 'private-chat');
    assert.deepStrictEqual(fetched, []);
    // Only hosted models in utility: the role borrows main's local model (never a hosted one).
    const borrowing = newChat({ marked: true, profileId: 'p-title-hosted' });
    const second = chatHandlers();
    await second.send(borrowing, 'Plan the fence repair.');
    await second.titleSettled();
    assert.deepStrictEqual(second.routes.find((r) => r.role === 'utility').targets, [LOCAL]);
    assert.strictEqual(ctx.getChat(borrowing, { messages: false }).title, 'Hello there');
    assert.deepStrictEqual(fetched, []);
  });

  it('R-LI-22: a title is skipped', async () => {
    // The title's local model is on a server that is switched off, and the
    // role's next target is hosted. In a private chat the title is skipped.
    const marked = newChat({ marked: true, profileId: 'p-title-down' });
    const { routes, send, titleSettled } = chatHandlers();
    await send(marked, 'Plan the fence repair.');
    await titleSettled();
    assert.strictEqual(lastReply(marked), 'Hello there', 'the turn itself answered');
    assert.deepStrictEqual(routes.find((r) => r.role === 'utility').targets, [DOWN_TITLE]);
    assert.strictEqual(ctx.getChat(marked, { messages: false }).title, 'New Chat');
    assert.deepStrictEqual(fetched, [], 'the title did not fall through to the hosted model');
    // Without the mark the same title fails over to the hosted model (which
    // the stub refuses): the hosted request is attempted.
    const open = newChat({ profileId: 'p-title-down' });
    const second = chatHandlers();
    await second.send(open, 'Plan the fence repair.');
    await second.titleSettled();
    assert.ok(hostedChat().length > 0, 'an ordinary chat\'s title reached for the hosted model');
  });

  it('the advisor reviews on the turn\'s routed provider', async () => {
    const withAdvisor = { getSettings: () => ({ ...ctx.getSettings(), advisor: { enabled: true } }) };
    const { send } = chatHandlers(withAdvisor);
    const marked = newChat({ marked: true, title: 'Fence' });
    const before = boxPosts().length;
    await send(marked, 'Review the fence plan.');
    const reviews = boxPosts().slice(before).filter((r) => JSON.stringify(r.body).includes('senior code reviewer'));
    assert.strictEqual(reviews.length, 1, 'the review went to the local server');
    assert.match(lastReply(marked), /Advisor Review/);
    assert.deepStrictEqual(fetched, []);
  });

  it('R-LI-33: ImageGenerate is refused PRIVATE_HOSTED_CALL', async () => {
    const marked = newChat({ marked: true });
    const turnModels = ctx.snapshotModels({ chatId: marked });
    const built = [];
    const context = { turnModels, getSettings: () => ({}), getProviderToken: () => 'sk-test-openai-123456', createImageClient: (p) => { built.push(p); throw new Error('no client'); } };
    const refused = await ImageGenerateTool.execute({ prompt: 'a lighthouse' }, context);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.success, false);
    assert.strictEqual(refused.code, 'PRIVATE_HOSTED_CALL');
    assert.strictEqual(refused.error, 'Image generation is not available in a private chat: it would send the prompt to a hosted model.');
    // A run with no snapshot: the host's own word for the run's chat.
    for (const egress of [turnModels.egress, true]) {
      assert.strictEqual((await ImageGenerateTool.execute({ prompt: 'x' }, { ...context, turnModels: null, egress })).code, 'PRIVATE_HOSTED_CALL');
    }
    assert.deepStrictEqual(built, []);
    // Through the turn's executor it is refused before anyone is asked to approve it.
    const env = await ctx.getRuntimeEnvironment({ workingDirectory: dataDir });
    const executor = await ctx.createToolExecutorWithApprovals(null, env, null, { workingDirectory: dataDir, chatId: marked, turnModels, useSandbox: false });
    const viaExecutor = await executor.execute('ImageGenerate', { prompt: 'a lighthouse' });
    assert.strictEqual(viaExecutor.code, 'PRIVATE_HOSTED_CALL');
    assert.deepStrictEqual(fetched, []);
    // Not private: the tool goes on to its settings (no image key is saved here).
    const open = await ImageGenerateTool.execute({ prompt: 'x' }, { ...context, turnModels: ctx.snapshotModels({ chatId: newChat() }) });
    assert.notStrictEqual(open.code, 'PRIVATE_HOSTED_CALL');
  });

  it('R-LI-33: read-aloud uses the system engine', async () => {
    const spoken = [];
    const tts = {
      speak: async (text, options) => { spoken.push(['speak', options.engine]); return { ok: true }; },
      speakSummary: async (text, options) => { spoken.push(['summary', options.engine]); return { ok: true }; }
    };
    const voice = { enabled: true, engine: 'elevenlabs', speakChatResponses: true, voiceId: 'v-1' };
    const { send, speakLast } = chatHandlers({
      getTtsEngine: () => tts,
      getVoiceSettings: () => ({ ...voice }),
      speakSummaryText: (text, options) => tts.speakSummary(text, options)
    });
    const marked = newChat({ marked: true, title: 'Fence' });
    const open = newChat({ title: 'Fence' });
    await send(marked, 'Read me the plan.');
    await send(open, 'Read me the plan.');
    assert.deepStrictEqual(spoken, [['summary', 'system'], ['summary', 'elevenlabs']]);
    spoken.length = 0;
    assert.strictEqual((await speakLast(marked)).ok, true);
    assert.strictEqual((await speakLast(marked, true)).ok, true);
    assert.strictEqual((await speakLast(open)).ok, true);
    assert.deepStrictEqual(spoken, [['speak', 'system'], ['summary', 'system'], ['speak', 'elevenlabs']]);
  });

  it('R-LI-32: delegate is refused PRIVATE_NO_DELEGATE', async () => {
    const marked = newChat({ marked: true });
    const env = await ctx.getRuntimeEnvironment({ workingDirectory: dataDir });
    const executor = await ctx.createToolExecutorWithApprovals(null, env, null, {
      workingDirectory: dataDir, chatId: marked, turnModels: ctx.snapshotModels({ chatId: marked }), useSandbox: false
    });
    for (const name of ['delegate', 'run_runbook', 'send_to_job', 'cancel_job']) {
      const refused = await executor.execute(name, { machine: 'gpu-box', task: 'Summarise the chat.' });
      assert.strictEqual(refused.success, false, name);
      assert.strictEqual(refused.code, 'PRIVATE_NO_DELEGATE', name);
    }
    const open = newChat();
    const openExecutor = await ctx.createToolExecutorWithApprovals(null, env, null, {
      workingDirectory: dataDir, chatId: open, turnModels: ctx.snapshotModels({ chatId: open }), useSandbox: false
    });
    assert.strictEqual(openExecutor.privateRefusalFor('delegate', {}), null);
  });

  it('N1: Cron create, SessionsSpawn and remote dispatch are refused PRIVATE_NO_DETACHED_RUN', async () => {
    const marked = newChat({ marked: true });
    const env = await ctx.getRuntimeEnvironment({ workingDirectory: dataDir });
    const calls = [
      ['Cron', { action: 'add', job: { schedule: '0 9 * * *', payload: { message: 'Summarise the chat.' } } }],
      ['Cron', { action: 'update', id: 'job-1', job: { payload: { message: 'x' } } }],
      ['sessions_spawn', { agentId: 'main', message: 'Summarise the chat.' }],
      ['RemoteDispatch', { action: 'dispatch', peer: 'gpu-box', message: 'Summarise the chat.' }]
    ];
    // With the turn's snapshot, and for a run that has only its chat id.
    for (const options of [{ turnModels: ctx.snapshotModels({ chatId: marked }) }, {}]) {
      const executor = await ctx.createToolExecutorWithApprovals(null, env, null, { workingDirectory: dataDir, chatId: marked, useSandbox: false, ...options });
      for (const [name, params] of calls) {
        const refused = await executor.execute(name, params);
        assert.strictEqual(refused.code, 'PRIVATE_NO_DETACHED_RUN', name);
        assert.strictEqual(refused.success, false);
      }
    }
    const open = newChat();
    const openExecutor = await ctx.createToolExecutorWithApprovals(null, env, null, {
      workingDirectory: dataDir, chatId: open, turnModels: ctx.snapshotModels({ chatId: open }), useSandbox: false
    });
    for (const [name, params] of calls) assert.strictEqual(openExecutor.privateRefusalFor(name, params), null, name);
    assert.deepStrictEqual(fetched, []);
  });

  it('N1: a workflow is not planned from a private chat', async () => {
    const handlers = new Map();
    const planned = [];
    const view = Object.assign(Object.create(ctx), {
      getPlannerExecutor: () => ({
        plan: async (goal, options) => { planned.push([goal, options.chatId]); return { goal, tasks: [] }; },
        planAndExecute: async (goal, options) => { planned.push([goal, options.chatId]); return { id: 'wf-1' }; }
      })
    });
    registerWorkflowHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, view);
    const marked = newChat({ marked: true });
    const open = newChat();
    for (const channel of [IPC.WORKFLOW_PLAN, IPC.WORKFLOW_PLAN_AND_EXECUTE]) {
      for (const chatId of [marked, 'no-such-chat']) {
        const refused = await handlers.get(channel)({}, { goal: 'Repair the fence', chatId });
        assert.strictEqual(refused.ok, false, channel);
        assert.strictEqual(refused.code, 'PRIVATE_NO_DETACHED_RUN', channel);
      }
    }
    assert.deepStrictEqual(planned, []);
    assert.strictEqual((await handlers.get(IPC.WORKFLOW_PLAN)({}, { goal: 'Repair the fence', chatId: open })).ok, true);
    assert.strictEqual((await handlers.get(IPC.WORKFLOW_PLAN)({}, { goal: 'Repair the fence' })).ok, true);
    assert.deepStrictEqual(planned, [['Repair the fence', open], ['Repair the fence', undefined]]);
  });

  it('R-LI-9: WebSearch and WebFetch run in a private chat', async () => {
    const marked = newChat({ marked: true });
    const env = await ctx.getRuntimeEnvironment({ workingDirectory: dataDir });
    const executor = await ctx.createToolExecutorWithApprovals(null, env, null, {
      workingDirectory: dataDir, chatId: marked, turnModels: ctx.snapshotModels({ chatId: marked }), useSandbox: false
    });
    const search = await executor.execute('WebSearch', { query: 'fence post spacing' });
    assert.strictEqual(search.ok, true, JSON.stringify(search));
    const page = await executor.execute('WebFetch', { url: 'https://203.0.113.10/fence' });
    assert.notStrictEqual(page.code, 'PRIVATE_HOSTED_CALL');
    const urls = toElsewhere().map((f) => f.url);
    assert.ok(urls.some((u) => /duckduckgo\.com/.test(u) && /fence/.test(u)), 'the search sent its query');
    assert.ok(urls.includes('https://203.0.113.10/fence'), 'the page was fetched');
  });
});

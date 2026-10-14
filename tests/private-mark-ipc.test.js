// tests/private-mark-ipc.test.js
// The owner's paths to the private mark (local inference spec 2026-10-13
// §8.1, §8.2, §8.7, §13.2; R-LI-10, R-LI-23): chat:markPrivate and
// case:markPrivate answer with the confirmation's facts first and mark only
// on { confirm: true }, one way, from the app's own window (or a paired
// desktop's event) only; a bridge chat and a chat with a turn running are
// refused; marking a case chat marks the case and every chat of it. After
// the mark a turn with only hosted models is refused before any call.
//
// A real core on a temp data dir, a fake local server on 127.0.0.1 and a
// fetch stub that answers only OpenAI's model list.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { classifyChannel } = require('../src/desktop-bridge/allowlist');
const { unit } = require('../src/history/embedders/vectors');
const IPC = require('../src/ipc/constants');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { HAS_GIT } = require('./helpers/ingest-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const t = (provider, model, effort = null) => ({ provider, model, effort });
const HOSTED = t('openai', 'gpt-5.5');
const LOCAL = t('local', 'workstation/chat-model');
const call = (provider, model, extra = {}) => ({ provider, model, inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: provider === 'local' ? 0 : 0.01, ...extra });
const localCall = () => call('local', 'workstation/chat-model', { local: { server: 'workstation', class: 'loopback' } });

describe('chat:markPrivate and case:markPrivate', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  let box;
  let dataDir;
  let core;
  let ctx;
  let handlers;
  const originalFetch = globalThis.fetch;
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  const fetched = [];
  const updates = [];
  const sender = { send: (channel, payload) => { if (channel === 'chat:updated') updates.push(payload); }, isDestroyed: () => false };
  const windowEvent = () => markLocalDesktopEvent({ sender });
  const pairedEvent = () => markLocalDesktopEvent({ sender }, { deviceId: 'kld-test-device' });
  const invoke = (channel, payload, event = windowEvent()) => handlers.get(channel)(event, payload);

  before(async () => {
    box = await startFakeLlmServer();
    box.setReply('chat-model', 'Hello there');
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      fetched.push({ url: String(url), method });
      if (method === 'GET' && /api\.openai\.com\/v1\/models/.test(String(url))) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`no network in unit tests (${method} ${url})`);
    };
    delete process.env.KL_CASES_ROOT;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-private-mark-'));
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', {
      models: {
        localServers: [{
          id: 'workstation', name: 'Workstation', kind: 'vllm', baseUrl: `${box.url}/vllm`, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
          pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT
        }],
        profiles: [
          { id: 'p-hosted', name: 'Hosted', kind: 'user', roles: { main: [HOSTED], worker: [], utility: [] } },
          { id: 'p-local', name: 'Local', kind: 'user', roles: { main: [LOCAL], worker: [], utility: [] } }
        ],
        defaultProfileId: 'p-hosted'
      },
      cases: { timeZone: 'UTC' }
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
    handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} };
    registerChatHandlers(ipcMain, ctx);
    registerCaseHandlers(ipcMain, ctx);
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    if (core) await core.shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    await box.close();
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  beforeEach(() => { fetched.length = 0; updates.length = 0; });

  let n = 0;
  const newChat = (extra = {}) => {
    const id = `chat-${++n}`;
    ctx.createChat({ id, title: `Fence ${n}`, createdAt: AT, updatedAt: AT, messages: [], ...extra });
    return id;
  };
  const store = () => ctx.getHistoryStore();
  const reply = (chatId, calls, subagents = []) => ctx.appendMessageToChat(chatId, 'assistant', 'Done.', { llm: { calls, ...(subagents.length ? { subagents } : {}) } });

  it('R-LI-10: the confirmation counts what was already sent, by provider, and marks nothing', async () => {
    const chatId = newChat();
    ctx.appendMessageToChat(chatId, 'user', 'Where is the side gate key?');
    reply(chatId, [call('openai', 'gpt-5.5')]);
    reply(chatId, [localCall()]);
    reply(chatId, [localCall()], [{ agentId: 'a1', role: 'worker', calls: [call('anthropic', 'claude-x')] }]);
    const r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.confirm, false);
    assert.strictEqual(r.untrustedText, true);
    assert.deepStrictEqual(r.facts.alreadySent, { messages: 2, providers: ['anthropic', 'openai'] });
    assert.strictEqual(r.facts.bridge, false);
    assert.deepStrictEqual(r.facts.chats.map((c) => c.id), [chatId]);
    assert.strictEqual(store().isPrivate(chatId), false, 'the first call marks nothing');
  });

  it('R-LI-10: hostedVectors says a hosted embedder has vectors of the chat', async () => {
    const chatId = newChat();
    ctx.appendMessageToChat(chatId, 'user', 'The side gate key is under the blue pot by the shed door.');
    let r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId });
    assert.strictEqual(r.facts.hostedVectors, false);
    const chunks = store().chunksOfChat(chatId);
    assert.ok(chunks.length > 0);
    store().putEmbeddings('openai:text-embedding-3-small', chunks.map((c, i) => ({ chunkId: c.id, vec: unit([1, i + 1]) })));
    r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId });
    assert.strictEqual(r.facts.hostedVectors, true);
  });

  it('the confirmation names the roles with no local model, and the chats that recalled this one', async () => {
    const chatId = newChat();
    const reader = newChat({ title: 'Reader chat' });
    ctx.appendMessageToChat(reader, 'assistant', 'Recalled it.', { context: { recalledChats: [chatId] } });
    const r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId });
    const main = r.facts.missing.find((m) => m.role === 'main');
    assert.ok(main, JSON.stringify(r.facts.missing));
    assert.match(main.why, /Nothing was sent to a hosted model/);
    assert.deepStrictEqual(r.facts.recalledBy, [{ chatId: reader, title: 'Reader chat' }]);
    const local = newChat({ profileId: 'p-local' });
    const r2 = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId: local });
    assert.ok(!r2.facts.missing.some((m) => m.role === 'main'), 'a profile with a local main has nothing missing for main');
  });

  it('the second call marks; then a turn with only hosted models is refused PRIVATE_NO_LOCAL_MODEL before any call', async () => {
    const chatId = newChat();
    const r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId, confirm: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.marked, true);
    assert.strictEqual(store().isPrivate(chatId), true);
    assert.ok(updates.some((u) => u && (u.chatId === chatId || u.id === chatId || u.chat?.id === chatId)), 'chat:updated is sent');
    await assert.rejects(ctx.resolveRole('main', { chatId }), (err) => err.code === 'PRIVATE_NO_LOCAL_MODEL');
    assert.deepStrictEqual(fetched.filter((f) => f.method !== 'GET'), []);
  });

  it('R-LI-10: nothing unmarks; a request shaped like one is PRIVATE_ONE_WAY', async () => {
    const chatId = newChat();
    await invoke(IPC.CHAT_MARK_PRIVATE, { chatId, confirm: true });
    for (const payload of [{ chatId, private: false }, { chatId, private: false, confirm: true }]) {
      const r = await invoke(IPC.CHAT_MARK_PRIVATE, payload);
      assert.deepStrictEqual([r.ok, r.code], [false, 'PRIVATE_ONE_WAY']);
    }
    const again = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId, confirm: true });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.marked, false, 'already private');
    assert.strictEqual(store().isPrivate(chatId), true);
    ctx.updateChat(chatId, { private: false, title: 'Renamed' });
    assert.strictEqual(store().isPrivate(chatId), true, 'a chat patch cannot clear it');
  });

  it('PRIVATE_CHAT_BUSY while a turn runs in the chat', async () => {
    const chatId = newChat();
    const real = ctx.isChatRunning;
    ctx.isChatRunning = (id) => id === chatId;
    try {
      const r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId, confirm: true });
      assert.deepStrictEqual([r.ok, r.code], [false, 'PRIVATE_CHAT_BUSY']);
    } finally {
      ctx.isChatRunning = real;
    }
    assert.strictEqual(store().isPrivate(chatId), false);
  });

  it('PRIVATE_BRIDGE_CHAT for a Telegram or Discord chat', async () => {
    const chatId = newChat({ origin: 'telegram' });
    const facts = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId });
    assert.strictEqual(facts.facts.bridge, true);
    const r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId, confirm: true });
    assert.deepStrictEqual([r.ok, r.code], [false, 'PRIVATE_BRIDGE_CHAT']);
    assert.strictEqual(store().isPrivate(chatId), false);
  });

  it('NOT_LOCAL_WINDOW for an event nobody marked; a paired desktop\'s marked event is accepted', async () => {
    const chatId = newChat();
    for (const event of [{ sender }, null, {}]) {
      const r = await handlers.get(IPC.CHAT_MARK_PRIVATE)(event, { chatId, confirm: true });
      assert.deepStrictEqual([r.ok, r.code], [false, 'NOT_LOCAL_WINDOW']);
    }
    assert.strictEqual(store().isPrivate(chatId), false);
    const r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId, confirm: true }, pairedEvent());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(store().isPrivate(chatId), true);
  });

  it('R-LI-23: marking a case chat marks the case and every chat of it, in one confirmation that names them', async () => {
    const rt = ctx.getCaseRuntime();
    const c = await rt.createCase({ title: `Lakeside lot ${n}`, objective: 'Convert the lot to cash', force: true });
    const a = newChat({ caseId: c.id });
    const b = newChat({ caseId: c.id });
    const facts = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId: a });
    assert.deepStrictEqual(facts.facts.chats.map((x) => x.id).sort(), [a, b].sort());
    const r = await invoke(IPC.CHAT_MARK_PRIVATE, { chatId: a, confirm: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(rt.isPrivate(c.id), true);
    assert.strictEqual(store().isPrivate(a), true);
    assert.strictEqual(store().isPrivate(b), true);
  });

  it('case:markPrivate has the same two steps', async () => {
    const rt = ctx.getCaseRuntime();
    const c = await rt.createCase({ title: `Barn roof ${n}`, objective: 'Repair the barn roof', force: true });
    const a = newChat({ caseId: c.id });
    reply(a, [call('openai', 'gpt-5.5')]);
    const first = await invoke(IPC.CASE_MARK_PRIVATE, { caseId: c.id });
    assert.deepStrictEqual([first.ok, first.confirm, first.untrustedText], [true, false, true]);
    assert.deepStrictEqual(first.facts.alreadySent, { messages: 1, providers: ['openai'] });
    assert.ok(first.facts.missing.some((m) => m.role === 'judge' || m.role === 'main'));
    assert.strictEqual(rt.isPrivate(c.id), false);
    const refused = await handlers.get(IPC.CASE_MARK_PRIVATE)({ sender }, { caseId: c.id, confirm: true });
    assert.deepStrictEqual([refused.ok, refused.code], [false, 'NOT_LOCAL_WINDOW']);
    const oneWay = await invoke(IPC.CASE_MARK_PRIVATE, { caseId: c.id, private: false });
    assert.deepStrictEqual([oneWay.ok, oneWay.code], [false, 'PRIVATE_ONE_WAY']);
    const r = await invoke(IPC.CASE_MARK_PRIVATE, { caseId: c.id, confirm: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(rt.isPrivate(c.id), true);
    assert.strictEqual(store().isPrivate(a), true);
  });

  it('both channels ride the proxied chat and case domains', () => {
    assert.strictEqual(classifyChannel(IPC.CHAT_MARK_PRIVATE), 'proxy');
    assert.strictEqual(classifyChannel(IPC.CASE_MARK_PRIVATE), 'proxy');
  });
});

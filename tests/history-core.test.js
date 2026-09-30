// tests/history-core.test.js
// createCore opens <dataDir>/history.sqlite, moves chat-data.json's chats
// into it, reports a store that will not open, and closes it on shutdown
// (recall spec §4.4, §11.1, §15). A chat turn through the real core (§3,
// §6.5, §7, §8): tail plus new message, the recalled block in the dynamic
// prompt, provenance, calibration, the kill switch, and SearchHistory
// reaching the store.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { createCore } = require('../src/core');
const { HistoryStore } = require('../src/history');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const IPC = require('../src/ipc/constants');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const { setLogLevel } = require('../src/logging');

const tempDirs = [];
afterEach(() => {
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeDeps(chats = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-core-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  store.set('chats', chats);
  return {
    dataDir,
    deps: {
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    }
  };
}
const T = '2026-09-28T10:00:00.000Z';
const msg = (id, sender, text) => ({ id, sender, text, timestamp: T });
const backups = (dir) => fs.readdirSync(dir).filter((f) => /^chat-data\.backup-.*\.json$/.test(f));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('createCore and the history store', () => {
  it('opens <dataDir>/history.sqlite and moves the JSON chats into it at construction', () => {
    const { dataDir, deps } = makeDeps([
      { id: 'c1', title: 'Lakeside lot', messages: [msg('m1', 'user', 'blue folder'), msg('m2', 'assistant', 'noted')] },
      { id: 'c2', title: 'Second', messages: [] }
    ]);
    const core = createCore(deps);
    const store = core.context.getHistoryStore();
    assert.ok(store instanceof HistoryStore);
    assert.strictEqual(core.context.historyStore, store);
    assert.strictEqual(store.dbPath, path.join(dataDir, 'history.sqlite'));
    assert.deepStrictEqual(core.context.listChats().map((c) => [c.id, c.messageCount]), [['c1', 2], ['c2', 0]]);
    assert.deepStrictEqual(deps.store.get('chats'), []);
    assert.strictEqual(backups(dataDir).length, 1);
    assert.deepStrictEqual(core.context.getHistoryStatus(), { available: true, error: null, migrationFailed: 0 });
  });

  it('reports how many chats could not be moved and leaves them in chat-data.json', () => {
    const bad = { id: 'bad', title: 'Bad', messages: 'not a list' };
    const { deps } = makeDeps([{ id: 'good', title: 'Good', messages: [] }, bad]);
    const core = createCore(deps);
    assert.strictEqual(core.context.getHistoryStatus().migrationFailed, 1);
    assert.deepStrictEqual(core.context.listChats().map((c) => c.id), ['good']);
    assert.deepStrictEqual(deps.store.get('chats'), [bad]);
  });

  it('uses deps.history.dbPath when given', () => {
    const { dataDir, deps } = makeDeps();
    const other = path.join(dataDir, 'elsewhere', 'custom.sqlite');
    const core = createCore({ ...deps, history: { dbPath: other } });
    assert.strictEqual(core.context.getHistoryStore().dbPath, other);
    assert.ok(fs.existsSync(other));
    assert.ok(!fs.existsSync(path.join(dataDir, 'history.sqlite')));
  });

  it('never reads or changes an old chat-history.sqlite', () => {
    const { dataDir, deps } = makeDeps([{ id: 'from-json', title: 'From JSON', messages: [] }]);
    const blobFile = path.join(dataDir, 'chat-history.sqlite');
    const blob = new DatabaseSync(blobFile);
    blob.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT INTO chats VALUES ('from-blob', 0, '{"id":"from-blob","title":"Blob","messages":[]}');`);
    blob.close();
    const before = sha(blobFile);
    const core = createCore(deps);
    assert.deepStrictEqual(core.context.listChats().map((c) => c.id), ['from-json']);
    assert.strictEqual(sha(blobFile), before);
  });

  it('reports a store that will not open, leaves chat-data.json alone, and still starts', async () => {
    const { dataDir, deps } = makeDeps([{ id: 'c1', title: 'Kept in JSON', messages: [] }]);
    fs.writeFileSync(path.join(dataDir, 'history.sqlite'), 'invented text that is not a database '.repeat(40));
    const core = createCore(deps);
    const status = core.context.getHistoryStatus();
    assert.strictEqual(status.available, false);
    assert.match(status.error, /not a database/);
    assert.throws(() => core.context.listChats(), (err) => err.code === 'HISTORY_UNAVAILABLE');
    assert.throws(() => core.context.appendMessageToChat('c1', 'user', 'hi'), (err) => err.code === 'HISTORY_UNAVAILABLE');
    assert.strictEqual(deps.store.get('chats').length, 1);
    assert.deepStrictEqual(backups(dataDir), []);
    await core.start();
    await core.shutdown();
  });

  it('opens nothing and moves nothing with history.open false', () => {
    const { dataDir, deps } = makeDeps([{ id: 'c1', title: 'Stays', messages: [] }]);
    const core = createCore({ ...deps, history: { open: false } });
    assert.strictEqual(core.context.getHistoryStatus().available, false);
    assert.ok(!fs.existsSync(path.join(dataDir, 'history.sqlite')));
    assert.strictEqual(deps.store.get('chats').length, 1);
  });

  it('appends messages as rows and closes the store on shutdown', async () => {
    const { dataDir, deps } = makeDeps();
    const core = createCore(deps);
    core.context.createChat({ id: 'c1', title: 'One', messages: [] });
    const chat = core.context.appendMessageToChat('c1', 'user', 'hello');
    assert.deepStrictEqual(chat.messages.map((m) => [m.seq, m.text]), [[1, 'hello']]);
    await core.start();
    await core.shutdown();
    assert.strictEqual(core.context.getHistoryStore().isOpen, false);
    const reopened = HistoryStore.open(path.join(dataDir, 'history.sqlite'));
    assert.deepStrictEqual(reopened.getMessages('c1').map((m) => m.text), ['hello']);
    reopened.close();
  });

  it('exposes the context builder, token estimator and retriever over the store', () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    const { getContextBuilder, getTokenEstimator, getHistoryRetriever } = core.context;
    assert.strictEqual(typeof getContextBuilder().build, 'function');
    assert.strictEqual(typeof getTokenEstimator().estimate, 'function');
    assert.strictEqual(typeof getHistoryRetriever().retrieve, 'function');
  });

  it('chunks what a version-1 store held after start(), not while the core is built', async () => {
    const { dataDir, deps } = makeDeps();
    const file = path.join(dataDir, 'history.sqlite');
    const seed = HistoryStore.open(file);
    seed.createChat({ id: 'c1', title: 'From H1', messages: [msg('m1', 'user', 'the blue folder is in the Lakeside shed'), msg('m2', 'assistant', 'noted')] });
    seed.close();
    const raw = new DatabaseSync(file);
    raw.exec(`DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
      DROP TABLE chunks_fts; DROP TABLE chunks; DROP TABLE calibration;
      UPDATE schema_version SET version = 1;`);
    raw.close();
    const core = createCore(deps);
    const store = core.context.getHistoryStore();
    assert.deepStrictEqual(store.searchText('Lakeside', {}), [], 'not indexed while the core is built');
    try {
      await core.start();
      const result = await core.context.getHistoryBackfill().done;
      assert.deepStrictEqual(result, { indexed: 2, finished: true });
      assert.strictEqual(store.searchText('Lakeside', {}).length, 1);
    } finally {
      await core.shutdown();
    }
  });

  it('chunks new messages with the chunk sizes in settings.history.chunk', () => {
    const { deps } = makeDeps();
    deps.store.set('settings', { history: { chunk: { targetChars: 200, minChars: 50 } } });
    const core = createCore(deps);
    core.context.createChat({ id: 'c1', title: 'One', messages: [] });
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about the lakeside gate and fence. `.repeat(3)).join('\n\n');
    core.context.appendMessageToChat('c1', 'user', paragraphs, {}, { returnChat: false });
    const store = core.context.getHistoryStore();
    const [message] = store.getMessages('c1');
    assert.ok(store.chunksOfMessage(message.id).length > 3);
  });
});

setLogLevel('fatal');

const FAKE = 'kl-test-history';
const MODEL = 'history-main';
const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';

function seededMessages(count) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({
      id: `seed-${i}`,
      sender: i % 2 ? 'user' : 'assistant',
      text: i === 3 ? GATE : `Seeded note ${i} about the weekly grocery list and the garden hose timer.`,
      timestamp: new Date(Date.parse('2026-02-01T09:00:00.000Z') + i * 60000).toISOString()
    });
  }
  return out;
}

describe('history: a chat turn through the core', () => {
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  let core = null;
  afterEach(async () => {
    if (core) await core.shutdown();
    core = null;
    ProviderFactory._registry.delete(FAKE);
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
  });

  // script: what each parent call returns, in order; the last one repeats.
  function fakeProvider(calls, script) {
    return class {
      getProviderName() { return FAKE; }
      getDefaultModel() { return MODEL; }
      async sendMessage() { return 'unused'; }
      async sendMessageWithTools(messages, _tools, options) {
        calls.push({ messages, options });
        const step = script[Math.min(calls.length, script.length) - 1];
        return {
          ...step,
          llmMetrics: {
            provider: FAKE, model: step.metricsModel || MODEL, inputTokens: 2000, outputTokens: 10, totalTokens: 2010, costUsd: 0.001,
            pricingUsage: { input: 2000, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 0 }
          }
        };
      }
      buildToolMessages(response, toolResult, toolCallId) {
        return [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ];
      }
    };
  }

  async function start({ history = {}, script = [{ type: 'text', content: 'The code is 4417.' }], messages = seededMessages(40) } = {}) {
    const calls = [];
    ProviderFactory.registerProvider(FAKE, fakeProvider(calls, script));
    delete process.env.KL_CASES_ROOT;
    const { deps } = makeDeps([{ id: 'chat-1', title: 'Seeded chat', createdAt: '2026-02-01T09:00:00.000Z', updatedAt: '2026-02-01T10:00:00.000Z', messages }]);
    deps.store.set('settings', {
      models: {
        profiles: [{ id: 'p-h', name: 'H', kind: 'user', roles: { main: [{ provider: FAKE, model: MODEL, effort: null }], worker: [], utility: [] } }],
        defaultProfileId: 'p-h'
      },
      history
    });
    core = createCore({ ...deps, fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); } });
    await core.start();
    core.saveProviderToken(FAKE, 'fake-token-123456');
    const handlers = new Map();
    registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, core.context);
    const event = { sender: { send: () => {}, isDestroyed: () => false } };
    const send = (message) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: 'chat-1', message, agentMode: true });
    return { calls, send };
  }

  const lastMessage = () => {
    const chat = core.context.getChat('chat-1', { messages: true });
    return chat.messages[chat.messages.length - 1];
  };

  it('sends the tail and the new message, with the recalled block in the dynamic prompt', async () => {
    const { calls, send } = await start();
    const builder = core.context.getContextBuilder();
    const build = builder.build.bind(builder);
    const queries = [];
    builder.build = async (args) => {
      const built = await build(args);
      queries.push(built.stats.query);
      return built;
    };
    const result = await send('What was the side gate code at the Lakeside lot?');
    assert.notStrictEqual(result?.ok, false, JSON.stringify(result));
    assert.deepStrictEqual(queries, ['What was the side gate code at the Lakeside lot?'], 'by default the query is the new message alone');
    const first = calls[0];
    // The default tail, #25-#40 (16 messages), then the new message.
    assert.strictEqual(first.messages.length, 17, `sent ${first.messages.length} messages`);
    const texts = first.messages.map((m) => String(m.text ?? m.content ?? ''));
    assert.strictEqual(texts[0], 'Seeded note 25 about the weekly grocery list and the garden hose timer.');
    assert.strictEqual(texts[texts.length - 1], 'What was the side gate code at the Lakeside lot?');
    assert.ok(!texts.some((t) => t.includes('4417')), '#3 is not in the tail');
    assert.ok(first.options.systemPromptDynamic.includes('<recalled_history>'));
    assert.match(first.options.systemPromptDynamic, /\[#3 · user · [^\]]+\]\nFor the record, the side gate code/);
    assert.ok(!String(first.options.systemPrompt).includes('<recalled_history>'));
  });

  it('stores provenance on the reply and calibrates the estimator', async () => {
    const { send } = await start();
    await send('What was the side gate code at the Lakeside lot?');
    const reply = lastMessage();
    assert.strictEqual(reply.sender, 'assistant');
    const ctx = reply.context;
    assert.deepStrictEqual(ctx.tail, { fromSeq: 25, toSeq: 40 });
    assert.ok(ctx.recalledChunkIds.length > 0);
    assert.ok(ctx.recalledExcerpts >= 1);
    assert.ok(ctx.estTokens.system > 0 && ctx.estTokens.tail > 0 && ctx.estTokens.recalled > 0);
    assert.ok(ctx.fullHistoryEstTokens > 0);
    assert.strictEqual(ctx.embedder, 'none');
    assert.strictEqual(ctx.scope, 'chat');
    const seqs = core.context.getHistoryStore().chunks(ctx.recalledChunkIds).map((c) => c.seq);
    assert.ok(seqs.includes(3));
    assert.strictEqual(core.context.getHistoryStore().calibration(MODEL).samples, 1);
  });

  it('calibrates under the model the call actually used', async () => {
    const { send } = await start({ script: [{ type: 'text', content: 'The code is 4417.', metricsModel: 'history-fallback' }] });
    await send('What was the side gate code at the Lakeside lot?');
    const store = core.context.getHistoryStore();
    assert.strictEqual(store.calibration('history-fallback').samples, 1);
    assert.strictEqual(store.calibration(MODEL), null);
  });

  it('does not calibrate a turn that sends an image or a document', async () => {
    const messages = seededMessages(40);
    messages[38] = { ...messages[38], images: [{ name: 'gate.png', mimeType: 'image/png', base64: 'aGVsbG8=' }] };
    const { calls, send } = await start({ messages });
    await send('What was the side gate code at the Lakeside lot?');
    assert.ok(calls[0].messages.some((m) => Array.isArray(m.images) && m.images.length), 'the image was sent');
    assert.strictEqual(core.context.getHistoryStore().calibration(MODEL), null);
  });

  it('history.recall.enabled false sends the tail only', async () => {
    const { calls, send } = await start({ history: { recall: { enabled: false } } });
    await send('What was the side gate code at the Lakeside lot?');
    assert.ok(!String(calls[0].options.systemPromptDynamic || '').includes('<recalled_history>'));
    assert.strictEqual(calls[0].messages.length, 17, 'the default tail of 16 and the new message');
    assert.deepStrictEqual(lastMessage().context.recalledChunkIds, []);
  });

  it('SearchHistory in a turn reads this chat from the store', async () => {
    const { send } = await start({
      script: [
        { type: 'tool_use', toolName: 'SearchHistory', toolUseId: 'sh-1', parameters: { query: 'gate code' } },
        { type: 'text', content: 'Found it.' }
      ]
    });
    await send('Search the history for the gate code.');
    const chat = core.context.getChat('chat-1', { messages: true });
    const toolResult = chat.messages.find((m) => m.sender === 'toolResult' && m.toolName === 'SearchHistory');
    assert.ok(toolResult, 'the tool ran');
    assert.strictEqual(toolResult.result.ok, true);
    assert.ok(toolResult.result.excerpts.some((e) => e.text.includes('4417')));
  });
});

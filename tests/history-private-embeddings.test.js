// tests/history-private-embeddings.test.js
// A private chat's text and the embedders (local inference spec
// 2026-10-13 §8.4; owner ruling R-LI-25): with a hosted embedder active, a
// private chat's chunks are never handed to it, the keep-local embedder (the
// default local model, in the embed worker) fills them and the imported
// chats', a private chat's query is embedded locally or not at all, and Jev
// is never sent a scope that holds a private chat. The hosted embedder is a
// fake provider that records what it is given; the embed worker is the
// in-process fake runner; Jev is a loopback fake. Chats are marked through
// the store.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { startEmbedIndexer } = require('../src/history/embed-indexer');
const { EmbedderHost } = require('../src/history/embedder-host');
const { createVectorSearch } = require('../src/history/vector-search');
const { VectorIndex } = require('../src/history/vector-index');
const { importChat } = require('../src/history/import-chats');
const { createRecallReranker, keepLocalReason } = require('../src/history/reranker');
const { JevReranker } = require('../src/history/jev-reranker');
const { searchHistoryExcerpts } = require('../src/history/search');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { resolveScope, OPEN_POLICY } = require('../src/history/scope');
const { HISTORY_DEFAULTS, mergeHistorySettings } = require('../src/history/settings');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const { setLogLevel } = require('../src/logging');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

setLogLevel('fatal');

const MARKDOWN = path.join(__dirname, 'fixtures', 'history', 'markdown-transcript.md');
const HOSTED_KEY = 'openai:text-embedding-3-small';
const LOCAL_KEY = `local:${HISTORY_DEFAULTS.embedder.model}`;
const OPEN = [
  { sender: 'user', text: 'The boathouse fence is forty meters of cedar.' },
  { sender: 'assistant', text: 'Noted: forty meters of cedar fence at the boathouse.' }
];
const PRIVATE = [
  { sender: 'user', text: 'The side gate code for the orchard lot is 7731.' },
  { sender: 'assistant', text: 'Noted: the orchard lot gate code is 7731.' },
  { sender: 'user', text: 'The orchard lot survey pipe runs along the east fence.' },
  { sender: 'assistant', text: 'Noted: the survey pipe is along the east fence.' }
];
const QUESTION = 'What is the gate code for the orchard lot?';
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('private chats and the embedders (R-LI-25)', () => {
  let t;
  let ix;
  let host;
  afterEach(async () => {
    if (ix) await ix.stop();
    ix = null;
    if (host) await host.stop();
    host = null;
    if (t) t.cleanup();
    t = null;
  });

  // embedder: the history.embedder settings. hosted records every text the
  // hosted provider is given.
  async function setup({ embedder = { kind: 'openai' }, recall = {}, start = true, imported = true } = {}) {
    t = openTempStore();
    const { store } = t;
    seedChat(store, { id: 'open', title: 'Boathouse', messages: OPEN });
    store.createChat({ id: 'priv', title: 'Orchard', createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:00.000Z', messages: [] }, { private: true });
    PRIVATE.forEach((m, i) => store.appendMessage('priv', { ...m, id: `priv-m${i + 1}`, timestamp: new Date(BASE_TIME + (i + 10) * 60000).toISOString() }));
    const importedId = imported ? (await importChat({ store, filePath: MARKDOWN, schedule: (fn) => fn() })).chatId : null;
    const settings = { history: { version: 3, embedder: { batchSize: 8, ...embedder }, recall: { tailUserTurns: 1, rerank: { enabled: false, search: false }, ...recall } } };
    const getSettings = () => settings;
    const bow = createBagOfWordsEmbedder();
    const hosted = [];
    const runner = new FakeEmbedRunner();
    const failures = [];
    host = new EmbedderHost({
      getSettings,
      modelsDir: path.join(t.dir, 'models'),
      createRunner: () => runner,
      createProvider: () => ({
        async embed(inputs) {
          hosted.push(...inputs);
          return { vectors: await bow.embed(inputs), usage: { input: inputs.length } };
        }
      }),
      notify: () => {},
      log: { warn: (m) => failures.push(m), info() {}, debug() {} }
    });
    if (start) host.start();
    ix = startEmbedIndexer({ store, host, getSettings, setTimer: () => 1, clearTimer: () => {}, log: { warn() {}, info() {}, debug() {} } });
    const drain = async () => {
      for (let i = 0; i < 40; i += 1) {
        await ix.tick();
        await flush();
      }
    };
    const index = new VectorIndex({ store });
    const { vectorSearch, vectorOf } = createVectorSearch({ host, index });
    const estimator = new TokenEstimator();
    const retriever = new Retriever({ store, estimator, vectorSearch, vectorOf });
    const builder = new ContextBuilder({
      store, retriever, estimator, getSettings, now: () => BASE_TIME + 86400000,
      resolveScope: (chatId) => resolveScope({ store, chatId, policy: OPEN_POLICY })
    });
    const textsOf = (chatId) => store.chunksOfChat(chatId).map((c) => c.text);
    const rowsOf = (key, chatId) => [...store.vectorRows(key, chatId)].length;
    const sawAny = (texts) => hosted.filter((given) => texts.some((text) => given.includes(text)));
    return { store, settings, getSettings, hosted, runner, failures, drain, retriever, builder, importedId, textsOf, rowsOf, sawAny, recall: () => mergeHistorySettings(settings.history).recall };
  }

  it('the store never returns a private chat\'s chunks for a key that does not say it is local', async () => {
    const s = await setup();
    const ids = (rows) => [...new Set(rows.map((r) => r.chatId))].sort();
    const kept = [s.importedId, 'priv'].sort();
    assert.deepStrictEqual(ids(s.store.pendingEmbeddings(HOSTED_KEY, { limit: 500 })), ['open']);
    assert.deepStrictEqual(ids(s.store.pendingEmbeddings(HOSTED_KEY, { limit: 500, chatId: 'priv' })), []);
    assert.deepStrictEqual(ids(s.store.pendingEmbeddings(LOCAL_KEY, { limit: 500, localOnly: true })), [...kept, 'open'].sort());
    assert.deepStrictEqual(ids(s.store.pendingEmbeddings(LOCAL_KEY, { limit: 500, localOnly: true, onlyKeptLocal: true })), kept);
    assert.deepStrictEqual(ids(s.store.pendingEmbeddings(LOCAL_KEY, { limit: 500, localOnly: true, onlyKeptLocal: true, chatId: 'open' })), []);
    // onlyKeptLocal without localOnly is a hosted caller asking for kept-local chunks: none.
    assert.deepStrictEqual(s.store.pendingEmbeddings(HOSTED_KEY, { limit: 500, onlyKeptLocal: true }), []);
    assert.strictEqual(s.store.countPending(HOSTED_KEY, { onlyKeptLocal: true }), 0);
    const total = s.textsOf('open').length + s.textsOf('priv').length + s.textsOf(s.importedId).length;
    assert.strictEqual(s.store.countPending(HOSTED_KEY), s.textsOf('open').length);
    assert.strictEqual(s.store.countPending(LOCAL_KEY, { localOnly: true }), total);
    assert.strictEqual(s.store.countPending(LOCAL_KEY, { localOnly: true, onlyKeptLocal: true }), total - s.textsOf('open').length);
  });

  it('R-LI-25: a hosted key is never given a private chat\'s chunks', async () => {
    const s = await setup();
    await s.drain();
    assert.ok(s.hosted.length > 0, 'the hosted embedder did embed something');
    assert.deepStrictEqual(s.sawAny(s.textsOf('priv')), []);
    assert.deepStrictEqual(s.sawAny(s.textsOf(s.importedId)), []);
    assert.ok(!s.hosted.some((text) => text.includes('7731') || text.includes('orchard')), 'no text of the private chat left the machine');
    assert.strictEqual(s.rowsOf(HOSTED_KEY, 'open'), s.textsOf('open').length);
    assert.strictEqual(s.rowsOf(HOSTED_KEY, 'priv'), 0);
    assert.strictEqual(s.rowsOf(HOSTED_KEY, s.importedId), 0);
    assert.deepStrictEqual(ix.progress(), { key: HOSTED_KEY, embedded: s.textsOf('open').length, pending: 0 });

    // A message typed into the private chat later stays local too.
    const before = s.hosted.length;
    s.store.appendMessage('priv', { id: 'later-1', sender: 'user', text: 'The orchard lot padlock is brass.', timestamp: '2026-03-01T09:00:00.000Z' });
    s.store.appendMessage('open', { id: 'later-2', sender: 'user', text: 'The boathouse roof leaks.', timestamp: '2026-03-01T09:01:00.000Z' });
    await s.drain();
    assert.deepStrictEqual(s.hosted.slice(before), ['The boathouse roof leaks.']);
    assert.strictEqual(s.rowsOf(HOSTED_KEY, 'priv'), 0);
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'priv'), s.textsOf('priv').length);
  });

  it('R-LI-25: the keep-local embedder fills them', async () => {
    const s = await setup();
    assert.deepStrictEqual(host.status().keepLocal, { key: LOCAL_KEY, state: 'off', download: null }, 'nothing loads until a chunk needs it');
    assert.strictEqual(host.keepLocal(), null);
    await s.drain();
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'priv'), s.textsOf('priv').length);
    assert.strictEqual(s.rowsOf(LOCAL_KEY, s.importedId), s.textsOf(s.importedId).length);
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'open'), 0, 'only the chats that are kept local');
    assert.deepStrictEqual(host.status().keepLocal, { key: LOCAL_KEY, state: 'ready', download: null });
    assert.strictEqual(host.keepLocal().name, LOCAL_KEY);
    assert.strictEqual(host.current().name, HOSTED_KEY, 'the hosted embedder is still the active one');
    assert.deepStrictEqual(s.runner.calls.filter((c) => c.op === 'load'), [{ op: 'load', role: 'embedder', model: HISTORY_DEFAULTS.embedder.model }]);
    assert.deepStrictEqual(ix.keepLocalProgress(), {
      key: LOCAL_KEY, embedded: s.textsOf('priv').length + s.textsOf(s.importedId).length, pending: 0
    });
    assert.deepStrictEqual(s.failures, []);
  });

  it('with no private or imported chat the keep-local embedder never loads', async () => {
    const s = await setup({ imported: false });
    s.store.deleteChat('priv');
    await s.drain();
    assert.deepStrictEqual(s.runner.calls, []);
    assert.deepStrictEqual(host.status().keepLocal, { key: LOCAL_KEY, state: 'off', download: null });
  });

  it('with the active embedder already local, no second embedder is created', async () => {
    const s = await setup({ embedder: { kind: 'local' } });
    await flush();
    await s.drain();
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'priv'), s.textsOf('priv').length);
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'open'), s.textsOf('open').length);
    assert.deepStrictEqual(s.hosted, []);
    assert.strictEqual(s.runner.calls.filter((c) => c.op === 'load').length, 1);
    assert.strictEqual(host.keepLocal(), host.current());
    assert.strictEqual(host.ensureKeepLocal(), host.current());
    assert.deepStrictEqual(host.status().keepLocal, { key: LOCAL_KEY, state: 'ready', download: null });
    assert.strictEqual(ix.keepLocalProgress(), null);
  });

  it('nothing loads before start(), and with vectors off', async () => {
    const stopped = await setup({ start: false });
    assert.strictEqual(host.ensureKeepLocal(), null);
    assert.strictEqual(host.keepLocal(), null);
    await stopped.drain();
    assert.deepStrictEqual(stopped.runner.calls, []);
    assert.deepStrictEqual(host.status().keepLocal, { key: null, state: 'off', download: null });
    await ix.stop();
    await host.stop();
    t.cleanup();
    const off = await setup({ embedder: { kind: 'none' } });
    assert.strictEqual(host.ensureKeepLocal(), null);
    await off.drain();
    assert.deepStrictEqual(off.runner.calls, []);
    assert.deepStrictEqual(host.status().keepLocal, { key: null, state: 'off', download: null });
  });

  it('a keep-local model that does not load leaves the chunks unembedded and the hosted embedder running', async () => {
    const s = await setup();
    const load = s.runner.load.bind(s.runner);
    s.runner.load = async (role, model, opts) => {
      if (role === 'embedder') throw Object.assign(new Error(`${model} could not be loaded: fetch failed (offline)`), { code: 'MODEL_UNAVAILABLE' });
      return load(role, model, opts);
    };
    await s.drain();
    assert.strictEqual(host.status().keepLocal.state, 'unavailable');
    assert.strictEqual(host.status().state, 'ready');
    assert.strictEqual(host.keepLocal(), null);
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'priv'), 0);
    assert.strictEqual(s.rowsOf(HOSTED_KEY, 'open'), s.textsOf('open').length);
    assert.deepStrictEqual(s.sawAny(s.textsOf('priv')), [], 'and nothing of the private chat went to the hosted one instead');
    assert.strictEqual(s.failures.length, 1, 'said once');
  });

  it('a switch of the embedder setting drops the keep-local embedder', async () => {
    const s = await setup();
    await s.drain();
    assert.strictEqual(host.status().keepLocal.state, 'ready');
    s.settings.history.embedder = { kind: 'none' };
    assert.deepStrictEqual(host.status().keepLocal, { key: null, state: 'off', download: null });
    assert.strictEqual(host.keepLocal(), null);
  });

  it('R-LI-25: the query is embedded locally or not at all', async () => {
    const s = await setup();
    // No keep-local embedder is ready yet: the query is not embedded at all.
    const cold = await s.builder.build({ chatId: 'priv', message: QUESTION });
    assert.strictEqual(cold.stats.vectorsSkipped, 'private-chat');
    assert.strictEqual(cold.stats.embedder, 'none');
    assert.ok(cold.stats.recalledExcerpts > 0, 'keyword search still recalls');
    assert.ok(cold.recalled.text.includes('7731'));
    assert.deepStrictEqual(s.hosted, [], 'the hosted embedder was not given the query');
    assert.deepStrictEqual(s.runner.calls, [], 'a turn does not start the keep-local embedder');

    await s.drain();
    const before = s.hosted.length;
    const embeds = s.runner.calls.filter((c) => c.op === 'embed').length;
    const warm = await s.builder.build({ chatId: 'priv', message: QUESTION });
    assert.strictEqual(warm.stats.embedder, LOCAL_KEY);
    assert.strictEqual(warm.stats.vectorsSkipped, null);
    assert.ok(warm.stats.recalledExcerpts > 0);
    assert.strictEqual(s.hosted.length, before, 'the hosted embedder never saw the query');
    assert.ok(!s.hosted.some((text) => text.includes(QUESTION)));
    const queries = s.runner.calls.slice().filter((c) => c.op === 'embed').slice(embeds);
    assert.deepStrictEqual(queries, [{ op: 'embed', model: HISTORY_DEFAULTS.embedder.model, n: 1, priority: 'query' }]);
  });

  it('SearchHistory in a private chat keeps its query local too, with rerank off', async () => {
    const s = await setup();
    await s.drain();
    const before = s.hosted.length;
    const out = await searchHistoryExcerpts({ store: s.store, retriever: s.retriever, chatId: 'priv', query: 'orchard gate code', limit: 10, settings: s.recall(), asOf: BASE_TIME });
    assert.ok(out.length > 0);
    assert.strictEqual(s.hosted.length, before);
    // A chat that is not private searches with the hosted embedder, as before.
    await searchHistoryExcerpts({ store: s.store, retriever: s.retriever, chatId: 'open', query: 'cedar fence meters', limit: 10, settings: s.recall(), asOf: BASE_TIME });
    assert.deepStrictEqual(s.hosted.slice(before), ['cedar fence meters']);
  });

  it('a turn in an imported chat that is not private still sends its query to the hosted embedder', async () => {
    // Today's behaviour (the open H4 item), unchanged by the private rule.
    const s = await setup();
    await s.drain();
    const before = s.hosted.length;
    const built = await s.builder.build({ chatId: s.importedId, message: 'What is the side gate code at the Lakeside lot?' });
    assert.deepStrictEqual(s.hosted.slice(before), ['What is the side gate code at the Lakeside lot?']);
    assert.strictEqual(built.stats.embedder, HOSTED_KEY);
    const open = await s.builder.build({ chatId: 'open', message: 'How long is the cedar fence?' });
    assert.strictEqual(open.stats.embedder, HOSTED_KEY);
    assert.strictEqual(s.hosted.at(-1), 'How long is the cedar fence?');
  });

  it('a private chat that reads an ordinary chat still embeds its query locally', async () => {
    const s = await setup();
    await s.drain();
    s.store.setLinks('priv', ['open']);
    s.store.setHistoryScope('priv', 'linked');
    const before = s.hosted.length;
    const built = await s.builder.build({ chatId: 'priv', message: QUESTION, crossChat: true });
    assert.strictEqual(built.stats.scopeChats, 2);
    assert.strictEqual(built.stats.embedder, LOCAL_KEY);
    assert.strictEqual(s.hosted.length, before);
  });

  it('marking a chat, then the indexer, rebuilds its vectors under the local key', async () => {
    const s = await setup();
    seedChat(s.store, { id: 'later', title: 'Depot', startMinute: 100, messages: [
      { sender: 'user', text: 'The depot gate code is 2209.' },
      { sender: 'assistant', text: 'Noted: the depot gate code is 2209.' }
    ] });
    await s.drain();
    const n = s.textsOf('later').length;
    assert.strictEqual(s.rowsOf(HOSTED_KEY, 'later'), n);
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'later'), 0);
    const given = s.hosted.length;
    assert.deepStrictEqual(s.store.markPrivate('later'), { marked: true, droppedVectors: n });
    await s.drain();
    assert.strictEqual(s.rowsOf(HOSTED_KEY, 'later'), 0, 'the hosted vectors are gone and are not made again');
    assert.strictEqual(s.rowsOf(LOCAL_KEY, 'later'), n);
    assert.strictEqual(s.hosted.length, given, 'the hosted embedder was given nothing after the mark');
  });

  it('keepLocalReason names a private chat first', async () => {
    const s = await setup();
    assert.strictEqual(keepLocalReason(s.store, ['open']), null);
    assert.strictEqual(keepLocalReason(s.store, ['priv']), 'private-chat');
    assert.strictEqual(keepLocalReason(s.store, 'priv'), 'private-chat');
    assert.strictEqual(keepLocalReason(s.store, [s.importedId]), 'imported-chat');
    assert.strictEqual(keepLocalReason(s.store, ['open', s.importedId, 'priv']), 'private-chat');
    s.store.markPrivate(s.importedId);
    assert.strictEqual(keepLocalReason(s.store, [s.importedId]), 'private-chat');
    assert.strictEqual(keepLocalReason(s.store, ['open', 'no-such-chat', null]), null);
    // A ref whose mark cannot be read counts as private.
    const odd = { chatRef: (id) => ({ id, title: 'x', source: null, importedFromCase: false }) };
    assert.strictEqual(keepLocalReason(odd, ['x']), 'private-chat');
  });

  describe('Jev', () => {
    let server;
    before(async () => { server = await startFakeJevServer(); });
    after(() => server.close());

    it('R-LI-25: a scope that holds a private chat is never sent to Jev', async () => {
      const s = await setup({ recall: { rerank: { kind: 'jev', enabled: true, search: true } } });
      const jev = new JevReranker({
        getSettings: s.getSettings, getKey: () => 'test-key-not-real-0001',
        createProvider: (k) => new TypesafeProvider(k, { baseUrl: server.url }), notify: () => {}, env: {}
      });
      jev.start();
      const reranker = createRecallReranker({ host, jev, getSettings: s.getSettings });
      const estimator = new TokenEstimator();
      const retriever = new Retriever({ store: s.store, estimator, reranker });
      const builder = new ContextBuilder({
        store: s.store, retriever, estimator, getSettings: s.getSettings, now: () => BASE_TIME + 86400000,
        resolveScope: (chatId) => resolveScope({ store: s.store, chatId, policy: OPEN_POLICY })
      });
      const sent = server.requests.length;
      const own = await builder.build({ chatId: 'priv', message: QUESTION, crossChat: true });
      assert.ok(own.stats.recalledExcerpts > 0, 'something was recalled, so a rerank was due');
      assert.match(own.stats.rerankSkipped, /^private-chat/);
      assert.strictEqual(own.stats.reranker, null);
      // An ordinary chat whose scope holds the private chat (a policy that let it through).
      s.store.setLinks('open', ['priv']);
      s.store.setHistoryScope('open', 'linked');
      const linked = await builder.build({ chatId: 'open', message: QUESTION, crossChat: true });
      assert.match(linked.stats.rerankSkipped, /^private-chat/);
      const found = await searchHistoryExcerpts({ store: s.store, retriever, chatId: 'priv', query: 'orchard gate code', limit: 10, settings: s.recall(), reranker, asOf: BASE_TIME });
      assert.ok(found.length > 0);
      assert.strictEqual(server.requests.length, sent, 'Jev got no request');
      // The same reranker does send a scope with no private or imported chat.
      s.store.setHistoryScope('open', 'chat');
      // Two later turns, so the fence note is outside the tail and is recalled.
      ['The boathouse roof is slate.', 'Noted.', 'The boathouse door is red.', 'Noted.'].forEach((text, i) => s.store.appendMessage('open', {
        id: `open-later-${i}`, sender: i % 2 ? 'assistant' : 'user', text, timestamp: new Date(BASE_TIME + (100 + i) * 60000).toISOString()
      }));
      const plain = await builder.build({ chatId: 'open', message: 'How long is the cedar fence at the boathouse?', crossChat: true });
      assert.strictEqual(plain.stats.rerankSkipped, null);
      assert.strictEqual(plain.stats.reranker, 'jev:jev-1.13.0');
      assert.strictEqual(server.requests.length, sent + 1);
    });
  });
});

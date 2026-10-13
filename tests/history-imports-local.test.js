// tests/history-imports-local.test.js
// Owner ruling R-H4-2: an imported chat stays on this machine. Its chunks are
// embedded only by the local model (every other embedder kind counts as
// hosted, Ollama included), and with Jev chosen a turn or a search whose
// scope holds an imported chat is not reranked at all.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startEmbedIndexer } = require('../src/history/embed-indexer');
const { importChat } = require('../src/history/import-chats');
const { createRecallReranker, keepLocalReason } = require('../src/history/reranker');
const { searchHistoryExcerpts } = require('../src/history/search');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { resolveScope, OPEN_POLICY } = require('../src/history/scope');
const { mergeHistorySettings } = require('../src/history/settings');
const { unit } = require('../src/history/embedders/vectors');
const { addSink } = require('../src/logging');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

const MARKDOWN = path.join(__dirname, 'fixtures', 'history', 'markdown-transcript.md');
const NATIVE = [
  { sender: 'user', text: 'The gate hinge at the depot needs oil.' },
  { sender: 'assistant', text: 'Noted: oil the depot gate hinge.' },
  { sender: 'user', text: 'The depot gate sticks in the rain.' },
  { sender: 'assistant', text: 'Noted: the depot gate sticks when it rains.' }
];
const OTHER = [
  { sender: 'user', text: 'The boathouse gate is painted green.' },
  { sender: 'assistant', text: 'Noted: a green gate at the boathouse.' },
  { sender: 'user', text: 'The boathouse gate latch is new.' },
  { sender: 'assistant', text: 'Noted: a new latch.' }
];

const bow = createBagOfWordsEmbedder();
function recordingEmbedder(name) {
  const texts = [];
  return {
    name, kind: name.split(':')[0], model: name.split(':').slice(1).join(':'), dim: 28, tokens: 0, texts,
    async embed(batch) {
      texts.push(...batch);
      return (await bow.embed(batch)).map((v) => unit(v));
    }
  };
}

describe('imported chats stay local (R-H4-2)', () => {
  let t;
  let ix;
  let imported;
  afterEach(async () => {
    if (ix) await ix.stop();
    ix = null;
    if (t) t.cleanup();
    t = null;
  });

  async function setup() {
    t = openTempStore();
    seedChat(t.store, { id: 'native', title: 'Depot', messages: NATIVE });
    seedChat(t.store, { id: 'other', title: 'Boathouse', messages: OTHER });
    imported = (await importChat({ store: t.store, filePath: MARKDOWN, schedule: (fn) => fn() })).chatId;
    return t.store;
  }
  function indexer(embedder) {
    const failures = [];
    ix = startEmbedIndexer({
      store: t.store, host: { current: () => embedder, fail: (e) => failures.push(e) },
      getSettings: () => ({ history: { embedder: { batchSize: 8 } } }),
      setTimer: () => 1, clearTimer: () => {}, log: { warn() {}, info() {}, debug() {} }
    });
    return failures;
  }
  async function drain() {
    for (let i = 0; i < 40; i += 1) await ix.tick();
  }
  const textsOf = (chatId) => t.store.chunksOfChat(chatId).map((c) => c.text);
  const embeddedOf = (key, chatId) => [...t.store.vectorRows(key, chatId)].length;

  for (const key of ['openai:text-embedding-3-small', 'ollama:nomic-embed-text']) {
    it(`R-H4-2: a hosted embedder is never given a chunk of an imported chat (${key.split(':')[0]})`, async () => {
      const store = await setup();
      const embedder = recordingEmbedder(key);
      const failures = indexer(embedder);
      await drain();
      const importedTexts = new Set(textsOf(imported));
      assert.ok(importedTexts.size >= 20);
      assert.deepStrictEqual(embedder.texts.filter((text) => importedTexts.has(text)), []);
      assert.ok(!embedder.texts.some((text) => text.includes('4417') || text.includes('culvert')), 'no text of the transcript left the machine');
      assert.strictEqual(embeddedOf(key, 'native'), textsOf('native').length);
      assert.strictEqual(embeddedOf(key, 'other'), textsOf('other').length);
      assert.strictEqual(embeddedOf(key, imported), 0);
      assert.deepStrictEqual(ix.progress(), { key, embedded: textsOf('native').length + textsOf('other').length, pending: 0 });
      assert.strictEqual(ix.idle(), true);
      assert.deepStrictEqual(failures, []);

      // A message typed into the imported chat later is kept local too.
      const before = embedder.texts.length;
      store.appendMessage(imported, { id: 'later-1', sender: 'user', text: 'The padlock on the Lakeside shed is brass.', timestamp: '2026-03-01T09:00:00.000Z' });
      store.appendMessage('native', { id: 'later-2', sender: 'user', text: 'The depot roof leaks.', timestamp: '2026-03-01T09:01:00.000Z' });
      await drain();
      assert.deepStrictEqual(embedder.texts.slice(before), ['The depot roof leaks.']);
      assert.strictEqual(embeddedOf(key, imported), 0);
      assert.strictEqual(ix.progress().pending, 0);
    });
  }

  it('R-H4-2: the local embedder embeds an imported chat like any other', async () => {
    await setup();
    const key = 'local:Xenova/all-MiniLM-L6-v2';
    const embedder = recordingEmbedder(key);
    indexer(embedder);
    await drain();
    assert.strictEqual(embeddedOf(key, imported), textsOf(imported).length);
    assert.strictEqual(embeddedOf(key, 'native'), textsOf('native').length);
    assert.ok(embedder.texts.some((text) => text.includes('4417')));
    assert.strictEqual(ix.progress().pending, 0);
  });

  it('a rebuild under a hosted key (its vectors deleted) still leaves the imported chat out', async () => {
    const store = await setup();
    const key = 'openai:text-embedding-3-small';
    const embedder = recordingEmbedder(key);
    indexer(embedder);
    await drain();
    store.deleteEmbeddings(key);
    embedder.texts.length = 0;
    await drain();
    const importedTexts = new Set(textsOf(imported));
    assert.ok(embedder.texts.length > 0);
    assert.deepStrictEqual(embedder.texts.filter((text) => importedTexts.has(text)), []);
  });

  it('keepLocalReason names an imported chat anywhere in the list', async () => {
    const store = await setup();
    assert.strictEqual(keepLocalReason(store, ['native', 'other']), null);
    assert.strictEqual(keepLocalReason(store, [imported]), 'imported-chat');
    assert.strictEqual(keepLocalReason(store, ['native', imported]), 'imported-chat');
    assert.strictEqual(keepLocalReason(store, imported), 'imported-chat');
    assert.strictEqual(keepLocalReason(store, ['native', 'no-such-chat', null]), null);
    assert.strictEqual(keepLocalReason(null, [imported]), null);
    store.createChat({ id: 'marked', title: 'Marked', importedFromCase: true, messages: [] });
    assert.strictEqual(keepLocalReason(store, ['marked']), 'imported-chat');
  });

  describe('Jev', () => {
    function rerankers(kind) {
      const calls = { jev: [], local: [] };
      const jev = {
        async rerank(query, texts, options = {}) {
          calls.jev.push(texts);
          if (options.info) options.info.name = 'jev:jev-1.13.0';
          return texts.map(() => 1);
        }
      };
      const host = {
        rerankModelName: () => 'cross-encoder-x',
        async rerank(query, texts) {
          calls.local.push(texts);
          return texts.map(() => 1);
        }
      };
      const settings = { history: { version: 3, recall: { tailUserTurns: 1, rerank: { kind, enabled: true, search: true } } } };
      const getSettings = () => settings;
      const reranker = createRecallReranker({ host, jev, getSettings });
      const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator(), reranker });
      const builder = new ContextBuilder({
        store: t.store, retriever, estimator: new TokenEstimator(), getSettings, now: () => BASE_TIME,
        resolveScope: (chatId) => resolveScope({ store: t.store, chatId, policy: OPEN_POLICY })
      });
      return { calls, reranker, retriever, builder, recall: mergeHistorySettings(settings.history).recall };
    }
    async function watched(fn) {
      const warnings = [];
      const off = addSink((record) => { if (['warn', 'error', 'fatal'].includes(record.level)) warnings.push(record); });
      try {
        return { out: await fn(), warnings };
      } finally {
        off();
      }
    }

    it('R-H4-2: Jev is not called when an imported chat is in scope', async () => {
      const store = await setup();
      const r = rerankers('jev');

      const own = await watched(() => r.builder.build({ chatId: imported, message: 'What is the side gate code at the Lakeside lot?', crossChat: true }));
      assert.ok(own.out.stats.recalledExcerpts > 0, 'something was recalled, so a rerank was due');
      assert.strictEqual(own.out.stats.rerankSkipped, 'imported-chat');
      assert.strictEqual(own.out.stats.reranker, null);
      assert.deepStrictEqual(own.warnings, []);

      store.setLinks('native', [imported]);
      store.setHistoryScope('native', 'linked');
      const linked = await watched(() => r.builder.build({ chatId: 'native', message: 'What is the side gate code at the Lakeside lot?', crossChat: true }));
      assert.deepStrictEqual(linked.out.stats.scope, 'linked');
      assert.strictEqual(linked.out.stats.rerankSkipped, 'imported-chat');
      assert.deepStrictEqual(linked.warnings, []);
      assert.deepStrictEqual(r.calls.jev, [], 'Jev was never called');
      assert.deepStrictEqual(r.calls.local, [], 'and the cross-encoder did not stand in for it');

      // The same chat's own turn, without its wider scope, holds no import.
      const alone = await r.builder.build({ chatId: 'native', message: 'Which gate sticks in the rain?' });
      assert.strictEqual(alone.stats.reranker, 'jev:jev-1.13.0');
      const plain = await r.builder.build({ chatId: 'other', message: 'Which gate is painted green?', crossChat: true });
      assert.strictEqual(plain.stats.reranker, 'jev:jev-1.13.0');
      assert.strictEqual(plain.stats.rerankSkipped, null);
      assert.strictEqual(r.calls.jev.length, 2);
    });

    it('the local cross-encoder still reranks all three', async () => {
      const store = await setup();
      const r = rerankers('local');
      store.setLinks('native', [imported]);
      store.setHistoryScope('native', 'linked');
      const builds = [
        await r.builder.build({ chatId: imported, message: 'What is the side gate code at the Lakeside lot?', crossChat: true }),
        await r.builder.build({ chatId: 'native', message: 'What is the side gate code at the Lakeside lot?', crossChat: true }),
        await r.builder.build({ chatId: 'other', message: 'Which gate is painted green?', crossChat: true })
      ];
      for (const b of builds) {
        assert.strictEqual(b.stats.reranker, 'local:cross-encoder-x');
        assert.strictEqual(b.stats.rerankSkipped, null);
      }
      assert.strictEqual(r.calls.local.length, 3);
      assert.deepStrictEqual(r.calls.jev, []);
    });

    it('SearchHistory in or over an imported chat is not sent to Jev', async () => {
      await setup();
      const r = rerankers('jev');
      const search = (chatId, chatIds, query) => searchHistoryExcerpts({
        store: t.store, retriever: r.retriever, chatId, chatIds, query, limit: 10, settings: r.recall, reranker: r.reranker, asOf: BASE_TIME
      });
      const own = await watched(() => search(imported, null, 'side gate code'));
      assert.ok(own.out.length > 0);
      const across = await watched(() => search('native', ['native', imported], 'gate'));
      assert.ok(across.out.length > 0);
      assert.deepStrictEqual(r.calls.jev, []);
      assert.deepStrictEqual([...own.warnings, ...across.warnings], []);
      await search('native', ['native', 'other'], 'gate');
      assert.strictEqual(r.calls.jev.length, 1);
    });

    it('the Retriever hands keepLocal to the reranker beside caseId', async () => {
      await setup();
      const seen = [];
      const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator() });
      const reranker = async (query, chunks, options) => { seen.push(options); return chunks.map(() => 1); };
      const settings = mergeHistorySettings({ version: 3, recall: { rerank: { enabled: true } } }).recall;
      await retriever.retrieve({ query: 'gate', chatIds: ['native'], settings, now: BASE_TIME, reranker, keepLocal: 'imported-chat' });
      await retriever.retrieve({ query: 'gate', chatIds: ['native'], settings, now: BASE_TIME, reranker });
      assert.deepStrictEqual(seen.map((o) => [o.keepLocal, o.caseId]), [['imported-chat', null], [null, null]]);
    });
  });
});

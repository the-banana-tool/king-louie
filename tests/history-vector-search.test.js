// tests/history-vector-search.test.js
// Spec §6.3 step 2 for the app: the query embedded as a query, cosine hits
// from the VectorIndex fused with BM25, never slowing a turn past
// QUERY_TIMEOUT_MS, and provenance saying which embedder was used or why none.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { createVectorSearch, QUERY_TIMEOUT_MS } = require('../src/history/vector-search');
const { VectorIndex } = require('../src/history/vector-index');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { mergeHistorySettings } = require('../src/history/settings');
const { unit } = require('../src/history/embedders/vectors');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

const KEY = 'fake:bow';
const bow = createBagOfWordsEmbedder();
const recall = (over = {}) => mergeHistorySettings({ recall: over }).recall;
const quiet = { warn() {}, info() {}, debug() {} };

function embedder({ hang = false, fail = null } = {}) {
  const calls = [];
  return {
    name: KEY, dim: 28, tokens: 0, calls,
    async embed(texts, opts) {
      calls.push({ texts, opts });
      if (hang) return new Promise(() => {});
      if (fail) throw fail;
      return (await bow.embed(texts)).map((v) => unit(v));
    }
  };
}
function hostWith(e) {
  const failures = [];
  return { failures, current: () => e, reason: () => 'the embedding model is loading', fail: (err) => failures.push(err) };
}
async function embedAll(store) {
  const rows = store.pendingEmbeddings(KEY, { limit: 1000 });
  const vecs = await bow.embed(rows.map((r) => r.text));
  store.putEmbeddings(KEY, rows.map((r, i) => ({ chunkId: r.id, vec: unit(vecs[i]) })));
}
const MSGS = [
  { sender: 'user', text: 'The linen bandage goes in the canopic jar.' },
  { sender: 'assistant', text: 'Linen wrapping and resin for the mummy.' },
  { sender: 'user', text: 'Filler about the garden hose and the weekly list.' },
  { sender: 'assistant', text: 'More filler about the grocery list.' }
];

describe('vector search', () => {
  let t;
  afterEach(() => { if (t) t.cleanup(); t = null; });

  it('embeds the query as a query and returns ranked hits, with the key in stats', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: MSGS });
    await embedAll(t.store);
    const e = embedder();
    const { vectorSearch } = createVectorSearch({ host: hostWith(e), index: new VectorIndex({ store: t.store, log: quiet }) });
    const stats = {};
    const hits = await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall({ vectorTopK: 2 }), stats });
    assert.strictEqual(hits.length, 2);
    assert.deepStrictEqual(hits.map((h) => h.vectorRank), [1, 2]);
    assert.deepStrictEqual(e.calls[0], { texts: ['linen'], opts: { kind: 'query' } });
    assert.deepStrictEqual(stats, { embedder: KEY, vectorsSkipped: null });
  });

  it('no ready embedder: no hits, and stats says why', async () => {
    t = openTempStore();
    const { vectorSearch } = createVectorSearch({ host: hostWith(null), index: new VectorIndex({ store: t.store, log: quiet }) });
    const stats = {};
    assert.deepStrictEqual(await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall(), stats }), []);
    assert.deepStrictEqual(stats, { embedder: 'none', vectorsSkipped: 'the embedding model is loading' });
  });

  it('a query embedding slower than queryTimeoutMs: no hits this turn, and not a failure', async () => {
    t = openTempStore();
    const host = hostWith(embedder({ hang: true }));
    const { vectorSearch } = createVectorSearch({ host, index: new VectorIndex({ store: t.store, log: quiet }), queryTimeoutMs: 30 });
    const stats = {};
    assert.deepStrictEqual(await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall(), stats }), []);
    assert.match(stats.vectorsSkipped, /too slow/);
    assert.strictEqual(host.failures.length, 0);
    assert.strictEqual(QUERY_TIMEOUT_MS, 1500);
  });

  it('a failed query embedding is reported to the host; a worker crash is not', async () => {
    t = openTempStore();
    const failing = hostWith(embedder({ fail: Object.assign(new Error('401 invalid key'), { status: 401 }) }));
    const a = createVectorSearch({ host: failing, index: new VectorIndex({ store: t.store, log: quiet }) });
    assert.deepStrictEqual(await a.vectorSearch({ query: 'x', chatIds: ['chat-1'], settings: recall(), stats: {} }), []);
    assert.strictEqual(failing.failures.length, 1);
    const crashing = hostWith(embedder({ fail: Object.assign(new Error('exited'), { code: 'EMBED_WORKER_CRASHED' }) }));
    const b = createVectorSearch({ host: crashing, index: new VectorIndex({ store: t.store, log: quiet }) });
    await b.vectorSearch({ query: 'x', chatIds: ['chat-1'], settings: recall(), stats: {} });
    assert.strictEqual(crashing.failures.length, 0);
  });

  it('a chat over vectorCacheMb on its own: BM25 alone, and the provenance note names the cap', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: Array.from({ length: 300 }, (_, i) => ({ sender: 'user', text: `linen note ${i} for the tomb` })) });
    await embedAll(t.store);
    // As in the VectorIndex test: 300 rows × (28 × 4 + 9) bytes ≈ 36 KB, over a 0.03 MB (31 KB) cap.
    const index = new VectorIndex({ store: t.store, getCapMb: () => 0.03, log: quiet });
    const { vectorSearch } = createVectorSearch({ host: hostWith(embedder()), index });
    const stats = {};
    assert.deepStrictEqual(await vectorSearch({ query: 'linen', chatIds: ['chat-1'], settings: recall(), stats }), []);
    assert.deepStrictEqual(stats, { embedder: KEY, vectorsSkipped: 'this chat has more vectors than history.recall.vectorCacheMb holds' });

    const estimator = new TokenEstimator();
    const builder = new ContextBuilder({
      store: t.store, retriever: new Retriever({ store: t.store, estimator, vectorSearch }), estimator,
      getSettings: () => ({ history: { recall: { tailUserTurns: 1 } } }), now: () => BASE_TIME
    });
    const out = await builder.build({ chatId: 'chat-1', message: 'linen' });
    assert.match(out.stats.vectorsSkipped, /vectorCacheMb/);
    assert.ok(out.recalled.chunkIds.length > 0, 'BM25 still recalls');
  });

  it('fused with BM25, the vector list recalls a chunk below the BM25 cut; the builder records the key', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: MSGS });
    await embedAll(t.store);
    const estimator = new TokenEstimator();
    const { vectorSearch, vectorOf } = createVectorSearch({ host: hostWith(embedder()), index: new VectorIndex({ store: t.store, log: quiet }) });
    const retriever = new Retriever({ store: t.store, estimator, vectorSearch, vectorOf });
    const lexical = new Retriever({ store: t.store, estimator });
    // Equal kind weights, so the ranks alone decide the order.
    const settings = recall({ bm25TopK: 1, recencyWeight: 0, kindWeights: { user: 1, assistant: 1 } });
    const bm25 = await lexical.retrieve({ query: 'linen', chatIds: ['chat-1'], settings, now: BASE_TIME });
    const fused = await retriever.retrieve({ query: 'linen', chatIds: ['chat-1'], settings, now: BASE_TIME });
    assert.strictEqual(bm25.length, 1);
    assert.deepStrictEqual(new Set(fused.slice(0, 2).map((h) => h.chunk.messageId)), new Set(['chat-1-m1', 'chat-1-m2']));
    assert.ok(fused.some((h) => h.signals.bm25Rank === null && h.signals.vectorRank !== null), 'a vector-only hit');

    const builder = new ContextBuilder({ store: t.store, retriever, estimator, getSettings: () => ({ history: { recall: { tailUserTurns: 1 } } }), now: () => BASE_TIME });
    const out = await builder.build({ chatId: 'chat-1', message: 'linen' });
    assert.strictEqual(out.stats.embedder, KEY);
    assert.strictEqual(out.stats.vectorsSkipped, null);
    const plain = new ContextBuilder({ store: t.store, retriever: lexical, estimator, getSettings: () => ({}), now: () => BASE_TIME });
    assert.strictEqual((await plain.build({ chatId: 'chat-1', message: 'linen' })).stats.embedder, 'none');
  });
});

// tests/history-rerank-provenance.test.js
// Step 6 in provenance (recall spec §7): the retrieval stats name the
// reranker that ran, or say why a reranker that was on did not, and the
// context builder passes both on.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { createHostReranker } = require('../src/history/reranker');
const { EmbedderHost } = require('../src/history/embedder-host');
const { EmbedError } = require('../src/history/embed-errors');
const { mergeHistorySettings } = require('../src/history/settings');
const { setLogLevel } = require('../src/logging');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

setLogLevel('fatal');

const NOTES = [
  { sender: 'user', text: 'The side gate code is 4417.' },
  { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
  { sender: 'user', text: 'The gate hinge needs oil.' },
  { sender: 'user', text: 'Lunch is at noon on Fridays.' }
];
const recall = (rerank) => mergeHistorySettings({ version: 3, recall: { tailUserTurns: 1, rerank } }).recall;
const named = (name) => async (query, chunks, { info } = {}) => {
  if (info) info.name = name;
  return chunks.map((c) => (c.text.includes('dock') ? 10 : 0));
};

describe('rerank provenance', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const setup = () => {
    t = openTempStore();
    seedChat(t.store, { messages: NOTES });
    return new Retriever({ store: t.store, estimator: new TokenEstimator() });
  };
  const run = async (retriever, rerank, reranker) => {
    const stats = {};
    const hits = await retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall(rerank), now: BASE_TIME, reranker, stats });
    return { hits, stats };
  };

  it('a reranker that ran is named; the reranked order is used', async () => {
    const r = setup();
    const { hits, stats } = await run(r, { enabled: true }, named('jev:jev-1.13.0'));
    assert.ok(hits[0].chunk.text.includes('dock'));
    assert.strictEqual(stats.reranker, 'jev:jev-1.13.0');
    assert.strictEqual(stats.rerankSkipped, null);
    const anon = await run(r, { enabled: true }, async (q, chunks) => chunks.map(() => 1));
    assert.strictEqual(anon.stats.reranker, 'unnamed');
  });

  it('rerank off: neither field is set', async () => {
    const { stats } = await run(setup(), { enabled: false }, named('x'));
    assert.strictEqual(stats.reranker, undefined);
    assert.strictEqual(stats.rerankSkipped, undefined);
  });

  it('says why a reranker that was on did not run', async () => {
    const r = setup();
    const unavailable = await run(r, { enabled: true }, async () => { throw new EmbedError('RERANK_UNAVAILABLE', 'no typesafe.ai key is saved'); });
    assert.deepStrictEqual([unavailable.stats.reranker, unavailable.stats.rerankSkipped], [null, 'no typesafe.ai key is saved']);
    const failed = await run(r, { enabled: true }, async () => { throw new Error('typesafe.ai failed (HTTP 500)'); });
    assert.strictEqual(failed.stats.rerankSkipped, 'the reranker failed: typesafe.ai failed (HTTP 500)');
    const slow = await run(r, { enabled: true, maxMs: 30 }, () => new Promise((resolve) => setTimeout(() => resolve([1, 1, 1]), 500)));
    assert.strictEqual(slow.stats.rerankSkipped, 'the reranker took longer than rerank.maxMs (30 ms)');
    const bad = await run(r, { enabled: true }, async () => [1]);
    assert.strictEqual(bad.stats.rerankSkipped, 'the reranker returned no usable scores');
    assert.strictEqual(bad.stats.reranker, null);
  });

  it('the context builder passes both on (null when rerank is off)', async () => {
    const retriever = setup();
    const build = async (rerank, reranker) => {
      const builder = new ContextBuilder({
        store: t.store, retriever, estimator: new TokenEstimator(),
        getSettings: () => ({ history: { version: 3, recall: { tailUserTurns: 1, rerank } } })
      });
      return (await builder.build({ chatId: 'chat-1', message: 'Which gate sticks?', upToSeq: 5, reranker })).stats;
    };
    const on = await build({ enabled: true }, named('local:Xenova/ms-marco-MiniLM-L-6-v2'));
    assert.strictEqual(on.reranker, 'local:Xenova/ms-marco-MiniLM-L-6-v2');
    assert.strictEqual(on.rerankSkipped, null);
    const off = await build({ enabled: false }, named('x'));
    assert.strictEqual(off.reranker, null);
    assert.strictEqual(off.rerankSkipped, null);
  });

  it('the local cross-encoder names itself local:<model>', async () => {
    const host = { rerank: async (q, texts) => texts.map(() => 0.5), rerankModelName: () => 'Xenova/ms-marco-MiniLM-L-6-v2' };
    const info = {};
    assert.deepStrictEqual(await createHostReranker(host)('gate', [{ text: 'a' }, { text: 'b' }], { maxMs: 100, info }), [0.5, 0.5]);
    assert.strictEqual(info.name, 'local:Xenova/ms-marco-MiniLM-L-6-v2');
    const embedderHost = new EmbedderHost({
      getSettings: () => ({ history: { recall: { rerank: { model: 'Xenova/other-reranker' } } } }),
      modelsDir: os.tmpdir(), createRunner: () => { throw new Error('not used'); }, createProvider: () => { throw new Error('not used'); }
    });
    assert.strictEqual(embedderHost.rerankModelName(), 'Xenova/other-reranker');
  });
});

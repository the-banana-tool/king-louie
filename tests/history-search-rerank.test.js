// tests/history-search-rerank.test.js
// Step 6 behind SearchHistory (recall spec §6.3, §8): the reranker reorders
// the search under rerank.searchMaxMs; off with rerank.search false; a
// failing reranker keeps the fused order; per turn only with rerank.enabled.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { searchHistoryExcerpts } = require('../src/history/search');
const { createHostReranker } = require('../src/history/reranker');
const { searchHistoryTool } = require('../src/tools/builtin/history-tools');
const { Retriever } = require('../src/history/retriever');
const { ContextBuilder } = require('../src/history/context-builder');
const { TokenEstimator } = require('../src/history/token-estimator');
const { mergeHistorySettings } = require('../src/history/settings');
const { addSink } = require('../src/logging');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

const recall = (over = {}) => mergeHistorySettings({ recall: over }).recall;
const NOTES = [
  { sender: 'user', text: 'The side gate code is 4417.' },
  { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
  { sender: 'user', text: 'The gate hinge needs oil.' }
];
const preferDock = (calls) => async (query, chunks, opts) => {
  calls.push({ query, n: chunks.length, opts });
  return chunks.map((c) => (c.text.includes('dock') ? 10 : 0));
};

describe('SearchHistory rerank', () => {
  let t;
  afterEach(() => t && t.cleanup());
  const setup = () => {
    t = openTempStore();
    seedChat(t.store, { messages: NOTES });
    return new Retriever({ store: t.store, estimator: new TokenEstimator() });
  };

  it('reranks with the cross-encoder under searchMaxMs when rerank.search is on', async () => {
    const retriever = setup();
    const calls = [];
    const out = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), reranker: preferDock(calls), asOf: BASE_TIME });
    assert.ok(out[0].text.includes('dock'));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.maxMs, 6000);
  });

  it('rerank.search false: the fused order, the reranker never called', async () => {
    const retriever = setup();
    const calls = [];
    const out = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall({ rerank: { search: false } }), reranker: preferDock(calls), asOf: BASE_TIME });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(out.length, 3);
  });

  it('a reranker that throws keeps the fused order', async () => {
    const retriever = setup();
    const plain = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), asOf: BASE_TIME });
    const failing = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), reranker: async () => { throw new Error('model gone'); }, asOf: BASE_TIME });
    assert.deepStrictEqual(failing.map((e) => e.seq), plain.map((e) => e.seq));
  });

  it('a reranker that is not started yet (RERANK_UNAVAILABLE) keeps the fused order without a warning', async () => {
    const retriever = setup();
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.line); });
    try {
      const plain = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), asOf: BASE_TIME });
      const notStarted = createHostReranker({ rerank: async () => { throw Object.assign(new Error('the reranker is not started'), { code: 'RERANK_UNAVAILABLE' }); } });
      for (let i = 0; i < 2; i += 1) {
        const out = await searchHistoryExcerpts({ store: t.store, retriever, chatId: 'chat-1', query: 'gate', limit: 10, settings: recall(), reranker: notStarted, asOf: BASE_TIME });
        assert.deepStrictEqual(out.map((e) => e.seq), plain.map((e) => e.seq));
      }
    } finally {
      remove();
    }
    assert.deepStrictEqual(warnings.filter((l) => l.includes('history/retriever')), []);
  });

  it('the SearchHistory tool passes the chat\'s reranker', async () => {
    const retriever = setup();
    const calls = [];
    const history = { chatId: 'chat-1', store: t.store, retriever, estimator: new TokenEstimator(), getSettings: () => ({}), reranker: preferDock(calls) };
    const out = await searchHistoryTool.execute({ query: 'gate' }, { history });
    assert.strictEqual(out.ok, true);
    assert.ok(out.excerpts[0].text.includes('dock'));
    assert.strictEqual(calls.length, 1);
  });

  it('per turn: only with rerank.enabled, under rerank.maxMs', async () => {
    t = openTempStore();
    // Four newer user turns fill a four-turn tail, so the notes are
    // recallable. The tail is pinned here, so Task 16 may change the default.
    seedChat(t.store, { messages: [...NOTES, ...Array.from({ length: 4 }, (_, i) => ({ sender: 'user', text: `filler ${i}` }))] });
    const calls = [];
    const estimator = new TokenEstimator();
    const retriever = new Retriever({ store: t.store, estimator, reranker: preferDock(calls) });
    let history = { recall: { tailUserTurns: 4 } };
    const builder = new ContextBuilder({ store: t.store, retriever, estimator, getSettings: () => ({ history }), now: () => BASE_TIME });
    await builder.build({ chatId: 'chat-1', message: 'gate' });
    assert.strictEqual(calls.length, 0, 'off by default');
    history = { recall: { tailUserTurns: 4, rerank: { enabled: true } } };
    await builder.build({ chatId: 'chat-1', message: 'gate' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.maxMs, 2000);
  });

  it('createHostReranker sends the chunk texts and the budget to the host', async () => {
    const seen = [];
    const rr = createHostReranker({ rerank: async (query, texts, opts) => { seen.push({ query, texts, opts }); return texts.map(() => 1); } });
    assert.deepStrictEqual(await rr('gate', [{ text: 'a' }, { text: 'b' }], { maxMs: 50 }), [1, 1]);
    assert.deepStrictEqual(seen, [{ query: 'gate', texts: ['a', 'b'], opts: { maxMs: 50 } }]);
  });
});

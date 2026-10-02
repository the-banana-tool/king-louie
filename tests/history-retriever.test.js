// tests/history-retriever.test.js
// BM25 retrieval, weights, recency, dedupe, cap, budget, scope (spec §6.3).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { mergeHistorySettings } = require('../src/history/settings');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

const recall = (over = {}) => mergeHistorySettings({ recall: over }).recall;
const DAY = 86400000;

function setup(messages, extraChats = []) {
  const t = openTempStore();
  seedChat(t.store, { messages });
  for (const chat of extraChats) seedChat(t.store, chat);
  return { t, retriever: new Retriever({ store: t.store, estimator: new TokenEstimator() }) };
}

describe('Retriever', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('BM25 alone: ranked hits with the H2 signals', async () => {
    const s = setup([
      { sender: 'user', text: 'The side gate code at the Lakeside lot is 4417, please keep it.' },
      { sender: 'assistant', text: 'Understood, the grocery list is saved for the weekend trip.' }
    ]);
    t = s.t;
    const hits = await s.retriever.retrieve({ query: 'gate code', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].chunk.messageId, 'chat-1-m1');
    const sig = hits[0].signals;
    assert.strictEqual(sig.bm25Rank, 1);
    assert.strictEqual(sig.vectorRank, null);
    assert.strictEqual(sig.rerank, null);
    assert.strictEqual(sig.kindWeight, 1.2);
    assert.ok(sig.recency > 0.99 && sig.recency <= 1);
    assert.ok(Math.abs(hits[0].score - (1 / 61) * 1.2 * sig.recency) < 1e-12);
  });

  it('kind weights: a user chunk outranks a tool result; the setting flips it', async () => {
    const s = setup([
      { sender: 'toolResult', toolName: 'Bash', result: 'gate code 4417 appears in the maintenance log file here' },
      { sender: 'user', text: 'gate code 4417 was confirmed by the owner this morning' }
    ]);
    t = s.t;
    const first = await s.retriever.retrieve({ query: 'gate code 4417', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME });
    assert.strictEqual(first[0].chunk.kind, 'user');
    const flipped = await s.retriever.retrieve({ query: 'gate code 4417', chatIds: ['chat-1'], settings: recall({ kindWeights: { user: 0.1 } }), now: BASE_TIME });
    assert.strictEqual(flipped[0].chunk.kind, 'tool_result');
  });

  it('recency: a newer chunk wins a near-tie; recencyWeight 0 turns it off', async () => {
    const s = setup([
      { sender: 'user', text: 'the fence line was measured at forty meters', timestamp: new Date(BASE_TIME - 200 * DAY).toISOString() },
      { sender: 'user', text: 'the fence line was measured at forty meters again', timestamp: new Date(BASE_TIME - DAY).toISOString() }
    ]);
    t = s.t;
    const hits = await s.retriever.retrieve({ query: 'fence line measured', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME });
    assert.strictEqual(hits[0].chunk.messageId, 'chat-1-m2');
    assert.ok(hits[1].signals.recency < 0.72);
    const flat = await s.retriever.retrieve({ query: 'fence', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0 }), now: BASE_TIME });
    for (const h of flat) assert.strictEqual(h.signals.recency, 1);
  });

  it('recencyByPosition: age is the fraction of the chat behind upToSeq, not days', async () => {
    // Same timestamp for both: day-based recency cannot tell them apart.
    const at = new Date(BASE_TIME - DAY).toISOString();
    const messages = [{ sender: 'user', text: 'the fence line was measured at forty meters', timestamp: at }];
    for (let i = 0; i < 8; i += 1) messages.push({ sender: 'assistant', text: `filler note ${i} about the grocery list`, timestamp: at });
    messages.push({ sender: 'user', text: 'the fence line was measured at forty meters again', timestamp: at });
    const s = setup(messages);
    t = s.t;
    const byDays = await s.retriever.retrieve({ query: 'fence line measured', chatIds: ['chat-1'], upToSeq: 11, settings: recall(), now: BASE_TIME });
    assert.strictEqual(byDays[0].signals.recency, byDays[1].signals.recency);

    const settings = recall({ recencyByPosition: true, recencyWeight: 0.5, recencyHalfLifeFraction: 0.25 });
    const hits = await s.retriever.retrieve({ query: 'fence line measured', chatIds: ['chat-1'], upToSeq: 11, settings, now: BASE_TIME });
    assert.strictEqual(hits[0].chunk.messageId, 'chat-1-m10');
    const expected = (seq) => 0.5 + 0.5 * Math.exp(-((11 - seq) / 11) / 0.25);
    assert.ok(Math.abs(hits[0].signals.recency - expected(10)) < 1e-12);
    assert.ok(Math.abs(hits[1].signals.recency - expected(1)) < 1e-12);

    // Without an upToSeq the age falls back to days.
    const fallback = await s.retriever.retrieve({ query: 'fence line measured', chatIds: ['chat-1'], settings, now: BASE_TIME });
    assert.strictEqual(fallback[0].signals.recency, fallback[1].signals.recency);
  });

  it('drops exact text duplicates', async () => {
    const same = 'The drainage pipe runs under the north fence of the Lakeside lot.';
    const s = setup([{ sender: 'user', text: same }, { sender: 'assistant', text: same }]);
    t = s.t;
    const hits = await s.retriever.retrieve({ query: 'drainage pipe', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME });
    assert.strictEqual(hits.length, 1);
  });

  it('caps chunks per message and fills the token budget without exceeding it', async () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} mentions the gate and the Lakeside lot drainage in detail number ${i}.`).join('\n\n');
    const s = setup([
      { sender: 'assistant', text: paras },
      { sender: 'user', text: 'short gate note that is long enough to be a chunk' }
    ]);
    t = s.t;
    const est = new TokenEstimator();
    const capped = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME });
    assert.strictEqual(capped.filter((h) => h.chunk.messageId === 'chat-1-m1').length, 4);
    const two = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall({ maxChunksPerMessage: 2 }), now: BASE_TIME });
    assert.strictEqual(two.filter((h) => h.chunk.messageId === 'chat-1-m1').length, 2);
    const budgeted = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], budgetTokens: 45, settings: recall(), now: BASE_TIME });
    const used = budgeted.reduce((sum, h) => sum + est.estimate(h.chunk.text), 0);
    assert.ok(used <= 45, `used ${used}`);
    assert.ok(budgeted.length >= 1);
    assert.deepStrictEqual(await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], budgetTokens: 0, settings: recall(), now: BASE_TIME }), []);
  });

  it('diversifyFirst: one chunk of each message before a second chunk of any', async () => {
    const strong = Array.from({ length: 6 }, (_, i) => `Gate gate gate: the Lakeside lot gate log, entry ${i}, checked twice.`).join('\n\n');
    const s = setup([
      { sender: 'assistant', text: strong },
      { sender: 'assistant', text: 'A gate was mentioned once in the fence survey of the lot.' },
      { sender: 'assistant', text: 'The gate came up once more in the drainage plan notes.' }
    ]);
    t = s.t;
    const est = new TokenEstimator();
    const all = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME });
    // A budget of the first four hits in score order.
    const budgetTokens = all.slice(0, 4).reduce((sum, h) => sum + est.estimate(h.chunk.text), 0);
    const messagesOf = (hits) => [...new Set(hits.map((h) => h.chunk.messageId))].sort();
    const plain = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], budgetTokens, settings: recall(), now: BASE_TIME });
    assert.deepStrictEqual(messagesOf(plain), ['chat-1-m1'], 'score order spends the budget on one message');
    const spread = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], budgetTokens, settings: recall({ diversifyFirst: true }), now: BASE_TIME });
    assert.deepStrictEqual(messagesOf(spread), ['chat-1-m1', 'chat-1-m2', 'chat-1-m3']);
    assert.ok(spread.reduce((sum, h) => sum + est.estimate(h.chunk.text), 0) <= budgetTokens);
    assert.ok(spread.filter((h) => h.chunk.messageId === 'chat-1-m1').length >= 1);
    // Without a budget both orders take the same chunks.
    const a = (await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME })).map((h) => h.chunk.id).sort();
    const b = (await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall({ diversifyFirst: true }), now: BASE_TIME })).map((h) => h.chunk.id).sort();
    assert.deepStrictEqual(a, b);
  });

  it('dedupeJaccard: drops a near-duplicate of a selected chunk and reports it', async () => {
    const run = (n) => `PASS tests/lot-drainage.test.js ok 1 north fence pipe ok 2 south fence pipe ok 3 culvert depth ok 4 outlet grade ok 5 total ${n} passed in the Lakeside lot suite`;
    const s = setup([
      { sender: 'toolResult', toolName: 'Bash', result: run(5) },
      { sender: 'toolResult', toolName: 'Bash', result: run(6) },
      { sender: 'user', text: 'The culvert depth for the lot was agreed at ninety centimetres.' }
    ]);
    t = s.t;
    const off = await s.retriever.retrieve({ query: 'culvert depth', chatIds: ['chat-1'], settings: recall(), now: BASE_TIME });
    assert.strictEqual(off.length, 3, 'exact dedupe alone keeps both near-identical results');
    const stats = {};
    const on = await s.retriever.retrieve({ query: 'culvert depth', chatIds: ['chat-1'], budgetTokens: 6000, settings: recall({ dedupeJaccard: 0.6 }), now: BASE_TIME, stats });
    assert.strictEqual(on.length, 2);
    assert.strictEqual(on.filter((h) => h.chunk.kind === 'tool_result').length, 1);
    assert.strictEqual(stats.nearDuplicates, 1);
    assert.ok(stats.nearDuplicateTokens > 0);
    assert.strictEqual(stats.exactDuplicates, 0);
    // A threshold above their similarity keeps both.
    const strict = await s.retriever.retrieve({ query: 'culvert depth', chatIds: ['chat-1'], settings: recall({ dedupeJaccard: 0.9 }), now: BASE_TIME });
    assert.strictEqual(strict.length, 3);
  });

  it('scope, tail exclusion, upToSeq and kinds', async () => {
    const s = setup([
      { sender: 'user', text: 'first gate note for the Lakeside lot, long enough' },
      { sender: 'assistant', text: 'second gate note for the Lakeside lot, long enough' },
      { sender: 'user', text: 'third gate note for the Lakeside lot, long enough' }
    ], [{ id: 'chat-2', messages: [{ sender: 'user', text: 'a gate note in another chat entirely, long enough' }] }]);
    t = s.t;
    const ids = async (opts) => (await s.retriever.retrieve({ query: 'gate note', settings: recall(), now: BASE_TIME, ...opts })).map((h) => h.chunk.messageId).sort();
    assert.deepStrictEqual(await ids({ chatIds: ['chat-1'] }), ['chat-1-m1', 'chat-1-m2', 'chat-1-m3']);
    assert.deepStrictEqual(await ids({ chatIds: ['chat-1'], excludeMessageIds: ['chat-1-m3'] }), ['chat-1-m1', 'chat-1-m2']);
    assert.deepStrictEqual(await ids({ chatIds: ['chat-1'], upToSeq: 3 }), ['chat-1-m1', 'chat-1-m2']);
    assert.deepStrictEqual(await ids({ chatIds: ['chat-1'], kinds: ['assistant'] }), ['chat-1-m2']);
    assert.deepStrictEqual(await ids({ chatIds: ['chat-1'], query: '' }), []);
  });

  it('pairToolMessages: a partner at or after upToSeq, outside kinds, or excluded is never shown', async () => {
    const s = setup([
      { sender: 'user', text: 'Survey the Lakeside lot fence.' },
      { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat survey/fence.txt' } },
      { sender: 'toolResult', toolName: 'Bash', result: 'north post leans two degrees' }
    ]);
    t = s.t;
    const settings = recall({ completeMessageTokens: 800, pairToolMessages: true });
    const ids = async (opts) => (await s.retriever.retrieve({ query: 'fence survey', chatIds: ['chat-1'], settings, now: BASE_TIME, ...opts }))
      .map((h) => h.chunk.messageId);
    assert.ok((await ids({ upToSeq: 4 })).includes('chat-1-m3'), 'control: the result is paired with its call');
    const cut = await ids({ upToSeq: 3 });
    assert.ok(cut.includes('chat-1-m2'), 'the call is recalled');
    assert.ok(!cut.includes('chat-1-m3'), 'the result at upToSeq is never shown');
    assert.ok(!(await ids({ upToSeq: 4, kinds: ['user', 'tool_use'] })).includes('chat-1-m3'), 'a partner outside kinds is not shown');
    assert.ok(!(await ids({ upToSeq: 4, excludeMessageIds: ['chat-1-m3'] })).includes('chat-1-m3'), 'an excluded partner is not shown');
  });

  describe('vector list (spec §6.3 steps 2-3)', () => {
    const msgs = [
      { sender: 'user', text: 'The side gate code at the Lakeside lot is 4417.' },
      { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
      { sender: 'user', text: 'Parking permits renew every March for the Lakeside lot.' },
      { sender: 'user', text: 'Later: the gate code changed after the storm.' }
    ];
    const chunkIdOf = (store, messageId) => store.chunksOfMessage(messageId)[0].id;

    it('a chunk on both lists ranks above a chunk on one, with both ranks as signals', async () => {
      const s = setup(msgs);
      t = s.t;
      const lexOnly = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0 }), now: BASE_TIME });
      const lexIds = lexOnly.map((h) => h.chunk.messageId);
      // The vector list puts m2 (lower on BM25) first, then m3 (not on BM25).
      const second = lexIds[1];
      const vectorHits = [{ chunkId: chunkIdOf(t.store, second), vectorRank: 1 }, { chunkId: chunkIdOf(t.store, 'chat-1-m3'), vectorRank: 2 }];
      const hits = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0, kindWeights: { user: 1 } }), now: BASE_TIME, vectorHits });
      const top = hits[0];
      assert.strictEqual(top.chunk.messageId, second, 'on both lists beats first on one');
      assert.strictEqual(top.signals.vectorRank, 1);
      assert.strictEqual(top.signals.bm25Rank, 2);
      assert.ok(Math.abs(top.score - (1 / 62 + 1 / 61)) < 1e-12);
      const m3 = hits.find((h) => h.chunk.messageId === 'chat-1-m3');
      assert.ok(m3, 'a vector-only hit is recalled');
      assert.strictEqual(m3.signals.bm25Rank, null);
      assert.strictEqual(m3.signals.vectorRank, 2);
    });

    it('lexical: false uses the vector list alone, capped at vectorTopK', async () => {
      const s = setup(msgs);
      t = s.t;
      const vectorHits = ['chat-1-m3', 'chat-1-m1', 'chat-1-m2'].map((id, i) => ({ chunkId: chunkIdOf(t.store, id), vectorRank: i + 1 }));
      const hits = await s.retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0, vectorTopK: 2 }), now: BASE_TIME, vectorHits, lexical: false });
      assert.deepStrictEqual(hits.map((h) => h.chunk.messageId), ['chat-1-m3', 'chat-1-m1']);
      assert.ok(hits.every((h) => h.signals.bm25Rank === null));
    });

    it('drops vector hits at or after upToSeq and outside the chat scope', async () => {
      const s = setup(msgs, [{ id: 'other', messages: [{ sender: 'user', text: 'The other chat gate.' }] }]);
      t = s.t;
      const vectorHits = [
        { chunkId: chunkIdOf(t.store, 'chat-1-m4'), vectorRank: 1 },
        { chunkId: chunkIdOf(t.store, 'other-m1'), vectorRank: 2 },
        { chunkId: chunkIdOf(t.store, 'chat-1-m3'), vectorRank: 3 }
      ];
      const hits = await s.retriever.retrieve({ query: 'permits', chatIds: ['chat-1'], upToSeq: 4, settings: recall(), now: BASE_TIME, vectorHits, lexical: false });
      assert.deepStrictEqual(hits.map((h) => h.chunk.messageId), ['chat-1-m3']);
    });

    it('asks the vectorSearch callback when no list is given', async () => {
      const t0 = openTempStore();
      seedChat(t0.store, { messages: msgs });
      t = t0;
      const seen = [];
      const retriever = new Retriever({
        store: t0.store, estimator: new TokenEstimator(),
        vectorSearch: async (args) => { seen.push(args); return [{ chunkId: chunkIdOf(t0.store, 'chat-1-m3'), vectorRank: 1 }]; }
      });
      const hits = await retriever.retrieve({ query: 'nothing lexical here', chatIds: ['chat-1'], upToSeq: 4, settings: recall(), now: BASE_TIME });
      assert.deepStrictEqual(hits.map((h) => h.chunk.messageId), ['chat-1-m3']);
      assert.strictEqual(seen[0].upToSeq, 4);
      assert.strictEqual(seen[0].settings.vectorTopK, 50);
    });
  });

  describe('rerank (spec §6.3 step 6)', () => {
    const msgs = [
      { sender: 'user', text: 'Gate note one: the side gate at the Lakeside lot sticks.' },
      { sender: 'user', text: 'Gate note two: the gate code is 4417 for the side gate.' },
      { sender: 'user', text: 'Gate note three: a gate repair visit is booked for Tuesday.' },
      { sender: 'user', text: 'Gate note four: the gate remote needs a new battery.' },
      { sender: 'user', text: 'Gate note five: the gate hinge was oiled last week.' }
    ];
    const opts = (over = {}) => ({ query: 'gate', chatIds: ['chat-1'], now: BASE_TIME, ...over });
    const order = (hits) => hits.map((h) => h.chunk.messageId);
    // A fake reranker: scores each chunk by where its message sits in `prefer`.
    const preferring = (prefer, calls = []) => async (query, chunks) => {
      calls.push({ query, ids: chunks.map((c) => c.messageId), seqs: chunks.map((c) => c.seq) });
      return chunks.map((c) => (prefer.includes(c.messageId) ? 100 - prefer.indexOf(c.messageId) : 0));
    };

    it('reorders only the top M; the rest keep their fused order below', async () => {
      const s = setup(msgs);
      t = s.t;
      const fused = order(await s.retriever.retrieve(opts({ settings: recall() })));
      assert.strictEqual(fused.length, 5);
      const calls = [];
      // Prefer the third fused hit, then the second; the fifth is outside topM 3.
      const reranker = preferring([fused[2], fused[1], fused[4]], calls);
      const hits = await s.retriever.retrieve(opts({ settings: recall({ rerank: { enabled: true, topM: 3 } }), reranker }));
      assert.deepStrictEqual(order(hits), [fused[2], fused[1], fused[0], fused[3], fused[4]]);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].ids, fused.slice(0, 3), 'the reranker sees the top M only');
      assert.strictEqual(calls[0].query, 'gate');
      assert.strictEqual(hits[0].score, 100);
      assert.strictEqual(hits[0].signals.rerank, 100);
      assert.ok(Number.isFinite(hits[0].signals.fused));
      assert.strictEqual(hits[3].signals.rerank, null, 'below topM: no rerank score');
    });

    it('never passes or surfaces a chunk at or after upToSeq', async () => {
      const s = setup(msgs);
      t = s.t;
      const later = t.store.chunksOfMessage('chat-1-m5')[0].id;
      const calls = [];
      const reranker = preferring(['chat-1-m5', 'chat-1-m4'], calls);
      const hits = await s.retriever.retrieve(opts({
        upToSeq: 5, settings: recall({ rerank: { enabled: true, topM: 50 } }), reranker,
        vectorHits: [{ chunkId: later, vectorRank: 1 }]
      }));
      assert.ok(calls[0].seqs.every((seq) => seq < 5));
      assert.ok(hits.every((h) => h.chunk.seq < 5));
      assert.strictEqual(hits[0].chunk.messageId, 'chat-1-m4');
    });

    it('off by default, and without a reranker; a constructor reranker is used when enabled', async () => {
      const t0 = openTempStore();
      seedChat(t0.store, { messages: msgs });
      t = t0;
      const calls = [];
      const retriever = new Retriever({ store: t0.store, estimator: new TokenEstimator(), reranker: preferring(['chat-1-m4'], calls) });
      const plain = order(await retriever.retrieve(opts({ settings: recall() })));
      assert.strictEqual(calls.length, 0, 'rerank.enabled defaults to false');
      const noReranker = new Retriever({ store: t0.store, estimator: new TokenEstimator() });
      assert.deepStrictEqual(order(await noReranker.retrieve(opts({ settings: recall({ rerank: { enabled: true } }) }))), plain);
      const hits = await retriever.retrieve(opts({ settings: recall({ rerank: { enabled: true } }) }));
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(hits[0].chunk.messageId, 'chat-1-m4');
    });

    it('keeps the fused order when the reranker throws or returns unusable scores', async () => {
      const s = setup(msgs);
      t = s.t;
      const settings = recall({ rerank: { enabled: true, topM: 3 } });
      const fused = order(await s.retriever.retrieve(opts({ settings: recall() })));
      for (const reranker of [
        async () => { throw new Error('model missing'); },
        async () => [1, 2],
        async () => [1, NaN, 3],
        async () => null
      ]) {
        assert.deepStrictEqual(order(await s.retriever.retrieve(opts({ settings, reranker }))), fused);
      }
    });

    it('a reranker slower than rerank.maxMs is skipped for the turn and logged, with the pair count and no text', async () => {
      const { addSink } = require('../src/logging');
      const s = setup(msgs);
      t = s.t;
      const fused = order(await s.retriever.retrieve(opts({ settings: recall() })));
      let late;
      const slow = (query, chunks) => new Promise((resolve) => {
        late = setTimeout(() => resolve(chunks.map((c, i) => i)), 1000);
      });
      const records = [];
      const remove = addSink((r) => records.push(r));
      const started = Date.now();
      let hits;
      try {
        hits = await s.retriever.retrieve(opts({ settings: recall({ rerank: { enabled: true, topM: 3, maxMs: 30 } }), reranker: slow }));
      } finally {
        remove();
        clearTimeout(late);
      }
      assert.ok(Date.now() - started < 800, 'the turn does not wait for the reranker');
      assert.deepStrictEqual(order(hits), fused, 'the fused order is kept');
      assert.ok(hits.every((h) => h.signals.rerank === null));
      const warn = records.find((r) => r.level === 'warn' && /maxMs/.test(r.message));
      assert.ok(warn, 'a warning is logged');
      assert.strictEqual(warn.meta.pairs, 3);
      assert.ok(!/gate/i.test(warn.line), 'no query or chunk text in the log');

      // Within maxMs the rerank applies.
      const quick = await s.retriever.retrieve(opts({ settings: recall({ rerank: { enabled: true, topM: 3, maxMs: 2000 } }), reranker: preferring([fused[2]]) }));
      assert.strictEqual(order(quick)[0], fused[2]);
    });

    it('the budget and per-message cap apply to the reranked order', async () => {
      const s = setup(msgs);
      t = s.t;
      const fused = order(await s.retriever.retrieve(opts({ settings: recall() })));
      const one = t.store.chunksOfMessage(fused[4])[0].text;
      const budget = new TokenEstimator().estimate(one) + 1;
      const hits = await s.retriever.retrieve(opts({
        settings: recall({ rerank: { enabled: true, topM: 5 } }), budgetTokens: budget, reranker: preferring([fused[4]])
      }));
      assert.deepStrictEqual(order(hits), [fused[4]]);
    });
  });
});

describe('Retriever: cosine dedupe (spec §6.3 step 7)', () => {
  const { unit } = require('../src/history/embedders/vectors');
  const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
  const bowEmbedder = createBagOfWordsEmbedder();
  let t;
  afterEach(() => t && t.cleanup());
  const msgs = [
    { sender: 'user', text: 'The side gate code at the Lakeside lot is 4417.' },
    { sender: 'user', text: 'Again: the gate code for the Lakeside lot is 4417.' },
    { sender: 'user', text: 'The fence along the lot is forty meters.' }
  ];
  async function vectorsOf(store) {
    const map = new Map();
    for (const c of store.chunksOfChat('chat-1')) map.set(c.id, unit((await bowEmbedder.embed([c.text]))[0]));
    return (chunk) => map.get(chunk.id) || null;
  }
  const has = (hits, id) => hits.some((h) => h.chunk.messageId === id);

  it('drops a near-duplicate by cosine when both have vectors', async () => {
    const s = setup(msgs);
    t = s.t;
    const vectorOf = await vectorsOf(t.store);
    const stats = {};
    const hits = await s.retriever.retrieve({ query: 'gate code lot', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0 }), now: BASE_TIME, vectorOf, stats });
    assert.notStrictEqual(has(hits, 'chat-1-m1'), has(hits, 'chat-1-m2'), 'one of the two gate-code notes is kept');
    assert.ok(has(hits, 'chat-1-m3'), 'the fence note is not a duplicate');
    assert.strictEqual(stats.cosineDuplicates, 1);
  });

  it('keeps both at dedupeCosine 0, without vectors, or when a chunk has no vector', async () => {
    const s = setup(msgs);
    t = s.t;
    const vectorOf = await vectorsOf(t.store);
    const run = (over) => s.retriever.retrieve({ query: 'gate code lot', chatIds: ['chat-1'], now: BASE_TIME, settings: recall({ recencyWeight: 0 }), ...over });
    for (const hits of [
      await run({ vectorOf, settings: recall({ recencyWeight: 0, dedupeCosine: 0 }) }),
      await run({}),
      await run({ vectorOf: () => null })
    ]) {
      assert.ok(has(hits, 'chat-1-m1') && has(hits, 'chat-1-m2'));
    }
  });

  it('uses the constructor\'s vectorOf when the call gives none', async () => {
    const s = setup(msgs);
    t = s.t;
    const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator(), vectorOf: await vectorsOf(t.store) });
    const hits = await retriever.retrieve({ query: 'gate code lot', chatIds: ['chat-1'], settings: recall({ recencyWeight: 0 }), now: BASE_TIME });
    assert.notStrictEqual(has(hits, 'chat-1-m1'), has(hits, 'chat-1-m2'));
  });
});

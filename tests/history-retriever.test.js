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
});

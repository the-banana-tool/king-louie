// tests/history-settings.test.js
// The history settings namespace (recall spec §14, stage H2).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { HISTORY_DEFAULTS, mergeHistorySettings } = require('../src/history/settings');
const { mergeSettings, DEFAULT_SETTINGS } = require('../src/core/settings');

describe('history settings', () => {
  it('defaults match the spec', () => {
    const s = mergeHistorySettings(undefined);
    assert.deepStrictEqual(s.recall, {
      enabled: true, tailMessages: 16, tailTokens: 6000, tailMaxMessageTokens: 1500, tailIncludeToolCalls: true,
      recalledTokens: 6000, queryUserTurns: 0, bm25TopK: 200, rrfK: 60,
      kindWeights: { user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 },
      recencyWeight: 0.3, recencyHalfLifeDays: 30, maxChunksPerMessage: 4,
      completeMessageTokens: 0, prefixMinChars: 0, queryContextSeparate: false, pairToolMessages: false,
      diversifyFirst: false, dedupeJaccard: 0,
      vectorTopK: 50, rerank: { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 20, maxMs: 2000 },
      tailIncludeToolResults: true, tailToolResultMaxTokens: 1000, recencyByPosition: false, recencyHalfLifeFraction: 0.25
    });
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 40 });
    assert.strictEqual(s.readHistoryMaxTokens, 8000);
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall));
    assert.ok(!Object.isFrozen(s.recall), 'merged settings are a fresh object');
  });

  it('merges one key at a time and keeps the rest', () => {
    const s = mergeHistorySettings({ recall: { enabled: false, kindWeights: { tool_result: 0.2 } }, chunk: { minChars: 10 } });
    assert.strictEqual(s.recall.enabled, false);
    assert.strictEqual(s.recall.tailMessages, 16);
    assert.strictEqual(s.recall.kindWeights.tool_result, 0.2);
    assert.strictEqual(s.recall.kindWeights.user, 1.2);
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 10 });
  });

  it('falls back to the default for a value of the wrong type or out of range', () => {
    const s = mergeHistorySettings({
      recall: {
        enabled: 'no', tailMessages: '8', queryUserTurns: -1, tailTokens: -5, recalledTokens: NaN, recencyHalfLifeDays: 0,
        recencyWeight: 3, bm25TopK: 0, maxChunksPerMessage: 2.7, kindWeights: null,
        tailIncludeToolResults: 0, tailToolResultMaxTokens: 0, recencyByPosition: 1, recencyHalfLifeFraction: -0.5
      },
      chunk: { targetChars: 10 },
      readHistoryMaxTokens: 'lots'
    });
    assert.strictEqual(s.recall.enabled, true);
    assert.strictEqual(s.recall.tailMessages, 16);
    assert.strictEqual(s.recall.queryUserTurns, 0);
    assert.strictEqual(s.recall.tailTokens, 6000);
    assert.strictEqual(s.recall.recalledTokens, 6000);
    assert.strictEqual(s.recall.recencyHalfLifeDays, 30);
    assert.strictEqual(s.recall.recencyWeight, 0.3);
    assert.strictEqual(s.recall.bm25TopK, 200);
    assert.strictEqual(s.recall.maxChunksPerMessage, 2);
    assert.strictEqual(s.recall.kindWeights.user, 1.2);
    assert.strictEqual(s.chunk.targetChars, 1500);
    assert.strictEqual(s.readHistoryMaxTokens, 8000);
    assert.strictEqual(s.recall.tailIncludeToolResults, true, 'a falsy non-boolean falls back to the default, not to false');
    assert.strictEqual(s.recall.tailToolResultMaxTokens, 1000);
    assert.strictEqual(s.recall.recencyByPosition, false);
    assert.strictEqual(s.recall.recencyHalfLifeFraction, 0.25);
  });

  it('rerank: type-checked one key at a time', () => {
    const d = { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 20, maxMs: 2000 };
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: { enabled: true } } }).recall.rerank, { ...d, enabled: true });
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: { topM: 50.9 } } }).recall.rerank, { ...d, topM: 50 });
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: { enabled: 'yes', topM: 0 } } }).recall.rerank, d);
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: true } }).recall.rerank, d);
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: { maxMs: 500, model: 'Xenova/other-reranker' } } }).recall.rerank,
      { ...d, maxMs: 500, model: 'Xenova/other-reranker' });
    for (const maxMs of [0, -5, NaN, Infinity, '2000', null]) {
      assert.strictEqual(mergeHistorySettings({ recall: { rerank: { maxMs } } }).recall.rerank.maxMs, 2000, String(maxMs));
    }
    for (const model of ['', '   ', 42, null, ['x']]) {
      assert.strictEqual(mergeHistorySettings({ recall: { rerank: { model } } }).recall.rerank.model, d.model, JSON.stringify(model));
    }
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall.rerank));
  });

  it('budget-fill knobs: a flag and a fraction, else the default', () => {
    const on = mergeHistorySettings({ recall: { diversifyFirst: true, dedupeJaccard: 0.8 } }).recall;
    assert.strictEqual(on.diversifyFirst, true);
    assert.strictEqual(on.dedupeJaccard, 0.8);
    for (const bad of [{ diversifyFirst: 'yes', dedupeJaccard: 1.5 }, { diversifyFirst: 1, dedupeJaccard: -0.1 }, { dedupeJaccard: '0.8' }]) {
      const s = mergeHistorySettings({ recall: bad }).recall;
      assert.strictEqual(s.diversifyFirst, false, JSON.stringify(bad));
      assert.strictEqual(s.dedupeJaccard, 0, JSON.stringify(bad));
    }
  });

  it('is part of mergeSettings and DEFAULT_SETTINGS', () => {
    assert.strictEqual(DEFAULT_SETTINGS.history.recall.tailMessages, 16);
    assert.strictEqual(mergeSettings({}).history.recall.enabled, true);
    const merged = mergeSettings({ history: { recall: { recalledTokens: 2000 } } });
    assert.strictEqual(merged.history.recall.recalledTokens, 2000);
    assert.strictEqual(merged.history.recall.tailTokens, 6000);
    assert.strictEqual('retrieval' in merged.history, false);
  });
});

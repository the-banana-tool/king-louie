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
      enabled: true, tailMessages: 8, tailTokens: 6000, tailMaxMessageTokens: 1500, tailIncludeToolCalls: true,
      recalledTokens: 6000, queryUserTurns: 2, bm25TopK: 50, rrfK: 60,
      kindWeights: { user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 },
      recencyWeight: 0.3, recencyHalfLifeDays: 30, maxChunksPerMessage: 4,
      completeMessageTokens: 0, prefixMinChars: 0, queryContextSeparate: false, pairToolMessages: false,
      vectorTopK: 50, rerank: { enabled: false, topM: 20 }
    });
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 40 });
    assert.strictEqual(s.readHistoryMaxTokens, 8000);
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall));
    assert.ok(!Object.isFrozen(s.recall), 'merged settings are a fresh object');
  });

  it('merges one key at a time and keeps the rest', () => {
    const s = mergeHistorySettings({ recall: { enabled: false, kindWeights: { tool_result: 0.2 } }, chunk: { minChars: 10 } });
    assert.strictEqual(s.recall.enabled, false);
    assert.strictEqual(s.recall.tailMessages, 8);
    assert.strictEqual(s.recall.kindWeights.tool_result, 0.2);
    assert.strictEqual(s.recall.kindWeights.user, 1.2);
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 10 });
  });

  it('falls back to the default for a value of the wrong type or out of range', () => {
    const s = mergeHistorySettings({
      recall: {
        enabled: 'no', tailMessages: '8', tailTokens: -5, recalledTokens: NaN, recencyHalfLifeDays: 0,
        recencyWeight: 3, bm25TopK: 0, maxChunksPerMessage: 2.7, kindWeights: null
      },
      chunk: { targetChars: 10 },
      readHistoryMaxTokens: 'lots'
    });
    assert.strictEqual(s.recall.enabled, true);
    assert.strictEqual(s.recall.tailMessages, 8);
    assert.strictEqual(s.recall.tailTokens, 6000);
    assert.strictEqual(s.recall.recalledTokens, 6000);
    assert.strictEqual(s.recall.recencyHalfLifeDays, 30);
    assert.strictEqual(s.recall.recencyWeight, 0.3);
    assert.strictEqual(s.recall.bm25TopK, 50);
    assert.strictEqual(s.recall.maxChunksPerMessage, 2);
    assert.strictEqual(s.recall.kindWeights.user, 1.2);
    assert.strictEqual(s.chunk.targetChars, 1500);
    assert.strictEqual(s.readHistoryMaxTokens, 8000);
  });

  it('rerank: type-checked one key at a time', () => {
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: { enabled: true } } }).recall.rerank, { enabled: true, topM: 20 });
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: { topM: 50.9 } } }).recall.rerank, { enabled: false, topM: 50 });
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: { enabled: 'yes', topM: 0 } } }).recall.rerank, { enabled: false, topM: 20 });
    assert.deepStrictEqual(mergeHistorySettings({ recall: { rerank: true } }).recall.rerank, { enabled: false, topM: 20 });
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall.rerank));
  });

  it('is part of mergeSettings and DEFAULT_SETTINGS', () => {
    assert.strictEqual(DEFAULT_SETTINGS.history.recall.tailMessages, 8);
    assert.strictEqual(mergeSettings({}).history.recall.enabled, true);
    const merged = mergeSettings({ history: { recall: { recalledTokens: 2000 } } });
    assert.strictEqual(merged.history.recall.recalledTokens, 2000);
    assert.strictEqual(merged.history.recall.tailTokens, 6000);
    assert.strictEqual('retrieval' in merged.history, false);
  });
});

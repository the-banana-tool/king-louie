// tests/history-settings.test.js
// The history settings namespace (recall spec §14; stages H2 and H3).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  HISTORY_DEFAULTS, HISTORY_SETTINGS_VERSION, EMBEDDER_KINDS, mergeHistorySettings, embedderKey
} = require('../src/history/settings');
const { mergeSettings, DEFAULT_SETTINGS } = require('../src/core/settings');

const RERANK = { enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 };
const EMBEDDER = {
  kind: 'local',
  model: 'Xenova/bge-small-en-v1.5',
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' },
  openai: { model: 'text-embedding-3-small' },
  batchSize: 16,
  intervalMs: 2000,
  maxChunksPerToolResult: 0
};
const saved = (over = {}) => mergeHistorySettings({ version: HISTORY_SETTINGS_VERSION, ...over });

describe('history settings', () => {
  it('defaults match the spec', () => {
    const s = mergeHistorySettings(undefined);
    assert.strictEqual(s.version, 3);
    assert.deepStrictEqual(s.recall, {
      enabled: true, tailMessages: 16, tailTokens: 6000, tailMaxMessageTokens: 1500, tailIncludeToolCalls: true,
      tailIncludeToolResults: true, tailToolResultMaxTokens: 1000,
      recalledTokens: 6000, queryUserTurns: 0, bm25TopK: 200, rrfK: 60,
      kindWeights: { user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 },
      recencyWeight: 0.3, recencyHalfLifeDays: 30, maxChunksPerMessage: 4,
      vectorTopK: 50, dedupeCosine: 0.92, vectorCacheMb: 256, rerank: RERANK,
      completeMessageTokens: 0, prefixMinChars: 0, queryContextSeparate: false, pairToolMessages: false,
      diversifyFirst: false, dedupeJaccard: 0, recencyByPosition: false, recencyHalfLifeFraction: 0.25
    });
    assert.deepStrictEqual(s.embedder, EMBEDDER);
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 40 });
    assert.strictEqual(s.readHistoryMaxTokens, 8000);
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall));
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.embedder.ollama));
    assert.ok(!Object.isFrozen(s.recall), 'merged settings are a fresh object');
    assert.deepStrictEqual(EMBEDDER_KINDS, ['local', 'ollama', 'openai', 'none']);
  });

  it('merges one key at a time and keeps the rest', () => {
    const s = mergeHistorySettings({ recall: { enabled: false, kindWeights: { tool_result: 0.2 } }, chunk: { minChars: 10 }, embedder: { kind: 'none' } });
    assert.strictEqual(s.recall.enabled, false);
    assert.strictEqual(s.recall.kindWeights.tool_result, 0.2);
    assert.strictEqual(s.recall.kindWeights.user, 1.2);
    assert.deepStrictEqual(s.chunk, { targetChars: 1500, minChars: 10 });
    assert.deepStrictEqual(s.embedder, { ...EMBEDDER, kind: 'none' });
  });

  it('falls back to the default for a value of the wrong type or out of range', () => {
    const s = mergeHistorySettings({
      recall: {
        enabled: 'no', queryUserTurns: -1, tailTokens: -5, recalledTokens: NaN, recencyHalfLifeDays: 0,
        recencyWeight: 3, bm25TopK: 0, maxChunksPerMessage: 2.7, kindWeights: null,
        tailIncludeToolResults: 0, tailToolResultMaxTokens: 0, recencyByPosition: 1, recencyHalfLifeFraction: -0.5,
        dedupeCosine: 1.5, vectorCacheMb: 0
      },
      chunk: { targetChars: 10 },
      readHistoryMaxTokens: 'lots'
    });
    assert.strictEqual(s.recall.enabled, true);
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
    assert.strictEqual(s.recall.dedupeCosine, 0.92);
    assert.strictEqual(s.recall.vectorCacheMb, 256);
    assert.strictEqual(mergeHistorySettings({ recall: { dedupeCosine: 0 } }).recall.dedupeCosine, 0, '0 turns the cosine dedupe off');
  });

  it('rerank: type-checked one key at a time', () => {
    const d = RERANK;
    assert.deepStrictEqual(saved({ recall: { rerank: { enabled: true } } }).recall.rerank, { ...d, enabled: true });
    assert.deepStrictEqual(saved({ recall: { rerank: { topM: 50.9 } } }).recall.rerank, { ...d, topM: 50 });
    assert.deepStrictEqual(saved({ recall: { rerank: { enabled: 'yes', topM: 0 } } }).recall.rerank, d);
    assert.deepStrictEqual(saved({ recall: { rerank: true } }).recall.rerank, d);
    assert.deepStrictEqual(saved({ recall: { rerank: { maxMs: 500, model: 'Xenova/other-reranker' } } }).recall.rerank,
      { ...d, maxMs: 500, model: 'Xenova/other-reranker' });
    assert.deepStrictEqual(saved({ recall: { rerank: { search: false, searchMaxMs: 9000 } } }).recall.rerank, { ...d, search: false, searchMaxMs: 9000 });
    for (const maxMs of [0, -5, NaN, Infinity, '2000', null]) {
      assert.strictEqual(saved({ recall: { rerank: { maxMs } } }).recall.rerank.maxMs, 2000, String(maxMs));
      assert.strictEqual(saved({ recall: { rerank: { searchMaxMs: maxMs } } }).recall.rerank.searchMaxMs, 6000, String(maxMs));
    }
    for (const model of ['', '   ', 42, null, ['x'], '../escape', 'a/../b', 'C:\\models\\x', 'org/name:tag']) {
      assert.strictEqual(saved({ recall: { rerank: { model } } }).recall.rerank.model, d.model, JSON.stringify(model));
    }
    assert.strictEqual(saved({ recall: { rerank: { search: 'yes' } } }).recall.rerank.search, true);
    assert.ok(Object.isFrozen(HISTORY_DEFAULTS.recall.rerank));
  });

  it('a settings file saved before H3 (no version): rerank.topM 20 was the shipped default and reads as unset', () => {
    assert.strictEqual(mergeHistorySettings({ recall: { rerank: { topM: 20 } } }).recall.rerank.topM, 100);
    assert.strictEqual(mergeHistorySettings({ recall: { rerank: { topM: 30 } } }).recall.rerank.topM, 30);
    assert.strictEqual(saved({ recall: { rerank: { topM: 20 } } }).recall.rerank.topM, 20, 'a version-3 file keeps a chosen 20');
  });

  it('embedder: kind, model ids, the Ollama address and the pacing are type-checked', () => {
    const e = (over) => mergeHistorySettings({ embedder: over }).embedder;
    assert.strictEqual(e({ kind: 'onnx' }).kind, 'local');
    assert.strictEqual(e({ kind: 'ollama' }).kind, 'ollama');
    for (const model of ['../evil', 'a/../b', 'C:\\x', 'org/name:tag', '', 42]) assert.strictEqual(e({ model }).model, EMBEDDER.model, JSON.stringify(model));
    assert.strictEqual(e({ model: 'Xenova/all-MiniLM-L6-v2' }).model, 'Xenova/all-MiniLM-L6-v2');
    assert.strictEqual(e({ ollama: { model: 'nomic-embed-text:latest' } }).ollama.model, 'nomic-embed-text:latest');
    assert.strictEqual(e({ ollama: { baseUrl: 'ftp://192.0.2.10' } }).ollama.baseUrl, EMBEDDER.ollama.baseUrl);
    assert.strictEqual(e({ ollama: { baseUrl: 'http://192.0.2.10:11434/' } }).ollama.baseUrl, 'http://192.0.2.10:11434');
    assert.strictEqual(e({ openai: { model: 'text-embedding-3-large' } }).openai.model, 'text-embedding-3-large');
    assert.strictEqual(e({ batchSize: 0 }).batchSize, 16);
    assert.strictEqual(e({ batchSize: 1000 }).batchSize, 256);
    assert.strictEqual(e({ intervalMs: 50 }).intervalMs, 2000);
    assert.strictEqual(e({ maxChunksPerToolResult: -1 }).maxChunksPerToolResult, 0);
    assert.strictEqual(e({ maxChunksPerToolResult: 3 }).maxChunksPerToolResult, 3);
  });

  it('embedderKey names the model the vectors belong to', () => {
    const e = (over) => mergeHistorySettings({ embedder: over }).embedder;
    assert.strictEqual(embedderKey(e({})), 'local:Xenova/bge-small-en-v1.5');
    assert.strictEqual(embedderKey(e({ kind: 'ollama' })), 'ollama:nomic-embed-text');
    assert.strictEqual(embedderKey(e({ kind: 'openai' })), 'openai:text-embedding-3-small');
    assert.strictEqual(embedderKey(e({ kind: 'none' })), null);
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

  it('is part of mergeSettings and DEFAULT_SETTINGS, and a merged file stays as merged', () => {
    assert.strictEqual(DEFAULT_SETTINGS.history.embedder.kind, 'local');
    assert.strictEqual(mergeSettings({}).history.recall.enabled, true);
    const merged = mergeSettings({ history: { recall: { recalledTokens: 2000, rerank: { topM: 20 } } } });
    assert.strictEqual(merged.history.recall.recalledTokens, 2000);
    assert.strictEqual(merged.history.recall.rerank.topM, 100);
    assert.strictEqual(merged.history.version, 3);
    const chosen = mergeSettings({ ...merged, history: { ...merged.history, recall: { ...merged.history.recall, rerank: { ...merged.history.recall.rerank, topM: 20 } } } });
    assert.strictEqual(chosen.history.recall.rerank.topM, 20, 'after the first merge, 20 is a choice');
    assert.strictEqual('retrieval' in merged.history, false);
  });
});

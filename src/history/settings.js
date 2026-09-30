// src/history/settings.js
// The `history` settings namespace (recall spec §14, stage H2). The
// embedder, rerank and vector keys arrive with H3, the case nudge with H4.
// Every value is type-checked: a hand-edited settings file must never turn a
// budget into NaN, a negative number or a division by zero.
const HISTORY_DEFAULTS = Object.freeze({
  recall: Object.freeze({
    enabled: true,
    tailMessages: 8,
    tailTokens: 6000,
    tailMaxMessageTokens: 1500,
    tailIncludeToolCalls: true,
    recalledTokens: 6000,
    queryUserTurns: 2,
    bm25TopK: 50,
    rrfK: 60,
    kindWeights: Object.freeze({ user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 }),
    recencyWeight: 0.3,
    recencyHalfLifeDays: 30,
    maxChunksPerMessage: 4,
    // Experimental (recall tuning 2026-09-30); 0 / false = off.
    completeMessageTokens: 0,
    prefixMinChars: 0,
    queryContextSeparate: false,
    pairToolMessages: false,
    // Budget fill (recall budget 2026-09-30): diversifyFirst takes the best
    // chunk of each distinct message first, then fills by score;
    // dedupeJaccard > 0 drops a candidate whose word 5-gram Jaccard to a
    // selected chunk exceeds it.
    diversifyFirst: false,
    dedupeJaccard: 0,
    // Top cosine hits fused with BM25 (spec §6.3 step 2). Inert until a
    // vector list is given to retrieve() (H3; LongHaul's kl-recall-vec).
    vectorTopK: 50
  }),
  chunk: Object.freeze({ targetChars: 1500, minChars: 40 }),
  readHistoryMaxTokens: 8000
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// A count or budget >= min; `integer` floors it.
const atLeast = (value, fallback, min, integer = false) => {
  if (!finite(value) || value < min) return fallback;
  return integer ? Math.floor(value) : value;
};
const positive = (value, fallback) => (finite(value) && value > 0 ? value : fallback);
const fraction = (value, fallback) => (finite(value) && value >= 0 && value <= 1 ? value : fallback);
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

function mergeHistorySettings(source) {
  const src = isObject(source) ? source : {};
  const r = isObject(src.recall) ? src.recall : {};
  const c = isObject(src.chunk) ? src.chunk : {};
  const d = HISTORY_DEFAULTS.recall;
  const weightsIn = isObject(r.kindWeights) ? r.kindWeights : {};
  const kindWeights = {};
  for (const [kind, weight] of Object.entries(d.kindWeights)) kindWeights[kind] = atLeast(weightsIn[kind], weight, 0);
  return {
    recall: {
      enabled: flag(r.enabled, d.enabled),
      tailMessages: atLeast(r.tailMessages, d.tailMessages, 0, true),
      tailTokens: positive(r.tailTokens, d.tailTokens),
      tailMaxMessageTokens: positive(r.tailMaxMessageTokens, d.tailMaxMessageTokens),
      tailIncludeToolCalls: flag(r.tailIncludeToolCalls, d.tailIncludeToolCalls),
      recalledTokens: atLeast(r.recalledTokens, d.recalledTokens, 0),
      queryUserTurns: atLeast(r.queryUserTurns, d.queryUserTurns, 0, true),
      bm25TopK: atLeast(r.bm25TopK, d.bm25TopK, 1, true),
      rrfK: atLeast(r.rrfK, d.rrfK, 0),
      kindWeights,
      recencyWeight: fraction(r.recencyWeight, d.recencyWeight),
      recencyHalfLifeDays: positive(r.recencyHalfLifeDays, d.recencyHalfLifeDays),
      maxChunksPerMessage: atLeast(r.maxChunksPerMessage, d.maxChunksPerMessage, 1, true),
      completeMessageTokens: atLeast(r.completeMessageTokens, d.completeMessageTokens, 0),
      prefixMinChars: atLeast(r.prefixMinChars, d.prefixMinChars, 0, true),
      queryContextSeparate: flag(r.queryContextSeparate, d.queryContextSeparate),
      pairToolMessages: flag(r.pairToolMessages, d.pairToolMessages),
      diversifyFirst: flag(r.diversifyFirst, d.diversifyFirst),
      dedupeJaccard: fraction(r.dedupeJaccard, d.dedupeJaccard),
      vectorTopK: atLeast(r.vectorTopK, d.vectorTopK, 1, true)
    },
    chunk: {
      targetChars: atLeast(c.targetChars, HISTORY_DEFAULTS.chunk.targetChars, 200, true),
      minChars: atLeast(c.minChars, HISTORY_DEFAULTS.chunk.minChars, 0, true)
    },
    readHistoryMaxTokens: positive(src.readHistoryMaxTokens, HISTORY_DEFAULTS.readHistoryMaxTokens)
  };
}

module.exports = { HISTORY_DEFAULTS, mergeHistorySettings };

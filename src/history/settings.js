// src/history/settings.js
// The `history` settings namespace (recall spec §14, stage H2). The
// embedder, rerank and vector keys arrive with H3, the case nudge with H4.
// Every value is type-checked: a hand-edited settings file must never turn a
// budget into NaN, a negative number or a division by zero.
const HISTORY_DEFAULTS = Object.freeze({
  // Defaults measured on the LongHaul private set (2026-09-30, 103 verified
  // questions over four real sessions; recall spec §6.7): evidence recall
  // 0.19 with the first H2 defaults. The previous user turns in the query
  // were noise (queryUserTurns 0) and the answer often ranked below 50
  // (bm25TopK 200). The tail counted assistant rows, so agent sessions, which
  // write one assistant row per tool round, got an empty tail (tailMessages
  // 16), and it never showed tool results (tailIncludeToolResults).
  recall: Object.freeze({
    enabled: true,
    // The tail (spec §6.1).
    tailMessages: 16,
    tailTokens: 6000,
    tailMaxMessageTokens: 1500,
    tailIncludeToolCalls: true,
    // Tool results inside the tail span, newest first, with the tokens the
    // user and assistant messages leave; one over the cap is shortened.
    tailIncludeToolResults: true,
    tailToolResultMaxTokens: 1000,
    // Retrieval (spec §6.3).
    recalledTokens: 6000,
    queryUserTurns: 0,
    bm25TopK: 200,
    rrfK: 60,
    kindWeights: Object.freeze({ user: 1.2, assistant: 1.0, summary: 0.9, attachment: 0.9, tool_use: 0.7, tool_result: 0.6 }),
    recencyWeight: 0.3,
    recencyHalfLifeDays: 30,
    maxChunksPerMessage: 4,
    // Top cosine hits fused with BM25 (step 2). Inert until a vector list is
    // given to retrieve() (H3; LongHaul's kl-recall-vec).
    vectorTopK: 50,
    // Step 6: rescore the top topM candidates with a reranker callback given
    // to the Retriever. Inert without one (H3; LongHaul's kl-recall-rerank).
    // topM must exceed what the budget selects (60-90 chunks at 6000 tokens)
    // to change anything. maxMs: a reranker slower than this is skipped for
    // the turn (spec §15). model is the cross-encoder H3 loads; the Retriever
    // never reads it (the callback owns its model), it is here so the
    // settings match spec §14.
    rerank: Object.freeze({ enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 20, maxMs: 2000 }),
    // Measured and left off (spec §6.7); 0 / false = off.
    // completeMessageTokens: take a small message whole on its first hit;
    // pairToolMessages (only with it): a tool call brings its result.
    completeMessageTokens: 0,
    pairToolMessages: false,
    // prefixMinChars: prefix-match unquoted words at least this long.
    prefixMinChars: 0,
    // queryContextSeparate: previous user turns as their own fused list.
    queryContextSeparate: false,
    // diversifyFirst: the best chunk of each message first, then by score;
    // dedupeJaccard > 0: drop a word 5-gram near-duplicate of a selected chunk.
    diversifyFirst: false,
    dedupeJaccard: 0,
    // recencyByPosition: age as the fraction of the chat behind this point,
    // against recencyHalfLifeFraction, instead of days.
    recencyByPosition: false,
    recencyHalfLifeFraction: 0.25
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
const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value : fallback);

function mergeHistorySettings(source) {
  const src = isObject(source) ? source : {};
  const r = isObject(src.recall) ? src.recall : {};
  const c = isObject(src.chunk) ? src.chunk : {};
  const d = HISTORY_DEFAULTS.recall;
  const weightsIn = isObject(r.kindWeights) ? r.kindWeights : {};
  const rr = isObject(r.rerank) ? r.rerank : {};
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
      vectorTopK: atLeast(r.vectorTopK, d.vectorTopK, 1, true),
      rerank: {
        enabled: flag(rr.enabled, d.rerank.enabled),
        model: text(rr.model, d.rerank.model),
        topM: atLeast(rr.topM, d.rerank.topM, 1, true),
        maxMs: positive(rr.maxMs, d.rerank.maxMs)
      },
      tailIncludeToolResults: flag(r.tailIncludeToolResults, d.tailIncludeToolResults),
      tailToolResultMaxTokens: positive(r.tailToolResultMaxTokens, d.tailToolResultMaxTokens),
      recencyByPosition: flag(r.recencyByPosition, d.recencyByPosition),
      recencyHalfLifeFraction: positive(r.recencyHalfLifeFraction, d.recencyHalfLifeFraction)
    },
    chunk: {
      targetChars: atLeast(c.targetChars, HISTORY_DEFAULTS.chunk.targetChars, 200, true),
      minChars: atLeast(c.minChars, HISTORY_DEFAULTS.chunk.minChars, 0, true)
    },
    readHistoryMaxTokens: positive(src.readHistoryMaxTokens, HISTORY_DEFAULTS.readHistoryMaxTokens)
  };
}

module.exports = { HISTORY_DEFAULTS, mergeHistorySettings };

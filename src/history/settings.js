// src/history/settings.js
// The `history` settings namespace (recall spec §14; stages H2 and H3).
// Every value is type-checked: a hand-edited settings file must never turn a
// budget into NaN, a negative number or a division by zero.
//
// version: setSettings stores the whole merged object, defaults included, so
// a file saved before H3 holds the old shipped defaults as if they were
// choices. A source without version 3 is such a file, and a value that was a
// shipped default then reads as unset (rerank.topM 20 here; the tail keys
// below). The output always carries version 3, so the mapping runs once.
const HISTORY_SETTINGS_VERSION = 3;
const EMBEDDER_KINDS = Object.freeze(['local', 'ollama', 'openai', 'none']);
// A local model id is org/name (or name): letters, digits, . _ -; it becomes
// a folder under <dataDir>/models, so no ':' and no '.'/'..' segment.
const LOCAL_MODEL_RE = /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})?$/;
// A hosted model id may carry a tag (Ollama's "nomic-embed-text:latest").
const REMOTE_MODEL_RE = /^[A-Za-z0-9._:-]{1,100}(\/[A-Za-z0-9._:-]{1,100})?$/;
const LEGACY_RERANK_TOPM = 20;

const HISTORY_DEFAULTS = Object.freeze({
  // Defaults measured on the LongHaul private set (2026-09-30, 103 verified
  // questions over four real sessions; recall spec §6.7).
  recall: Object.freeze({
    enabled: true,
    // The tail (spec §6.1).
    tailMessages: 16,
    tailTokens: 6000,
    tailMaxMessageTokens: 1500,
    tailIncludeToolCalls: true,
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
    // Step 2: the top cosine hits fused with BM25 (above 50 bought nothing).
    vectorTopK: 50,
    // Step 7 with vectors: a candidate whose cosine to a selected chunk
    // exceeds this is dropped; 0 turns it off.
    dedupeCosine: 0.92,
    // The in-memory vector matrices, all chats together (spec §5.3).
    vectorCacheMb: 256,
    // Step 6: a local cross-encoder rescores the top topM. topM must exceed
    // what the budget selects (60-90 chunks at 6,000 tokens): 20 changed
    // nothing, 100 is the knee (about 2.2 s on a laptop CPU). enabled: every
    // turn (off: too slow per turn); search: SearchHistory, where the model
    // is waiting anyway, under searchMaxMs. maxMs: a per-turn rerank slower
    // than this is skipped for that turn (spec §15).
    rerank: Object.freeze({ enabled: false, model: 'Xenova/ms-marco-MiniLM-L-6-v2', topM: 100, maxMs: 2000, search: true, searchMaxMs: 6000 }),
    // Measured and left off (spec §6.7); 0 / false = off.
    completeMessageTokens: 0,
    pairToolMessages: false,
    prefixMinChars: 0,
    queryContextSeparate: false,
    diversifyFirst: false,
    dedupeJaccard: 0,
    recencyByPosition: false,
    recencyHalfLifeFraction: 0.25
  }),
  // Which embedder fills the embeddings table (spec §5.2). local runs in the
  // embed worker; ollama and openai go through their providers.
  embedder: Object.freeze({
    kind: 'local',
    model: 'Xenova/bge-small-en-v1.5',
    ollama: Object.freeze({ baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' }),
    openai: Object.freeze({ model: 'text-embedding-3-small' }),
    batchSize: 16,
    intervalMs: 2000,
    // 0: every chunk of a tool result is embedded; n: only its first n (all
    // are always in the full-text index).
    maxChunksPerToolResult: 0
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
const noDotSegment = (v) => !v.split('/').some((seg) => /^\.+$/.test(seg));
const localModel = (v, fallback) => (typeof v === 'string' && LOCAL_MODEL_RE.test(v) && noDotSegment(v) ? v : fallback);
const remoteModel = (v, fallback) => (typeof v === 'string' && REMOTE_MODEL_RE.test(v) && noDotSegment(v) ? v : fallback);
function httpUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value.replace(/\/+$/, '') : fallback;
  } catch {
    return fallback;
  }
}

function mergeEmbedder(source) {
  const e = isObject(source) ? source : {};
  const d = HISTORY_DEFAULTS.embedder;
  const o = isObject(e.ollama) ? e.ollama : {};
  const a = isObject(e.openai) ? e.openai : {};
  return {
    kind: EMBEDDER_KINDS.includes(e.kind) ? e.kind : d.kind,
    model: localModel(e.model, d.model),
    ollama: { baseUrl: httpUrl(o.baseUrl, d.ollama.baseUrl), model: remoteModel(o.model, d.ollama.model) },
    openai: { model: remoteModel(a.model, d.openai.model) },
    batchSize: Math.min(256, atLeast(e.batchSize, d.batchSize, 1, true)),
    intervalMs: atLeast(e.intervalMs, d.intervalMs, 100, true),
    maxChunksPerToolResult: atLeast(e.maxChunksPerToolResult, d.maxChunksPerToolResult, 0, true)
  };
}

function mergeHistorySettings(source) {
  const src = isObject(source) ? source : {};
  const legacy = src.version !== HISTORY_SETTINGS_VERSION;
  const r = isObject(src.recall) ? src.recall : {};
  const c = isObject(src.chunk) ? src.chunk : {};
  const d = HISTORY_DEFAULTS.recall;
  const weightsIn = isObject(r.kindWeights) ? r.kindWeights : {};
  const rr = isObject(r.rerank) ? r.rerank : {};
  const kindWeights = {};
  for (const [kind, weight] of Object.entries(d.kindWeights)) kindWeights[kind] = atLeast(weightsIn[kind], weight, 0);
  const topM = legacy && rr.topM === LEGACY_RERANK_TOPM ? d.rerank.topM : atLeast(rr.topM, d.rerank.topM, 1, true);
  return {
    version: HISTORY_SETTINGS_VERSION,
    recall: {
      enabled: flag(r.enabled, d.enabled),
      tailMessages: atLeast(r.tailMessages, d.tailMessages, 0, true),
      tailTokens: positive(r.tailTokens, d.tailTokens),
      tailMaxMessageTokens: positive(r.tailMaxMessageTokens, d.tailMaxMessageTokens),
      tailIncludeToolCalls: flag(r.tailIncludeToolCalls, d.tailIncludeToolCalls),
      tailIncludeToolResults: flag(r.tailIncludeToolResults, d.tailIncludeToolResults),
      tailToolResultMaxTokens: positive(r.tailToolResultMaxTokens, d.tailToolResultMaxTokens),
      recalledTokens: atLeast(r.recalledTokens, d.recalledTokens, 0),
      queryUserTurns: atLeast(r.queryUserTurns, d.queryUserTurns, 0, true),
      bm25TopK: atLeast(r.bm25TopK, d.bm25TopK, 1, true),
      rrfK: atLeast(r.rrfK, d.rrfK, 0),
      kindWeights,
      recencyWeight: fraction(r.recencyWeight, d.recencyWeight),
      recencyHalfLifeDays: positive(r.recencyHalfLifeDays, d.recencyHalfLifeDays),
      maxChunksPerMessage: atLeast(r.maxChunksPerMessage, d.maxChunksPerMessage, 1, true),
      vectorTopK: atLeast(r.vectorTopK, d.vectorTopK, 1, true),
      dedupeCosine: fraction(r.dedupeCosine, d.dedupeCosine),
      vectorCacheMb: positive(r.vectorCacheMb, d.vectorCacheMb),
      rerank: {
        enabled: flag(rr.enabled, d.rerank.enabled),
        model: localModel(rr.model, d.rerank.model),
        topM,
        maxMs: positive(rr.maxMs, d.rerank.maxMs),
        search: flag(rr.search, d.rerank.search),
        searchMaxMs: positive(rr.searchMaxMs, d.rerank.searchMaxMs)
      },
      completeMessageTokens: atLeast(r.completeMessageTokens, d.completeMessageTokens, 0),
      prefixMinChars: atLeast(r.prefixMinChars, d.prefixMinChars, 0, true),
      queryContextSeparate: flag(r.queryContextSeparate, d.queryContextSeparate),
      pairToolMessages: flag(r.pairToolMessages, d.pairToolMessages),
      diversifyFirst: flag(r.diversifyFirst, d.diversifyFirst),
      dedupeJaccard: fraction(r.dedupeJaccard, d.dedupeJaccard),
      recencyByPosition: flag(r.recencyByPosition, d.recencyByPosition),
      recencyHalfLifeFraction: positive(r.recencyHalfLifeFraction, d.recencyHalfLifeFraction)
    },
    embedder: mergeEmbedder(src.embedder),
    chunk: {
      targetChars: atLeast(c.targetChars, HISTORY_DEFAULTS.chunk.targetChars, 200, true),
      minChars: atLeast(c.minChars, HISTORY_DEFAULTS.chunk.minChars, 0, true)
    },
    readHistoryMaxTokens: positive(src.readHistoryMaxTokens, HISTORY_DEFAULTS.readHistoryMaxTokens)
  };
}

// The key an embedder's vectors are stored under (embeddings.model):
// "<kind>:<model>". null for kind none.
function embedderKey(embedder) {
  const e = isObject(embedder) ? embedder : HISTORY_DEFAULTS.embedder;
  if (e.kind === 'local') return `local:${e.model}`;
  if (e.kind === 'ollama') return `ollama:${e.ollama.model}`;
  if (e.kind === 'openai') return `openai:${e.openai.model}`;
  return null;
}

module.exports = {
  HISTORY_DEFAULTS, HISTORY_SETTINGS_VERSION, EMBEDDER_KINDS, LOCAL_MODEL_RE, REMOTE_MODEL_RE, mergeHistorySettings, embedderKey
};

// src/models/normalize.js
// models.dev and OpenRouter documents → King Louie's catalog shapes
// (spec 2026-09-27 §4.1, §4.2). Pure functions; no I/O.
const { KL_PROVIDERS, modelsDevIdFor, OPENROUTER_VENDORS } = require('./provider-ids');

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const strList = (v, fallback) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : fallback);

// A response id such as gpt-5.5-2026-04-23 or claude-haiku-4-5-20251001 → its base id.
function stripDateSuffix(id) {
  return String(id || '').replace(DATE_SUFFIX, '');
}

function entryKey(provider, id) {
  return `${String(provider || '').toLowerCase()}:${String(id || '').toLowerCase()}`;
}

function emptyScores() {
  return { intelligence: null, coding: null, agentic: null, source: 'artificial-analysis' };
}

function tierFrom(aboveContext, t) {
  return { aboveContext, input: num(t.input), output: num(t.output), cacheRead: num(t.cache_read), cacheWrite: num(t.cache_write) };
}

// models.dev cost (USD per million tokens) → Entry.cost, or null when unpriced.
function normalizeCost(cost) {
  if (!isPlainObject(cost)) return null;
  const tiers = [];
  if (Array.isArray(cost.tiers)) {
    for (const t of cost.tiers) {
      if (!isPlainObject(t) || t.tier?.type !== 'context' || num(t.tier?.size) === null) continue;
      tiers.push(tierFrom(t.tier.size, t));
    }
  } else if (isPlainObject(cost.context_over_200k)) {
    tiers.push(tierFrom(200000, cost.context_over_200k));
  }
  tiers.sort((a, b) => a.aboveContext - b.aboveContext);
  return {
    input: num(cost.input),
    output: num(cost.output),
    cacheRead: num(cost.cache_read),
    cacheWrite: num(cost.cache_write),
    reasoning: num(cost.reasoning),
    tiers
  };
}

function effortsOf(options) {
  if (!Array.isArray(options)) return [];
  const effort = options.find((o) => isPlainObject(o) && o.type === 'effort' && Array.isArray(o.values));
  return effort ? effort.values.filter((v) => typeof v === 'string') : [];
}

// One models.dev model → Entry. `raw` needs at least an id.
function normalizeModel(provider, raw) {
  const id = String(raw.id);
  const limit = isPlainObject(raw.limit) ? raw.limit : {};
  const modalities = isPlainObject(raw.modalities) ? raw.modalities : {};
  return {
    provider,
    id,
    name: str(raw.name) || id,
    family: str(raw.family),
    releaseDate: str(raw.release_date),
    knowledge: str(raw.knowledge),
    limits: { context: num(limit.context), input: num(limit.input), output: num(limit.output) },
    input: strList(modalities.input, ['text']),
    output: strList(modalities.output, ['text']),
    toolCall: raw.tool_call === true,
    structuredOutput: raw.structured_output === true,
    reasoning: { supported: raw.reasoning === true, efforts: effortsOf(raw.reasoning_options) },
    openWeights: raw.open_weights === true,
    local: false,
    cost: normalizeCost(raw.cost),
    scores: emptyScores(),
    sources: []
  };
}

// models.dev api.json (or a trimmed copy of it) → Entry[] for King Louie's providers.
function normalizeModelsDev(data) {
  const out = [];
  if (!isPlainObject(data)) return out;
  for (const provider of KL_PROVIDERS) {
    const block = data[modelsDevIdFor(provider)];
    if (!isPlainObject(block) || !isPlainObject(block.models)) continue;
    for (const [key, raw] of Object.entries(block.models)) {
      if (!isPlainObject(raw)) continue;
      out.push(normalizeModel(provider, { ...raw, id: str(raw.id) || key }));
    }
  }
  return out;
}

// True when the document looks like models.dev: at least one of King Louie's
// providers with a models map.
function validateModelsDev(data) {
  if (!isPlainObject(data)) return false;
  return KL_PROVIDERS.some((p) => {
    const block = data[modelsDevIdFor(p)];
    return isPlainObject(block) && isPlainObject(block.models);
  });
}

// Keep only King Louie's 14 providers (about 450 KB of the 4.9 MB document).
function trimModelsDev(data) {
  const out = {};
  for (const p of KL_PROVIDERS) {
    const id = modelsDevIdFor(p);
    if (isPlainObject(data?.[id])) out[id] = data[id];
  }
  return out;
}

// OpenRouter /api/v1/models → { "<vendor>/<id>": { intelligence, coding, agentic } }
// with lowercase keys. Only benchmarks.artificial_analysis is kept; variants
// such as ":batch" are skipped.
function normalizeScores(json) {
  const out = {};
  const list = Array.isArray(json?.data) ? json.data : [];
  for (const m of list) {
    if (!isPlainObject(m) || typeof m.id !== 'string' || m.id.includes(':')) continue;
    const aa = m.benchmarks?.artificial_analysis;
    if (!isPlainObject(aa)) continue;
    const s = { intelligence: num(aa.intelligence_index), coding: num(aa.coding_index), agentic: num(aa.agentic_index) };
    if (s.intelligence === null && s.coding === null && s.agentic === null) continue;
    out[m.id.toLowerCase()] = s;
  }
  return out;
}

function validateScores(json) {
  return isPlainObject(json) && Array.isArray(json.data);
}

// OpenRouter ids write versions with dots where vendors use hyphens
// (claude-sonnet-4.5 against claude-sonnet-4-5); the index holds both.
const dotless = (key) => key.replace(/\./g, '-');

function buildScoreIndex(scores) {
  const index = new Map();
  for (const [key, value] of Object.entries(scores || {})) {
    const k = key.toLowerCase();
    index.set(k, value);
    if (!index.has(dotless(k))) index.set(dotless(k), value);
  }
  return index;
}

// Scores for one entry: OpenRouter's own entries by id, a vendor's by
// "<vendor>/<id>", each exact and then without a date suffix.
function scoreFor(index, provider, id) {
  const lower = String(id || '').toLowerCase();
  const ids = [...new Set([lower, stripDateSuffix(lower)])];
  let keys = [];
  if (provider === 'openrouter') keys = ids;
  else if (OPENROUTER_VENDORS[provider]) keys = ids.map((i) => `${OPENROUTER_VENDORS[provider]}/${i}`);
  for (const k of keys) {
    const hit = index.get(k) || index.get(dotless(k));
    if (hit) return hit;
  }
  return null;
}

// A model a local server reports (Ollama): zero cost, capabilities as reported.
function localEntry(provider, { id, name = null, context = null, toolCall = null, imageInput = false }) {
  return {
    provider,
    id: String(id),
    name: str(name) || String(id),
    family: null,
    releaseDate: null,
    knowledge: null,
    limits: { context: num(context), input: null, output: null },
    input: imageInput ? ['text', 'image'] : ['text'],
    output: ['text'],
    toolCall: toolCall === true,
    structuredOutput: false,
    reasoning: { supported: false, efforts: [] },
    openWeights: true,
    local: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, tiers: [] },
    scores: emptyScores(),
    sources: []
  };
}

module.exports = {
  isPlainObject,
  stripDateSuffix,
  entryKey,
  emptyScores,
  normalizeCost,
  normalizeModel,
  normalizeModelsDev,
  validateModelsDev,
  trimModelsDev,
  normalizeScores,
  validateScores,
  buildScoreIndex,
  scoreFor,
  localEntry
};

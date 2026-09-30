'use strict';
// Cached model calls (benchmark spec §11: model outputs are cached by request
// hash, so a rerun with the same config costs nothing and a report can be
// regenerated). One JSON file per call under
// LONGHAUL_HOME/private/model-cache/<stage>/<key[0..1]>/<key>.json, written
// atomically once the call returns. A run cut off mid-way resumes: every call
// that finished is a hit, and only a call in flight when it stopped is made
// again. Entries hold model text (answers, verdict reasons, summaries of
// private sessions), so the cache is shared by every run but lives under
// private/, not runs/<id>/, and nothing here logs text.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, sha256Text } = require('./files');
const { withRetries } = require('./retry');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/model-cache');
const STAGES = Object.freeze(['answer', 'judge', 'summary']);
const CACHE_VERSION = 1;
const KEY_RE = /^[0-9a-f]{64}$/;
const NO_HOOKS = Object.freeze({ beforeCall: () => 0, afterCall: () => {}, cancel: () => {} });

// JSON with object keys sorted at every level and undefined values dropped,
// so a key never depends on the order its parts were written in.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function cacheKey(parts) {
  return sha256Text(stableStringify({ cacheVersion: CACHE_VERSION, ...parts }));
}

class ModelCache {
  constructor(root) {
    this.root = root;
  }

  static forHome(home) {
    return new ModelCache(path.join(home.private, 'model-cache'));
  }

  file(stage, key) {
    if (!STAGES.includes(stage)) throw new Error(`unknown model-cache stage ${JSON.stringify(stage)}`);
    if (!KEY_RE.test(String(key))) throw new Error('a model-cache key is a SHA-256 hex digest');
    return path.join(this.root, stage, key.slice(0, 2), `${key}.json`);
  }

  get(stage, key) {
    const file = this.file(stage, key);
    if (!fs.existsSync(file)) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      return entry && entry.key === key && typeof entry.text === 'string' ? entry : null;
    } catch {
      log.warn('unreadable model-cache entry; the call is made again', { stage });
      return null;
    }
  }

  put(stage, key, entry) {
    writeFileAtomic(this.file(stage, key), `${JSON.stringify({ ...entry, stage, key })}\n`);
  }
}

// One call's usage: tokens as the provider reported them and the catalog
// cost from llmMetrics, null where unknown (an unpriced model is never $0).
function usageFromMetrics(m) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!m) return { inputTokens: null, outputTokens: null, costUsd: null };
  return { inputTokens: num(m.inputTokens), outputTokens: num(m.outputTokens), costUsd: num(m.costUsd) };
}

const resultOf = (entry, cached) => ({
  text: entry.text,
  inputTokens: entry.inputTokens ?? null,
  outputTokens: entry.outputTokens ?? null,
  costUsd: entry.costUsd ?? null,
  latencyMs: entry.latencyMs ?? null,
  cached
});

// One model call through the cache. A hit spends nothing and returns what
// the reply cost when it was made (a report's cost is what the result cost
// to produce; spend.json has what this run paid). A miss asks the hooks
// (the spend guard) first, retries 429/5xx/transport failures, then stores
// the reply before returning it.
async function cachedCall({ cache, stage, key, client, prompt, maxTokens, hooks = NO_HOOKS, retry = {}, meta = {}, clock = () => Date.now() }) {
  const hit = cache.get(stage, key);
  if (hit) return resultOf(hit, true);
  const ticket = hooks.beforeCall({ stage, client, promptChars: prompt.length, maxTokens });
  const t0 = clock();
  let reply;
  try {
    reply = await withRetries(() => client.complete(prompt, { maxTokens }), retry);
  } catch (err) {
    hooks.cancel(ticket);
    throw err;
  }
  const entry = {
    text: String(reply?.text ?? ''),
    ...usageFromMetrics(reply?.llmMetrics),
    latencyMs: clock() - t0,
    provider: client.provider,
    model: client.model,
    maxTokens,
    meta
  };
  cache.put(stage, key, entry);
  hooks.afterCall(ticket, entry);
  return resultOf(entry, false);
}

module.exports = { STAGES, ModelCache, cacheKey, stableStringify, usageFromMetrics, cachedCall };

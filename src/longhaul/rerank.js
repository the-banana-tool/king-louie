'use strict';
// Reranker for the H3 probe (kl-recall-rerank; recall spec §6.3 step 6). A
// local cross-encoder scores (query, chunk text) pairs on the CPU; scores are
// cached under LONGHAUL_HOME/private/rerank/<sessionId>/<model>/, never
// anywhere else, so a sweep over topM or settings is free after its first
// pass:
//   scores.jsonl  one { q, m, i, h, s } per pair: question id, chunk
//                 messageId and idx, a hash of the exact query and chunk
//                 text scored, and the score
// The hash means a changed question, query (queryUserTurns) or chunk text is
// a miss, never a stale score. The cross-encoder needs
// @huggingface/transformers with the native onnxruntime-node, which are not
// dependencies of the app: install them in a checkout with
//   npm i --no-save @huggingface/transformers onnxruntime-node
const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { sha256Text } = require('./files');
const { UsageError } = require('./errors');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/rerank');

const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const MODEL_RE = /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})?$/;

function rerankCacheDir(privateRoot, sessionId, model) {
  if (!MODEL_RE.test(String(model || '')) || String(model).split('/').some((seg) => /^\.+$/.test(seg))) throw new UsageError(`rerank model must be a plain id (org/name), got ${JSON.stringify(model)}`);
  return path.join(privateRoot, 'rerank', sessionId, String(model).replace(/\//g, '__'));
}

const pairHash = (query, text) => sha256Text(`${query}\u0000${text}`).slice(0, 16);
const keyOf = (q, m, i, h) => `${q}\u0000${m}\u0000${i}\u0000${h}`;

class RerankCache {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'scores.jsonl');
    this.scores = new Map();
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (Number.isFinite(r.s)) this.scores.set(keyOf(r.q, r.m, r.i, r.h), r.s);
        } catch { /* a line cut off by an interrupted run */ }
      }
    }
  }

  static open(dir) {
    return new RerankCache(dir);
  }

  get size() { return this.scores.size; }

  get(questionId, chunk, hash) {
    return this.scores.get(keyOf(questionId, chunk.messageId, chunk.idx, hash));
  }

  // Appends one batch; the in-memory map is updated with it.
  add(rows) {
    if (!rows.length) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    for (const r of rows) this.scores.set(keyOf(r.q, r.m, r.i, r.h), r.s);
  }
}

// The cross-encoder: { model, score(query, texts) => number[] } (raw logits,
// higher is more relevant). Texts are scored in batches sorted by length so
// a batch pads to similar lengths; results come back in the given order.
async function loadCrossEncoder({ model = DEFAULT_RERANK_MODEL, batchSize = 16, maxLength = 512, load = null } = {}) {
  let T;
  try {
    T = load ? load() : require('@huggingface/transformers');
  } catch (err) {
    throw new UsageError('kl-recall-rerank needs @huggingface/transformers and onnxruntime-node, which the app does not ship: '
      + `npm i --no-save @huggingface/transformers onnxruntime-node (${err.code || err.message})`);
  }
  const t0 = performance.now();
  const tokenizer = await T.AutoTokenizer.from_pretrained(model);
  const net = await T.AutoModelForSequenceClassification.from_pretrained(model, { dtype: 'fp32', device: 'cpu' });
  log.info('cross-encoder loaded', { model, ms: Math.round(performance.now() - t0) });
  return {
    model,
    async score(query, texts) {
      const order = texts.map((t, i) => i).sort((a, b) => texts[a].length - texts[b].length);
      const out = new Array(texts.length);
      for (let b = 0; b < order.length; b += batchSize) {
        const idx = order.slice(b, b + batchSize);
        const inputs = tokenizer(new Array(idx.length).fill(query), {
          text_pair: idx.map((i) => texts[i]), padding: true, truncation: true, max_length: maxLength
        });
        const { logits } = await net(inputs);
        const data = logits.data;
        const width = data.length / idx.length;
        idx.forEach((i, k) => { out[i] = Number(data[k * width]); });
      }
      return out;
    }
  };
}

// The Retriever's reranker callback for one question: cached scores first,
// the rest from the scorer in one call, then cached. stats (optional)
// counts pairs, hits, misses and the scorer's wall time on misses.
function createCachedReranker({ cache, questionId, scorer, stats = null }) {
  return async (query, chunks) => {
    const hashes = chunks.map((c) => pairHash(query, c.text));
    const scores = chunks.map((c, i) => cache.get(questionId, c, hashes[i]));
    const todo = scores.map((s, i) => (s === undefined ? i : -1)).filter((i) => i >= 0);
    if (stats) { stats.pairs += chunks.length; stats.hits += chunks.length - todo.length; }
    if (todo.length) {
      const s = typeof scorer === 'function' ? await scorer() : scorer;
      const t0 = performance.now();
      const fresh = await s.score(query, todo.map((i) => chunks[i].text));
      const ms = performance.now() - t0;
      if (stats) { stats.misses += todo.length; stats.missMs += ms; stats.calls += 1; }
      const rows = todo.map((i, k) => ({ q: questionId, m: chunks[i].messageId, i: chunks[i].idx, h: hashes[i], s: fresh[k] }));
      cache.add(rows.filter((r) => Number.isFinite(r.s)));
      todo.forEach((i, k) => { scores[i] = fresh[k]; });
    }
    return scores;
  };
}

const newRerankStats = () => ({ pairs: 0, hits: 0, misses: 0, missMs: 0, calls: 0 });

module.exports = {
  DEFAULT_RERANK_MODEL, rerankCacheDir, pairHash, RerankCache, loadCrossEncoder, createCachedReranker, newRerankStats
};

'use strict';
// Reranker for the H3 probe (kl-recall-rerank; recall spec §6.3 step 6). The
// app's own cross-encoder, in the embed worker (src/history/embed-runner.js),
// scores (query, chunk text) pairs on the CPU; scores are
// cached under LONGHAUL_HOME/private/rerank/<sessionId>/<model>/, never
// anywhere else, so a sweep over topM or settings is free after its first
// pass:
//   scores.jsonl  one { q, m, i, h, s } per pair: question id, chunk
//                 messageId and idx, a hash of the exact query and chunk
//                 text scored, and the score
// The hash means a changed question, query (queryUserTurns) or chunk text is
// a miss, never a stale score. The model is downloaded once into
// LONGHAUL_HOME/private/models (embeddings.js localModelsDir).
const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { sha256Text } = require('./files');
const { UsageError } = require('./errors');

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

// The cross-encoder the app ships (recall stage H3), in the embed worker
// through an EmbedRunner: loaded once, then each score() call reranks.
function createRunnerScorer({ runner, model = DEFAULT_RERANK_MODEL, modelsDir }) {
  let loading = null;
  return {
    model,
    async score(query, texts) {
      if (!loading) {
        loading = runner.load('reranker', model, { modelsDir }).catch((err) => {
          loading = null;
          throw err;
        });
      }
      await loading;
      return runner.rerank(model, query, texts);
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
  DEFAULT_RERANK_MODEL, rerankCacheDir, pairHash, RerankCache, createRunnerScorer, createCachedReranker, newRerankStats
};

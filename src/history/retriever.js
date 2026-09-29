// src/history/retriever.js
// Retrieval: the ranking step inside recall (CONTEXT.md). Stage H2 runs
// spec §6.3 steps 1 (BM25), 3 with one signal, 4 (kind weight), 5
// (recency), 7 (exact-text dedupe) and 8 (per-message cap, token budget).
// H3 adds a vector list to _fuse, the rerank and the cosine dedupe; the
// signature of retrieve() stays the same.
const { HISTORY_DEFAULTS } = require('./settings');

const DAY_MS = 86400000;

class Retriever {
  constructor({ store, estimator }) {
    this.store = store;
    this.estimator = estimator;
  }

  // Step 1: BM25 over the scope, ranks 1-based.
  _lexical({ query, chatIds, kinds, upToSeq, settings }) {
    return this.store
      .searchText(query, { chatIds, kinds, limit: settings.bm25TopK, upToSeq })
      .map((hit, i) => ({ chunkId: hit.chunkId, bm25Rank: i + 1 }));
  }

  // Step 3 with one signal: that signal's ranks alone, 1 / (rrfK + rank).
  _fuse(lexical, settings) {
    return lexical.map((hit) => ({ ...hit, fused: 1 / (settings.rrfK + hit.bm25Rank) }));
  }

  async retrieve({
    query, chatIds, kinds = null, excludeMessageIds = [], budgetTokens = null, upToSeq = null,
    settings, model = null, now = Date.now()
  } = {}) {
    const s = settings || HISTORY_DEFAULTS.recall;
    if (!String(query || '').trim()) return [];
    const fused = this._fuse(this._lexical({ query, chatIds, kinds, upToSeq, settings: s }), s);
    if (!fused.length) return [];

    const byId = new Map(this.store.chunks(fused.map((h) => h.chunkId)).map((c) => [c.id, c]));
    const excluded = new Set(excludeMessageIds || []);
    const nowMs = typeof now === 'number' ? now : Date.parse(now);
    const scored = [];
    for (const hit of fused) {
      const chunk = byId.get(hit.chunkId);
      if (!chunk || excluded.has(chunk.messageId)) continue;
      // Step 4: kind weight.
      const kindWeight = Number.isFinite(s.kindWeights[chunk.kind]) ? s.kindWeights[chunk.kind] : 1;
      // Step 5: recency, (1 - w) + w · exp(-age / halfLife).
      const ts = Date.parse(chunk.ts);
      const ageDays = Number.isFinite(ts) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - ts) / DAY_MS) : 0;
      const recency = (1 - s.recencyWeight) + s.recencyWeight * Math.exp(-ageDays / s.recencyHalfLifeDays);
      scored.push({
        chunk,
        score: hit.fused * kindWeight * recency,
        signals: { bm25Rank: hit.bm25Rank, vectorRank: null, rerank: null, recency, kindWeight }
      });
    }
    scored.sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);

    // Step 7: without vectors, drop exact text duplicates.
    const seen = new Set();
    const deduped = scored.filter((item) => {
      const key = item.chunk.text.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Step 8: per-message cap, then the token budget when one is given.
    const perMessage = new Map();
    const out = [];
    let used = 0;
    for (const item of deduped) {
      const count = perMessage.get(item.chunk.messageId) || 0;
      if (count >= s.maxChunksPerMessage) continue;
      if (budgetTokens !== null && budgetTokens !== undefined) {
        const tokens = this.estimator.estimate(item.chunk.text, model);
        if (used + tokens > budgetTokens) continue;
        used += tokens;
      }
      perMessage.set(item.chunk.messageId, count + 1);
      out.push(item);
    }
    return out;
  }
}

module.exports = { Retriever };

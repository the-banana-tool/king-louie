// src/history/retriever.js
// Retrieval: the ranking step inside recall (CONTEXT.md). Spec §6.3 steps 1
// (BM25), 2 (a vector list, when one is given), 3 (fusion), 4 (kind weight),
// 5 (recency), 7 (exact-text dedupe) and 8 (per-message cap, token budget).
// stats (optional object) gets exactDuplicates, nearDuplicates and
// nearDuplicateTokens (candidates dropped by dedupeJaccard that would have
// fit). Step 2 takes the vector ranks from the caller (vectorHits) or from the
// vectorSearch callback; H3 adds the embedder behind that callback, the
// rerank and the cosine dedupe. The signature of retrieve() stays the same.
const { HISTORY_DEFAULTS } = require('./settings');

const DAY_MS = 86400000;
const rankOf = (hit) => (Number.isFinite(hit.bm25Rank) ? hit.bm25Rank : hit.vectorRank);
const SHINGLE_WORDS = 5;

// Word 5-gram shingles of a text (lowercased letters and digits); a text of
// fewer than five words is one shingle of all its words.
function wordShingles(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const out = new Set();
  if (words.length < SHINGLE_WORDS) {
    if (words.length) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) out.add(words.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}

function jaccardOf(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const x of small) if (large.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
}

class Retriever {
  // vectorSearch (optional): async ({ query, chatIds, kinds, upToSeq,
  // settings }) => [{ chunkId, vectorRank }], ranks 1-based.
  constructor({ store, estimator, vectorSearch = null }) {
    this.store = store;
    this.estimator = estimator;
    this.vectorSearch = typeof vectorSearch === 'function' ? vectorSearch : null;
  }

  // Step 1: BM25 over the scope, ranks 1-based.
  _lexical({ query, chatIds, kinds, upToSeq, settings }) {
    return this.store
      .searchText(query, { chatIds, kinds, limit: settings.bm25TopK, upToSeq, prefixMinChars: settings.prefixMinChars })
      .map((hit, i) => ({ chunkId: hit.chunkId, bm25Rank: i + 1 }));
  }

  // Step 2: the vector list, at most vectorTopK, ranked 1-based in the order
  // given when a hit carries no vectorRank of its own.
  _vector(vectorHits, settings) {
    if (!Array.isArray(vectorHits)) return [];
    return vectorHits
      .filter((h) => h && Number.isInteger(h.chunkId))
      .slice(0, settings.vectorTopK)
      .map((h, i) => ({ chunkId: h.chunkId, vectorRank: Number.isFinite(h.vectorRank) && h.vectorRank > 0 ? h.vectorRank : i + 1 }));
  }

  // Step 3: reciprocal rank fusion over every list (one BM25 list per query
  // text, plus the vector list): score = sum of 1 / (rrfK + rank). With one
  // list, its ranks alone. A chunk keeps its best rank on each signal.
  _fuse(lists, settings) {
    const byId = new Map();
    for (const list of lists) {
      for (const hit of list) {
        const cur = byId.get(hit.chunkId) || { chunkId: hit.chunkId, bm25Rank: null, vectorRank: null, fused: 0 };
        cur.fused += 1 / (settings.rrfK + rankOf(hit));
        for (const key of ['bm25Rank', 'vectorRank']) {
          if (Number.isFinite(hit[key])) cur[key] = cur[key] === null ? hit[key] : Math.min(cur[key], hit[key]);
        }
        byId.set(hit.chunkId, cur);
      }
    }
    const best = (h) => Math.min(h.bm25Rank ?? Infinity, h.vectorRank ?? Infinity);
    return [...byId.values()].sort((a, b) => b.fused - a.fused || best(a) - best(b));
  }

  async retrieve({
    query, contextQueries = [], chatIds, kinds = null, excludeMessageIds = [], budgetTokens = null, upToSeq = null,
    settings, model = null, now = Date.now(), vectorHits = null, lexical = true, stats = null
  } = {}) {
    const s = { ...HISTORY_DEFAULTS.recall, ...(settings || {}) };
    if (!String(query || '').trim()) return [];
    const texts = [query, ...(contextQueries || [])].filter((t) => String(t || '').trim());
    // lexical: false leaves BM25 out (a vector-only probe; LongHaul).
    const lists = lexical === false ? [] : texts.map((text) => this._lexical({ query: text, chatIds, kinds, upToSeq, settings: s }));
    let vectors = vectorHits;
    if (!Array.isArray(vectors) && this.vectorSearch) vectors = await this.vectorSearch({ query, chatIds, kinds, upToSeq, settings: s });
    const vectorList = this._vector(vectors, s);
    if (vectorList.length) lists.push(vectorList);
    const fused = this._fuse(lists, s);
    if (!fused.length) return [];

    const byId = new Map(this.store.chunks(fused.map((h) => h.chunkId)).map((c) => [c.id, c]));
    const excluded = new Set(excludeMessageIds || []);
    // A vector list comes from outside the store's own filters: hold every
    // hit to the scope, the kinds and upToSeq here (BM25 hits already are).
    const chatScope = Array.isArray(chatIds) && chatIds.length ? new Set(chatIds.map(String)) : null;
    const kindScope = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(String)) : null;
    const inScope = (chunk) => (!chatScope || chatScope.has(chunk.chatId))
      && (!kindScope || kindScope.has(chunk.kind))
      && (!Number.isInteger(upToSeq) || chunk.seq < upToSeq);
    const nowMs = typeof now === 'number' ? now : Date.parse(now);
    const scored = [];
    for (const hit of fused) {
      const chunk = byId.get(hit.chunkId);
      if (!chunk || excluded.has(chunk.messageId) || !inScope(chunk)) continue;
      // Step 4: kind weight.
      const kindWeight = Number.isFinite(s.kindWeights[chunk.kind]) ? s.kindWeights[chunk.kind] : 1;
      // Step 5: recency, (1 - w) + w · exp(-age / halfLife).
      const ts = Date.parse(chunk.ts);
      const ageDays = Number.isFinite(ts) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - ts) / DAY_MS) : 0;
      const recency = (1 - s.recencyWeight) + s.recencyWeight * Math.exp(-ageDays / s.recencyHalfLifeDays);
      scored.push({
        chunk,
        score: hit.fused * kindWeight * recency,
        signals: { bm25Rank: hit.bm25Rank, vectorRank: hit.vectorRank, rerank: null, recency, kindWeight }
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
    // completeMessageTokens > 0: the first hit on a message whose whole text
    // is at most that many tokens brings the message's other chunks with it
    // (a fact rarely sits in the one chunk the query's words landed in), when
    // they fit the budget; a longer message keeps chunk-by-chunk selection.
    const hasBudget = budgetTokens !== null && budgetTokens !== undefined;
    const perMessage = new Map();
    const considered = new Set();
    const taken = new Set();
    const dropped = new Set();
    const out = [];
    let used = 0;
    // dedupeJaccard > 0 (step 7 without vectors, beyond exact text): a
    // candidate whose word 5-gram Jaccard to a selected chunk exceeds it is
    // dropped. Agent sessions repeat tool output (a file read twice).
    const jaccard = s.dedupeJaccard > 0 ? s.dedupeJaccard : 0;
    const selectedShingles = [];
    const shingleCache = new Map();
    const shinglesOf = (chunk) => {
      if (!shingleCache.has(chunk.id)) shingleCache.set(chunk.id, wordShingles(chunk.text));
      return shingleCache.get(chunk.id);
    };
    const remember = (chunk) => { if (jaccard) selectedShingles.push(shinglesOf(chunk)); };
    const nearDuplicate = (chunk) => {
      if (!jaccard) return false;
      const own = shinglesOf(chunk);
      return selectedShingles.some((other) => jaccardOf(own, other) > jaccard);
    };
    let nearDuplicates = 0;
    let nearDuplicateTokens = 0;
    const drop = (item, tokens) => {
      dropped.add(item.chunk.id);
      nearDuplicates += 1;
      nearDuplicateTokens += tokens;
    };
    // pairToolMessages: a tool call and its result are one exchange; the
    // call names what was done, the result holds what came back, and a
    // question about it usually matches only the call. Taking a small
    // message whole also takes its small partner.
    const tokensOf = (chunks) => chunks.reduce((sum, c) => sum + this.estimator.estimate(c.text, model), 0);
    const takeWhole = (chunks, item, why) => {
      for (const c of chunks) {
        taken.add(c.id);
        remember(c);
        out.push({ chunk: c, score: item.score, signals: { ...item.signals, [why]: true } });
      }
      perMessage.set(chunks[0].messageId, chunks.length);
    };
    const consider = (item) => {
      const messageId = item.chunk.messageId;
      if (taken.has(item.chunk.id) || dropped.has(item.chunk.id)) return;
      if (s.completeMessageTokens > 0 && !considered.has(messageId)) {
        considered.add(messageId);
        const all = this.store.chunksOfMessage(messageId);
        const total = tokensOf(all);
        const partnerId = s.pairToolMessages && !excluded.has(messageId) ? this.store.pairedToolMessageId(messageId) : null;
        const partner = partnerId && !considered.has(partnerId) && !excluded.has(partnerId) ? this.store.chunksOfMessage(partnerId) : [];
        const partnerTotal = tokensOf(partner);
        const wholeFits = total <= s.completeMessageTokens && (!hasBudget || used + total <= budgetTokens);
        if (wholeFits && (all.length > 1 || partner.length)) {
          if (nearDuplicate(item.chunk)) {
            drop(item, this.estimator.estimate(item.chunk.text, model));
            return;
          }
          takeWhole(all, item, 'completed');
          used += total;
          if (partner.length && partnerTotal <= s.completeMessageTokens && (!hasBudget || used + partnerTotal <= budgetTokens)) {
            considered.add(partnerId);
            takeWhole(partner, item, 'paired');
            used += partnerTotal;
          }
          return;
        }
      }
      const count = perMessage.get(messageId) || 0;
      if (count >= s.maxChunksPerMessage) return;
      const tokens = this.estimator.estimate(item.chunk.text, model);
      if (hasBudget && used + tokens > budgetTokens) return;
      if (nearDuplicate(item.chunk)) {
        drop(item, tokens);
        return;
      }
      used += tokens;
      perMessage.set(messageId, count + 1);
      taken.add(item.chunk.id);
      remember(item.chunk);
      out.push(item);
    };
    // diversifyFirst: a first pass takes the best chunk of each distinct
    // message in score order, then the rest fill by score, so the budget
    // spreads over more messages before any one gets a second chunk.
    if (s.diversifyFirst) {
      for (const item of deduped) if (!perMessage.get(item.chunk.messageId)) consider(item);
    }
    for (const item of deduped) consider(item);
    if (stats && typeof stats === 'object') {
      stats.exactDuplicates = scored.length - deduped.length;
      stats.nearDuplicates = nearDuplicates;
      stats.nearDuplicateTokens = nearDuplicateTokens;
    }
    return out;
  }
}

module.exports = { Retriever };

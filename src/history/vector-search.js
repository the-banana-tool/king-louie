// src/history/vector-search.js
// Spec §6.3 step 2 for the app: the turn's query embedded (kind 'query') by
// the host's embedder, then cosine top vectorTopK over the chats in scope
// from the VectorIndex. It never slows a turn by more than queryTimeoutMs
// and never throws: with no ready embedder, a slow or failed query embedding,
// a store error while loading vectors, or every chat in scope over the vector
// cache cap, the turn runs on BM25 alone, stats.embedder is 'none' and
// stats.vectorsSkipped says why (provenance, the recall line). A query that
// failed for a reason other than the worker crashing, a model switch or a
// shutdown is reported to the host (host.fail) under the embedder's key.
//
// A private chat in scope (keepLocal 'private-chat', local inference spec
// 2026-10-13 §8.4, R-LI-25): the egress rule for a private chat's text
// covers the query too. It is embedded by the local embedder in the embed
// worker (host.keepLocal(): the active one when it is local, else the
// keep-local embedder) and searched under that key, or not embedded at all
// (vectorsSkipped 'private-chat', BM25 only). A turn never starts the
// keep-local embedder; the indexer does. Any keepLocal other than null and
// 'imported-chat' is read as private. An imported chat that is not private
// keeps the active embedder (the open H4 item).
const { WORKER_FAILURES, NOT_FAILURES } = require('./embed-errors');
const { createLogger } = require('../logging');

// A query waits at most one document slice in the worker (EmbedRunner's
// DOC_SLICE, about 0.8 s at bge-small's measured 102 ms a chunk) plus its
// own embedding.
const QUERY_TIMEOUT_MS = 1500;
const TIMED_OUT = Symbol('query embedding timed out');
const OVER_CAP = 'this chat has more vectors than history.recall.vectorCacheMb holds';
const PRIVATE_CHAT = 'private-chat';

function createVectorSearch({ host, index, queryTimeoutMs = QUERY_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, log = createLogger('history/vector-search') }) {
  async function vectorSearch({ query, chatIds, kinds = null, upToSeq = null, upToSeqChatId = null, settings, stats = null, keepLocal = null }) {
    const note = (reason) => {
      if (stats) {
        stats.embedder = 'none';
        stats.vectorsSkipped = reason;
      }
      return [];
    };
    const kept = keepLocal !== null && keepLocal !== undefined && keepLocal !== 'imported-chat';
    let embedder;
    if (kept) {
      embedder = typeof host.keepLocal === 'function' ? host.keepLocal() : null;
      if (!embedder || typeof embedder.name !== 'string' || !embedder.name.startsWith('local:')) return note(PRIVATE_CHAT);
    } else {
      embedder = host.current();
      if (!embedder) return note(host.reason());
    }
    let timer = null;
    let vecs;
    try {
      vecs = await Promise.race([
        embedder.embed([String(query)], { kind: 'query' }),
        new Promise((resolve) => { timer = setTimer(resolve, queryTimeoutMs, TIMED_OUT); })
      ]);
    } catch (err) {
      if (!WORKER_FAILURES.has(err.code) && !NOT_FAILURES.has(err.code)) host.fail(err, embedder.name);
      return note(`the query could not be embedded (${err.message})`);
    } finally {
      clearTimer(timer);
    }
    if (vecs === TIMED_OUT) return note('the query embedding was too slow this turn');
    let hits;
    let over;
    try {
      hits = index.search({ model: embedder.name, query: vecs[0], chatIds, kinds, upToSeq, upToSeqChatId, k: settings.vectorTopK });
      over = (chatIds || []).filter((id) => index.skipped(embedder.name, id));
    } catch (err) {
      log.warn(`Vector search failed this turn; keyword search only: ${err.message}`);
      return note(`the vectors could not be read (${err.message})`);
    }
    // Every chat in scope over the cap: the key was not used this turn.
    if (over.length && over.length === chatIds.length) return note(OVER_CAP);
    if (stats) {
      stats.embedder = embedder.name;
      stats.vectorsSkipped = over.length ? OVER_CAP : null;
    }
    return hits;
  }

  // Only from matrices already loaded, for the active key.
  const vectorOf = (chunk) => {
    const e = host.current();
    return e ? index.vectorOf(e.name, chunk) : null;
  };

  return { vectorSearch, vectorOf };
}

module.exports = { createVectorSearch, QUERY_TIMEOUT_MS };

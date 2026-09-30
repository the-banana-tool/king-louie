// src/history/vector-search.js
// Spec §6.3 step 2 for the app: the turn's query embedded (kind 'query') by
// the host's embedder, then cosine top vectorTopK over the chats in scope
// from the VectorIndex. It never slows a turn by more than queryTimeoutMs
// and never throws: with no ready embedder, a slow or failed query embedding,
// or a chat over the vector cache cap, the turn runs on BM25 alone and stats
// says why (provenance, the recall line). A query that failed for a reason
// other than the worker crashing is reported to the host (host.fail).
const { WORKER_FAILURES } = require('./embed-errors');

// A query waits at most one document slice in the worker (EmbedRunner's
// DOC_SLICE, about 0.8 s at bge-small's measured 102 ms a chunk) plus its
// own embedding.
const QUERY_TIMEOUT_MS = 1500;
const TIMED_OUT = Symbol('query embedding timed out');

function createVectorSearch({ host, index, queryTimeoutMs = QUERY_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  async function vectorSearch({ query, chatIds, kinds = null, upToSeq = null, settings, stats = null }) {
    const note = (reason) => {
      if (stats) {
        stats.embedder = 'none';
        stats.vectorsSkipped = reason;
      }
      return [];
    };
    const embedder = host.current();
    if (!embedder) return note(host.reason());
    let timer = null;
    let vecs;
    try {
      vecs = await Promise.race([
        embedder.embed([String(query)], { kind: 'query' }),
        new Promise((resolve) => { timer = setTimer(resolve, queryTimeoutMs, TIMED_OUT); })
      ]);
    } catch (err) {
      if (!WORKER_FAILURES.has(err.code) && err.code !== 'MODEL_CHANGED') host.fail(err);
      return note(`the query could not be embedded (${err.message})`);
    } finally {
      clearTimer(timer);
    }
    if (vecs === TIMED_OUT) return note('the query embedding was too slow this turn');
    const hits = index.search({ model: embedder.name, query: vecs[0], chatIds, kinds, upToSeq, k: settings.vectorTopK });
    const over = (chatIds || []).some((id) => index.skipped(embedder.name, id));
    if (stats) {
      stats.embedder = embedder.name;
      stats.vectorsSkipped = over ? 'this chat has more vectors than history.recall.vectorCacheMb holds' : null;
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

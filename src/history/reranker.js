// src/history/reranker.js
// The Retriever's reranker callback (recall spec §6.3 step 6) backed by the
// EmbedderHost's local cross-encoder in the embed worker. The Retriever races
// it against maxMs and keeps the fused order on a timeout or a failure; the
// same maxMs reaches the runner as a deadline, so it stops sending slices.
function createHostReranker(host) {
  return (query, chunks, { maxMs } = {}) => host.rerank(String(query), chunks.map((c) => String(c.text)), { maxMs });
}

module.exports = { createHostReranker };

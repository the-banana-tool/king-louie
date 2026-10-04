// src/history/reranker.js
// The Retriever's reranker callback (recall spec §6.3 step 6) backed by the
// EmbedderHost's local cross-encoder in the embed worker. The Retriever races
// it against maxMs and keeps the fused order on a timeout or a failure; the
// same maxMs reaches the runner as a deadline, so it stops sending slices.
// It names itself in info.name ('local:<model>') for provenance.
function createHostReranker(host) {
  return async (query, chunks, { maxMs, info } = {}) => {
    const model = typeof host.rerankModelName === 'function' ? host.rerankModelName() : null;
    const scores = await host.rerank(String(query), chunks.map((c) => String(c.text)), { maxMs });
    if (info && typeof info === 'object' && model) info.name = `local:${model}`;
    return scores;
  };
}

module.exports = { createHostReranker };

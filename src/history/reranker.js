// src/history/reranker.js
// The Retriever's reranker callback (recall spec §6.3 step 6) backed by the
// EmbedderHost's local cross-encoder in the embed worker. The Retriever races
// it against maxMs and keeps the fused order on a timeout or a failure; the
// same maxMs reaches the runner as a deadline, so it stops sending slices.
// It names itself in info.name ('local:<model>') for provenance.
const { mergeHistorySettings } = require('./settings');

function createHostReranker(host) {
  return async (query, chunks, { maxMs, info } = {}) => {
    const model = typeof host.rerankModelName === 'function' ? host.rerankModelName() : null;
    const scores = await host.rerank(String(query), chunks.map((c) => String(c.text)), { maxMs });
    if (info && typeof info === 'object' && model) info.name = `local:${model}`;
    return scores;
  };
}

// The reranker the Retriever and SearchHistory get (spec §6.3 step 6):
// rerank.kind 'jev' sends to typesafe.ai through the JevReranker, anything
// else runs the local cross-encoder. Read per call, so a saved switch
// applies to the next turn; a Jev failure keeps the fused order and never
// falls back to the cross-encoder.
function createRecallReranker({ host, jev, getSettings }) {
  const local = createHostReranker(host);
  return (query, chunks, options = {}) => {
    const { kind } = mergeHistorySettings((getSettings() || {}).history).recall.rerank;
    if (kind === 'jev' && jev) return jev.rerank(String(query), chunks.map((c) => String(c.text)), options);
    return local(query, chunks, options);
  };
}

module.exports = { createHostReranker, createRecallReranker };

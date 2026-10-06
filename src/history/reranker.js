// src/history/reranker.js
// The Retriever's reranker callback (recall spec §6.3 step 6) backed by the
// EmbedderHost's local cross-encoder in the embed worker. The Retriever races
// it against maxMs and keeps the fused order on a timeout or a failure; the
// same maxMs reaches the runner as a deadline, so it stops sending slices.
// It names itself in info.name ('local:<model>') for provenance.
const { mergeHistorySettings } = require('./settings');
const { EmbedError } = require('./embed-errors');

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
// falls back to the cross-encoder. A case chat (options.caseId, owner
// decision 2026-10-06) is never sent to Jev and not reranked at all: its
// private facts stay off third parties, as the cases outbound gate keeps
// them. RERANK_SKIPPED 'case-chat' tells the Retriever to keep the fused
// order without a warning.
function createRecallReranker({ host, jev, getSettings }) {
  const local = createHostReranker(host);
  return async (query, chunks, options = {}) => {
    const { kind } = mergeHistorySettings((getSettings() || {}).history).recall.rerank;
    if (kind === 'jev' && options && options.caseId) throw new EmbedError('RERANK_SKIPPED', 'case-chat');
    if (kind === 'jev' && jev) return jev.rerank(String(query), chunks.map((c) => String(c.text)), options);
    return local(query, chunks, options);
  };
}

// The case a chat belongs to, or null: what the dispatcher needs to keep a
// case chat away from Jev. Read from the store's chat row; a store without
// chats (or a chat it does not hold) is no case.
function caseIdOf(store, chatId) {
  if (!store || typeof store.getChat !== 'function' || !chatId) return null;
  const chat = store.getChat(String(chatId), { messages: false });
  return chat && chat.caseId ? String(chat.caseId) : null;
}

module.exports = { createHostReranker, createRecallReranker, caseIdOf };

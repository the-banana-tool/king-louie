// src/history/search.js
// Excerpts on demand: SearchHistory and history:search run retrieval
// without the budget step (spec §8); the recall line's drawer shows the
// excerpts one reply was given (§7).
const { formatExcerpts } = require('./excerpts');

async function searchHistoryExcerpts({ store, retriever, chatId, query, kinds = null, limit = 10, settings, asOf = Date.now() }) {
  const hits = await retriever.retrieve({ query, chatIds: [chatId], kinds, budgetTokens: null, settings, now: asOf });
  const chunks = hits.map((h) => h.chunk);
  const chunkCounts = store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
  return formatExcerpts(chunks, { chatId, asOf, chunkCounts, order: 'given' }).slice(0, limit);
}

function excerptsForMessage({ store, chatId, seq }) {
  const [message] = store.getMessages(chatId, { fromSeq: seq, toSeq: seq });
  const ids = message && message.context && Array.isArray(message.context.recalledChunkIds) ? message.context.recalledChunkIds : [];
  if (!ids.length) return [];
  const chunks = store.chunks(ids);
  // Aged as the model saw them, at the reply's own time.
  const asOf = Date.parse(message.timestamp || '') || Date.now();
  const chunkCounts = store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
  return formatExcerpts(chunks, { chatId, asOf, chunkCounts, order: 'seq' });
}

module.exports = { searchHistoryExcerpts, excerptsForMessage };

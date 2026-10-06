// src/history/search.js
// Excerpts on demand: SearchHistory and history:search run retrieval
// without the budget step (spec §8); the recall line's drawer shows the
// excerpts one reply was given (§7).
const { formatExcerpts } = require('./excerpts');
const { caseIdOf } = require('./reranker');
const { createLogger } = require('../logging');

const log = createLogger('history-search');

// SearchHistory reranks (spec §6.3 step 6, §6.7): the model is waiting on
// the tool anyway, so the cross-encoder's ~2 s at topM 100 is affordable
// here, under rerank.searchMaxMs, where it is not per turn. rerank.search
// false, or no reranker, leaves the fused order (or the per-turn opt-in).
async function searchHistoryExcerpts({ store, retriever, chatId, query, kinds = null, limit = 10, settings, asOf = Date.now(), reranker = null }) {
  const rr = settings && settings.rerank ? settings.rerank : null;
  const useRerank = Boolean(reranker && rr && rr.search);
  const s = useRerank ? { ...settings, rerank: { ...rr, enabled: true, maxMs: rr.searchMaxMs } } : settings;
  const hits = await retriever.retrieve({
    query, chatIds: [chatId], kinds, budgetTokens: null, settings: s, now: asOf, reranker: useRerank ? reranker : null,
    caseId: useRerank ? caseIdOf(store, chatId) : null
  });
  const chunks = hits.map((h) => h.chunk);
  const chunkCounts = store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
  return formatExcerpts(chunks, { chatId, asOf, chunkCounts, order: 'given' }).slice(0, limit);
}

function excerptsForMessage({ store, chatId, seq }) {
  const [message] = store.getMessages(chatId, { fromSeq: seq, toSeq: seq });
  const ids = message && message.context && Array.isArray(message.context.recalledChunkIds) ? message.context.recalledChunkIds : [];
  if (!ids.length) return [];
  // An imported reply, or one in a chat rewritten by replaceChat or
  // updateChat({ messages }), can carry ids that now name another chat's
  // chunks or a later message's: only this chat's chunks before the reply.
  const all = store.chunks(ids);
  const chunks = all.filter((c) => c.chatId === String(chatId) && c.seq < message.seq);
  if (chunks.length < all.length) log.debug(`Reply #${message.seq} in chat ${chatId}: ignored ${all.length - chunks.length} recalled chunk ids that no longer point before it in this chat`);
  // Aged as the model saw them, at the reply's own time.
  const asOf = Date.parse(message.timestamp || '') || Date.now();
  const chunkCounts = store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
  return formatExcerpts(chunks, { chatId, asOf, chunkCounts, order: 'seq' });
}

module.exports = { searchHistoryExcerpts, excerptsForMessage };

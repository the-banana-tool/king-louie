// src/history/search.js
// Excerpts on demand: SearchHistory and history:search run retrieval
// without the budget step (spec §8); the recall line's drawer shows the
// excerpts one reply was given (§7). history:excerpts then hides another
// chat's excerpt that the asking chat may no longer read.
const { formatExcerpts } = require('./excerpts');
const { caseIdOf, keepLocalReason } = require('./reranker');
const { createLogger } = require('../logging');

const log = createLogger('history-search');

// SearchHistory reranks (spec §6.3 step 6, §6.7): the model is waiting on
// the tool anyway, so the cross-encoder's ~2 s at topM 100 is affordable
// here, under rerank.searchMaxMs, where it is not per turn. rerank.search
// false, or no reranker, leaves the fused order (or the per-turn opt-in).
// chatIds: the chats to search (a history scope, stage H4; this chat first).
// Left out, or empty, it is this chat alone: an empty list never means every
// chat here. chatTitles names the other chats in their excerpts' headers.
async function searchHistoryExcerpts({ store, retriever, chatId, chatIds = null, chatTitles = new Map(), query, kinds = null, limit = 10, settings, asOf = Date.now(), reranker = null }) {
  const scope = Array.isArray(chatIds) && chatIds.length ? chatIds : [chatId];
  const rr = settings && settings.rerank ? settings.rerank : null;
  const useRerank = Boolean(reranker && rr && rr.search);
  const s = useRerank ? { ...settings, rerank: { ...rr, enabled: true, maxMs: rr.searchMaxMs } } : settings;
  const hits = await retriever.retrieve({
    query, chatIds: scope, kinds, budgetTokens: null, settings: s, now: asOf, reranker: useRerank ? reranker : null,
    // One case chat anywhere in scope keeps the rerank off Jev.
    caseId: useRerank ? caseIdOf(store, scope) : null,
    // So does one imported or private chat (R-H4-2, R-LI-25); a private one
    // also keeps the query off a hosted embedder, so it is asked whether
    // the search reranks or not.
    keepLocal: keepLocalReason(store, scope)
  });
  const chunks = hits.map((h) => h.chunk);
  const chunkCounts = store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
  return formatExcerpts(chunks, { chatId, asOf, chunkCounts, chatTitles, order: 'given' }).slice(0, limit);
}

function excerptsForMessage({ store, chatId, seq }) {
  const [message] = store.getMessages(chatId, { fromSeq: seq, toSeq: seq });
  const ids = message && message.context && Array.isArray(message.context.recalledChunkIds) ? message.context.recalledChunkIds : [];
  if (!ids.length) return [];
  // An imported reply, or one in a chat rewritten by replaceChat or
  // updateChat({ messages }), can carry ids that now name another chat's
  // chunks or a later message's: only this chat's chunks before the reply,
  // and (stage H4) chunks of a chat the reply's own provenance says it
  // recalled from, written no later than the reply.
  const own = String(chatId);
  const named = Array.isArray(message.context.recalledChats) ? message.context.recalledChats : [];
  const recalledChats = new Set(named.filter((id) => typeof id === 'string' && id && id !== own));
  const repliedAt = Date.parse(message.timestamp || '');
  const before = (c) => {
    const at = Date.parse(c.ts || '');
    return Number.isFinite(repliedAt) && Number.isFinite(at) && at <= repliedAt;
  };
  const all = store.chunks(ids);
  const chunks = all.filter((c) => (c.chatId === own ? c.seq < message.seq : recalledChats.has(c.chatId) && before(c)));
  if (chunks.length < all.length) log.debug(`Reply #${message.seq} in chat ${chatId}: ignored ${all.length - chunks.length} recalled chunk ids that no longer point before it in this chat or in a chat it recalled from`);
  // Aged as the model saw them, at the reply's own time.
  const asOf = repliedAt || Date.now();
  const chunkCounts = store.messageChunkCounts([...new Set(chunks.map((c) => c.messageId))]);
  const chatTitles = new Map();
  for (const c of chunks) {
    if (c.chatId === own || chatTitles.has(c.chatId) || typeof store.chatRef !== 'function') continue;
    const ref = store.chatRef(c.chatId);
    if (ref) chatTitles.set(c.chatId, ref.title);
  }
  return formatExcerpts(chunks, { chatId: own, asOf, chunkCounts, chatTitles, order: 'seq' });
}

module.exports = { searchHistoryExcerpts, excerptsForMessage };

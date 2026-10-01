// src/history/chat-facade.js
// The chat functions createCore puts on its context (recall spec §4.4):
// explicit store calls, plus appendMessageToChat with its old signature and
// return value, built on appendMessage. llmTotals is kept incrementally in
// the chat's meta_json instead of re-summing every message on each append.

const ZERO_TOTALS = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });

function addLlmTotals(totals, message) {
  const add = message?.llm?.totals || {};
  return {
    inputTokens: (Number(totals?.inputTokens) || 0) + (Number(add.inputTokens) || 0),
    outputTokens: (Number(totals?.outputTokens) || 0) + (Number(add.outputTokens) || 0),
    totalTokens: (Number(totals?.totalTokens) || 0) + (Number(add.totalTokens) || 0),
    costUsd: Number(((Number(totals?.costUsd) || 0) + (Number(add.costUsd) || 0)).toFixed(8))
  };
}

const chatLlmTotals = (messages = []) => messages.reduce(addLlmTotals, { ...ZERO_TOTALS });

function createChatFacade({ historyStore, createId, now = () => new Date().toISOString() }) {
  if (!historyStore) throw new Error('createChatFacade needs historyStore.');
  if (typeof createId !== 'function') throw new Error('createChatFacade needs createId.');
  const store = historyStore;

  // Returns the whole chat, messages and all, as it always has. A caller that
  // ignores the result passes { returnChat: false } and gets the appended
  // { message, seq } (null for an unknown chat) without re-reading the chat.
  const appendMessageToChat = (chatId, sender, text, metadata = {}, { returnChat = true } = {}) => {
    // id, sender, timestamp and seq are this function's (and the store's) to
    // set; an IPC payload spread into metadata must not override them.
    const { id: _id, sender: _sender, timestamp: _timestamp, seq: _seq, ...safeMetadata } = metadata || {};
    const timestamp = now();
    const message = { id: createId(), sender, text, timestamp, ...safeMetadata };
    const appended = store.transaction(() => {
      const chat = store.getChat(chatId, { messages: false });
      if (!chat) return null;
      const base = chat.llmTotals && typeof chat.llmTotals === 'object'
        ? chat.llmTotals
        : chatLlmTotals(store.getMessages(chat.id));
      return store.appendMessage(chat.id, message, { updatedAt: timestamp, patch: { llmTotals: addLlmTotals(base, message) } });
    });
    if (!appended) return null;
    return returnChat ? store.getChat(chatId, { messages: true }) : appended;
  };

  // llmTotals is a record of spend, not a view of the remaining messages:
  // a truncate leaves it as it is, so money already spent stays counted.
  const truncateChatFrom = (chatId, seq) => {
    const done = store.transaction(() => {
      const chat = store.getChat(chatId, { messages: false });
      if (!chat) return false;
      store.truncateFrom(chat.id, seq);
      store.updateChat(chat.id, { updatedAt: now() }, { messages: false });
      return true;
    });
    return done ? store.getChat(chatId, { messages: true }) : null;
  };

  return {
    historyStore: store,
    listChats: (options) => store.listChats(options),
    getChat: (id, options) => store.getChat(id, options),
    createChat: (chat, options) => store.createChat(chat, options),
    replaceChat: (id, chat) => store.replaceChat(id, chat),
    upsertChat: (chat, options) => store.upsertChat(chat, options),
    updateChat: (id, patch, options) => store.updateChat(id, patch, options),
    updateChatsWhere: (predicate, patcher) => store.updateChatsWhere(predicate, patcher),
    deleteChat: (id) => store.deleteChat(id),
    getMessages: (chatId, range) => store.getMessages(chatId, range),
    findQuestionMessage: (chatId, questionId) => store.findQuestionMessage(chatId, questionId),
    appendMessageToChat,
    truncateChatFrom
  };
}

module.exports = { createChatFacade, addLlmTotals, chatLlmTotals };

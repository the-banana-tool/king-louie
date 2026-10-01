// src/history/unavailable-store.js
// Stands in for a history store that would not open (recall spec §15): every
// chat call fails loudly with the reason. There is no fallback to the JSON
// file.

class HistoryUnavailableError extends Error {
  constructor(cause) {
    super(`Chat history is unavailable: ${cause?.message || cause || 'the history store did not open'}`);
    this.name = 'HistoryUnavailableError';
    this.code = 'HISTORY_UNAVAILABLE';
    this.cause = cause;
  }
}

const METHODS = [
  'listChats', 'getChat', 'createChat', 'replaceChat', 'upsertChat', 'updateChat', 'updateChatsWhere', 'deleteChat',
  'appendMessage', 'truncateFrom', 'getMessages', 'findQuestionMessage', 'messageCount', 'transaction', 'getMeta', 'setMeta'
];

function createUnavailableHistoryStore(cause) {
  const store = { available: false, isOpen: false, cause, close() {} };
  for (const method of METHODS) {
    store[method] = () => { throw new HistoryUnavailableError(cause); };
  }
  return store;
}

module.exports = { createUnavailableHistoryStore, HistoryUnavailableError };

// tests/helpers/history-context.js
// A chat context for IPC and core-free tests: the real chat facade over an
// in-memory history store, seeded with `chats` in order. Spread it into the
// context a handler is registered with.
const { HistoryStore, createChatFacade } = require('../../src/history');

function historyContext(chats = [], { createId } = {}) {
  const historyStore = HistoryStore.open(':memory:');
  for (const chat of chats) historyStore.createChat(chat, { position: 'back' });
  let n = 0;
  const facade = createChatFacade({ historyStore, createId: createId || (() => `hc-${++n}`) });
  return {
    ...facade,
    getHistoryStore: () => historyStore,
    getHistoryStatus: () => ({ available: true, error: null, migrationFailed: 0 })
  };
}

module.exports = { historyContext };

const { HistoryStore } = require('./history-store');
const { migrateFromJson, MIGRATION_MARKER } = require('./migrate-json');
const { createChatFacade, addLlmTotals, chatLlmTotals } = require('./chat-facade');
const { createUnavailableHistoryStore, HistoryUnavailableError } = require('./unavailable-store');
const { InvalidMessageError, DERIVED_CHAT_KEYS } = require('./rows');

module.exports = {
  HistoryStore,
  migrateFromJson,
  MIGRATION_MARKER,
  createChatFacade,
  addLlmTotals,
  chatLlmTotals,
  createUnavailableHistoryStore,
  HistoryUnavailableError,
  InvalidMessageError,
  DERIVED_CHAT_KEYS
};

const { HistoryStore } = require('./history-store');
const { migrateFromJson, MIGRATION_MARKER } = require('./migrate-json');
const { createChatFacade, addLlmTotals, chatLlmTotals } = require('./chat-facade');
const { createUnavailableHistoryStore, HistoryUnavailableError } = require('./unavailable-store');
const { chunkMessage } = require('./chunker');
const { TokenEstimator } = require('./token-estimator');
const { Retriever } = require('./retriever');
const { ContextBuilder } = require('./context-builder');
const { HISTORY_DEFAULTS, mergeHistorySettings } = require('./settings');
const { formatExcerpts, formatRecalledBlock } = require('./excerpts');
const { InvalidMessageError, DERIVED_CHAT_KEYS } = require('./rows');

module.exports = {
  HistoryStore,
  migrateFromJson,
  MIGRATION_MARKER,
  createChatFacade,
  TokenEstimator,
  Retriever,
  ContextBuilder,
  HISTORY_DEFAULTS,
  mergeHistorySettings,
  formatExcerpts,
  formatRecalledBlock,
  chunkMessage,
  addLlmTotals,
  chatLlmTotals,
  createUnavailableHistoryStore,
  HistoryUnavailableError,
  InvalidMessageError,
  DERIVED_CHAT_KEYS
};

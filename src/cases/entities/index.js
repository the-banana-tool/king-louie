// src/cases/entities/index.js
const { EntityIndex, INDEX_VERSION } = require('./entity-index');
const { normalizeEntity, keyType, ENTITY_TYPES } = require('./normalize');
const { extractEntities, TEXT_KINDS } = require('./extract');

module.exports = { EntityIndex, INDEX_VERSION, normalizeEntity, keyType, ENTITY_TYPES, extractEntities, TEXT_KINDS };

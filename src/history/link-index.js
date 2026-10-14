// src/history/link-index.js
// Schema step 4 (recall spec §4.1, stage H4): a chat's history scope, its
// links to other chats and the record of each import, as plain functions over
// the store's DatabaseSync, like chunk-index.js. HistoryStore delegates here.
//
// A link is one-directional: (chat_id, linked_chat_id) lets chat_id read
// linked_chat_id, never the other way. Deleting either chat removes the row,
// and deleting an imported chat removes its import row.
const { prepared } = require('./chunk-index');

const SCHEMA_V4_SQL = `
CREATE TABLE chat_links (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  linked_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, linked_chat_id),
  CHECK (chat_id <> linked_chat_id)
);
CREATE INDEX chat_links_linked ON chat_links(linked_chat_id);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_path TEXT,
  source_hash TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  imported_at TEXT,
  state TEXT NOT NULL DEFAULT 'running',     -- running | done
  importer_version INTEGER,
  message_count INTEGER
);
CREATE INDEX imports_chat ON imports(chat_id);
`;

// Schema step 5 (local inference spec 2026-10-13 §8.1): a chat's private
// mark. 0 or 1; the store only ever writes 1 (HistoryStore#markPrivate, a
// private createChat). It is one-way: nothing writes it back.
const SCHEMA_V5_SQL = `
ALTER TABLE chats ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
`;

// Narrowest first.
const HISTORY_SCOPES = Object.freeze(['chat', 'linked', 'all']);
const DEFAULT_SCOPE = 'chat';
const IMPORT_STATES = Object.freeze(['running', 'done']);

const isScope = (value) => typeof value === 'string' && HISTORY_SCOPES.includes(value);
const chatExists = (db, chatId) => Boolean(prepared(db, 'SELECT 1 AS present FROM chats WHERE id = ?').get(chatId));
const intOrNull = (value) => (Number.isInteger(value) ? value : null);
const textOrNull = (value) => (typeof value === 'string' && value ? value : null);

// ── scope ────────────────────────────────────────────────────────────────

// An unknown chat, or a stored value outside the three, reads as 'chat'.
function getHistoryScope(db, chatId) {
  const row = prepared(db, 'SELECT history_scope AS scope FROM chats WHERE id = ?').get(String(chatId));
  return row && isScope(row.scope) ? row.scope : DEFAULT_SCOPE;
}

// False for an unknown chat; RangeError for a value outside the three.
function setHistoryScope(db, chatId, scope) {
  if (!isScope(scope)) throw new RangeError(`A history scope is one of ${HISTORY_SCOPES.join(', ')}; got ${JSON.stringify(scope) ?? String(scope)}.`);
  return Number(prepared(db, 'UPDATE chats SET history_scope = ? WHERE id = ?').run(scope, String(chatId)).changes) > 0;
}

// ── links ────────────────────────────────────────────────────────────────

// The chats chatId may read, in the chat list's order.
function getLinks(db, chatId) {
  return prepared(db, `SELECT l.linked_chat_id AS id FROM chat_links l JOIN chats c ON c.id = l.linked_chat_id
    WHERE l.chat_id = ? ORDER BY c.position, c.rowid`).all(String(chatId)).map((row) => row.id);
}

// Replaces chatId's links. Dropped: duplicates, the chat itself, anything that
// is not a string, ids of chats that do not exist. The caller holds the
// transaction. Returns what is stored now (list order).
function setLinks(db, chatId, ids) {
  const id = String(chatId);
  if (!chatExists(db, id)) return [];
  prepared(db, 'DELETE FROM chat_links WHERE chat_id = ?').run(id);
  const insert = prepared(db, 'INSERT OR IGNORE INTO chat_links (chat_id, linked_chat_id) VALUES (?, ?)');
  for (const linked of new Set(Array.isArray(ids) ? ids : [])) {
    if (typeof linked !== 'string' || !linked || linked === id || !chatExists(db, linked)) continue;
    insert.run(id, linked);
  }
  return getLinks(db, id);
}

// ── refs ─────────────────────────────────────────────────────────────────

// What the scope policy needs to know about a chat, without its messages or
// the list's message aggregate. origin and importedFromCase live in
// meta_json; so does a caseId or source that is not a string. `private` is
// the chats.private column; on a file below schema step 5 (privacyAware
// false) the mark cannot be read, and what cannot be read is private.
function refOf(row, privacyAware) {
  let meta = null;
  try {
    meta = row.meta_json ? JSON.parse(row.meta_json) : null;
  } catch {
    meta = null;
  }
  const fromMeta = (key) => (meta && meta[key] !== undefined && meta[key] !== null && meta[key] !== '' ? meta[key] : null);
  return {
    id: row.id,
    title: row.title,
    caseId: row.case_id || fromMeta('caseId'),
    source: row.source || fromMeta('source'),
    origin: fromMeta('origin'),
    importedFromCase: Boolean(meta) && meta.importedFromCase === true,
    private: privacyAware === true ? Number(row.private) !== 0 : true
  };
}

const REF_COLUMNS = 'id, title, case_id, source, meta_json';
const refColumns = (privacyAware) => (privacyAware === true ? `${REF_COLUMNS}, private` : REF_COLUMNS);

function chatRefs(db, { privacyAware = false } = {}) {
  return prepared(db, `SELECT ${refColumns(privacyAware)} FROM chats ORDER BY position, rowid`).all().map((row) => refOf(row, privacyAware));
}

function chatRef(db, chatId, { privacyAware = false } = {}) {
  const row = prepared(db, `SELECT ${refColumns(privacyAware)} FROM chats WHERE id = ?`).get(String(chatId));
  return row ? refOf(row, privacyAware) : null;
}

// ── imports ──────────────────────────────────────────────────────────────

// Whether an import row names this chat (running or done).
function importOfChat(db, chatId) {
  return Boolean(prepared(db, 'SELECT 1 AS present FROM imports WHERE chat_id = ? LIMIT 1').get(String(chatId)));
}

const IMPORT_COLUMNS = `id, source_kind AS sourceKind, source_path AS sourcePath, source_hash AS sourceHash,
  chat_id AS chatId, imported_at AS importedAt, state, importer_version AS importerVersion, message_count AS messageCount`;
const importRow = (row) => (row ? {
  id: row.id,
  sourceKind: row.sourceKind,
  sourcePath: row.sourcePath ?? null,
  sourceHash: row.sourceHash,
  chatId: row.chatId,
  importedAt: row.importedAt ?? null,
  state: row.state,
  importerVersion: row.importerVersion ?? null,
  messageCount: row.messageCount ?? null
} : null);

function findImport(db, sourceHash) {
  if (typeof sourceHash !== 'string' || !sourceHash) return null;
  return importRow(prepared(db, `SELECT ${IMPORT_COLUMNS} FROM imports WHERE source_hash = ?`).get(sourceHash));
}

function getImport(db, id) {
  if (typeof id !== 'string' || !id) return null;
  return importRow(prepared(db, `SELECT ${IMPORT_COLUMNS} FROM imports WHERE id = ?`).get(id));
}

// Throws when the hash is already recorded (UNIQUE) or the chat does not
// exist (FOREIGN KEY): the caller decides what a second import means.
function recordImport(db, { id, sourceKind, sourcePath = null, sourceHash, chatId, importerVersion = null, state = 'running', importedAt = null } = {}) {
  if (!IMPORT_STATES.includes(state)) throw new RangeError(`An import's state is one of ${IMPORT_STATES.join(', ')}; got ${JSON.stringify(state)}.`);
  for (const [name, value] of [['id', id], ['sourceKind', sourceKind], ['sourceHash', sourceHash], ['chatId', chatId]]) {
    if (typeof value !== 'string' || !value) throw new TypeError(`recordImport needs ${name}.`);
  }
  prepared(db, `INSERT INTO imports (id, source_kind, source_path, source_hash, chat_id, imported_at, state, importer_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, sourceKind, textOrNull(sourcePath), sourceHash, chatId, state === 'done' ? textOrNull(importedAt) : null, state, intOrNull(importerVersion));
  return getImport(db, id);
}

function finishImport(db, id, { messageCount = null, importedAt = null } = {}) {
  if (typeof id !== 'string' || !id) return false;
  return Number(prepared(db, "UPDATE imports SET state = 'done', imported_at = ?, message_count = ? WHERE id = ?")
    .run(textOrNull(importedAt), intOrNull(messageCount), id).changes) > 0;
}

function unfinishedImports(db) {
  return prepared(db, `SELECT ${IMPORT_COLUMNS} FROM imports WHERE state = 'running' ORDER BY rowid`).all().map(importRow);
}

module.exports = {
  SCHEMA_V4_SQL, SCHEMA_V5_SQL, HISTORY_SCOPES, DEFAULT_SCOPE, IMPORT_STATES,
  getHistoryScope, setHistoryScope, getLinks, setLinks, chatRefs, chatRef,
  findImport, getImport, importOfChat, recordImport, finishImport, unfinishedImports
};

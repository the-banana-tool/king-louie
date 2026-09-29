// src/history/chunk-index.js
// The chunk, full-text and calibration tables (recall spec §4.1, §5.1,
// §6.3, §6.6) as plain functions over the store's DatabaseSync. HistoryStore
// delegates here so history-store.js keeps H1's shape.
const { chunkMessage } = require('./chunker');

const SCHEMA_V2_SQL = `
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  chars INTEGER NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX idx_chunks_message ON chunks(message_id);
CREATE INDEX idx_chunks_chat ON chunks(chat_id);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, content='chunks', content_rowid='id',
  tokenize = "unicode61 tokenchars '_-'"
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE calibration (
  model TEXT PRIMARY KEY,
  chars_per_token REAL NOT NULL,
  samples INTEGER NOT NULL
);
`;

// Prepared statements, cached per connection.
const cache = new WeakMap();
function prepared(db, sql) {
  let byConn = cache.get(db);
  if (!byConn) {
    byConn = new Map();
    cache.set(db, byConn);
  }
  let stmt = byConn.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    byConn.set(sql, stmt);
  }
  return stmt;
}

function insertChunks(db, chatId, message, chunkOptions = {}) {
  const pieces = chunkMessage(message, chunkOptions);
  if (!pieces.length) return 0;
  const stmt = prepared(db, 'INSERT INTO chunks (message_id, chat_id, idx, kind, text, chars, ts) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ts = String(message.timestamp || new Date(0).toISOString());
  for (const piece of pieces) {
    stmt.run(String(message.id), String(chatId), piece.idx, piece.kind, piece.text, piece.text.length, ts);
  }
  return pieces.length;
}

// The resumable backfill (H2): messages stored before schema step 2 have no
// chunks. The marker holds the messages.rowid cursor and the last rowid that
// existed at the upgrade; later inserts index themselves.
const BACKFILL_KEY = 'chunks_backfill';

function readBackfill(db) {
  const row = prepared(db, 'SELECT value FROM meta WHERE key = ?').get(BACKFILL_KEY);
  if (!row) return null;
  try {
    const state = JSON.parse(row.value);
    return Number.isInteger(state.cursor) && Number.isInteger(state.until) ? state : null;
  } catch {
    return null;
  }
}

function writeBackfill(db, state) {
  prepared(db, 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(BACKFILL_KEY, JSON.stringify(state));
}

function clearBackfill(db) {
  prepared(db, 'DELETE FROM meta WHERE key = ?').run(BACKFILL_KEY);
}

module.exports = { SCHEMA_V2_SQL, prepared, insertChunks, BACKFILL_KEY, readBackfill, writeBackfill, clearBackfill };

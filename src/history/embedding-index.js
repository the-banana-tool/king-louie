// src/history/embedding-index.js
// The embeddings table (recall spec §4.1, §5.2) as plain functions over the
// store's DatabaseSync, like chunk-index.js. A row is one chunk's vector for
// one embedder key ("local:Xenova/bge-small-en-v1.5"): unit length,
// little-endian float32. dim 0 with an empty vec is a tombstone: a chunk
// that crashed the embed worker on its own, never tried again for that key.
const { prepared } = require('./chunk-index');
const { vecToBlob } = require('./embedders/vectors');

const SCHEMA_V3_SQL = `
CREATE TABLE embeddings (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
CREATE INDEX idx_embeddings_model ON embeddings(model);
`;

const MISSING = 'NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id AND e.model = ?)';
// maxChunksPerToolResult: only the first n chunks of a tool result.
const CAPPED = "(? = 0 OR c.kind <> 'tool_result' OR c.idx < ?)";
const capOf = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// Only for chunks that still exist: a truncate between the read and the
// write leaves nothing to write, and no foreign-key error.
function putEmbeddings(db, model, rows) {
  const stmt = prepared(db, `INSERT OR REPLACE INTO embeddings (chunk_id, model, dim, vec)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?)`);
  let written = 0;
  for (const { chunkId, vec } of rows) {
    if (!Number.isInteger(chunkId)) continue;
    const blob = vec ? vecToBlob(vec) : Buffer.alloc(0);
    written += Number(stmt.run(chunkId, String(model), vec ? vec.length : 0, blob, chunkId).changes);
  }
  return written;
}

function pendingEmbeddings(db, model, { limit = 16, chatId = null, afterId = 0, maxChunksPerToolResult = 0 } = {}) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 16;
  const cap = capOf(maxChunksPerToolResult);
  const cols = 'c.id AS id, c.chat_id AS chatId, c.kind AS kind, c.text AS text';
  if (chatId !== null && chatId !== undefined) {
    return prepared(db, `SELECT ${cols} FROM chunks c WHERE c.chat_id = ? AND ${MISSING} AND ${CAPPED} ORDER BY c.id DESC LIMIT ?`)
      .all(String(chatId), String(model), cap, cap, max);
  }
  const after = Number.isInteger(afterId) && afterId > 0 ? afterId : 0;
  return prepared(db, `SELECT ${cols} FROM chunks c WHERE c.id > ? AND ${MISSING} AND ${CAPPED} ORDER BY c.id LIMIT ?`)
    .all(after, String(model), cap, cap, max);
}

function countPending(db, model, { maxChunksPerToolResult = 0 } = {}) {
  const cap = capOf(maxChunksPerToolResult);
  return Number(prepared(db, `SELECT count(*) AS n FROM chunks c WHERE ${MISSING} AND ${CAPPED}`).get(String(model), cap, cap).n);
}

function countEmbedded(db, model) {
  return Number(prepared(db, 'SELECT count(*) AS n FROM embeddings WHERE model = ? AND dim > 0').get(String(model)).n);
}

function deleteEmbeddings(db, model) {
  return Number(prepared(db, 'DELETE FROM embeddings WHERE model = ?').run(String(model)).changes);
}

// A chat's vectors for one key written after afterRowid, oldest first, with
// the chunk's seq and kind (the VectorIndex filters on both).
function vectorRows(db, model, chatId, { afterRowid = 0 } = {}) {
  return prepared(db, `SELECT e.rowid AS rowid, e.chunk_id AS chunkId, e.dim AS dim, e.vec AS vec, m.seq AS seq, c.kind AS kind
    FROM chunks c
    JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?
    JOIN messages m ON m.id = c.message_id
    WHERE c.chat_id = ? AND e.dim > 0 AND e.rowid > ?
    ORDER BY e.rowid`).iterate(String(model), String(chatId), Number(afterRowid) || 0);
}

module.exports = { SCHEMA_V3_SQL, putEmbeddings, pendingEmbeddings, countPending, countEmbedded, deleteEmbeddings, vectorRows };

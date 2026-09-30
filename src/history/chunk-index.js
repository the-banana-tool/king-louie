// src/history/chunk-index.js
// The chunk, full-text and calibration tables (recall spec §4.1, §5.1,
// §6.3, §6.6) as plain functions over the store's DatabaseSync. HistoryStore
// delegates here so history-store.js keeps H1's shape.
const { chunkMessage } = require('./chunker');
const { createLogger } = require('../logging');

const log = createLogger('history-index');

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

// FTS5 query from user text (spec §6.3 step 1, §15): quoted phrases stay
// phrases, every other term is quoted (so AND/OR/NEAR/*/^/: are literals),
// terms are OR-ed. Leading/trailing . and / are trimmed from unquoted terms
// so "config.yaml." at the end of a sentence is the phrase "config.yaml". The
// tokenizer treats only _ and - as token characters: . and / separate tokens,
// so a quoted "config.yaml" or "src/app.js" is a phrase of adjacent tokens
// (config, yaml), and a bare app.js matches wherever those tokens are adjacent.
// A '-' is never trimmed: it is part of the token, so "--user-data-dir"
// trimmed to "user-data-dir" would no longer match the stored flag.
const EDGE = /^[./]+|[./]+$/g;
// prefixMinChars > 0: an unquoted word of at least that many letters also
// matches as a prefix ("deploy"* finds deployed and deployment), a light
// substitute for stemming, which the index does not do.
function ftsQuery(text, { prefixMinChars = 0 } = {}) {
  const parts = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const quoted = m[1] !== undefined;
    const raw = quoted ? m[1] : m[2].replace(EDGE, '');
    if (!/[\p{L}\p{N}]/u.test(raw)) continue;
    const term = `"${raw.replace(/"/g, '""')}"`;
    const prefix = !quoted && prefixMinChars > 0 && /^\p{L}+$/u.test(raw) && raw.length >= prefixMinChars;
    parts.push(prefix ? `${term}*` : term);
  }
  return parts.join(' OR ');
}

const placeholders = (n) => new Array(n).fill('?').join(', ');
const asList = (v) => (Array.isArray(v) ? v.filter((x) => x !== undefined && x !== null).map(String) : []);

function searchText(db, query, { chatIds, kinds, limit = 50, upToSeq, messageIds, prefixMinChars = 0 } = {}) {
  const match = ftsQuery(query, { prefixMinChars });
  if (!match) return [];
  const where = ['chunks_fts MATCH ?'];
  const args = [match];
  const chats = asList(chatIds);
  const kindList = asList(kinds);
  const messages = asList(messageIds);
  if (chats.length) { where.push(`c.chat_id IN (${placeholders(chats.length)})`); args.push(...chats); }
  if (kindList.length) { where.push(`c.kind IN (${placeholders(kindList.length)})`); args.push(...kindList); }
  if (messages.length) { where.push(`c.message_id IN (${placeholders(messages.length)})`); args.push(...messages); }
  if (Number.isInteger(upToSeq)) { where.push('m.seq < ?'); args.push(upToSeq); }
  const max = Number.isInteger(limit) && limit > 0 ? limit : 50;
  // bm25score, not "rank": rank is an FTS5 hidden column.
  const sql = `SELECT c.id AS chunkId, bm25(chunks_fts) AS bm25score
    FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN messages m ON m.id = c.message_id
    WHERE ${where.join(' AND ')} ORDER BY bm25score LIMIT ?`;
  try {
    return db.prepare(sql).all(...args, max).map((r) => ({ chunkId: r.chunkId, score: -r.bm25score }));
  } catch (err) {
    log.warn(`Full-text search failed; recall uses the tail alone this turn: ${err.message}`);
    return [];
  }
}

const CHUNK_COLUMNS = `c.id AS id, c.message_id AS messageId, c.chat_id AS chatId, m.seq AS seq, c.idx AS idx,
  c.kind AS kind, c.text AS text, c.chars AS chars, c.ts AS ts, m.sender AS sender, m.tool_name AS toolName`;
const chunkRow = (row) => ({ ...row, toolName: row.toolName ?? null });

function getChunks(db, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Number.isInteger);
  const byId = new Map();
  for (let i = 0; i < list.length; i += 500) {
    const batch = list.slice(i, i + 500);
    const rows = db.prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN messages m ON m.id = c.message_id WHERE c.id IN (${placeholders(batch.length)})`).all(...batch);
    for (const row of rows) byId.set(row.id, chunkRow(row));
  }
  return list.map((id) => byId.get(id)).filter(Boolean);
}

function chunksOfMessage(db, messageId) {
  return prepared(db, `SELECT ${CHUNK_COLUMNS} FROM chunks c JOIN messages m ON m.id = c.message_id WHERE c.message_id = ? ORDER BY c.idx`)
    .all(String(messageId)).map(chunkRow);
}

// The other half of a tool exchange: a tool call's result, or a result's
// call. Matched by meta.toolUseId when both sides carry one (imported
// sessions), else the nearest message of the other sender with the same
// tool name within PAIR_WINDOW messages (native chats append call, result).
const PAIR_WINDOW = 12;
function pairedToolMessageId(db, messageId) {
  const m = prepared(db, 'SELECT id, chat_id, seq, sender, tool_name, meta_json FROM messages WHERE id = ?').get(String(messageId));
  if (!m || (m.sender !== 'toolUse' && m.sender !== 'toolResult')) return null;
  const forward = m.sender === 'toolUse';
  const want = forward ? 'toolResult' : 'toolUse';
  const rows = prepared(db, forward
    ? 'SELECT id, tool_name, meta_json FROM messages WHERE chat_id = ? AND seq > ? AND seq <= ? AND sender = ? ORDER BY seq'
    : 'SELECT id, tool_name, meta_json FROM messages WHERE chat_id = ? AND seq < ? AND seq >= ? AND sender = ? ORDER BY seq DESC')
    .all(m.chat_id, m.seq, forward ? m.seq + PAIR_WINDOW : m.seq - PAIR_WINDOW, want);
  const metaOf = (row) => { try { return row.meta_json ? JSON.parse(row.meta_json) : null; } catch { return null; } };
  const myId = metaOf(m)?.toolUseId ?? null;
  if (myId !== null) {
    const exact = rows.find((row) => metaOf(row)?.toolUseId === myId);
    if (exact) return exact.id;
  }
  const same = rows.find((row) => row.tool_name === m.tool_name);
  return same ? same.id : null;
}

function messageChunkCounts(db, messageIds) {
  const list = asList(messageIds);
  const out = new Map();
  for (let i = 0; i < list.length; i += 500) {
    const batch = list.slice(i, i + 500);
    const sql = `SELECT message_id AS id, count(*) AS n FROM chunks WHERE message_id IN (${placeholders(batch.length)}) GROUP BY message_id`;
    for (const row of db.prepare(sql).all(...batch)) out.set(row.id, row.n);
  }
  return out;
}

function lastSeq(db, chatId) {
  return prepared(db, 'SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE chat_id = ?').get(String(chatId)).n;
}

function historyChars(db, chatId, { upToSeq } = {}) {
  if (Number.isInteger(upToSeq)) {
    return prepared(db, 'SELECT COALESCE(SUM(c.chars), 0) AS n FROM chunks c JOIN messages m ON m.id = c.message_id WHERE c.chat_id = ? AND m.seq < ?')
      .get(String(chatId), upToSeq).n;
  }
  return prepared(db, 'SELECT COALESCE(SUM(chars), 0) AS n FROM chunks WHERE chat_id = ?').get(String(chatId)).n;
}

function getCalibration(db, model) {
  const row = prepared(db, 'SELECT model, chars_per_token AS charsPerToken, samples FROM calibration WHERE model = ?').get(String(model));
  return row ? { model: row.model, charsPerToken: row.charsPerToken, samples: row.samples } : null;
}

function setCalibration(db, model, charsPerToken, samples) {
  prepared(db, `INSERT INTO calibration (model, chars_per_token, samples) VALUES (?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET chars_per_token = excluded.chars_per_token, samples = excluded.samples`)
    .run(String(model), Number(charsPerToken), Math.floor(Number(samples) || 0));
}

module.exports = {
  pairedToolMessageId,
  SCHEMA_V2_SQL, prepared, insertChunks, BACKFILL_KEY, readBackfill, writeBackfill, clearBackfill,
  ftsQuery, searchText, getChunks, chunksOfMessage, messageChunkCounts, lastSeq, historyChars, getCalibration, setCalibration
};

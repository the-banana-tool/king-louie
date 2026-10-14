// src/history/history-store.js
// The history store (recall spec 2026-09-25 §3, §4): the system of record for
// chats, their messages (one row each, dense per-chat seq) and attachments,
// in one SQLite file per data directory. One connection for the store's
// life. Electron-free.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const chunkIndex = require('./chunk-index');
const embeddingIndex = require('./embedding-index');
const linkIndex = require('./link-index');
const { insertChunks, readBackfill, writeBackfill, clearBackfill } = chunkIndex;
const { applySchema, currentVersion, latestVersion, SchemaVersionError } = require('./schema');
const rows = require('./rows');
const { createLogger } = require('../logging');

const log = createLogger('history');
const BUSY_TIMEOUT_MS = 5000;
// The schema step that adds chunks, full-text search and calibration.
const INDEX_SCHEMA_VERSION = 2;
// The schema step that adds the embeddings table.
const EMBEDDINGS_SCHEMA_VERSION = 3;
// The schema step that adds chat links and import records.
const LINKS_SCHEMA_VERSION = 4;
// The schema step that adds a chat's private mark.
const PRIVATE_SCHEMA_VERSION = 5;
// The chat meta key of the recall mark (markRecalledOtherChats).
const RECALL_MARK_KEY = 'recalledOtherChatsAt';

const PREVIEW_CHARS = 500;
const normalizeId = (value) => String(value ?? '').trim();
const textOrNull = (value) => (typeof value === 'string' && value ? value : null);

// One pass over messages, grouped per chat, joined to each chat's preview
// row: the last user/assistant message, or the last message of any kind.
const LIST_SQL = `
  WITH agg AS (
    SELECT chat_id,
      COUNT(*) AS message_count,
      SUM(sender = 'user') AS user_count,
      SUM(sender = 'assistant') AS assistant_count,
      COALESCE(MAX(CASE WHEN sender IN ('user', 'assistant') THEN seq END), MAX(seq)) AS last_seq
    FROM messages
    GROUP BY chat_id
  )
  SELECT c.*,
    COALESCE(a.message_count, 0) AS message_count,
    COALESCE(a.user_count, 0) AS user_count,
    COALESCE(a.assistant_count, 0) AS assistant_count,
    substr(p.text, 1, ${PREVIEW_CHARS}) AS preview_text,
    p.timestamp AS preview_at
  FROM chats c
  LEFT JOIN agg a ON a.chat_id = c.id
  LEFT JOIN messages p ON p.chat_id = c.id AND p.seq = a.last_seq
  ORDER BY c.position, c.rowid`;

class HistoryStore {
  // allowOlderSchema (read-only only): open a file at any schema version from
  // 1 to the latest without upgrading it, for callers that read only chats
  // and messages (desktop import from an H1 profile). Its index methods then
  // find nothing, and setCalibration throws.
  static open(dbPath, { readonly = false, allowOlderSchema = false, now, chunkOptions } = {}) {
    if (!dbPath || typeof dbPath !== 'string') throw new TypeError('HistoryStore.open needs a file path or ":memory:".');
    const memory = dbPath === ':memory:';
    if (!memory && !readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath, readonly ? { readOnly: true } : {});
    let version;
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA foreign_keys = ON');
      if (readonly) {
        const found = currentVersion(db);
        const latest = latestVersion();
        if (found > latest) throw new SchemaVersionError(found, latest);
        if (found < latest && !(allowOlderSchema && found >= 1)) throw new SchemaVersionError(found, latest, 'HISTORY_SCHEMA_OLDER');
        version = found;
      } else {
        if (!memory) db.exec('PRAGMA journal_mode = WAL');
        version = applySchema(db);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    const store = new this(db, { dbPath, readonly, now });
    store.schemaVersion = version;
    // Chunk sizes (settings.history.chunk), read on every insert so a
    // settings change applies to the next message.
    store._chunkOptions = typeof chunkOptions === 'function' ? chunkOptions : () => chunkOptions || {};
    // Messages stored before schema step 2 are chunked later, a batch at a
    // time (backfillChunks, driven by startChunkBackfill after startup).
    return store;
  }

  constructor(db, { dbPath = null, readonly = false, now } = {}) {
    this.db = db;
    this.dbPath = dbPath;
    this.readonly = readonly;
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
    this._depth = 0;
    this._closed = false;
    this._statements = new Map();
    // Bumped by every change that can drop a vector or let a later chunk
    // reuse a chunk id (truncate, rewrite, delete, rebuild): the VectorIndex
    // drops its cached matrices when it moves.
    this.vectorEpoch = 0;
    this._appendListeners = new Set();
    this.schemaVersion = latestVersion();
  }

  // False only for a read-only store opened below schema 2 (no chunks).
  get indexed() {
    return this.schemaVersion >= INDEX_SCHEMA_VERSION;
  }

  // False for a read-only store opened below schema 3.
  get embeddable() {
    return this.schemaVersion >= EMBEDDINGS_SCHEMA_VERSION;
  }

  // False for a read-only store opened below schema 4: it has no links and
  // no import records, and its scope, link and import methods answer with
  // the neutral value ('chat', [], null, false) and never throw.
  get linkable() {
    return this.schemaVersion >= LINKS_SCHEMA_VERSION;
  }

  // False for a read-only store opened below schema 5: it has no private
  // column, so every chat in it reads as private (isPrivate, chatRefs).
  get privacyAware() {
    return this.schemaVersion >= PRIVATE_SCHEMA_VERSION;
  }

  // fn(chatId, seq) after each appendMessage has committed its message and
  // chunks (the EmbedIndexer embeds the newest chat first). A listener that
  // throws is logged; the append stands.
  onAppend(fn) {
    this._appendListeners.add(fn);
    return () => this._appendListeners.delete(fn);
  }

  _emitAppend(chatId, seq) {
    for (const fn of this._appendListeners) {
      try {
        fn(chatId, seq);
      } catch (err) {
        log.warn(`A history append listener failed: ${err.message}`);
      }
    }
  }

  _bumpVectorEpoch() {
    this.vectorEpoch += 1;
  }

  get isOpen() {
    return !this._closed;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._statements.clear();
    this.db.close();
  }

  _stmt(sql) {
    let statement = this._statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this._statements.set(sql, statement);
    }
    return statement;
  }

  // BEGIN IMMEDIATE takes the write lock up front, so a reader (H2's embed
  // worker) never upgrades into a busy error halfway. A nested call is a
  // savepoint: an inner failure undoes only the inner work.
  transaction(fn) {
    if (this._closed) throw new Error('The history store is closed.');
    const nested = this._depth > 0;
    const savepoint = `kl_sp_${this._depth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this._depth += 1;
    try {
      const result = fn(this.db);
      if (result && typeof result.then === 'function') {
        throw new TypeError('HistoryStore.transaction(fn) takes a synchronous function.');
      }
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } else {
          this.db.exec('ROLLBACK');
        }
      } catch (rollbackErr) {
        log.warn(`Rolling back a history transaction failed: ${rollbackErr.message}`);
      }
      throw err;
    } finally {
      this._depth -= 1;
    }
  }

  getMeta(key) {
    const row = this._stmt('SELECT value FROM meta WHERE key = ?').get(String(key));
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this._stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value));
  }

  // ── chats ──────────────────────────────────────────────────────────────

  listChats({ messages = false } = {}) {
    return this._stmt(LIST_SQL).all().map((row) => {
      const chat = {
        ...rows.rowToChat(row),
        messageCount: Number(row.message_count),
        userMessageCount: Number(row.user_count),
        assistantMessageCount: Number(row.assistant_count),
        preview: row.preview_text || '',
        lastMessageText: row.preview_text || '',
        lastMessageAt: row.preview_at || null
      };
      return messages ? { ...chat, messages: this._messagesFor(row.id) } : chat;
    });
  }

  getChat(id, { messages = true } = {}) {
    const key = normalizeId(id);
    if (!key) return null;
    const row = this._chatRow(key);
    if (!row) return null;
    const chat = rows.rowToChat(row);
    return messages ? { ...chat, messages: this._messagesFor(key) } : chat;
  }

  // options.private (exactly true) creates the chat private. `private` on
  // the chat object is ignored (rows.js drops it). A chat created over an
  // existing id keeps that chat's private mark, whatever the options say.
  createChat(chat, { position = 'front', private: asPrivate = false } = {}) {
    const id = normalizeId(chat?.id);
    if (!id || typeof chat !== 'object') return null;
    return this.transaction(() => {
      // A chat created over an id keeps that id's recall mark.
      const mark = this._recallMark(id);
      const wasPrivate = this._privateMark(id) === true;
      // Only a chat that replaced an existing one can drop vectors.
      if (Number(this._stmt('DELETE FROM chats WHERE id = ?').run(id).changes) > 0) this._bumpVectorEpoch();
      this._insertChatRow(id, mark === undefined ? chat : { ...chat, [RECALL_MARK_KEY]: mark }, this._nextPosition(position));
      // Before the first message row: the chat is private from the start.
      if (this.privacyAware && (wasPrivate || asPrivate === true)) this._stmt('UPDATE chats SET private = 1 WHERE id = ?').run(id);
      this._insertMessages(id, chat.messages, textOrNull(chat.updatedAt) || textOrNull(chat.createdAt));
      return this.getChat(id);
    });
  }

  replaceChat(id, chat) {
    const key = normalizeId(id || chat?.id);
    if (!key || !chat || typeof chat !== 'object') return null;
    return this.transaction(() => {
      if (!this._chatRow(key)) return null;
      this._updateChatRow(key, chat);
      this._stmt('DELETE FROM messages WHERE chat_id = ?').run(key);
      this._bumpVectorEpoch();
      this._insertMessages(key, chat.messages, textOrNull(chat.updatedAt) || textOrNull(chat.createdAt));
      return this.getChat(key);
    });
  }

  upsertChat(chat, options = {}) {
    const id = normalizeId(chat?.id);
    if (!id) return null;
    return this.transaction(() => (this._chatRow(id)
      ? this.replaceChat(id, chat)
      : this.createChat({ ...chat, id }, options)));
  }

  updateChat(id, patch = {}, { messages = true } = {}) {
    const key = normalizeId(id);
    if (!key) return null;
    return this.transaction(() => {
      const row = this._chatRow(key);
      if (!row) return null;
      const { messages: nextMessages, ...fields } = patch || {};
      const merged = { ...rows.rowToChat(row), ...fields };
      this._updateChatRow(key, merged);
      if (Array.isArray(nextMessages)) {
        this._stmt('DELETE FROM messages WHERE chat_id = ?').run(key);
        this._bumpVectorEpoch();
        this._insertMessages(key, nextMessages, textOrNull(merged.updatedAt) || textOrNull(merged.createdAt));
      }
      return this.getChat(key, { messages });
    });
  }

  updateChatsWhere(predicate, patcher) {
    if (typeof predicate !== 'function' || typeof patcher !== 'function') return [];
    return this.transaction(() => {
      const changed = [];
      for (const row of this._stmt('SELECT * FROM chats ORDER BY position, rowid').all()) {
        const chat = rows.rowToChat(row);
        if (!predicate(chat)) continue;
        const patch = patcher(chat);
        if (!patch || typeof patch !== 'object') continue;
        const { messages: _ignored, ...fields } = patch;
        this._updateChatRow(chat.id, { ...chat, ...fields });
        changed.push(this.getChat(chat.id, { messages: false }));
      }
      return changed;
    });
  }

  deleteChat(id) {
    const key = normalizeId(id);
    if (!key) return false;
    const removed = Number(this._stmt('DELETE FROM chats WHERE id = ?').run(key).changes) > 0;
    if (removed) this._bumpVectorEpoch();
    return removed;
  }

  // ── messages ───────────────────────────────────────────────────────────

  appendMessage(chatId, message, { updatedAt, patch } = {}) {
    const id = normalizeId(chatId);
    if (!id) return null;
    const out = this.transaction((db) => {
      const row = this._chatRow(id);
      if (!row) return null;
      const inserted = this._insertMessage(db, id, message, { fallbackTimestamp: updatedAt });
      const { messages: _ignored, ...fields } = patch || {};
      this._updateChatRow(id, { ...rows.rowToChat(row), updatedAt: updatedAt || inserted.stored.timestamp, ...fields });
      return { message: inserted.stored, seq: inserted.seq };
    });
    if (out) this._emitAppend(id, out.seq);
    return out;
  }

  // Several messages in one transaction, through the same insert path as
  // appendMessage (each is chunked and gets its full-text rows with it): an
  // import's batch (stage H4). One append emission, with the last seq. Null
  // for an unknown chat; a message that is refused stores none of the batch.
  appendMessages(chatId, messages, { updatedAt } = {}) {
    const id = normalizeId(chatId);
    if (!id) return null;
    if (!Array.isArray(messages)) throw new rows.InvalidMessageError('A chat\'s messages must be a list.');
    const out = this.transaction((db) => {
      const row = this._chatRow(id);
      if (!row) return null;
      let last = null;
      for (const message of messages) last = this._insertMessage(db, id, message, { fallbackTimestamp: updatedAt });
      if (!last) return { count: 0, lastSeq: 0 };
      this._updateChatRow(id, { ...rows.rowToChat(row), updatedAt: updatedAt || last.stored.timestamp });
      return { count: messages.length, lastSeq: last.seq };
    });
    if (out && out.count) this._emitAppend(id, out.lastSeq);
    return out;
  }

  // Removing messages is only ever "from seq n onward", so seq stays dense
  // from 1 (spec §4.1).
  truncateFrom(chatId, seq) {
    const id = normalizeId(chatId);
    const from = Number(seq);
    if (!Number.isInteger(from) || from < 1) throw new RangeError(`truncateFrom needs a seq of 1 or more, got ${seq}.`);
    const removed = this.transaction(() => Number(this._stmt('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(id, from).changes));
    if (removed) this._bumpVectorEpoch();
    return removed;
  }

  // fromSeq and toSeq are both inclusive; limit counts from fromSeq.
  getMessages(chatId, { fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER, limit = -1 } = {}) {
    const id = normalizeId(chatId);
    if (!id) return [];
    const bound = (value, fallback) => (Number.isInteger(Number(value)) ? Number(value) : fallback);
    return this._messagesFor(id, {
      fromSeq: bound(fromSeq, 1),
      toSeq: bound(toSeq, Number.MAX_SAFE_INTEGER),
      limit: Number.isInteger(Number(limit)) && Number(limit) >= 0 ? Number(limit) : -1
    });
  }

  // The seq of the chat's assistant message carrying a case question's
  // `question` metadata (management surfaces spec §3.4), or null. One
  // indexed scan of the chat's rows in SQLite: no message is read into JS.
  findQuestionMessage(chatId, questionId) {
    const id = normalizeId(chatId);
    if (!id || typeof questionId !== 'string' || !questionId) return null;
    const row = this._stmt(`SELECT seq FROM messages
      WHERE chat_id = ? AND sender = 'assistant' AND meta_json IS NOT NULL AND json_valid(meta_json)
        AND json_extract(meta_json, '$.question.questionId') = ?
      ORDER BY seq DESC LIMIT 1`).get(id, questionId);
    return row ? Number(row.seq) : null;
  }

  // The context builder's tail scan (recall spec §6.1): one page of a chat's
  // messages before beforeSeq, newest first, with only what the tail needs:
  // user and assistant rows with their attachments and, when toolCalls is
  // set, tool calls' name and parameters. Tool results, status rows and
  // tool calls' other columns are never read.
  tailScanPage(chatId, { beforeSeq = Number.MAX_SAFE_INTEGER, limit = 200, toolCalls = false } = {}) {
    const id = normalizeId(chatId);
    if (!id) return [];
    const before = Number.isInteger(Number(beforeSeq)) ? Number(beforeSeq) : Number.MAX_SAFE_INTEGER;
    const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 200;
    const list = this._stmt(`SELECT id, seq, sender, timestamp,
        CASE WHEN sender = 'toolUse' THEN NULL ELSE text END AS text,
        tool_name,
        CASE WHEN sender = 'toolUse' THEN params_json END AS params_json,
        CASE WHEN sender = 'toolUse' THEN NULL ELSE run_id END AS run_id,
        CASE WHEN sender = 'toolUse' THEN NULL ELSE llm_json END AS llm_json,
        CASE WHEN sender = 'toolUse' THEN NULL ELSE context_json END AS context_json,
        CASE WHEN sender = 'toolUse' THEN NULL ELSE meta_json END AS meta_json
      FROM messages
      WHERE chat_id = ? AND seq < ? AND (sender IN ('user', 'assistant') OR (? = 1 AND sender = 'toolUse'))
      ORDER BY seq DESC LIMIT ?`).all(id, before, toolCalls ? 1 : 0, max);
    const content = list.filter((row) => row.sender !== 'toolUse').map((row) => row.id);
    const byMessage = new Map();
    for (let i = 0; i < content.length; i += 500) {
      const batch = content.slice(i, i + 500);
      const attachments = this.db.prepare(`SELECT * FROM attachments WHERE message_id IN (${batch.map(() => '?').join(', ')})
        ORDER BY message_id, kind, idx`).all(...batch);
      for (const a of attachments) {
        if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
        byMessage.get(a.message_id).push(a);
      }
    }
    return list.map((row) => rows.rowToMessage(row, byMessage.get(row.id) || []));
  }

  // The tool results the tail folds in (tailIncludeToolResults): one page of
  // those after afterSeq (the tail's first message) and before beforeSeq,
  // newest first, at most limit rows, without attachments. Read once the
  // tail's span is known, so a tool result older than the tail is never
  // loaded; the caller pages with beforeSeq and stops when its budget is
  // spent.
  tailToolResults(chatId, { afterSeq = 0, beforeSeq = Number.MAX_SAFE_INTEGER, limit = 20 } = {}) {
    const id = normalizeId(chatId);
    if (!id) return [];
    const after = Number.isInteger(Number(afterSeq)) ? Number(afterSeq) : 0;
    const before = Number.isInteger(Number(beforeSeq)) ? Number(beforeSeq) : Number.MAX_SAFE_INTEGER;
    const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
    const list = this._stmt(`SELECT id, seq, sender, timestamp, text, tool_name, result_json, run_id, llm_json, context_json, meta_json
      FROM messages
      WHERE chat_id = ? AND sender = 'toolResult' AND seq > ? AND seq < ?
      ORDER BY seq DESC LIMIT ?`).all(id, after, before, max);
    return list.map((row) => rows.rowToMessage(row, []));
  }

  messageCount(chatId) {
    return Number(this._stmt('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(normalizeId(chatId)).n);
  }

  // ── internals shared with messages and later stages ─────────────────────

  _chatRow(id) {
    return this._stmt('SELECT * FROM chats WHERE id = ?').get(id);
  }

  _nextPosition(position) {
    const { lo, hi } = this._stmt('SELECT MIN(position) AS lo, MAX(position) AS hi FROM chats').get();
    if (position === 'back') return (hi === null ? -1 : Number(hi)) + 1;
    return (lo === null ? 1 : Number(lo)) - 1;
  }

  _insertChatRow(id, chat, position) {
    const r = rows.chatToRow(chat);
    this._stmt(`INSERT INTO chats (id, position, title, created_at, updated_at, agent_mode, sandbox_mode,
        case_id, working_directory, source, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, position, r.title, r.created_at, r.updated_at, r.agent_mode, r.sandbox_mode,
        r.case_id, r.working_directory, r.source, r.meta_json);
  }

  // The recall mark the chat `id` holds now, or undefined. Read from the row
  // itself, never from a chat object.
  _recallMark(id) {
    const row = this._stmt('SELECT meta_json FROM chats WHERE id = ?').get(id);
    if (!row || typeof row.meta_json !== 'string' || !row.meta_json.includes(RECALL_MARK_KEY)) return undefined;
    const value = JSON.parse(row.meta_json)[RECALL_MARK_KEY];
    return value === null ? undefined : value;
  }

  // Every write of a chat's fields goes through here, so a mark the row
  // holds outlives whatever the chat object says.
  _updateChatRow(id, chat) {
    const mark = this._recallMark(id);
    const r = rows.chatToRow(mark === undefined ? chat : { ...chat, [RECALL_MARK_KEY]: mark });
    this._stmt(`UPDATE chats SET title = ?, created_at = ?, updated_at = ?, agent_mode = ?, sandbox_mode = ?,
        case_id = ?, working_directory = ?, source = ?, meta_json = ?
      WHERE id = ?`)
      .run(r.title, r.created_at, r.updated_at, r.agent_mode, r.sandbox_mode,
        r.case_id, r.working_directory, r.source, r.meta_json, id);
  }

  _insertMessages(chatId, messages, fallbackTimestamp) {
    if (messages === undefined || messages === null) return;
    if (!Array.isArray(messages)) throw new rows.InvalidMessageError('A chat\'s messages must be a list.');
    for (const message of messages) this._insertMessage(this.db, chatId, message, { fallbackTimestamp });
  }

  // A message id is a global primary key, but a chat copied by desktop
  // import carries its source's message ids: a taken (or missing) id gets a
  // fresh one, the content is kept.
  _freeMessageId(candidate) {
    const id = typeof candidate === 'number' && Number.isFinite(candidate) ? String(candidate) : normalizeId(typeof candidate === 'string' ? candidate : '');
    if (id && !this._stmt('SELECT 1 AS taken FROM messages WHERE id = ?').get(id)) return id;
    const fresh = crypto.randomUUID();
    if (id) log.debug(`Message id ${id} is already stored; this copy is stored as ${fresh}.`);
    return fresh;
  }

  // The one place a message row is written. Always called inside a
  // transaction; H2 adds its chunk and full-text rows here, so they commit
  // or roll back with the message. Returns the stored shape (with seq).
  _insertMessage(db, chatId, message, { fallbackTimestamp } = {}) {
    const { row, attachments } = rows.messageToRow(message, { fallbackTimestamp: fallbackTimestamp || this._now() });
    const seq = Number(this._stmt('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE chat_id = ?').get(chatId).next);
    const id = this._freeMessageId(message.id);
    const info = this._stmt(`INSERT INTO messages (id, chat_id, seq, sender, text, timestamp, tool_name, params_json,
        result_json, run_id, llm_json, context_json, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chatId, seq, row.sender, row.text, row.timestamp, row.tool_name, row.params_json,
        row.result_json, row.run_id, row.llm_json, row.context_json, row.meta_json);
    for (const a of attachments) {
      this._stmt('INSERT INTO attachments (id, message_id, kind, idx, name, mime, bytes, text, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`${id}:${a.kind}:${a.idx}`, id, a.kind, a.idx, a.name, a.mime, a.bytes, a.text, a.meta_json);
    }
    const stored = rows.rowToMessage({ ...row, id, seq }, attachments);
    this._indexMessage(db, chatId, stored);
    return { rowId: Number(info.lastInsertRowid), id, seq, stored };
  }

  // Every insert path indexes here, in the caller's transaction: a failure
  // rolls the message back (spec §5.1).
  _indexMessage(db, chatId, message) {
    insertChunks(db, chatId, message, this._chunkOptions ? this._chunkOptions() : {});
  }

  // Messages stored before schema step 2 still to chunk (0 when none).
  backfillRemaining() {
    if (this.readonly || !this.indexed) return 0;
    const state = readBackfill(this.db);
    if (!state) return 0;
    return Number(this._stmt('SELECT count(*) AS n FROM messages WHERE rowid > ? AND rowid <= ?').get(state.cursor, state.until).n);
  }

  // Chunk one batch of the messages stored before schema step 2: one read
  // for the batch's rows and one for their attachments, then one
  // transaction that indexes them and moves the cursor, so a crash resumes
  // after the last committed batch and no message is chunked twice.
  // Returns { indexed, done, remaining }.
  backfillChunks({ batchSize = 500 } = {}) {
    const state = this.readonly || !this.indexed ? null : readBackfill(this.db);
    if (!state) return { indexed: 0, done: true, remaining: 0 };
    const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 500;
    const batch = this._stmt('SELECT rowid AS row_id, * FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?')
      .all(state.cursor, state.until, size);
    if (!batch.length) {
      clearBackfill(this.db);
      return { indexed: 0, done: true, remaining: 0 };
    }
    const last = Number(batch[batch.length - 1].row_id);
    const attachments = this._stmt(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.rowid > ? AND m.rowid <= ? ORDER BY a.message_id, a.kind, a.idx`).all(state.cursor, last);
    const byMessage = new Map();
    for (const a of attachments) {
      if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
      byMessage.get(a.message_id).push(a);
    }
    this.transaction((db) => {
      for (const { row_id: _rowId, ...row } of batch) {
        const message = rows.rowToMessage(row, byMessage.get(row.id) || []);
        this._stmt('DELETE FROM chunks WHERE message_id = ?').run(message.id);
        this._indexMessage(db, row.chat_id, message);
      }
      writeBackfill(db, { cursor: last, until: state.until });
    });
    const remaining = Number(this._stmt('SELECT count(*) AS n FROM messages WHERE rowid > ? AND rowid <= ?').get(last, state.until).n);
    if (remaining === 0) clearBackfill(this.db);
    return { indexed: batch.length, done: remaining === 0, remaining };
  }

  // Recall stage H2 (spec §3.2, §6.3, §6.6).
  // A store opened below schema 2 (allowOlderSchema) has no index: reads
  // find nothing and never touch the file.
  searchText(query, options = {}) { return this.indexed ? chunkIndex.searchText(this.db, query, options) : []; }
  chunks(ids) { return this.indexed ? chunkIndex.getChunks(this.db, ids) : []; }
  chunksOfMessage(messageId) { return this.indexed ? chunkIndex.chunksOfMessage(this.db, messageId) : []; }
  chunksOfChat(chatId) { return this.indexed ? chunkIndex.chunksOfChat(this.db, chatId) : []; }
  pairedToolMessageId(messageId, options = {}) { return this.indexed ? chunkIndex.pairedToolMessageId(this.db, messageId, options) : null; }
  messageChunkCounts(messageIds) { return this.indexed ? chunkIndex.messageChunkCounts(this.db, messageIds) : new Map(); }
  lastSeq(chatId) { return chunkIndex.lastSeq(this.db, chatId); }
  // How many messages of the chat have sender 'user' (the case nudge).
  userMessageCount(chatId) {
    const row = this._stmt("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND sender = 'user'").get(String(chatId));
    return Number(row ? row.n : 0);
  }
  historyChars(chatId, options = {}) { return this.indexed ? chunkIndex.historyChars(this.db, chatId, options) : 0; }
  calibration(model) { return this.indexed ? chunkIndex.getCalibration(this.db, model) : null; }
  setCalibration(model, charsPerToken, samples) {
    if (!this.indexed) {
      throw new Error(`history.sqlite has schema version ${this.schemaVersion} and was opened without upgrading it; it has no calibration table.`);
    }
    chunkIndex.setCalibration(this.db, model, charsPerToken, samples);
  }

  // Recall stage H3 (spec §4.1, §5.2, §5.3). A store below schema 3 has no
  // embeddings table: reads find nothing and writes do nothing; a read-only
  // store never writes.
  putEmbeddings(model, rows) {
    if (!this.embeddable || this.readonly || !Array.isArray(rows) || !rows.length) return 0;
    return this.transaction((db) => embeddingIndex.putEmbeddings(db, model, rows));
  }
  // options.localOnly (exactly true) is the local embedder's: without it an
  // imported chat's chunks are never pending (owner ruling R-H4-2).
  // The store says whether it can read the private mark; a caller cannot.
  pendingEmbeddings(model, options = {}) { return this.embeddable ? embeddingIndex.pendingEmbeddings(this.db, model, { ...options, privacyAware: this.privacyAware }) : []; }
  countPending(model, options = {}) { return this.embeddable ? embeddingIndex.countPending(this.db, model, { ...options, privacyAware: this.privacyAware }) : 0; }
  countEmbedded(model) { return this.embeddable ? embeddingIndex.countEmbedded(this.db, model) : 0; }
  vectorRows(model, chatId, options = {}) { return this.embeddable ? embeddingIndex.vectorRows(this.db, model, chatId, options) : []; }
  deleteEmbeddings(model) {
    if (!this.embeddable || this.readonly) return 0;
    const removed = embeddingIndex.deleteEmbeddings(this.db, model);
    this._bumpVectorEpoch();
    return removed;
  }

  // The recall mark (stage H4 review; owner ruling R-H4-1): this chat was
  // given text from another chat, by a turn's recalled block or by
  // SearchHistory / ReadHistory. It is set before that text reaches a model,
  // so a turn that dies with no reply stored is still on record, and it is
  // never cleared: _updateChatRow and createChat carry the row's mark over
  // any chat object (a patch, a replace, an upsert), and truncation, the
  // scope and the links do not touch it. A chat object may bring a mark with
  // it (a copy from a desktop); none can take one away. It lives in
  // meta_json, so it needs no schema step and reads back on the chat as
  // `recalledOtherChatsAt`. True when the chat is marked now; false for an
  // unknown chat or a store that cannot write, which the caller must treat
  // as a refusal.
  markRecalledOtherChats(chatId) {
    const id = normalizeId(chatId);
    if (!id || this.readonly) return false;
    return this.transaction(() => {
      const row = this._chatRow(id);
      if (!row) return false;
      if (this._recallMark(id) !== undefined) return true;
      const meta = row.meta_json ? JSON.parse(row.meta_json) : {};
      meta[RECALL_MARK_KEY] = this._now();
      return Number(this._stmt('UPDATE chats SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), id).changes) > 0;
    });
  }

  // The private mark (local inference spec 2026-10-13 §8.1, §8.4; owner
  // ruling R-LI-10): a private chat makes no model call that leaves the
  // owner's hardware. It is the chats.private column and it is one-way:
  // markPrivate and a private createChat set it, and nothing clears it (no
  // method here writes the column any other way; _updateChatRow, replaceChat,
  // the upsert path and truncation never name it, and rows.js drops a
  // `private` found on a chat object). The only way out is a new chat.

  // The row's mark: true, false, or undefined for no such chat.
  _privateMark(id) {
    if (!this.privacyAware) return undefined;
    const row = this._stmt('SELECT private FROM chats WHERE id = ?').get(id);
    return row ? Number(row.private) !== 0 : undefined;
  }

  // Whether the chat is private. A mark that cannot be read is private: an
  // unknown chat id, a store below schema 5, a closed store, a failed read.
  isPrivate(chatId) {
    try {
      const id = typeof chatId === 'string' ? normalizeId(chatId) : '';
      if (!id || this._closed || !this.privacyAware) return true;
      return this._privateMark(id) !== false;
    } catch (err) {
      log.warn(`A chat's private mark could not be read, so the chat is treated as private: ${err.message}`);
      return true;
    }
  }

  // Marks the chat private and, in the same transaction, deletes every
  // vector of its chunks that a hosted embedder made (any key that does not
  // start "local:"; the local embedder fills its own key again). A failure
  // leaves the chat unmarked and its vectors in place. `marked` is false for
  // an unknown chat or one that is already private (nothing is deleted
  // then). Throws on a read-only store.
  markPrivate(chatId) {
    if (this.readonly) throw new Error('The history store is read-only; a chat cannot be marked private in it.');
    if (!this.privacyAware) throw new Error(`history.sqlite has schema version ${this.schemaVersion}; it has no private mark.`);
    const id = typeof chatId === 'string' ? normalizeId(chatId) : '';
    const out = this.transaction(() => {
      if (!id || this._privateMark(id) !== false) return { marked: false, droppedVectors: 0 };
      this._stmt('UPDATE chats SET private = 1 WHERE id = ?').run(id);
      // substr, not LIKE: LIKE ignores case, and only the exact prefix is
      // the local embedder's.
      const droppedVectors = Number(this._stmt(`DELETE FROM embeddings
        WHERE substr(model, 1, 6) <> 'local:' AND chunk_id IN (SELECT id FROM chunks WHERE chat_id = ?)`).run(id).changes);
      return { marked: true, droppedVectors };
    });
    if (out.droppedVectors > 0) this._bumpVectorEpoch();
    return out;
  }

  // What the private mark's confirmation says (local inference spec
  // 2026-10-13 §8.1): how many vectors of the chat's chunks a hosted
  // embedder made (any key that is not "local:"), and which other chats'
  // replies say they recalled this one (`context.recalledChats`). Reads
  // only; a store that cannot answer gives null.
  hostedVectorCount(chatId) {
    const id = normalizeId(chatId);
    if (!id || !this.embeddable) return 0;
    try {
      return Number(this._stmt(`SELECT count(*) AS n FROM embeddings
        WHERE substr(model, 1, 6) <> 'local:' AND chunk_id IN (SELECT id FROM chunks WHERE chat_id = ?)`).get(id).n);
    } catch (err) {
      log.warn(`Counting a chat's hosted vectors failed: ${err.message}`);
      return null;
    }
  }
  chatsRecalling(chatId) {
    const id = normalizeId(chatId);
    if (!id) return [];
    try {
      const rows = this._stmt('SELECT DISTINCT chat_id AS chatId, context_json AS context FROM messages WHERE chat_id <> ? AND context_json IS NOT NULL AND instr(context_json, ?) > 0').all(id, id);
      const out = [];
      for (const row of rows) {
        let ctx = null;
        try {
          ctx = JSON.parse(row.context);
        } catch {
          ctx = null;
        }
        const named = ctx && Array.isArray(ctx.recalledChats) ? ctx.recalledChats : [];
        if (named.includes(id) && !out.includes(row.chatId)) out.push(row.chatId);
      }
      return out;
    } catch (err) {
      log.warn(`Finding the chats that recalled a chat failed: ${err.message}`);
      return null;
    }
  }

  // Chat ids an import must not be given although no chat in this store has
  // them: the ids of chats still in chat-data.json (the core sets the check;
  // stage H4 review). The move out of the JSON file would take a chat it
  // finds under such an id for the original. Held in memory only; a check
  // that throws reserves the id.
  reserveChatIds(isReserved) {
    this._isReservedChatId = typeof isReserved === 'function' ? isReserved : null;
  }
  isReservedChatId(chatId) {
    const id = normalizeId(chatId);
    if (!id || !this._isReservedChatId) return false;
    try {
      return this._isReservedChatId(id) !== false;
    } catch (err) {
      log.warn(`Whether a chat id is reserved could not be checked, so it is: ${err.message}`);
      return true;
    }
  }

  // Recall stage H4 (spec §3.2, §4.1). A chat's history scope and its links
  // say which chats its turns may read; both are set only by the owner's own
  // action, never from a chat object (rows.js drops historyScope). Neither
  // moves a vector, so neither bumps vectorEpoch.
  getHistoryScope(chatId) {
    const id = normalizeId(chatId);
    return this.linkable && id ? linkIndex.getHistoryScope(this.db, id) : linkIndex.DEFAULT_SCOPE;
  }
  setHistoryScope(chatId, scope) {
    const id = normalizeId(chatId);
    if (!this.linkable || this.readonly) return false;
    // An invalid scope throws even for an unknown chat.
    return linkIndex.setHistoryScope(this.db, id, scope);
  }
  // Linked chat ids in the chat list's order (one-directional).
  getLinks(chatId) {
    const id = normalizeId(chatId);
    return this.linkable && id ? linkIndex.getLinks(this.db, id) : [];
  }
  setLinks(chatId, ids) {
    const id = normalizeId(chatId);
    if (!this.linkable || this.readonly || !id) return [];
    return this.transaction((db) => linkIndex.setLinks(db, id, ids));
  }
  // { id, title, caseId, source, origin, importedFromCase, private } for
  // every chat in list order; no message is read. Works on any schema
  // version; below schema 5 every chat's `private` is true (unreadable).
  chatRefs() { return linkIndex.chatRefs(this.db, { privacyAware: this.privacyAware }); }
  chatRef(chatId) {
    const id = normalizeId(chatId);
    return id ? linkIndex.chatRef(this.db, id, { privacyAware: this.privacyAware }) : null;
  }
  findImport(sourceHash) { return this.linkable ? linkIndex.findImport(this.db, sourceHash) : null; }
  getImport(id) { return this.linkable ? linkIndex.getImport(this.db, id) : null; }
  // Whether this chat was made by an import (it has an import row).
  importOfChat(chatId) {
    const id = normalizeId(chatId);
    return Boolean(this.linkable && id && linkIndex.importOfChat(this.db, id));
  }
  unfinishedImports() { return this.linkable ? linkIndex.unfinishedImports(this.db) : []; }
  // Throws when the hash is already recorded or the chat does not exist.
  recordImport(record = {}) {
    if (!this.linkable || this.readonly) return null;
    return linkIndex.recordImport(this.db, { ...record, importedAt: record.state === 'done' ? this._now() : null });
  }
  finishImport(id, { messageCount = null } = {}) {
    if (!this.linkable || this.readonly) return false;
    return linkIndex.finishImport(this.db, id, { messageCount, importedAt: this._now() });
  }

  _messagesFor(chatId, { fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER, limit = -1 } = {}) {
    const list = this._stmt('SELECT * FROM messages WHERE chat_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?')
      .all(chatId, fromSeq, toSeq, limit);
    if (!list.length) return [];
    const attachments = this._stmt(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.chat_id = ? AND m.seq >= ? AND m.seq <= ? ORDER BY a.message_id, a.kind, a.idx`)
      .all(chatId, list[0].seq, list[list.length - 1].seq);
    const byMessage = new Map();
    for (const a of attachments) {
      if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
      byMessage.get(a.message_id).push(a);
    }
    return list.map((row) => rows.rowToMessage(row, byMessage.get(row.id) || []));
  }
}

module.exports = { HistoryStore };

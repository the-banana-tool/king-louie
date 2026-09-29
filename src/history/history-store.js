// src/history/history-store.js
// The history store (recall spec 2026-09-25 §3, §4): the system of record for
// chats, their messages (one row each, dense per-chat seq) and attachments,
// in one SQLite file per data directory. One connection for the store's
// life. Electron-free.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { applySchema, currentVersion, latestVersion, SchemaVersionError } = require('./schema');
const rows = require('./rows');
const { createLogger } = require('../logging');

const log = createLogger('history');
const BUSY_TIMEOUT_MS = 5000;

const PREVIEW_CHARS = 500;
const normalizeId = (value) => String(value ?? '').trim();
const textOrNull = (value) => (typeof value === 'string' && value ? value : null);

const LIST_SQL = `
  SELECT c.*,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender = 'user') AS user_count,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender = 'assistant') AS assistant_count,
    COALESCE(
      (SELECT MAX(seq) FROM messages m WHERE m.chat_id = c.id AND m.sender IN ('user', 'assistant')),
      (SELECT MAX(seq) FROM messages m WHERE m.chat_id = c.id)
    ) AS last_seq
  FROM chats c
  ORDER BY c.position, c.rowid`;

class HistoryStore {
  static open(dbPath, { readonly = false, now } = {}) {
    if (!dbPath || typeof dbPath !== 'string') throw new TypeError('HistoryStore.open needs a file path or ":memory:".');
    const memory = dbPath === ':memory:';
    if (!memory && !readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath, readonly ? { readOnly: true } : {});
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA foreign_keys = ON');
      if (readonly) {
        const found = currentVersion(db);
        const latest = latestVersion();
        if (found > latest) throw new SchemaVersionError(found, latest);
        if (found < latest) throw new SchemaVersionError(found, latest, 'HISTORY_SCHEMA_OLDER');
      } else {
        if (!memory) db.exec('PRAGMA journal_mode = WAL');
        applySchema(db);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new this(db, { dbPath, readonly, now });
  }

  constructor(db, { dbPath = null, readonly = false, now } = {}) {
    this.db = db;
    this.dbPath = dbPath;
    this.readonly = readonly;
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
    this._depth = 0;
    this._closed = false;
    this._statements = new Map();
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
      const last = row.last_seq
        ? this._stmt('SELECT substr(text, 1, ?) AS text, timestamp FROM messages WHERE chat_id = ? AND seq = ?')
          .get(PREVIEW_CHARS, row.id, row.last_seq)
        : null;
      const chat = {
        ...rows.rowToChat(row),
        messageCount: Number(row.message_count),
        userMessageCount: Number(row.user_count),
        assistantMessageCount: Number(row.assistant_count),
        preview: last?.text || '',
        lastMessageText: last?.text || '',
        lastMessageAt: last?.timestamp || null
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

  createChat(chat, { position = 'front' } = {}) {
    const id = normalizeId(chat?.id);
    if (!id || typeof chat !== 'object') return null;
    return this.transaction(() => {
      this._stmt('DELETE FROM chats WHERE id = ?').run(id);
      this._insertChatRow(id, chat, this._nextPosition(position));
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
    if (key) this._stmt('DELETE FROM chats WHERE id = ?').run(key);
    return this.listChats();
  }

  // ── messages ───────────────────────────────────────────────────────────

  appendMessage(chatId, message, { updatedAt, patch } = {}) {
    const id = normalizeId(chatId);
    if (!id) return null;
    return this.transaction((db) => {
      const row = this._chatRow(id);
      if (!row) return null;
      const inserted = this._insertMessage(db, id, message, { fallbackTimestamp: updatedAt });
      const { messages: _ignored, ...fields } = patch || {};
      this._updateChatRow(id, { ...rows.rowToChat(row), updatedAt: updatedAt || inserted.stored.timestamp, ...fields });
      return { message: inserted.stored, seq: inserted.seq };
    });
  }

  // Removing messages is only ever "from seq n onward", so seq stays dense
  // from 1 (spec §4.1).
  truncateFrom(chatId, seq) {
    const id = normalizeId(chatId);
    const from = Number(seq);
    if (!Number.isInteger(from) || from < 1) throw new RangeError(`truncateFrom needs a seq of 1 or more, got ${seq}.`);
    return this.transaction(() => Number(this._stmt('DELETE FROM messages WHERE chat_id = ? AND seq >= ?').run(id, from).changes));
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

  _updateChatRow(id, chat) {
    const r = rows.chatToRow(chat);
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
    return { rowId: Number(info.lastInsertRowid), id, seq, stored };
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

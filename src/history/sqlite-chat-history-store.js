const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function withoutMessages(chat = {}) {
  const { messages: _messages, ...metadata } = chat;
  return metadata;
}

function normalizeChat(chat = {}) {
  if (!chat || typeof chat !== 'object' || !String(chat.id || '').trim()) return null;
  return {
    ...chat,
    id: String(chat.id).trim(),
    messages: Array.isArray(chat.messages) ? chat.messages : []
  };
}

function sortRow(a, b) {
  const left = Number.isFinite(a.position) ? a.position : 0;
  const right = Number.isFinite(b.position) ? b.position : 0;
  return left - right;
}

class SqliteChatHistoryStore {
  constructor(options = {}) {
    const dbPath = options.dbPath || (options.dataDir ? path.join(options.dataDir, 'chat-history.sqlite') : null);
    if (!dbPath) throw new Error('SqliteChatHistoryStore requires dbPath or dataDir.');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = options.db || null;
    this.initialize();
    if (Array.isArray(options.migrateChats) && options.migrateChats.length && this.getAllChats().length === 0) {
      this.setChats(options.migrateChats);
    }
  }

  initialize() {
    this.withDb((db) => db.exec(`
      ${this.dbPath === ':memory:' ? '' : 'PRAGMA journal_mode = WAL;'}
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_position ON chats(position);
    `));
  }

  close() {
    if (this.db) this.db.close();
  }

  withDb(fn) {
    const db = this.db || new DatabaseSync(this.dbPath);
    try {
      return fn(db);
    } finally {
      if (!this.db) db.close();
    }
  }

  rowToChat(row) {
    if (!row) return null;
    try {
      return normalizeChat(JSON.parse(row.data));
    } catch {
      return null;
    }
  }

  getAllRows() {
    return this.withDb((db) => db.prepare('SELECT id, position, data FROM chats ORDER BY position ASC').all());
  }

  getAllChats() {
    return this.getAllRows().map((row) => this.rowToChat(row)).filter(Boolean);
  }

  setChats(chats = []) {
    const normalized = (Array.isArray(chats) ? chats : []).map(normalizeChat).filter(Boolean);
    this.withDb((db) => {
      const insert = db.prepare('INSERT INTO chats (id, position, data) VALUES (?, ?, ?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM chats');
        normalized.forEach((chat, index) => insert.run(chat.id, index, JSON.stringify(chat)));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });
    return normalized;
  }

  listChats(options = {}) {
    const includeMessages = options.messages === true || options.includeMessages === true;
    return this.getAllChats().map((chat) => (includeMessages ? chat : withoutMessages(chat)));
  }

  getChat(chatId, options = {}) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    const row = this.withDb((db) => db.prepare('SELECT data FROM chats WHERE id = ?').get(id));
    const chat = this.rowToChat(row);
    if (!chat) return null;
    const includeMessages = options.messages !== false && options.includeMessages !== false;
    return includeMessages ? chat : withoutMessages(chat);
  }

  nextPosition(position = 'front') {
    const rows = this.withDb((db) => db.prepare('SELECT MIN(position) AS minPosition, MAX(position) AS maxPosition FROM chats').get());
    if (position === 'back') return (Number.isFinite(rows?.maxPosition) ? rows.maxPosition : -1) + 1;
    return (Number.isFinite(rows?.minPosition) ? rows.minPosition : 0) - 1;
  }

  createChat(chat = {}, options = {}) {
    const normalized = normalizeChat(chat);
    if (!normalized) return null;
    const position = this.nextPosition(options.position || 'front');
    this.withDb((db) => {
      db.prepare('DELETE FROM chats WHERE id = ?').run(normalized.id);
      db.prepare('INSERT INTO chats (id, position, data) VALUES (?, ?, ?)')
        .run(normalized.id, position, JSON.stringify(normalized));
    });
    return normalized;
  }

  replaceChat(chatId, chat = {}) {
    const id = String(chatId || chat?.id || '').trim();
    if (!id) return null;
    const existing = this.withDb((db) => db.prepare('SELECT position FROM chats WHERE id = ?').get(id));
    if (!existing) return null;
    const normalized = normalizeChat({ ...chat, id });
    if (!normalized) return null;
    this.withDb((db) => db.prepare('UPDATE chats SET data = ? WHERE id = ?').run(JSON.stringify(normalized), id));
    return normalized;
  }

  upsertChat(chat = {}, options = {}) {
    const normalized = normalizeChat(chat);
    if (!normalized) return null;
    return this.getChat(normalized.id, { messages: true })
      ? this.replaceChat(normalized.id, normalized)
      : this.createChat(normalized, options);
  }

  deleteChat(chatId) {
    const id = String(chatId || '').trim();
    if (id) this.withDb((db) => db.prepare('DELETE FROM chats WHERE id = ?').run(id));
    return this.getAllChats();
  }

  updateChat(chatId, patch = {}) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    const chat = this.getChat(id, { messages: true });
    if (!chat) return null;
    const updated = { ...chat, ...(patch || {}) };
    this.withDb((db) => db.prepare('UPDATE chats SET data = ? WHERE id = ?').run(JSON.stringify(updated), id));
    return updated;
  }

  updateChatsWhere(predicate, patcher) {
    if (typeof predicate !== 'function' || typeof patcher !== 'function') return [];
    const rows = this.getAllRows().sort(sortRow);
    const changed = [];
    this.withDb((db) => {
      const update = db.prepare('UPDATE chats SET data = ? WHERE id = ?');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const chat = this.rowToChat(row);
          if (!chat || !predicate(chat)) continue;
          const patch = patcher(chat);
          if (!patch || typeof patch !== 'object') continue;
          const next = { ...chat, ...patch };
          update.run(JSON.stringify(next), chat.id);
          changed.push(next);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });
    return changed;
  }

  appendMessage(chatId, message = {}, options = {}) {
    const id = String(chatId || '').trim();
    if (!id) return null;
    const chat = this.getChat(id, { messages: true });
    if (!chat) return null;
    const now = options.updatedAt || message.timestamp || new Date().toISOString();
    const updated = {
      ...chat,
      updatedAt: now,
      messages: [...(Array.isArray(chat.messages) ? chat.messages : []), message],
      ...(options.patch || {})
    };
    this.withDb((db) => db.prepare('UPDATE chats SET data = ? WHERE id = ?').run(JSON.stringify(updated), id));
    return updated;
  }
}

module.exports = {
  SqliteChatHistoryStore
};
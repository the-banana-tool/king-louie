// src/history/history-store.js
// The history store (recall spec 2026-09-25 §3, §4): the system of record for
// chats, their messages (one row each, dense per-chat seq) and attachments,
// in one SQLite file per data directory. One connection for the store's
// life. Electron-free.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { applySchema, currentVersion, latestVersion, SchemaVersionError } = require('./schema');
const { createLogger } = require('../logging');

const log = createLogger('history');
const BUSY_TIMEOUT_MS = 5000;

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
}

module.exports = { HistoryStore };

// tests/helpers/history-fixture.js
// A HistoryStore on a temp dir, and chats seeded through the real
// appendMessage, so every message is chunked exactly as in the app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../../src/history');

const BASE_TIME = Date.parse('2026-01-01T09:00:00.000Z');
const isoAt = (minutes) => new Date(BASE_TIME + minutes * 60000).toISOString();

function openTempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-'));
  const dbPath = path.join(dir, 'history.sqlite');
  const store = HistoryStore.open(dbPath, options);
  return {
    store,
    dir,
    dbPath,
    cleanup() {
      // Tests may replace t.store (reopen); close whichever is current.
      try { this.store.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// messages: [{ sender, text, ...metadata }]; ids `${id}-m1`…, one minute apart.
function seedChat(store, { id = 'chat-1', title = 'Test chat', caseId = null, messages = [], startMinute = 0, stepMinutes = 1 } = {}) {
  store.createChat({ id, title, ...(caseId ? { caseId } : {}), createdAt: isoAt(startMinute), updatedAt: isoAt(startMinute), messages: [] });
  return messages.map((m, i) => {
    const message = { ...m, id: m.id || `${id}-m${i + 1}`, timestamp: m.timestamp || isoAt(startMinute + i * stepMinutes) };
    return store.appendMessage(id, message, { updatedAt: message.timestamp }).seq;
  });
}

// A second, read-only connection (WAL lets it read while the store writes).
const readDb = (dbPath) => new DatabaseSync(dbPath, { readOnly: true });

// What an H1 profile looks like: the index tables dropped, schema_version 1.
// Takes a raw DatabaseSync on the store's file (the store closed).
function downgradeToVersion1(db) {
  db.exec(`DROP TABLE IF EXISTS embeddings;
    DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
    DROP TABLE chunks_fts; DROP TABLE chunks; DROP TABLE calibration;
    UPDATE schema_version SET version = 1;`);
}

module.exports = { BASE_TIME, isoAt, openTempStore, seedChat, readDb, downgradeToVersion1 };

// tests/history-backfill.test.js
// Messages H1 stored before schema step 2 are chunked on open, in batches,
// resumably (H2 contract; spec §11.1 "a crash midway resumes").
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const text = (i) => `Message ${i} is about the Lakeside lot fence and marker word w${i} for the index.`;

// Build a store with messages, then turn it back into a version-1 database:
// what an H1 profile looks like before H2's first start.
function versionOneStore(count) {
  const t = openTempStore();
  seedChat(t.store, { messages: Array.from({ length: count }, (_, i) => ({ sender: i % 2 ? 'assistant' : 'user', text: text(i + 1) })) });
  t.store.close();
  const db = new DatabaseSync(t.dbPath);
  db.exec(`
    DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
    DROP TABLE chunks_fts; DROP TABLE chunks; DROP TABLE calibration;
    UPDATE schema_version SET version = 1 WHERE version = 2;
  `);
  db.prepare("DELETE FROM meta WHERE key = 'chunks_backfill'").run();
  db.close();
  return t;
}

describe('history backfill', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('upgrading a version-1 store chunks every existing message once', () => {
    t = versionOneStore(7);
    t.store = HistoryStore.open(t.dbPath);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 7);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '\"w5\"'").get().n, 1);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'chunks_backfill'").get().n, 0, 'marker cleared when done');
    db.close();
  });

  it('resumes after a failed batch without duplicating chunks', () => {
    t = versionOneStore(7);
    // The backfill open() starts fails once, on the 4th message (second batch of two).
    const original = HistoryStore.prototype._indexMessage;
    let failed = false;
    HistoryStore.prototype._indexMessage = function patched(db, chatId, message) {
      if (!failed && message.id === 'chat-1-m4') {
        failed = true;
        throw new Error('crash mid-backfill');
      }
      return original.call(this, db, chatId, message);
    };
    try {
      assert.throws(() => HistoryStore.open(t.dbPath, { backfillBatchSize: 2 }), /crash mid-backfill/);
    } finally {
      HistoryStore.prototype._indexMessage = original;
    }
    let db = readDb(t.dbPath);
    const marker = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'chunks_backfill'").get().value);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 2, 'first batch committed');
    assert.ok(marker.cursor > 0 && marker.cursor < marker.until);
    db.close();

    t.store = HistoryStore.open(t.dbPath, { backfillBatchSize: 2 });
    db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 7);
    assert.strictEqual(db.prepare('SELECT count(DISTINCT message_id) AS n FROM chunks').get().n, 7);
    db.close();
  });

  it('messages appended after the upgrade are indexed once, not again by the backfill', () => {
    t = versionOneStore(3);
    t.store = HistoryStore.open(t.dbPath);
    t.store.appendMessage('chat-1', { id: 'late', sender: 'user', text: text(99), timestamp: '2026-01-02T00:00:00.000Z' }, {});
    assert.deepStrictEqual(t.store.backfillChunks(), { indexed: 0, total: 0 });
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM chunks WHERE message_id = 'late'").get().n, 1);
    db.close();
  });

  it('a new, empty store writes no marker', () => {
    t = openTempStore();
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'chunks_backfill'").get().n, 0);
    db.close();
  });
});

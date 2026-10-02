// tests/history-backfill.test.js
// Messages H1 stored before schema step 2 are chunked after startup, a batch
// per call (and a batch per tick from startChunkBackfill), resumably (H2
// contract; spec §11.1 "a crash midway resumes"). open() never backfills.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { startChunkBackfill } = require('../src/history/backfill');
const { openTempStore, seedChat, readDb, downgradeToVersion1 } = require('./helpers/history-fixture');
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
  downgradeToVersion1(db);
  db.prepare("DELETE FROM meta WHERE key = 'chunks_backfill'").run();
  db.close();
  return t;
}

const chunkCount = (dbPath) => {
  const db = readDb(dbPath);
  try { return db.prepare('SELECT count(*) AS n FROM chunks').get().n; } finally { db.close(); }
};

// Batches until done, as startChunkBackfill does a tick at a time.
function runToEnd(store, options) {
  let indexed = 0;
  for (let i = 0; i < 1000; i += 1) {
    const step = store.backfillChunks(options);
    indexed += step.indexed;
    if (step.done) return indexed;
  }
  throw new Error('backfill never finished');
}

describe('history backfill', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('open() upgrades a version-1 store without chunking; each backfillChunks call is one batch', () => {
    t = versionOneStore(7);
    t.store = HistoryStore.open(t.dbPath, { backfillBatchSize: 2 });
    assert.strictEqual(chunkCount(t.dbPath), 0, 'open does not backfill');
    // One query per batch: no per-message read.
    const original = HistoryStore.prototype._messagesFor;
    HistoryStore.prototype._messagesFor = () => { throw new Error('per-message read'); };
    let first;
    try {
      first = t.store.backfillChunks({ batchSize: 3 });
    } finally {
      HistoryStore.prototype._messagesFor = original;
    }
    assert.deepStrictEqual(first, { indexed: 3, done: false, remaining: 4 });
    assert.strictEqual(chunkCount(t.dbPath), 3);
    assert.strictEqual(runToEnd(t.store, { batchSize: 3 }), 4);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 7);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '\"w5\"'").get().n, 1);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'chunks_backfill'").get().n, 0, 'marker cleared when done');
    db.close();
  });

  it('resumes after a failed batch without duplicating chunks', () => {
    t = versionOneStore(7);
    t.store = HistoryStore.open(t.dbPath);
    // The backfill fails once, on the 4th message (second batch of two).
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
      assert.throws(() => runToEnd(t.store, { batchSize: 2 }), /crash mid-backfill/);
    } finally {
      HistoryStore.prototype._indexMessage = original;
    }
    t.store.close();
    let db = readDb(t.dbPath);
    const marker = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'chunks_backfill'").get().value);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 2, 'first batch committed');
    assert.ok(marker.cursor > 0 && marker.cursor < marker.until);
    db.close();

    t.store = HistoryStore.open(t.dbPath);
    runToEnd(t.store, { batchSize: 2 });
    db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 7);
    assert.strictEqual(db.prepare('SELECT count(DISTINCT message_id) AS n FROM chunks').get().n, 7);
    db.close();
  });

  it('messages appended after the upgrade are indexed once, not again by the backfill', () => {
    t = versionOneStore(3);
    t.store = HistoryStore.open(t.dbPath);
    t.store.appendMessage('chat-1', { id: 'late', sender: 'user', text: text(99), timestamp: '2026-01-02T00:00:00.000Z' }, {});
    assert.strictEqual(runToEnd(t.store), 3);
    assert.deepStrictEqual(t.store.backfillChunks(), { indexed: 0, done: true, remaining: 0 });
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM chunks WHERE message_id = 'late'").get().n, 1);
    db.close();
  });

  it('startChunkBackfill runs a batch per tick, logs progress, and search finds only what is indexed', async () => {
    t = versionOneStore(7);
    t.store = HistoryStore.open(t.dbPath);
    const ticks = [];
    const lines = [];
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(`warn ${m}`) };
    const run = startChunkBackfill(t.store, { batchSize: 2, logEvery: 2, log, schedule: (fn) => ticks.push(fn) });
    assert.strictEqual(chunkCount(t.dbPath), 0, 'nothing runs synchronously');
    ticks.shift()();
    assert.strictEqual(chunkCount(t.dbPath), 2);
    assert.deepStrictEqual(t.store.searchText('w7', {}), [], 'not indexed yet');
    while (ticks.length) ticks.shift()();
    const result = await run.done;
    assert.deepStrictEqual(result, { indexed: 7, finished: true });
    assert.strictEqual(chunkCount(t.dbPath), 7);
    assert.strictEqual(t.store.searchText('w7', {}).length, 1);
    assert.ok(lines.some((l) => /Indexed 4 of 7/.test(l)), lines.join('|'));
    assert.match(lines[lines.length - 1], /Indexed all 7 stored messages/);
  });

  it('closing the store or stop() ends the backfill; read-only and in-memory stores never backfill', async () => {
    t = versionOneStore(7);
    t.store = HistoryStore.open(t.dbPath);
    const ticks = [];
    const run = startChunkBackfill(t.store, { batchSize: 2, schedule: (fn) => ticks.push(fn), log: { info() {}, warn() {} } });
    ticks.shift()();
    t.store.close();
    while (ticks.length) ticks.shift()();
    assert.deepStrictEqual(await run.done, { indexed: 2, finished: false });

    t.store = HistoryStore.open(t.dbPath, { readonly: true });
    const ro = startChunkBackfill(t.store, { schedule: () => assert.fail('scheduled a read-only backfill') });
    assert.deepStrictEqual(await ro.done, { indexed: 0, finished: false });
    t.store.close();

    const memory = HistoryStore.open(':memory:');
    const mem = startChunkBackfill(memory, { schedule: () => assert.fail('scheduled an in-memory backfill') });
    assert.deepStrictEqual(await mem.done, { indexed: 0, finished: false });
    memory.close();

    t.store = HistoryStore.open(t.dbPath);
    const ticks2 = [];
    const again = startChunkBackfill(t.store, { batchSize: 2, schedule: (fn) => ticks2.push(fn), log: { info() {}, warn() {} } });
    again.stop();
    while (ticks2.length) ticks2.shift()();
    assert.deepStrictEqual(await again.done, { indexed: 0, finished: false });
  });

  it('a new, empty store writes no marker', () => {
    t = openTempStore();
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'chunks_backfill'").get().n, 0);
    db.close();
  });
});

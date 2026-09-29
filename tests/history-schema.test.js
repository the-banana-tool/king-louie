// tests/history-schema.test.js
// The history store's schema steps and its connection (recall spec §4.1, H1).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { SCHEMA_STEPS: ALL_STEPS, applySchema, currentVersion, latestVersion } = require('../src/history/schema');

// These tests cover H1's step; later stages' steps have their own tests.
const SCHEMA_STEPS = ALL_STEPS.slice(0, 1);

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) stores.pop().close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-history-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'history.sqlite');
}
function open(p, options) {
  const store = HistoryStore.open(p, options);
  stores.push(store);
  return store;
}
const pragma = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];

describe('history schema steps', () => {
  it('creates the H1 tables and records version 1 once', () => {
    const db = new DatabaseSync(':memory:');
    assert.strictEqual(applySchema(db, SCHEMA_STEPS), 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.deepStrictEqual(tables, ['attachments', 'chats', 'messages', 'meta', 'schema_version']);
    assert.strictEqual(applySchema(db, SCHEMA_STEPS), 1, 'a second run changes nothing');
    assert.deepStrictEqual(db.prepare('SELECT version FROM schema_version').all().map((r) => r.version), [1]);
    assert.strictEqual(latestVersion(), ALL_STEPS.length);
    db.close();
  });

  it('gives chats a position and messages a unique (chat_id, seq)', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db, SCHEMA_STEPS);
    const chatCols = db.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
    assert.ok(chatCols.includes('position'));
    assert.ok(chatCols.includes('history_scope'));
    db.exec("INSERT INTO chats (id, position, title) VALUES ('c1', 0, 'One')");
    db.exec("INSERT INTO messages (id, chat_id, seq, sender, timestamp) VALUES ('m1', 'c1', 1, 'user', 't')");
    assert.throws(() => db.exec("INSERT INTO messages (id, chat_id, seq, sender, timestamp) VALUES ('m2', 'c1', 1, 'user', 't')"), /UNIQUE/);
    db.close();
  });

  it('runs only the pending steps, in order', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db, SCHEMA_STEPS);
    const ran = [];
    const steps = [...SCHEMA_STEPS, { version: 2, up(d) { ran.push(2); d.exec('CREATE TABLE extra (x TEXT)'); } }];
    assert.strictEqual(applySchema(db, steps), 2);
    assert.strictEqual(applySchema(db, steps), 2);
    assert.deepStrictEqual(ran, [2]);
    assert.strictEqual(currentVersion(db), 2);
    db.close();
  });

  it('rolls a failing step back and keeps the stored version', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(db, SCHEMA_STEPS);
    const steps = [...SCHEMA_STEPS, { version: 2, up(d) { d.exec('CREATE TABLE half (x TEXT)'); throw new Error('step failed'); } }];
    assert.throws(() => applySchema(db, steps), /step failed/);
    assert.strictEqual(currentVersion(db), 1);
    assert.strictEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
    db.close();
  });

  it('refuses a file from a newer King Louie and leaves it as it was', () => {
    const p = tempDbPath();
    open(p).close();
    const raw = new DatabaseSync(p);
    raw.exec('UPDATE schema_version SET version = 99');
    raw.close();
    assert.throws(() => HistoryStore.open(p), (err) => err.code === 'HISTORY_SCHEMA_NEWER');
    const check = new DatabaseSync(p);
    assert.strictEqual(check.prepare('SELECT version FROM schema_version').get().version, 99);
    check.close();
  });
});

describe('HistoryStore connection', () => {
  it('opens a file store in WAL mode with a 5 s busy timeout and foreign keys on, creating its folder', () => {
    const p = tempDbPath();
    const store = open(p);
    assert.ok(fs.existsSync(p));
    assert.strictEqual(pragma(store.db, 'journal_mode'), 'wal');
    assert.strictEqual(pragma(store.db, 'busy_timeout'), 5000);
    assert.strictEqual(pragma(store.db, 'foreign_keys'), 1);
    assert.strictEqual(store.isOpen, true);
  });

  it('opens :memory: without WAL', () => {
    const store = open(':memory:');
    assert.notStrictEqual(pragma(store.db, 'journal_mode'), 'wal');
    assert.strictEqual(pragma(store.db, 'foreign_keys'), 1);
  });

  it('keeps meta values and overwrites them', () => {
    const store = open(':memory:');
    assert.strictEqual(store.getMeta('migrated_from_json'), null);
    store.setMeta('migrated_from_json', '2026-09-29T12:00:00.000Z');
    store.setMeta('migrated_from_json', '2026-09-30T12:00:00.000Z');
    assert.strictEqual(store.getMeta('migrated_from_json'), '2026-09-30T12:00:00.000Z');
  });

  it('commits, rolls back, and nests transactions as savepoints', () => {
    const store = open(':memory:');
    assert.strictEqual(store.transaction((db) => { assert.strictEqual(db, store.db); store.setMeta('a', '1'); return 42; }), 42);
    assert.throws(() => store.transaction(() => { store.setMeta('b', '2'); throw new Error('boom'); }), /boom/);
    assert.strictEqual(store.getMeta('a'), '1');
    assert.strictEqual(store.getMeta('b'), null);
    store.transaction(() => {
      store.setMeta('outer', 'kept');
      assert.throws(() => store.transaction(() => { store.setMeta('inner', 'dropped'); throw new Error('inner'); }), /inner/);
    });
    assert.strictEqual(store.getMeta('outer'), 'kept');
    assert.strictEqual(store.getMeta('inner'), null);
  });

  it('refuses an async transaction function and rolls its writes back', () => {
    const store = open(':memory:');
    assert.throws(() => store.transaction(() => { store.setMeta('x', '1'); return Promise.resolve(); }), TypeError);
    assert.strictEqual(store.getMeta('x'), null);
  });

  it('closes once and refuses work afterwards', () => {
    const store = open(':memory:');
    store.close();
    store.close();
    assert.strictEqual(store.isOpen, false);
    assert.throws(() => store.transaction(() => {}), /closed/);
  });

  it('opens read-only: reads, never writes', () => {
    const p = tempDbPath();
    const writer = open(p);
    writer.setMeta('k', 'v');
    writer.close();
    const reader = open(p, { readonly: true });
    assert.strictEqual(reader.readonly, true);
    assert.strictEqual(reader.getMeta('k'), 'v');
    assert.throws(() => reader.setMeta('k', 'w'), /readonly|read-only/i);
  });
});

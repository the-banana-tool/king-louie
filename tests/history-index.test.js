// tests/history-index.test.js
// Schema step 2 and indexing inside appendMessage (recall spec §4.1, §5.1).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';
const ftsCount = (db, term) => db.prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?').get(`"${term}"`).n;

describe('history index: schema step 2', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('creates chunks, chunks_fts and calibration (schema 2) and is at version 3', () => {
    t = openTempStore();
    const db = readDb(t.dbPath);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map((r) => r.name);
    for (const name of ['chunks', 'chunks_fts', 'calibration', 'chunks_ai', 'chunks_ad', 'chunks_au']) assert.ok(names.includes(name), name);
    assert.strictEqual(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 3);
    db.close();
  });

  it('appendMessage writes the chunks and their FTS rows in the same transaction', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }, { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat src/app.js' } }] });
    const db = readDb(t.dbPath);
    const rows = db.prepare('SELECT message_id, chat_id, idx, kind, text, chars, ts FROM chunks ORDER BY id').all();
    assert.deepStrictEqual(rows.map((r) => [r.message_id, r.chat_id, r.idx, r.kind]), [['chat-1-m1', 'chat-1', 0, 'user'], ['chat-1-m2', 'chat-1', 0, 'tool_use']]);
    assert.strictEqual(rows[0].chars, GATE.length);
    assert.strictEqual(rows[0].ts, '2026-01-01T09:00:00.000Z');
    assert.strictEqual(ftsCount(db, '4417'), 1);
    assert.strictEqual(ftsCount(db, 'src/app.js'), 1, 'the full path matches as a phrase');
    assert.strictEqual(ftsCount(db, 'app.js'), 1, 'a file name matches alone: / is a separator');
    db.close();
  });

  it('a failed index rolls the message back and throws', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }] });
    t.store._indexMessage = () => { throw new Error('index failed'); };
    assert.throws(() => t.store.appendMessage('chat-1', { id: 'x1', sender: 'user', text: GATE, timestamp: '2026-01-02T00:00:00.000Z' }), /index failed/);
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM messages WHERE chat_id = 'chat-1'").get().n, 1);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM messages WHERE id = 'x1'").get().n, 0);
    db.close();
  });

  it('truncateFrom and deleteChat remove chunks and FTS rows; the index stays consistent', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: 'The north fence line is forty meters long, measured twice.' }, { sender: 'assistant', text: GATE }] });
    seedChat(t.store, { id: 'chat-2', messages: [{ sender: 'user', text: 'A second chat mentions the 4417 code too, in its own words.' }] });
    t.store.truncateFrom('chat-1', 2);
    let db = readDb(t.dbPath);
    assert.strictEqual(ftsCount(db, 'fence'), 1);
    assert.strictEqual(ftsCount(db, '4417'), 1, 'only chat-2 still has it');
    db.close();
    t.store.deleteChat('chat-2');
    db = readDb(t.dbPath);
    assert.strictEqual(ftsCount(db, '4417'), 0);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 1);
    db.close();
    // integrity-check needs a writable connection: use the store's own.
    assert.doesNotThrow(() => t.store.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')"));
  });

  it('chunkOptions from open() are used for every insert', () => {
    t = openTempStore({ chunkOptions: () => ({ targetChars: 300, minChars: 5 }) });
    seedChat(t.store, { messages: [{ sender: 'user', text: `tiny\n\n${'z'.repeat(20)}` }, { sender: 'user', text: 'y'.repeat(900) }] });
    const db = readDb(t.dbPath);
    assert.deepStrictEqual(db.prepare("SELECT text FROM chunks WHERE message_id = 'chat-1-m1'").all().map((r) => r.text), ['z'.repeat(20)],
      '"tiny" is under minChars 5; the 20-character fragment is not (the default 40 would drop it)');
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM chunks WHERE message_id = 'chat-1-m2'").get().n, 3);
    db.close();
  });
});

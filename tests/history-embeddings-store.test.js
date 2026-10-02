// tests/history-embeddings-store.test.js
// Schema step 3 and the store's embedding methods (recall spec §4.1, §5.2).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { HistoryStore } = require('../src/history');
const { vecToBlob, blobToVec, unit, embedInput, MAX_EMBED_CHARS } = require('../src/history/embedders/vectors');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');

const KEY = 'local:Xenova/bge-small-en-v1.5';
const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';
const vec = (...xs) => unit(xs);

describe('vectors', () => {
  it('stores little-endian float32 and reads it back', () => {
    const blob = vecToBlob(Float32Array.from([1, -2.5]));
    assert.strictEqual(Buffer.from(blob).toString('hex'), '0000803f000020c0');
    assert.deepStrictEqual(Array.from(blobToVec(new Uint8Array(blob))), [1, -2.5]);
  });

  it('unit() normalises, keeps a zero vector, refuses NaN and empty', () => {
    const v = unit([3, 4]);
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
    assert.deepStrictEqual(Array.from(unit([0, 0])), [0, 0]);
    assert.throws(() => unit([NaN, 1]), (err) => err.code === 'EMBED_FAILED');
    assert.throws(() => unit([]), (err) => err.code === 'EMBED_FAILED');
  });

  it('embedInput() cuts at MAX_EMBED_CHARS and never sends an empty string', () => {
    assert.strictEqual(embedInput('x'.repeat(MAX_EMBED_CHARS + 10)).length, MAX_EMBED_CHARS);
    assert.strictEqual(embedInput('   '), ' ');
    assert.strictEqual(embedInput(null), ' ');
  });
});

describe('the embeddings table', () => {
  let t;
  afterEach(() => t && t.cleanup());

  it('schema step 3 adds it; an H2 store upgrades with every chunk pending', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }, { sender: 'assistant', text: 'Noted, the gate code is saved for the site visit.' }] });
    const db = readDb(t.dbPath);
    assert.strictEqual(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 3);
    assert.deepStrictEqual(db.prepare("SELECT name FROM pragma_table_info('embeddings') ORDER BY cid").all().map((r) => r.name), ['chunk_id', 'model', 'dim', 'vec']);
    db.close();
    t.store.close();
    const raw = new DatabaseSync(t.dbPath);
    raw.exec('DROP TABLE embeddings; UPDATE schema_version SET version = 2;');
    raw.close();
    t.store = HistoryStore.open(t.dbPath);
    assert.strictEqual(t.store.embeddable, true);
    assert.strictEqual(t.store.countPending(KEY), 2);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
  });

  it('put, pending and vectorRows round-trip; a tombstone is never pending and never a vector', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [
      { sender: 'user', text: GATE },
      { sender: 'assistant', text: 'The north fence is forty meters.' },
      { sender: 'user', text: 'And the drainage pipe?' }
    ] });
    const pending = t.store.pendingEmbeddings(KEY, { limit: 10 });
    assert.deepStrictEqual(pending.map((r) => r.kind), ['user', 'assistant', 'user']);
    assert.strictEqual(pending[0].text, GATE);
    assert.strictEqual(pending[0].chatId, 'chat-1');
    assert.strictEqual(t.store.putEmbeddings(KEY, [{ chunkId: pending[0].id, vec: vec(1, 0) }, { chunkId: pending[1].id, vec: null }]), 2);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10 }).map((r) => r.id), [pending[2].id]);
    assert.strictEqual(t.store.countEmbedded(KEY), 1, 'a tombstone is not a vector');
    const rows = [...t.store.vectorRows(KEY, 'chat-1')];
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].chunkId, pending[0].id);
    assert.strictEqual(rows[0].seq, 1);
    assert.strictEqual(rows[0].kind, 'user');
    assert.strictEqual(rows[0].dim, 2);
    assert.deepStrictEqual(Array.from(blobToVec(rows[0].vec)), [1, 0]);
    assert.deepStrictEqual([...t.store.vectorRows(KEY, 'chat-1', { afterRowid: rows[0].rowid })], []);
    assert.strictEqual(t.store.countPending('openai:text-embedding-3-small'), 3, 'another key has rows of its own');
  });

  it('pending: the preferred chat newest first, else by id after the cursor', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: 'first gate note' }, { sender: 'user', text: 'second gate note' }] });
    seedChat(t.store, { id: 'chat-2', messages: [{ sender: 'user', text: 'other chat fence note' }] });
    const all = t.store.pendingEmbeddings(KEY, { limit: 10 });
    assert.deepStrictEqual(all.map((r) => r.chatId), ['chat-1', 'chat-1', 'chat-2']);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10, chatId: 'chat-1' }).map((r) => r.id), [all[1].id, all[0].id]);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10, afterId: all[0].id }).map((r) => r.id), [all[1].id, all[2].id]);
    assert.strictEqual(t.store.pendingEmbeddings(KEY, { limit: 1 }).length, 1);
  });

  it('maxChunksPerToolResult caps the chunks of one tool result that are embedded', () => {
    t = openTempStore();
    const long = Array.from({ length: 5 }, (_, i) => `Section ${i + 1} of the survey output. ${'drainage reading '.repeat(100)}`).join('\n\n');
    seedChat(t.store, { messages: [{ sender: 'toolResult', toolName: 'Bash', result: long }] });
    assert.strictEqual(t.store.chunksOfChat('chat-1').length, 5);
    assert.strictEqual(t.store.countPending(KEY), 5);
    assert.strictEqual(t.store.countPending(KEY, { maxChunksPerToolResult: 2 }), 2);
    assert.deepStrictEqual(t.store.pendingEmbeddings(KEY, { limit: 10, maxChunksPerToolResult: 2 }).map((r) => r.text.slice(0, 9)), ['Section 1', 'Section 2']);
  });

  it('never holds a Vault call or result: they make no chunks, so nothing of them is pending', () => {
    t = openTempStore();
    const SECRET = 'sk-live-lakeside-4417-secret';
    seedChat(t.store, { messages: [
      { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'store', key: 'gate', value: SECRET } },
      { sender: 'toolResult', toolName: 'Vault', result: { ok: true, value: SECRET } },
      { sender: 'user', text: 'Thanks, the gate key is stored.' }
    ] });
    const pending = t.store.pendingEmbeddings(KEY, { limit: 50 });
    assert.deepStrictEqual(pending.map((r) => r.kind), ['user']);
    assert.ok(pending.every((r) => !r.text.includes(SECRET)));
    assert.strictEqual(t.store.countPending(KEY), 1);
  });

  it('truncate and delete cascade to the vectors and bump vectorEpoch; a vector for a gone chunk is not written', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }, { sender: 'user', text: 'The fence is forty meters.' }] });
    const [a, b] = t.store.pendingEmbeddings(KEY, { limit: 10 });
    t.store.putEmbeddings(KEY, [{ chunkId: a.id, vec: vec(1, 0) }, { chunkId: b.id, vec: vec(0, 1) }]);
    const e0 = t.store.vectorEpoch;
    t.store.truncateFrom('chat-1', 2);
    assert.ok(t.store.vectorEpoch > e0);
    assert.strictEqual(t.store.countEmbedded(KEY), 1);
    assert.strictEqual(t.store.putEmbeddings(KEY, [{ chunkId: b.id, vec: vec(0, 1) }]), 0, 'no row for a chunk that is gone, no FK error');
    const e1 = t.store.vectorEpoch;
    t.store.deleteChat('chat-1');
    assert.ok(t.store.vectorEpoch > e1);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
  });

  it('deleteEmbeddings removes one key only and bumps vectorEpoch', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }] });
    const [row] = t.store.pendingEmbeddings(KEY, { limit: 1 });
    t.store.putEmbeddings(KEY, [{ chunkId: row.id, vec: vec(1, 0) }]);
    t.store.putEmbeddings('ollama:nomic-embed-text', [{ chunkId: row.id, vec: vec(0, 1) }]);
    const e0 = t.store.vectorEpoch;
    assert.strictEqual(t.store.deleteEmbeddings(KEY), 1);
    assert.ok(t.store.vectorEpoch > e0);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
    assert.strictEqual(t.store.countEmbedded('ollama:nomic-embed-text'), 1);
  });

  it('createChat bumps vectorEpoch only when it replaces an existing chat', () => {
    t = openTempStore();
    const e0 = t.store.vectorEpoch;
    t.store.createChat({ id: 'c-new', title: 'New chat', messages: [] });
    assert.strictEqual(t.store.vectorEpoch, e0, 'a new chat removes no vector');
    t.store.createChat({ id: 'c-new', title: 'The same id again', messages: [] });
    assert.ok(t.store.vectorEpoch > e0, 'replacing a chat can remove vectors');
  });

  it('onAppend fires after the append with the chat and seq; a throwing listener does not fail the append', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [] });
    const seen = [];
    const off = t.store.onAppend((chatId, seq) => seen.push([chatId, seq, t.store.chunksOfChat(chatId).length]));
    t.store.onAppend(() => { throw new Error('listener bug'); });
    const out = t.store.appendMessage('chat-1', { id: 'x1', sender: 'user', text: GATE, timestamp: '2026-01-01T09:00:00.000Z' });
    assert.strictEqual(out.seq, 1);
    assert.deepStrictEqual(seen, [['chat-1', 1, 1]]);
    off();
    t.store.appendMessage('chat-1', { id: 'x2', sender: 'user', text: 'again', timestamp: '2026-01-01T09:01:00.000Z' });
    assert.strictEqual(seen.length, 1);
  });

  it('a read-only store writes no vectors', () => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }] });
    const [row] = t.store.pendingEmbeddings(KEY, { limit: 1 });
    t.store.close();
    t.store = HistoryStore.open(t.dbPath, { readonly: true });
    assert.strictEqual(t.store.putEmbeddings(KEY, [{ chunkId: row.id, vec: vec(1, 0) }]), 0);
    assert.strictEqual(t.store.countEmbedded(KEY), 0);
  });
});

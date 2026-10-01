// tests/history-vector-index.test.js
// VectorIndex (recall spec §5.3): brute-force cosine that matches a direct
// computation, filters, appends extending the matrix, reuse of chunk ids
// after a truncate, the vectorCacheMb cap (a chat too big alone, LRU).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { VectorIndex } = require('../src/history/vector-index');
const { unit, blobToVec } = require('../src/history/embedders/vectors');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

const KEY = 'fake:bow';
const bow = createBagOfWordsEmbedder();
const q = async (text) => unit((await bow.embed([text]))[0]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function embedAll(store, key = KEY) {
  for (;;) {
    const rows = store.pendingEmbeddings(key, { limit: 100 });
    if (!rows.length) return;
    const vecs = await bow.embed(rows.map((r) => r.text));
    store.putEmbeddings(key, rows.map((r, i) => ({ chunkId: r.id, vec: unit(vecs[i]) })));
  }
}

const TEXTS = [
  { sender: 'user', text: 'The linen bandage goes in the canopic jar.' },
  { sender: 'assistant', text: 'Salt and natron dry the body first.' },
  { sender: 'user', text: 'The mask and the amulet stay with the mummy.' },
  { sender: 'assistant', text: 'Linen wrapping and resin for the mummy.' },
  { sender: 'user', text: 'The gate code at the lot is 4417.' },
  { sender: 'assistant', text: 'A linen bandage for the priest.' }
];
const quietLog = (warns = []) => ({ warn: (m) => warns.push(m), info() {}, debug() {} });

describe('VectorIndex', () => {
  let t;
  afterEach(() => { if (t) t.cleanup(); t = null; });

  it('search matches a direct cosine top-k, ranks from 1', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS });
    await embedAll(t.store);
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    const query = await q('linen bandage');
    const hits = index.search({ model: KEY, query, chatIds: ['chat-1'], k: 3 });
    const direct = [...t.store.vectorRows(KEY, 'chat-1')]
      .map((r) => ({ id: r.chunkId, s: dot(blobToVec(r.vec), query) }))
      .sort((a, b) => b.s - a.s || a.id - b.id)
      .slice(0, 3);
    assert.deepStrictEqual(hits.map((h) => h.chunkId), direct.map((d) => d.id));
    assert.deepStrictEqual(hits.map((h) => h.vectorRank), [1, 2, 3]);
    assert.ok(Math.abs(hits[0].cosine - direct[0].s) < 1e-6);
  });

  it('holds hits to upToSeq and the kinds', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS });
    await embedAll(t.store);
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    const query = await q('linen bandage');
    const early = index.search({ model: KEY, query, chatIds: ['chat-1'], upToSeq: 4, k: 10 });
    const seqOf = new Map(t.store.chunksOfChat('chat-1').map((c) => [c.id, c.seq]));
    assert.ok(early.length > 0 && early.every((h) => seqOf.get(h.chunkId) < 4));
    const assistant = index.search({ model: KEY, query, chatIds: ['chat-1'], kinds: ['assistant'], k: 10 });
    const kindOf = new Map(t.store.chunksOfChat('chat-1').map((c) => [c.id, c.kind]));
    assert.ok(assistant.length > 0 && assistant.every((h) => kindOf.get(h.chunkId) === 'assistant'));
    assert.deepStrictEqual(index.search({ model: 'other:key', query, chatIds: ['chat-1'] }), []);
  });

  it('appends extend the loaded matrix without reading it again', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS });
    await embedAll(t.store);
    const reads = [];
    const original = t.store.vectorRows.bind(t.store);
    t.store.vectorRows = (model, chatId, opts) => { reads.push(opts.afterRowid); return original(model, chatId, opts); };
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    const query = await q('coffin tomb');
    assert.ok(index.search({ model: KEY, query, chatIds: ['chat-1'], k: 1 }).every((h) => h.cosine === 0), 'nothing about a coffin yet');
    t.store.appendMessage('chat-1', { id: 'new-1', sender: 'user', text: 'The coffin is in the tomb.', timestamp: '2026-01-02T09:00:00.000Z' });
    await embedAll(t.store);
    const [hit] = index.search({ model: KEY, query, chatIds: ['chat-1'], k: 1 });
    assert.strictEqual(t.store.chunks([hit.chunkId])[0].messageId, 'new-1');
    assert.strictEqual(reads[0], 0);
    assert.ok(reads.at(-1) > 0, 'only rows after the last one read');
  });

  it('a truncate lets a new chunk reuse an old id: the cached vector is dropped, never served stale', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS.slice(0, 3) });
    await embedAll(t.store);
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    index.search({ model: KEY, query: await q('linen'), chatIds: ['chat-1'] });
    const oldId = t.store.chunksOfMessage('chat-1-m2')[0].id;
    t.store.truncateFrom('chat-1', 2);
    t.store.appendMessage('chat-1', { id: 'fresh', sender: 'user', text: 'The priest and the resin.', timestamp: '2026-01-03T09:00:00.000Z' });
    await embedAll(t.store);
    const fresh = t.store.chunksOfMessage('fresh')[0];
    assert.strictEqual(fresh.id, oldId, 'SQLite reused the id (the case this test is for)');
    const [hit] = index.search({ model: KEY, query: await q('priest resin'), chatIds: ['chat-1'], k: 1 });
    assert.strictEqual(hit.chunkId, fresh.id);
    const stored = blobToVec([...t.store.vectorRows(KEY, 'chat-1')].find((r) => r.chunkId === fresh.id).vec);
    assert.deepStrictEqual(Array.from(index.vectorOf(KEY, fresh)), Array.from(stored));
  });

  it('a chat whose vectors alone exceed vectorCacheMb is not searched by vector, with one warning; memory stays under the cap', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: Array.from({ length: 300 }, (_, i) => ({ sender: 'user', text: `linen note ${i} for the tomb` })) });
    seedChat(t.store, { id: 'small', messages: TEXTS.slice(0, 2) });
    await embedAll(t.store);
    const warns = [];
    // 300 rows × (28 × 4 + 9) bytes ≈ 36 KB, over a 0.03 MB (31 KB) cap.
    const index = new VectorIndex({ store: t.store, getCapMb: () => 0.03, log: quietLog(warns) });
    const query = await q('linen');
    assert.deepStrictEqual(index.search({ model: KEY, query, chatIds: ['chat-1'] }), []);
    assert.strictEqual(index.skipped(KEY, 'chat-1'), true);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /vectorCacheMb/);
    index.search({ model: KEY, query, chatIds: ['chat-1'] });
    assert.strictEqual(warns.length, 1, 'warned once');
    assert.ok(index.search({ model: KEY, query, chatIds: ['small'] }).length > 0, 'a small chat is still searched');
    assert.ok(index.stats().bytes <= index.stats().capBytes);
  });

  it('evicts the least recently used chat to stay under the cap', async () => {
    t = openTempStore();
    for (const id of ['a', 'b', 'c']) seedChat(t.store, { id, messages: TEXTS.slice(0, 4) });
    await embedAll(t.store);
    // Each chat's matrix is 64 rows of capacity × 121 bytes ≈ 7.7 KB; 0.02 MB holds two.
    const index = new VectorIndex({ store: t.store, getCapMb: () => 0.02, log: quietLog() });
    const query = await q('linen');
    index.search({ model: KEY, query, chatIds: ['a'] });
    index.search({ model: KEY, query, chatIds: ['b'] });
    index.search({ model: KEY, query, chatIds: ['a'] });
    index.search({ model: KEY, query, chatIds: ['c'] });
    assert.strictEqual(index.stats().chats, 2);
    assert.ok(index.stats().bytes <= index.stats().capBytes);
    const chunkOfB = t.store.chunksOfChat('b')[0];
    assert.strictEqual(index.vectorOf(KEY, chunkOfB), null, 'b was the least recently used');
    assert.ok(index.vectorOf(KEY, t.store.chunksOfChat('a')[0]), 'a stayed');
  });

  it('a lowered vectorCacheMb evicts on the next search, so memory stays under the new cap', async () => {
    t = openTempStore();
    for (const id of ['a', 'b']) seedChat(t.store, { id, messages: TEXTS.slice(0, 4) });
    await embedAll(t.store);
    let capMb = 0.02;
    const index = new VectorIndex({ store: t.store, getCapMb: () => capMb, log: quietLog() });
    const query = await q('linen');
    index.search({ model: KEY, query, chatIds: ['a'] });
    index.search({ model: KEY, query, chatIds: ['b'] });
    assert.strictEqual(index.stats().chats, 2);
    capMb = 0.01;
    assert.ok(index.search({ model: KEY, query, chatIds: ['b'] }).length > 0);
    assert.strictEqual(index.stats().chats, 1);
    assert.ok(index.stats().bytes <= index.stats().capBytes);
    assert.strictEqual(index.vectorOf(KEY, t.store.chunksOfChat('a')[0]), null, 'a was the least recently used');
  });

  it('a store error while loading drops the half-loaded matrix; the next search loads it whole', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: TEXTS });
    await embedAll(t.store);
    const index = new VectorIndex({ store: t.store, log: quietLog() });
    const query = await q('linen bandage');
    const real = t.store.vectorRows.bind(t.store);
    t.store.vectorRows = function* (...args) {
      const [first] = real(...args);
      yield first;
      throw new Error('database disk image is malformed');
    };
    assert.throws(() => index.search({ model: KEY, query, chatIds: ['chat-1'], k: 6 }), /malformed/);
    assert.deepStrictEqual([index.stats().chats, index.stats().bytes], [0, 0], 'no half-loaded entry is kept');
    t.store.vectorRows = real;
    assert.strictEqual(index.search({ model: KEY, query, chatIds: ['chat-1'], k: 6 }).length, 6, 'reloaded from scratch');
  });
});

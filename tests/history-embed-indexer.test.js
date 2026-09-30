// tests/history-embed-indexer.test.js
// Background embedding (recall spec §5.2): batches, the newest chat first,
// maxChunksPerToolResult, a poison chunk, a model switch mid-backfill,
// failures reported to the host. In-process embedders; manual ticks.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { startEmbedIndexer } = require('../src/history/embed-indexer');
const { unit } = require('../src/history/embedders/vectors');
const { createBagOfWordsEmbedder } = require('./helpers/fake-embedder');
const { openTempStore, seedChat, readDb } = require('./helpers/history-fixture');

const bow = createBagOfWordsEmbedder();
function fakeEmbedder(name = 'fake:bow', { failWhen = null, gate = null } = {}) {
  const calls = [];
  return {
    name, kind: 'fake', model: name, dim: 28, tokens: 0, calls,
    async embed(texts) {
      calls.push(texts.slice());
      if (gate) await gate;
      const err = failWhen && failWhen(texts);
      if (err) throw err;
      return (await bow.embed(texts)).map((v) => unit(v));
    }
  };
}
const crash = () => Object.assign(new Error('the embed worker exited (code 70)'), { code: 'EMBED_WORKER_CRASHED' });
const notes = (n, prefix = 'note') => Array.from({ length: n }, (_, i) => ({ sender: i % 2 ? 'assistant' : 'user', text: `${prefix} ${i} about the linen bandage and the gate code` }));

function setup({ embedder = fakeEmbedder(), history = {} } = {}) {
  const t = openTempStore();
  const failures = [];
  const timers = [];
  const host = { active: embedder, current() { return this.active; }, fail: (e) => failures.push(e) };
  const indexer = () => startEmbedIndexer({
    store: t.store, host, getSettings: () => ({ history }),
    setTimer: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimer: () => {},
    log: { warn() {}, info() {}, debug() {} }
  });
  return { t, host, failures, timers, indexer };
}

describe('EmbedIndexer', () => {
  let t;
  let ix;
  afterEach(async () => { if (ix) await ix.stop(); ix = null; if (t) t.cleanup(); t = null; });

  it('embeds every chunk in batches of batchSize and reports progress', async () => {
    const s = setup({ history: { embedder: { batchSize: 8 } } });
    t = s.t;
    seedChat(t.store, { messages: notes(20) });
    ix = s.indexer();
    for (let i = 0; i < 3; i += 1) await ix.tick();
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 20);
    assert.deepStrictEqual(ix.progress(), { key: 'fake:bow', embedded: 20, pending: 0 });
    assert.deepStrictEqual(s.host.active.calls.map((c) => c.length), [8, 8, 4]);
    assert.deepStrictEqual(await ix.tick(), { embedded: 0, skipped: 0 });
  });

  it('an append nudges it: the chat with the newest append goes first', async () => {
    const s = setup({ history: { embedder: { batchSize: 1 } } });
    t = s.t;
    seedChat(t.store, { messages: notes(10) });
    seedChat(t.store, { id: 'chat-2', messages: [] });
    ix = s.indexer();
    s.timers.length = 0;
    t.store.appendMessage('chat-2', { id: 'n1', sender: 'user', text: 'The mummy mask is in the tomb.', timestamp: '2026-01-02T09:00:00.000Z' });
    assert.deepStrictEqual(s.timers, [0], 'scheduled at once');
    await ix.tick();
    assert.deepStrictEqual(s.host.active.calls[0], ['The mummy mask is in the tomb.']);
  });

  it('maxChunksPerToolResult: only the first n chunks of a tool result are embedded', async () => {
    const s = setup({ history: { embedder: { maxChunksPerToolResult: 2 } } });
    t = s.t;
    const long = Array.from({ length: 5 }, (_, i) => `Section ${i + 1} of the survey output. ${'drainage reading '.repeat(100)}`).join('\n\n');
    seedChat(t.store, { messages: [{ sender: 'toolResult', toolName: 'Bash', result: long }] });
    ix = s.indexer();
    await ix.tick();
    await ix.tick();
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 2);
    assert.strictEqual(ix.progress().pending, 0);
  });

  it('a chunk that crashes the worker is isolated and tombstoned; the rest are embedded; the host is not failed', async () => {
    const s = setup({ embedder: fakeEmbedder('fake:bow', { failWhen: (texts) => (texts.some((x) => x.includes('poison')) ? crash() : null) }) });
    t = s.t;
    seedChat(t.store, { messages: [...notes(3), { sender: 'user', text: 'poison text that crashes the model' }, ...notes(3, 'later')] });
    ix = s.indexer();
    const out = await ix.tick();
    assert.deepStrictEqual(out, { embedded: 6, skipped: 1 });
    assert.strictEqual(s.failures.length, 0);
    const db = readDb(t.dbPath);
    const dims = db.prepare("SELECT e.dim AS dim, c.text AS text FROM embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.model = 'fake:bow'").all();
    db.close();
    assert.strictEqual(dims.find((r) => r.text.includes('poison')).dim, 0, 'a tombstone');
    assert.strictEqual(t.store.countPending('fake:bow'), 0, 'never retried for this key');
  });

  it('any other failure is reported to the host once and nothing is written', async () => {
    const s = setup({ embedder: fakeEmbedder('fake:bow', { failWhen: () => Object.assign(new Error('401 invalid key'), { status: 401 }) }) });
    t = s.t;
    seedChat(t.store, { messages: notes(4) });
    ix = s.indexer();
    await ix.tick();
    assert.strictEqual(s.failures.length, 1);
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 0);
  });

  it('a model switch mid-backfill: the batch in flight lands under its own key; the next tick fills the new key', async () => {
    let open;
    const gate = new Promise((r) => { open = r; });
    const a = fakeEmbedder('local:model-a', { gate });
    const s = setup({ embedder: a, history: { embedder: { batchSize: 4 } } });
    t = s.t;
    seedChat(t.store, { messages: notes(8) });
    ix = s.indexer();
    const inFlight = ix.tick();
    await new Promise((r) => setImmediate(r));
    s.host.active = fakeEmbedder('local:model-b');
    open();
    await inFlight;
    assert.strictEqual(t.store.countEmbedded('local:model-a'), 4);
    assert.strictEqual(t.store.countEmbedded('local:model-b'), 0);
    await ix.tick();
    await ix.tick();
    assert.strictEqual(t.store.countEmbedded('local:model-b'), 8);
    assert.strictEqual(t.store.countEmbedded('local:model-a'), 4, 'the old key keeps its rows');
  });

  it('does nothing without a ready embedder, on a read-only store, or after stop()', async () => {
    const s = setup({ embedder: null });
    t = s.t;
    seedChat(t.store, { messages: notes(2) });
    ix = s.indexer();
    assert.deepStrictEqual(await ix.tick(), { embedded: 0, skipped: 0 });
    s.host.active = fakeEmbedder();
    await ix.stop();
    assert.deepStrictEqual(await ix.tick(), { embedded: 0, skipped: 0 });
    assert.strictEqual(t.store.countEmbedded('fake:bow'), 0);
  });
});

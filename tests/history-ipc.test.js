// tests/history-ipc.test.js
// history:excerpts and history:search (recall spec §7, §12).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

const GATE = 'For the record, the side gate code at the Lakeside lot is 4417.';

describe('history IPC', () => {
  let t;
  const handlers = new Map();
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  before(() => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }, { sender: 'user', text: 'What was the gate code again, please?' }] });
    const ids = t.store.searchText('gate code', { chatIds: ['chat-1'], upToSeq: 2 }).map((h) => h.chunkId);
    t.store.appendMessage('chat-1', {
      id: 'reply-1', sender: 'assistant', text: 'It is 4417.', timestamp: '2026-01-03T09:00:00.000Z',
      context: { tail: { fromSeq: 2, toSeq: 2 }, recalledChunkIds: ids, recalledExcerpts: 1, estTokens: { system: 1, tail: 1, recalled: 1 }, fullHistoryEstTokens: 30, embedder: 'none', scope: 'chat' }
    }, {});
    const estimator = new TokenEstimator();
    registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      getHistoryStore: () => t.store,
      getHistoryRetriever: () => new Retriever({ store: t.store, estimator }),
      getSettings: () => ({})
    });
  });
  after(() => t.cleanup());

  it('history:excerpts returns the excerpts a reply was shown, as untrusted text', async () => {
    const out = await call(IPC.HISTORY_EXCERPTS, { chatId: 'chat-1', seq: 3 });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    assert.deepStrictEqual(out.excerpts, [{ seq: 1, header: '[#1 · user · 2 days ago]', text: GATE }]);
    assert.deepStrictEqual((await call(IPC.HISTORY_EXCERPTS, { chatId: 'chat-1', seq: 1 })).excerpts, []);
  });

  it('history:search searches the chat', async () => {
    const out = await call(IPC.HISTORY_SEARCH, { chatId: 'chat-1', query: 'gate code', limit: 5 });
    assert.strictEqual(out.ok, true);
    assert.ok(out.excerpts.some((e) => e.text.includes('4417')));
  });

  it('refuses a malformed payload', async () => {
    assert.strictEqual((await call(IPC.HISTORY_EXCERPTS, { chatId: 'chat-1', seq: '3' })).ok, false);
    assert.strictEqual((await call(IPC.HISTORY_EXCERPTS, {})).ok, false);
    assert.strictEqual((await call(IPC.HISTORY_SEARCH, { chatId: 'chat-1', query: '' })).ok, false);
  });
});

describe('history IPC: the embedder', () => {
  const { EventEmitter } = require('node:events');
  const { mergeHistorySettings } = require('../src/history/settings');
  let t;
  let settings;
  const handlers = new Map();
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const host = Object.assign(new EventEmitter(), {
    retried: 0,
    status: () => ({ kind: 'local', key: 'local:Xenova/all-MiniLM-L6-v2', state: 'ready', download: null, error: null, tokens: 0 }),
    retry() { this.retried += 1; }
  });
  before(() => {
    t = openTempStore();
    seedChat(t.store, { messages: [{ sender: 'user', text: GATE }] });
    const [row] = t.store.pendingEmbeddings('local:Xenova/all-MiniLM-L6-v2', { limit: 1 });
    t.store.putEmbeddings('local:Xenova/all-MiniLM-L6-v2', [{ chunkId: row.id, vec: Float32Array.from([1, 0]) }]);
    settings = { history: mergeHistorySettings({}) };
    registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      getHistoryStore: () => t.store,
      getEmbedderHost: () => host,
      getEmbedIndexer: () => ({ progress: () => ({ key: 'local:Xenova/all-MiniLM-L6-v2', embedded: 1, pending: 0 }) }),
      getSettings: () => settings,
      setSettings: (s) => { settings = s; }
    });
  });
  after(() => t.cleanup());

  it('status: the host state, the progress and the settings the pane shows', async () => {
    const out = await call(IPC.HISTORY_EMBEDDER_STATUS, {});
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.untrustedText, true);
    assert.strictEqual(out.status.state, 'ready');
    assert.deepStrictEqual(out.progress, { key: 'local:Xenova/all-MiniLM-L6-v2', embedded: 1, pending: 0 });
    assert.strictEqual(out.settings.embedder.kind, 'local');
    assert.deepStrictEqual(out.settings.rerank, { enabled: false, search: true, kind: 'local' });
  });

  it('save: merges the embedder and rerank choices; refuses a value the merge would replace', async () => {
    const ok = await call(IPC.HISTORY_EMBEDDER_SAVE, { embedder: { kind: 'ollama', ollama: { baseUrl: 'http://192.0.2.10:11434/' } }, rerank: { enabled: true } });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(settings.history.embedder.kind, 'ollama');
    assert.strictEqual(settings.history.embedder.ollama.baseUrl, 'http://192.0.2.10:11434');
    assert.strictEqual(settings.history.recall.rerank.enabled, true);
    assert.strictEqual(settings.history.recall.tailTokens, 6000, 'other keys kept');
    const bad = await call(IPC.HISTORY_EMBEDDER_SAVE, { embedder: { model: '../escape' } });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /model/);
    assert.strictEqual(settings.history.embedder.model, 'Xenova/all-MiniLM-L6-v2', 'nothing saved');
  });

  it('rebuild deletes the active key\'s vectors; retry asks the host', async () => {
    const out = await call(IPC.HISTORY_EMBEDDER_REBUILD, {});
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.removed, 1);
    assert.strictEqual(t.store.countEmbedded('local:Xenova/all-MiniLM-L6-v2'), 0);
    await call(IPC.HISTORY_EMBEDDER_RETRY, {});
    assert.strictEqual(host.retried, 1);
  });
});

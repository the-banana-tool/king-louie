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

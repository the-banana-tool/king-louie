// tests/history-ipc-jev.test.js
// The history IPC for the hosted reranker (recall spec §14): the status
// carries the reranker and the Jev view; choosing jev needs the explicit
// confirmation; the key goes in and never comes back; Retry resets Jev.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerHistoryHandlers } = require('../src/ipc/history-handlers');
const { mergeHistorySettings } = require('../src/history/settings');

const KEY = 'test-key-not-real-0001';

describe('history IPC: the hosted reranker', () => {
  let settings;
  let saved;
  let cleared;
  let resets;
  const handlers = new Map();
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const jev = {
    status: () => ({ kind: settings.history.recall.rerank.kind, model: 'jev-latest', state: 'ready', error: null, hasKey: saved.length > 0, tokens: 12, requests: 1 }),
    reset() { resets += 1; }
  };
  registerHistoryHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    getSettings: () => settings,
    setSettings: (s) => { settings = s; },
    getJevReranker: () => jev,
    saveTypesafeKey: (k) => { saved.push(k); },
    clearTypesafeKey: () => { cleared += 1; }
  });
  beforeEach(() => {
    settings = { history: mergeHistorySettings({}) };
    saved = [];
    cleared = 0;
    resets = 0;
  });

  it('status: the reranker kind and the Jev view', async () => {
    const out = await call(IPC.HISTORY_EMBEDDER_STATUS, {});
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.settings.rerank, { enabled: false, search: true, kind: 'local' });
    assert.strictEqual(out.jev.state, 'ready');
    assert.strictEqual(out.jev.tokens, 12);
  });

  it('choosing jev needs confirmJev; local and staying on jev do not (Review Focus 5)', async () => {
    const refused = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'jev' } });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /Allow sending to typesafe\.ai/);
    assert.strictEqual(settings.history.recall.rerank.kind, 'local', 'nothing saved');
    const ok = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'jev', enabled: true }, confirmJev: true });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(settings.history.recall.rerank.kind, 'jev');
    assert.strictEqual(ok.settings.rerank.kind, 'jev');
    const stay = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'jev', enabled: false } });
    assert.strictEqual(stay.ok, true, 'already chosen: no second confirmation');
    const back = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'local' } });
    assert.strictEqual(back.ok, true);
    assert.strictEqual(settings.history.recall.rerank.kind, 'local');
    const bad = await call(IPC.HISTORY_EMBEDDER_SAVE, { rerank: { kind: 'remote' }, confirmJev: true });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Not a valid reranker/);
  });

  it('saveKey: checks the shape, saves it trimmed, never answers with it; clearKey removes it', async () => {
    for (const key of [undefined, 42, 'short', 'has a space inside', 'x'.repeat(513)]) {
      const out = await call(IPC.HISTORY_JEV_SAVE_KEY, { key });
      assert.strictEqual(out.ok, false, JSON.stringify(key));
    }
    assert.deepStrictEqual(saved, []);
    const out = await call(IPC.HISTORY_JEV_SAVE_KEY, { key: `  ${KEY}\n` });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(saved, [KEY]);
    assert.ok(!JSON.stringify(out).includes(KEY), 'the key never comes back');
    assert.strictEqual(out.jev.hasKey, true);
    const gone = await call(IPC.HISTORY_JEV_CLEAR_KEY, {});
    assert.strictEqual(gone.ok, true);
    assert.strictEqual(cleared, 1);
  });

  it('Retry resets Jev', async () => {
    await call(IPC.HISTORY_EMBEDDER_RETRY, {});
    assert.strictEqual(resets, 1);
  });
});

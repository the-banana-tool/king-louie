// tests/models-ipc.test.js
// The models channels (spec 2026-09-27 §5): catalog status and refresh,
// Test all, usable models and their reasons, the Ollama address.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');
const { setLogLevel } = require('../src/logging');

// One case here deliberately calls a channel with no catalog available;
// silence wrapHandler's resulting error log so TAP output stays clean.
setLogLevel('fatal');

function setup(overrides = {}) {
  const calls = { refresh: [], usable: [], explain: [], tested: [], settings: [] };
  let settings = { models: { ollama: { baseUrl: 'http://127.0.0.1:11434' } } };
  const context = {
    getCatalog: () => ({
      status: () => ({ source: 'snapshot', fetchedAt: null, snapshotDate: '2026-09-27T00:00:00.000Z', stale: false, models: 742 }),
      refresh: async (opts) => { calls.refresh.push(opts); return { source: 'live', fetchedAt: '2026-09-28T00:00:00.000Z' }; }
    }),
    getAvailability: () => ({
      statusAll: () => ({ openai: { ok: true, models: ['gpt-5.5'] }, groq: null }),
      testAll: async () => ({ openai: { ok: true } }),
      test: async (p) => { calls.tested.push(p); return { ok: true, models: ['test-model'] }; },
      usable: ({ needs }) => { calls.usable.push(needs); return [{ provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5', known: true, priced: true, cost: { input: 5, output: 30 }, context: 1050000, toolCall: true, imageInput: true, local: false, extra: 'dropped' }]; },
      explain: (p, m, { needs }) => { calls.explain.push([p, m, needs]); return { usable: false, reasons: ['No token saved for Groq.'], notes: [], entry: { big: true } }; }
    }),
    getSettings: () => settings,
    setSettings: (next) => { calls.settings.push(next); settings = next; },
    ...overrides
  };
  const handlers = new Map();
  registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, context);
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { call, calls };
}

describe('models IPC', () => {
  it('reports catalog status and provider statuses', async () => {
    const { call } = setup();
    const r = await call(IPC.MODELS_STATUS);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.catalog.source, 'snapshot');
    assert.deepStrictEqual(r.providers.openai.models, ['gpt-5.5']);
  });

  it('forces a catalog refresh', async () => {
    const { call, calls } = setup();
    assert.strictEqual((await call(IPC.MODELS_REFRESH_CATALOG)).ok, true);
    assert.deepStrictEqual(calls.refresh, [{ force: true }]);
  });

  it('tests all providers', async () => {
    assert.deepStrictEqual(await setup().call(IPC.MODELS_TEST_ALL), { ok: true, providers: { openai: { ok: true } } });
  });

  it('lists usable models for sanitized needs, as plain candidate views', async () => {
    const { call, calls } = setup();
    const r = await call(IPC.MODELS_USABLE, { needs: { toolCall: 'yes', imageInput: true, textOutput: true, minContext: -1, extra: 1 } });
    assert.deepStrictEqual(calls.usable, [{ imageInput: true, textOutput: true }]);
    assert.strictEqual(r.models[0].extra, undefined);
    assert.strictEqual(r.models[0].model, 'gpt-5.5');
  });

  it('explains a model without sending the catalog entry', async () => {
    const { call, calls } = setup();
    assert.deepStrictEqual(await call(IPC.MODELS_EXPLAIN, { provider: 'groq', model: 'llama-3.3-70b', needs: { toolCall: true } }), {
      ok: true, usable: false, reasons: ['No token saved for Groq.'], notes: []
    });
    assert.deepStrictEqual(calls.explain, [['groq', 'llama-3.3-70b', { toolCall: true }]]);
    assert.strictEqual((await call(IPC.MODELS_EXPLAIN, {})).ok, false);
  });

  it('saves a valid Ollama address and tests it; refuses anything else', async () => {
    const { call, calls } = setup();
    assert.strictEqual((await call(IPC.MODELS_SET_OLLAMA_URL, { baseUrl: 'not a url' })).ok, false);
    assert.strictEqual((await call(IPC.MODELS_SET_OLLAMA_URL, { baseUrl: 'ftp://192.0.2.7' })).ok, false);
    const r = await call(IPC.MODELS_SET_OLLAMA_URL, { baseUrl: 'http://192.0.2.7:11434/' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.baseUrl, 'http://192.0.2.7:11434');
    assert.strictEqual(calls.settings[0].models.ollama.baseUrl, 'http://192.0.2.7:11434');
    assert.deepStrictEqual(calls.tested, ['ollama']);
    assert.deepStrictEqual(r.status.models, ['test-model']);
  });

  it('says so when the host has no catalog', async () => {
    const { call } = setup({ getCatalog: () => null });
    const r = await call(IPC.MODELS_STATUS);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not available/);
  });
});

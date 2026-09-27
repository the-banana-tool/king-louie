// tests/models-ollama.test.js
// Ollama discovery (spec 2026-09-27 §5.4) against a local fake server: the
// address from models.ollama.baseUrl, /api/tags for installed models,
// /api/show for context length and capabilities.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { discoverOllama } = require('../src/models/ollama');
const { Availability } = require('../src/models/availability');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

// The "stopped Ollama" case deliberately fails a connection test; silence
// the resulting warning so TAP output stays clean.
setLogLevel('fatal');

describe('Ollama discovery', () => {
  let server;
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('reads installed models, their context length and capabilities', async () => {
    assert.deepStrictEqual(await discoverOllama({ baseUrl: `${server.url}/ollama/` }), [
      { id: 'test-model', context: 8192, toolCall: true, imageInput: false },
      { id: 'vision-model', context: null, toolCall: false, imageInput: true }
    ]);
  });

  it('says the server did not answer when nothing listens', async () => {
    await assert.rejects(discoverOllama({ baseUrl: 'http://127.0.0.1:9' }), /Ollama at http:\/\/127\.0\.0\.1:9 did not answer/);
  });

  it('tests Ollama at the configured address and adds its models to the catalog as local', async () => {
    let store = {};
    const catalog = fixtureCatalog();
    const availability = new Availability({
      catalog,
      hasCredential: () => true,
      createProvider: async () => { throw new Error('Ollama is tested through discovery, not a provider'); },
      getStatuses: () => store,
      setStatuses: (s) => { store = s; },
      getSettings: () => ({ models: { ollama: { baseUrl: `${server.url}/ollama` } } })
    });
    const s = await availability.test('ollama');
    assert.strictEqual(s.ok, true);
    assert.deepStrictEqual(s.models, ['test-model', 'vision-model']);
    const entry = catalog.get('ollama', 'test-model');
    assert.strictEqual(entry.local, true);
    assert.strictEqual(entry.limits.context, 8192);
    assert.strictEqual(catalog.price('ollama', 'test-model', { input: 1000, output: 100 }).usd, 0);
    assert.strictEqual(availability.explain('ollama', 'test-model', { needs: { toolCall: true } }).usable, true);
    assert.deepStrictEqual(availability.explain('ollama', 'vision-model', { needs: { toolCall: true } }).reasons, ['vision-model has no tool calling.']);
    assert.strictEqual(availability.explain('ollama', 'vision-model', { needs: { imageInput: true } }).usable, true);
  });

  it('a stopped Ollama fails its test with the reason', async () => {
    let store = {};
    const availability = new Availability({
      catalog: fixtureCatalog(),
      hasCredential: () => true,
      createProvider: async () => null,
      getStatuses: () => store,
      setStatuses: (s) => { store = s; },
      getSettings: () => ({ models: { ollama: { baseUrl: 'http://127.0.0.1:9' } } })
    });
    const s = await availability.test('ollama');
    assert.strictEqual(s.ok, false);
    assert.match(s.error, /did not answer/);
  });
});

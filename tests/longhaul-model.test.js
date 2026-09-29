// tests/longhaul-model.test.js
// Providers from environment keys (benchmark spec §12) and LongHaul's model
// client. Never touches the network: a fake provider or the local fake server.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const ProviderFactory = require('../src/providers/provider-factory');
const { PROVIDER_KEY_ENV, keyFromEnv } = require('../src/providers/env-keys');
const { KEY_ENV } = require('../scripts/smoke-providers');
const { createModelClient } = require('../src/longhaul/model');
const { UsageError } = require('../src/longhaul/errors');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');

describe('keys from the environment', () => {
  it('takes the first variable that is set and ignores blank ones', () => {
    assert.deepStrictEqual(keyFromEnv('gemini', { GOOGLE_GENERATIVE_AI_API_KEY: 'g-123456789' }), { name: 'GOOGLE_GENERATIVE_AI_API_KEY', value: 'g-123456789' });
    assert.strictEqual(keyFromEnv('gemini', { GEMINI_API_KEY: 'a-123456789', GOOGLE_GENERATIVE_AI_API_KEY: 'b-123456789' }).name, 'GEMINI_API_KEY');
    assert.strictEqual(keyFromEnv('openai', { OPENAI_API_KEY: '   ' }), null);
    assert.strictEqual(KEY_ENV, PROVIDER_KEY_ENV, 'the smoke script shares the table');
  });

  it('builds a provider from the environment, or says which variable to set', () => {
    assert.throws(() => ProviderFactory.fromEnv('openai', { env: {} }), (err) => err.code === 'NO_PROVIDER_KEY' && /OPENAI_API_KEY/.test(err.message));
    assert.throws(() => ProviderFactory.fromEnv('nope', { env: {} }), (err) => err.code === 'UNKNOWN_PROVIDER');
    assert.strictEqual(ProviderFactory.fromEnv('ollama', { env: {} }).getName(), 'ollama');
    assert.strictEqual(ProviderFactory.fromEnv('openai', { env: { OPENAI_API_KEY: 'test-key-123456' } }).apiKey, 'test-key-123456');
  });
});

describe('createModelClient', () => {
  it('makes one tool-less call at temperature 0 and returns the streamed text', async () => {
    const calls = [];
    const fake = {
      async streamMessage(messages, options, onChunk) {
        calls.push({ messages, options });
        onChunk('{"a":');
        onChunk('1}');
        return { content: '', llmMetrics: { model: options.model } };
      }
    };
    const client = createModelClient({ model: 'm-1', providerInstance: fake });
    const out = await client.complete('hello');
    assert.strictEqual(out.text, '{"a":1}');
    assert.deepStrictEqual(calls[0].messages, [{ role: 'user', content: 'hello' }]);
    assert.deepStrictEqual(calls[0].options, { model: 'm-1', temperature: 0, max_tokens: 800 });
  });

  it('turns a missing key, an unknown provider or a missing model into a usage error', () => {
    assert.throws(() => createModelClient({ provider: 'openai', model: 'm', env: {} }), (err) => err instanceof UsageError && /OPENAI_API_KEY/.test(err.message));
    assert.throws(() => createModelClient({ provider: 'nope', model: 'm', env: {} }), UsageError);
    assert.throws(() => createModelClient({ provider: 'openai', env: { OPENAI_API_KEY: 'test-key-123456' } }), UsageError);
  });

  describe('against the local fake server', () => {
    let server;
    before(async () => { server = await startFakeLlmServer(); });
    after(async () => { await server.close(); });

    it('streams a reply through a real provider class', async () => {
      const client = createModelClient({
        provider: 'openai', model: 'test-model',
        env: { OPENAI_API_KEY: 'test-key-123456' },
        options: { baseUrl: `${server.url}/openai/v1` }
      });
      assert.strictEqual((await client.complete('hi')).text, 'Hello there');
    });
  });
});

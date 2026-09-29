'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const OpenAIProvider = require('../src/providers/openai-provider');
const { rejectsTemperature, guessSupportsTemperature } = OpenAIProvider;
const { acceptsTemperature } = require('../src/models/capabilities');
const { normalizeModel } = require('../src/models/normalize');

// OpenAI's refusal, as seen for gpt-6-sol.
const NO_TEMPERATURE = "Unsupported parameter: 'temperature' is not supported with this model.";

// Just enough catalog for a provider: entries keyed by model id, no prices.
function fakeCatalog(entries) {
  return {
    get: (provider, model) => (provider === 'openai' && entries[model] ? { ...entries[model] } : null),
    price: () => null
  };
}

describe('catalog temperature flag', () => {
  it('keeps models.dev\'s temperature flag, and null when it has none', () => {
    assert.strictEqual(normalizeModel('openai', { id: 'gpt-6-sol', temperature: false }).temperature, false);
    assert.strictEqual(normalizeModel('openai', { id: 'gpt-4o', temperature: true }).temperature, true);
    assert.strictEqual(normalizeModel('openai', { id: 'mystery' }).temperature, null);
  });

  it('acceptsTemperature answers only for models the catalog knows', () => {
    const catalog = fakeCatalog({ 'gpt-6-sol': { temperature: false }, 'gpt-4o': { temperature: true }, 'old': { temperature: null } });
    assert.strictEqual(acceptsTemperature(catalog, 'openai', 'gpt-6-sol'), false);
    assert.strictEqual(acceptsTemperature(catalog, 'OpenAI', 'gpt-4o'), true);
    assert.strictEqual(acceptsTemperature(catalog, 'openai', 'old'), null);
    assert.strictEqual(acceptsTemperature(catalog, 'openai', 'unknown'), null);
    assert.strictEqual(acceptsTemperature(null, 'openai', 'gpt-4o'), null);
  });
});

describe('OpenAIProvider#supportsTemperature', () => {
  it('follows the catalog over the name guess', () => {
    const provider = new OpenAIProvider('sk-test-123456', {
      catalog: fakeCatalog({ 'gpt-5.4': { temperature: true }, 'gpt-4o-temp-off': { temperature: false } })
    });
    assert.strictEqual(provider.supportsTemperature('gpt-5.4'), true, 'the guess would say no');
    assert.strictEqual(provider.supportsTemperature('gpt-4o-temp-off'), false, 'the guess would say yes');
  });

  it('guesses from the name for a model the catalog does not know', () => {
    const provider = new OpenAIProvider('sk-test-123456', { catalog: fakeCatalog({}) });
    assert.strictEqual(provider.supportsTemperature('gpt-6-sol'), false);
    assert.strictEqual(provider.supportsTemperature('gpt-4.1'), true);
  });

  it('treats GPT-5 and every later generation as taking no temperature', () => {
    for (const m of ['gpt-5', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-7-flex', 'gpt-12', 'openai/gpt-6', 'o3-mini', 'chatgpt-4o-latest', 'gpt-5.2-codex']) {
      assert.strictEqual(guessSupportsTemperature(m), false, m);
    }
    for (const m of ['gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo', 'my-finetune']) {
      assert.strictEqual(guessSupportsTemperature(m), true, m);
    }
  });
});

describe('rejectsTemperature', () => {
  it('recognizes OpenAI\'s temperature refusals only', () => {
    assert.strictEqual(rejectsTemperature(NO_TEMPERATURE), true);
    assert.strictEqual(rejectsTemperature("Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported."), true);
    assert.strictEqual(rejectsTemperature("Unsupported parameter: 'max_tokens' is not supported with this model."), false);
    assert.strictEqual(rejectsTemperature('Incorrect API key provided'), false);
    assert.strictEqual(rejectsTemperature(undefined), false);
  });
});

describe('a model that refuses temperature at runtime', () => {
  let server;
  let baseUrl;
  const hits = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        hits.push(parsed);
        res.setHeader('Content-Type', 'application/json');
        if ('temperature' in parsed) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: NO_TEMPERATURE, type: 'invalid_request_error', param: 'temperature' } }));
          return;
        }
        res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('is retried once without temperature and left out from then on', async () => {
    // The catalog wrongly says yes, as a stale snapshot might.
    const provider = new OpenAIProvider('sk-test-123456', {
      baseUrl,
      catalog: fakeCatalog({ 'temp-refusal-test': { temperature: true } })
    });

    assert.strictEqual(await provider.sendMessage([{ role: 'user', content: 'hi' }], { model: 'temp-refusal-test' }), 'ok');
    assert.deepStrictEqual(hits.map((h) => 'temperature' in h), [true, false]);

    assert.strictEqual(await provider.sendMessage([{ role: 'user', content: 'again' }], { model: 'temp-refusal-test' }), 'ok');
    assert.deepStrictEqual(hits.map((h) => 'temperature' in h), [true, false, false], 'no second failed round trip');
    assert.strictEqual(provider.supportsTemperature('temp-refusal-test'), false);
  });
});

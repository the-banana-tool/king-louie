'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const { rejectsTemperature } = AnthropicProvider;

// Anthropic's refusal, as seen for claude-opus-5-5.
const NO_TEMPERATURE = '`temperature` is deprecated for this model.';

function fakeCatalog(entries) {
  return {
    get: (provider, model) => (provider === 'anthropic' && entries[model] ? { ...entries[model] } : null),
    price: () => null
  };
}

describe('AnthropicProvider#supportsTemperature', () => {
  it('follows the catalog, and sends temperature for a model it does not know', () => {
    const provider = new AnthropicProvider('sk-ant-test-123456', {
      catalog: fakeCatalog({ 'claude-opus-5-5': { temperature: false }, 'claude-opus-4-5': { temperature: true } })
    });
    assert.strictEqual(provider.supportsTemperature('claude-opus-5-5'), false);
    assert.strictEqual(provider.supportsTemperature('claude-opus-4-5'), true);
    assert.strictEqual(provider.supportsTemperature('claude-unknown'), true);
  });
});

describe('rejectsTemperature', () => {
  it('recognizes Anthropic\'s temperature refusals only', () => {
    assert.strictEqual(rejectsTemperature(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: NO_TEMPERATURE } })), true);
    assert.strictEqual(rejectsTemperature('temperature: Extra inputs are not permitted'), true);
    assert.strictEqual(rejectsTemperature('max_tokens: Field required'), false);
    assert.strictEqual(rejectsTemperature('invalid x-api-key'), false);
    assert.strictEqual(rejectsTemperature(undefined), false);
  });
});

describe('an Anthropic model that takes no temperature', () => {
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
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: NO_TEMPERATURE } }));
          return;
        }
        res.end(JSON.stringify({ model: parsed.model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('never gets temperature when the catalog says so, on any call', async () => {
    hits.length = 0;
    const provider = new AnthropicProvider('sk-ant-test-123456', { baseUrl, catalog: fakeCatalog({ 'claude-opus-5-5': { temperature: false } }) });
    assert.strictEqual(await provider.sendMessage([{ role: 'user', content: 'hi' }], { model: 'claude-opus-5-5' }), 'ok');
    const withTools = await provider.sendMessageWithTools([{ role: 'user', content: 'hi' }], [], { model: 'claude-opus-5-5' });
    assert.ok(withTools);
    assert.deepStrictEqual(hits.map((h) => 'temperature' in h), [false, false]);
  });

  it('is retried once without temperature when the catalog is stale, and left out from then on', async () => {
    hits.length = 0;
    const provider = new AnthropicProvider('sk-ant-test-123456', { baseUrl, catalog: fakeCatalog({ 'temp-refusal-test': { temperature: true } }) });
    assert.strictEqual(await provider.sendMessage([{ role: 'user', content: 'hi' }], { model: 'temp-refusal-test' }), 'ok');
    assert.deepStrictEqual(hits.map((h) => 'temperature' in h), [true, false]);
    assert.strictEqual(await provider.sendMessage([{ role: 'user', content: 'again' }], { model: 'temp-refusal-test' }), 'ok');
    assert.deepStrictEqual(hits.map((h) => 'temperature' in h), [true, false, false], 'no second failed round trip');
    assert.strictEqual(provider.supportsTemperature('temp-refusal-test'), false);
  });
});

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

describe('MistralProvider', () => {
  let MistralProvider;
  let ProviderFactory;

  before(() => {
    MistralProvider = require('../src/providers/mistral-provider');
    ProviderFactory = require('../src/providers/provider-factory');
  });

  it('instantiates with config', () => {
    const provider = new MistralProvider('test-key-minimum-length');
    assert.strictEqual(provider.getName(), 'mistral');
    assert.strictEqual(provider.getLabel(), 'Mistral AI');
  });

  it('returns model list', () => {
    const provider = new MistralProvider('test-key-minimum-length');
    const models = provider.getModels();
    assert.ok(models.length >= 3);
    assert.ok(models.some(m => m.id === 'mistral-large-latest'));
    assert.ok(models.some(m => m.id === 'codestral-latest'));
  });

  it('uses correct base URL', () => {
    const provider = new MistralProvider('test-key-minimum-length');
    assert.strictEqual(provider.baseUrl, 'https://api.mistral.ai/v1');
  });

  it('formats messages in OpenAI-compatible format', () => {
    const provider = new MistralProvider('test-key-minimum-length');
    const messages = [{ role: 'user', content: 'Hello' }];
    const formatted = provider.formatMessages(messages);
    assert.strictEqual(formatted[0].role, 'user');
    assert.strictEqual(formatted[0].content, 'Hello');
  });

  it('includes tools in request when provided', async () => {
    const provider = new MistralProvider('test-key-minimum-length');

    const originalFetch = global.fetch;
    let requestOptions = null;

    global.fetch = async (url, options) => {
      requestOptions = options;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'test' } }],
          usage: {}
        })
      };
    };

    try {
      const tools = [{
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} }
      }];
      await provider.sendMessageWithTools([{ role: 'user', content: 'hi' }], tools, {});

      const body = JSON.parse(requestOptions.body);
      assert.ok(body.tools);
      assert.strictEqual(body.tools[0].type, 'function');
      assert.strictEqual(body.tools[0].function.name, 'test_tool');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('handles API error gracefully', async () => {
    const provider = new MistralProvider('invalid-key-so-it-passes-min-length');

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'Invalid API key' } })
    });

    try {
      await assert.rejects(
        () => provider.sendMessage([{ role: 'user', content: 'hi' }]),
        { message: 'Invalid API key' }
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('is registered in ProviderFactory', () => {
    assert.ok(ProviderFactory.listRegistered().includes('mistral'));
    const provider = ProviderFactory.createProvider('mistral', 'test-key-minimum-length');
    assert.ok(provider instanceof MistralProvider);
    assert.strictEqual(provider.getName(), 'mistral');
  });

  it('returns pricing table', () => {
    const provider = new MistralProvider('test-key-minimum-length');
    const pricing = provider.getModelPricingTable();
    assert.ok(pricing['mistral-large-latest']);
    assert.strictEqual(pricing['mistral-large-latest'].inputPerMillion, 2.00);
  });
});

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

describe('OpenRouterProvider', () => {
  let OpenRouterProvider;
  let ProviderFactory;

  before(() => {
    OpenRouterProvider = require('../src/providers/openrouter-provider');
    ProviderFactory = require('../src/providers/provider-factory');
  });

  it('instantiates with config', () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');
    assert.strictEqual(provider.getName(), 'openrouter');
    assert.strictEqual(provider.getLabel(), 'OpenRouter');
  });

  it('uses correct base URL', () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');
    assert.strictEqual(provider.baseUrl, 'https://openrouter.ai/api/v1');
  });

  it('includes required extra headers', () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');
    const headers = provider.getHeaders();
    assert.ok(headers['HTTP-Referer']);
    assert.ok(headers['X-Title']);
    assert.ok(headers['Authorization'].includes('Bearer'));
  });

  it('returns a default model list', () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');
    const models = provider.getModels();
    assert.ok(models.length > 0);
    assert.ok(models.some(m => m.id === 'openai/gpt-4o-mini'));
  });

  it('formats messages in OpenAI-compatible format', () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');
    const messages = [{ role: 'user', content: 'Hello' }];
    const formatted = provider.formatMessages(messages);
    assert.strictEqual(formatted[0].role, 'user');
    assert.strictEqual(formatted[0].content, 'Hello');
  });

  it('includes tools in request when provided', async () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');

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

      // Verify extra headers are included
      const headers = JSON.parse(JSON.stringify(requestOptions.headers));
      assert.ok(headers['HTTP-Referer']);
      assert.ok(headers['X-Title']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('handles API error gracefully', async () => {
    const provider = new OpenRouterProvider('invalid-key-so-it-passes-min-length');

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
    assert.ok(ProviderFactory.listRegistered().includes('openrouter'));
    const provider = ProviderFactory.createProvider('openrouter', 'or-test-key-min-length');
    assert.ok(provider instanceof OpenRouterProvider);
    assert.strictEqual(provider.getName(), 'openrouter');
  });
});

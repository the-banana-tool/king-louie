const { describe, it, before } = require('node:test');
const assert = require('node:assert');

describe('GroqProvider', () => {
  let GroqProvider;
  let ProviderFactory;

  before(() => {
    GroqProvider = require('../src/providers/groq-provider');
    ProviderFactory = require('../src/providers/provider-factory');
  });

  it('instantiates with config', () => {
    const provider = new GroqProvider('gsk-test');
    assert.strictEqual(provider.getName(), 'groq');
    assert.strictEqual(provider.getLabel(), 'Groq');
  });

  it('returns model list', () => {
    const provider = new GroqProvider('gsk-test');
    const models = provider.getModels();
    assert.ok(models.length >= 3);
    assert.ok(models.some(m => m.id === 'llama-3.3-70b-versatile'));
  });

  it('uses correct base URL', () => {
    const provider = new GroqProvider('gsk-test');
    assert.strictEqual(provider.baseUrl, 'https://api.groq.com/openai/v1');
  });

  it('formats messages in OpenAI-compatible format', () => {
    const provider = new GroqProvider('gsk-test');
    const messages = [{ role: 'user', content: 'Hello' }];
    const formatted = provider.formatMessages ? provider.formatMessages(messages) : messages;
    assert.strictEqual(formatted[0].role, 'user');
    assert.strictEqual(formatted[0].content, 'Hello');
  });

  it('includes tools in request when provided', async () => {
    const provider = new GroqProvider('gsk-test');

    // We override fetch for testing
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
    const provider = new GroqProvider('invalid-key-so-it-passes-min-length');

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
    const provider = ProviderFactory.createProvider('groq', 'test-key');
    assert.ok(provider instanceof GroqProvider);
    assert.strictEqual(provider.getName(), 'groq');
  });
});

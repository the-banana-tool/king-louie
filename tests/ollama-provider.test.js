const { describe, it, before } = require('node:test');
const assert = require('node:assert');

describe('OllamaProvider', () => {
  let OllamaProvider;
  let ProviderFactory;

  before(() => {
    OllamaProvider = require('../src/providers/ollama-provider');
    ProviderFactory = require('../src/providers/provider-factory');
  });

  it('instantiates with default baseUrl', () => {
    const provider = new OllamaProvider();
    assert.strictEqual(provider.baseUrl, 'http://localhost:11434/v1');
  });

  it('does not require API key', () => {
    const provider = new OllamaProvider();
    assert.ok(provider);
    assert.strictEqual(provider.getName(), 'ollama');
  });

  it('does not require API key even with empty string', () => {
    const provider = new OllamaProvider('');
    assert.ok(provider);
  });

  it('getName returns ollama', () => {
    const provider = new OllamaProvider();
    assert.strictEqual(provider.getName(), 'ollama');
    assert.strictEqual(provider.getLabel(), 'Ollama (Local)');
  });

  it('returns empty model list by default', () => {
    const provider = new OllamaProvider();
    const models = provider.getModels();
    assert.strictEqual(models.length, 0);
  });

  it('does not include Authorization header', () => {
    const provider = new OllamaProvider();
    const headers = provider.getHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], undefined);
  });

  it('formats messages in OpenAI-compatible format', () => {
    const provider = new OllamaProvider();
    const messages = [{ role: 'user', content: 'Hello' }];
    const formatted = provider.formatMessages(messages);
    assert.strictEqual(formatted[0].role, 'user');
    assert.strictEqual(formatted[0].content, 'Hello');
  });

  it('discoverModels handles connection refused', async () => {
    const provider = new OllamaProvider();
    // Override baseUrl to a port nothing listens on
    provider.baseUrl = 'http://localhost:1/v1';
    await assert.rejects(
      () => provider.discoverModels(),
      /not running|ECONNREFUSED|fetch failed/i
    );
  });

  it('is registered in ProviderFactory', () => {
    assert.ok(ProviderFactory.listRegistered().includes('ollama'));
    const provider = ProviderFactory.createProvider('ollama', null);
    assert.ok(provider instanceof OllamaProvider);
    assert.strictEqual(provider.getName(), 'ollama');
  });

  it('sends message via OpenAI-compatible endpoint', async () => {
    const provider = new OllamaProvider();

    const originalFetch = global.fetch;
    let capturedUrl = null;
    let capturedHeaders = null;

    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response from ollama' } }],
          usage: {}
        })
      };
    };

    try {
      const result = await provider.sendMessage([{ role: 'user', content: 'hi' }], { model: 'llama3' });
      assert.strictEqual(result, 'response from ollama');
      assert.ok(capturedUrl.includes('/v1/chat/completions'));
      assert.strictEqual(capturedHeaders['Authorization'], undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

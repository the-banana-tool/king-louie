const { describe, it, before } = require('node:test');
const assert = require('node:assert');

describe('GeminiProvider', () => {
  let GeminiProvider;
  let ProviderFactory;

  before(() => {
    GeminiProvider = require('../src/providers/gemini-provider');
    ProviderFactory = require('../src/providers/provider-factory');
  });

  it('instantiates with API key', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    assert.strictEqual(provider.getName(), 'gemini');
    assert.strictEqual(provider.getLabel(), 'Google Gemini');
  });

  it('returns model list', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const models = provider.getModels();
    assert.ok(models.some(m => m.id === 'gemini-2.0-flash'));
    assert.ok(models.some(m => m.id === 'gemini-2.0-pro'));
  });

  it('formats messages to Gemini format', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const { contents } = provider.formatMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ]);
    assert.strictEqual(contents[0].role, 'user');
    assert.deepStrictEqual(contents[0].parts, [{ text: 'Hello' }]);
    assert.strictEqual(contents[1].role, 'model');
    assert.deepStrictEqual(contents[1].parts, [{ text: 'Hi there' }]);
  });

  it('extracts system instruction from messages', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const { contents, systemInstruction } = provider.formatMessages([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' }
    ]);
    assert.strictEqual(systemInstruction, 'You are helpful');
    assert.strictEqual(contents.length, 1);
    assert.strictEqual(contents[0].role, 'user');
  });

  it('formats tools to functionDeclarations', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const tools = [{ name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }];
    const formatted = provider.formatTools(tools);
    assert.ok(Array.isArray(formatted));
    assert.ok(formatted[0].functionDeclarations);
    assert.strictEqual(formatted[0].functionDeclarations[0].name, 'Bash');
  });

  it('returns undefined for empty tools', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    assert.strictEqual(provider.formatTools([]), undefined);
    assert.strictEqual(provider.formatTools(null), undefined);
  });

  it('parses tool call responses', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const candidate = {
      content: {
        parts: [
          { functionCall: { name: 'Bash', args: { command: 'ls' } } }
        ]
      }
    };
    const calls = provider.parseToolCalls(candidate);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'Bash');
    assert.deepStrictEqual(calls[0].arguments, { command: 'ls' });
    assert.ok(calls[0].id);
  });

  it('constructs correct API URL', () => {
    const provider = new GeminiProvider('my-api-key-test');
    const url = provider.getApiUrl('gemini-2.0-flash');
    assert.ok(url.includes('generateContent'));
    assert.ok(url.includes('key=my-api-key-test'));
    assert.ok(!url.includes('stream'));
  });

  it('constructs correct streaming URL', () => {
    const provider = new GeminiProvider('my-api-key-test');
    const url = provider.getApiUrl('gemini-2.0-flash', true);
    assert.ok(url.includes('streamGenerateContent'));
    assert.ok(url.includes('alt=sse'));
    assert.ok(url.includes('key=my-api-key-test'));
  });

  it('does not include Authorization header', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const headers = provider.getHeaders();
    assert.strictEqual(headers['Content-Type'], 'application/json');
    assert.strictEqual(headers['Authorization'], undefined);
  });

  it('handles API error gracefully', async () => {
    const provider = new GeminiProvider('invalid-key-so-it-passes-min-length');

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'API key not valid' } })
    });

    try {
      await assert.rejects(
        () => provider.sendMessage([{ role: 'user', content: 'hi' }]),
        { message: 'API key not valid' }
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('sendMessageWithTools returns tool_use for function call', async () => {
    const provider = new GeminiProvider('test-key-minimum-length');

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [
              { functionCall: { name: 'Bash', args: { command: 'ls' } } }
            ]
          }
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      })
    });

    try {
      const tools = [{ name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: {} } }];
      const result = await provider.sendMessageWithTools(
        [{ role: 'user', content: 'list files' }], tools, {}
      );
      assert.strictEqual(result.type, 'tool_use');
      assert.strictEqual(result.toolName, 'Bash');
      assert.deepStrictEqual(result.parameters, { command: 'ls' });
      assert.ok(result.llmMetrics);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('sendMessageWithTools returns text when no tool call', async () => {
    const provider = new GeminiProvider('test-key-minimum-length');

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: 'Hello there!' }]
          }
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      })
    });

    try {
      const result = await provider.sendMessageWithTools(
        [{ role: 'user', content: 'hi' }], [], {}
      );
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.content, 'Hello there!');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('is registered in ProviderFactory', () => {
    assert.ok(ProviderFactory.listRegistered().includes('gemini'));
    const provider = ProviderFactory.createProvider('gemini', 'test-key-minimum-length');
    assert.ok(provider instanceof GeminiProvider);
    assert.strictEqual(provider.getName(), 'gemini');
  });

  it('returns pricing table', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const pricing = provider.getModelPricingTable();
    assert.ok(pricing['gemini-2.0-flash']);
    assert.strictEqual(pricing['gemini-2.0-flash'].inputPerMillion, 0.10);
  });
});

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

  it('streamMessageWithTools accumulates tool call deltas and returns tool_use shape', async () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');

    // Build a fake SSE stream with tool call deltas split across chunks
    const sseLines = [
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Paris\\"}"}}]}}]}',
      'data: {"model":"openai/gpt-4o-mini","usage":{"prompt_tokens":10,"completion_tokens":5},"choices":[{"delta":{}}]}',
      'data: [DONE]'
    ].join('\n') + '\n';

    const encoder = new TextEncoder();
    const encoded = encoder.encode(sseLines);
    let pos = 0;
    const mockReader = {
      read: async () => {
        if (pos >= encoded.length) return { done: true, value: undefined };
        const chunk = encoded.slice(pos, pos + 50);
        pos += 50;
        return { done: false, value: chunk };
      }
    };

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      body: { getReader: () => mockReader }
    });

    try {
      const tools = [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
      const result = await provider.streamMessageWithTools(
        [{ role: 'user', content: 'What is the weather in Paris?' }],
        tools,
        {}
      );
      assert.strictEqual(result.type, 'tool_use');
      assert.strictEqual(result.toolName, 'get_weather');
      assert.strictEqual(result.toolUseId, 'call-1');
      assert.deepStrictEqual(result.parameters, { city: 'Paris' });
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.messageContent, '');
      assert.ok(result.llmMetrics);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('streamMessageWithTools calls onChunk for text content', async () => {
    const provider = new OpenRouterProvider('or-test-key-min-length');

    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":", world"}}]}',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":3},"choices":[{"delta":{}}]}',
      'data: [DONE]'
    ].join('\n') + '\n';

    const encoder = new TextEncoder();
    const encoded = encoder.encode(sseLines);
    let pos = 0;
    const mockReader = {
      read: async () => {
        if (pos >= encoded.length) return { done: true, value: undefined };
        const chunk = encoded.slice(pos, pos + 100);
        pos += 100;
        return { done: false, value: chunk };
      }
    };

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      body: { getReader: () => mockReader }
    });

    const chunks = [];
    try {
      const result = await provider.streamMessageWithTools(
        [{ role: 'user', content: 'Say hi' }],
        [],
        {},
        (chunk) => chunks.push(chunk)
      );
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.content, 'Hello, world');
      assert.deepStrictEqual(chunks, ['Hello', ', world']);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

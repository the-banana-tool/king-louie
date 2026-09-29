'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const OpenAIProvider = require('../src/providers/openai-provider');
const { needsResponsesApi } = OpenAIProvider;

// OpenAI's refusal for a reasoning model that takes function tools only on
// /v1/responses (seen for gpt-5.6-sol).
const TOOLS_WITH_REASONING = "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

describe('needsResponsesApi', () => {
  it('recognizes every refusal that points at /v1/responses', () => {
    assert.strictEqual(needsResponsesApi('This is not a chat model and thus not supported in the v1/chat/completions endpoint.'), true);
    assert.strictEqual(needsResponsesApi('This model is only supported in v1/responses and not in v1/chat/completions.'), true);
    assert.strictEqual(needsResponsesApi(TOOLS_WITH_REASONING), true);
  });

  it('leaves unrelated errors alone', () => {
    assert.strictEqual(needsResponsesApi('Incorrect API key provided'), false);
    assert.strictEqual(needsResponsesApi('Rate limit reached for requests'), false);
    assert.strictEqual(needsResponsesApi(''), false);
    assert.strictEqual(needsResponsesApi(undefined), false);
  });
});

describe('sendMessageWithTools falls back to /v1/responses', () => {
  let server;
  let baseUrl;
  const hits = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hits.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/chat/completions')) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: TOOLS_WITH_REASONING, type: 'invalid_request_error' } }));
          return;
        }
        res.end(JSON.stringify({
          model: 'gpt-5.6-sol',
          output: [{ type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{"id":"f-1"}' }],
          usage: { input_tokens: 10, output_tokens: 5 }
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('retries a tools call on /v1/responses when chat completions refuses tools with reasoning', async () => {
    const provider = new OpenAIProvider('sk-test-123456', { baseUrl });
    const tools = [{ name: 'lookup', description: 'Look one up', parameters: { type: 'object', properties: { id: { type: 'string' } } } }];
    const result = await provider.sendMessageWithTools([{ role: 'user', content: 'check f-1' }], tools, { model: 'gpt-5.6-sol-fallback-test' });

    assert.deepStrictEqual(hits.map((h) => h.url), ['/v1/chat/completions', '/v1/responses']);
    assert.strictEqual(hits[1].body.tools[0].name, 'lookup');
    assert.strictEqual(result.type, 'tool_use');
    assert.strictEqual(result.toolName, 'lookup');
    assert.deepStrictEqual(result.parameters, { id: 'f-1' });
  });
});

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const AnthropicProvider = require('../src/providers/anthropic-provider');

function countBreakpoints(body) {
  let n = 0;
  for (const t of body.tools || []) if (t.cache_control) n += 1;
  for (const b of Array.isArray(body.system) ? body.system : []) if (b.cache_control) n += 1;
  for (const m of body.messages || []) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b && b.cache_control) n += 1;
  }
  return n;
}

const TOOLS = [
  { name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } },
  { name: 'ToolSearch', description: 'search', parameters: { type: 'object', properties: {} } },
  { name: 'Write', description: 'write', parameters: { type: 'object', properties: {} } },
  { name: 'Bash', description: 'bash', parameters: { type: 'object', properties: {} } }
];

function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

describe('Anthropic cache breakpoint on the last message', () => {
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
        if (parsed.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.end(sse([
            { type: 'message_start', message: { model: parsed.model, usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', usage: { output_tokens: 1 } },
            { type: 'message_stop' }
          ]));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model: parsed.model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const provider = () => new AnthropicProvider('sk-ant-test-123456', { baseUrl });
  const opts = { model: 'claude-test', systemPrompt: 'You are a test.', systemPromptDynamic: 'turn context' };

  it('turns a string last message into a text block with a breakpoint, on all four paths', async () => {
    hits.length = 0;
    const p = provider();
    const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'hello' }];
    await p.sendMessage(messages, opts);
    await p.sendMessageWithTools(messages, TOOLS, opts);
    await p.streamMessage(messages, opts, () => {});
    await p.streamMessageWithTools(messages, TOOLS, opts, () => {});
    assert.strictEqual(hits.length, 4);
    for (const body of hits) {
      const last = body.messages[body.messages.length - 1];
      assert.deepStrictEqual(last.content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
      // Earlier messages are untouched.
      assert.strictEqual(body.messages[0].content, 'first');
      assert.strictEqual(body.messages[1].content, 'reply');
    }
  });

  it('puts the breakpoint on the last block of array content (a tool_result) without mutating the history', async () => {
    hits.length = 0;
    const p = provider();
    const toolResults = [
      { type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' },
      { type: 'tool_result', tool_use_id: 't2', content: '{"ok":false,"error":"no"}' }
    ];
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
      { role: 'user', content: toolResults }
    ];
    await p.sendMessageWithTools(messages, TOOLS, opts);
    await p.sendMessageWithTools(messages, TOOLS, opts);
    for (const body of hits) {
      const last = body.messages[body.messages.length - 1].content;
      assert.strictEqual(last[0].cache_control, undefined);
      assert.deepStrictEqual(last[1].cache_control, { type: 'ephemeral' });
      assert.strictEqual(last[1].tool_use_id, 't2');
    }
    assert.strictEqual(toolResults[1].cache_control, undefined, 'the caller\'s block is not mutated');
    assert.strictEqual(messages[2].content.length, 2);
  });

  it('keeps the total at four breakpoints with ToolSearch, tools and a system prompt', async () => {
    hits.length = 0;
    const p = provider();
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    await p.sendMessageWithTools(messages, TOOLS, opts);
    await p.streamMessageWithTools(messages, TOOLS, opts, () => {});
    for (const body of hits) assert.strictEqual(countBreakpoints(body), 4);
    // Without ToolSearch in the middle: three.
    hits.length = 0;
    await p.sendMessageWithTools(messages, TOOLS.filter((t) => t.name !== 'ToolSearch'), opts);
    assert.strictEqual(countBreakpoints(hits[0]), 3);
  });

  it('adds no breakpoint to an empty last message, and sends an empty messages array as is', async () => {
    hits.length = 0;
    const p = provider();
    await p.sendMessageWithTools([{ role: 'user', content: '' }], TOOLS, opts);
    assert.strictEqual(hits[0].messages[0].content, '');
    await p.sendMessageWithTools([{ role: 'user', content: [{ type: 'text', text: ' ' }] }], TOOLS, opts);
    assert.strictEqual(hits[1].messages[0].content[0].cache_control, undefined);
    const res = await p.sendMessageWithTools([], TOOLS, opts);
    assert.ok(res);
    assert.deepStrictEqual(hits[2].messages, []);
  });

  it('formatMessages itself adds no breakpoint', () => {
    const out = provider().formatMessages([{ role: 'user', content: 'x' }]);
    assert.deepStrictEqual(out, [{ role: 'user', content: 'x' }]);
  });
});

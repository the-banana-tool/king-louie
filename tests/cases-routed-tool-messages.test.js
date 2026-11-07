'use strict';

// A case turn's agent loop talks to CaseRuntime#routedProvider. Measured on
// 2026-10-20: three case turns made 40, 40 and 9 Anthropic calls with the
// same input size on every call, the same refused Executor call each time.
// The loop appends each tool_use / tool_result pair through the provider's
// buildToolMessages; a routed provider without it gets the loop's generic
// OpenAI-shaped fallback, which Anthropic's formatMessages drops (role
// 'tool', and tool_calls on an assistant row), so the model never saw a
// result and asked again. This holds the whole path to an Anthropic body.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const InferenceRouter = require('../src/providers/inference-router');
const { NO_RETRY } = require('../src/providers/failover-policy');
const AgentLoop = require('../src/execution/agent-loop');
const { CaseRuntime } = require('../src/cases/case-runtime');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const REFUSAL = 'payload field "intent" is not accepted by phone-agent (not in its payloadSchema)';
const TOOLS = [{ name: 'Executor', description: 'jobs', parameters: { type: 'object', properties: { action: { type: 'string' } } } }];

describe('a case turn on Anthropic sends each tool result back', () => {
  let server;
  let baseUrl;
  const bodies = [];
  let toolTurns = 3;

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        bodies.push(body);
        res.setHeader('Content-Type', 'application/json');
        const content = bodies.length <= toolTurns
          ? [{ type: 'tool_use', id: `toolu_${bodies.length}`, name: 'Executor', input: { action: 'submit', payload: { intent: 'x' } } }]
          : [{ type: 'text', text: 'done' }];
        res.end(JSON.stringify({ model: body.model, content, usage: { input_tokens: 10, output_tokens: 1 } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  function router() {
    return new InferenceRouter({
      getProviderToken: () => 'sk-ant-test-123456',
      createProvider: () => new AnthropicProvider('sk-ant-test-123456', { baseUrl }),
      prepareProvider: async () => {},
      sleep: async () => {}
    });
  }

  async function runLoop(provider, { stream = false } = {}) {
    bodies.length = 0;
    toolTurns = 3;
    const executor = { execute: async () => ({ ok: false, error: REFUSAL }) };
    const loop = new AgentLoop(provider, executor, {
      maxIterations: 10,
      failoverPolicy: NO_RETRY,
      ...(stream ? { onChunk: () => {} } : {})
    });
    const result = await loop.run([{ role: 'user', content: 'sell the lot' }], TOOLS, { model: 'claude-test' });
    return result;
  }

  function assertGrows() {
    assert.strictEqual(bodies.length, 4);
    bodies.forEach((body, i) => {
      assert.strictEqual(body.messages.length, 1 + 2 * i, `call ${i + 1} carries every earlier pair`);
    });
    const last = bodies[3].messages;
    const results = last.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    assert.strictEqual(results.length, 3);
    for (const m of results) assert.match(JSON.stringify(m.content), /not accepted by phone-agent/);
    const uses = last.filter((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
    assert.deepStrictEqual(uses.map((m) => m.content.find((b) => b.type === 'tool_use').id), ['toolu_1', 'toolu_2', 'toolu_3']);
  }

  it('through the router\'s routed provider (a non-case turn)', async () => {
    const provider = router().routedProvider({ targets: [{ provider: 'anthropic', model: 'claude-test' }] });
    const result = await runLoop(provider);
    assert.strictEqual(result.type, 'complete');
    assertGrows();
  });

  it('through CaseRuntime#routedProvider (an owner case turn)', async () => {
    const runtime = Object.create(CaseRuntime.prototype);
    runtime.host = { inferenceRouter: router() };
    // A case that is not private: no egress policy on the route.
    runtime._egressOf = () => null;
    const turn = { caseId: 'c-1', models: { egress: null, profileId: null } };
    const provider = runtime.routedProvider(turn, { targets: [{ provider: 'anthropic', model: 'claude-test' }], meta: { role: 'main' } });
    const result = await runLoop(provider);
    assert.strictEqual(result.type, 'complete');
    assertGrows();
  });
});

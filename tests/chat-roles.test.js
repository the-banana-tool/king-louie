// tests/chat-roles.test.js
// Roles on the chat send path (models spec 2026-09-27 §8, §10): each call
// of a reply records its role; later tasks add the sub-agent roll-up,
// titles on utility and the advisor's usage.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { chatHarness } = require('./helpers/chat-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const metricsFor = (model, costUsd = 0.001) => ({ provider: 'openai', model, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd });

describe('cost tags on a chat turn', () => {
  it('each call of the reply carries its role and profile, and the usage record its role', async () => {
    const provider = {
      streamMessage: async (_m, opts, onChunk) => { onChunk('Hello'); return { llmMetrics: metricsFor(opts.model) }; }
    };
    const h = chatHarness({ provider });
    await h.send({ agentMode: false });
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.deepStrictEqual([reply.llm.calls[0].role, reply.llm.calls[0].profileId, reply.llm.calls[0].failover], ['main', 'p-test', false]);
    assert.strictEqual(h.usage[0].role, 'main');
  });
});

describe('sub-agent calls roll up into the reply (spec §10)', () => {
  // The parent calls one tool, then answers. The "tool" reports a sub-agent
  // run the way SpawnAgent does, through onSubagentLlm.
  function rollupHarness({ stopAfterTool = false } = {}) {
    let parentCalls = 0;
    let h = null;
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => {
        parentCalls += 1;
        if (parentCalls === 1) return { type: 'tool_use', toolName: 'SpawnAgent', toolUseId: 't1', parameters: { task: 'look' }, llmMetrics: metricsFor(opts.model, 0.01) };
        return { type: 'text', content: 'done', llmMetrics: metricsFor(opts.model, 0.02) };
      },
      buildToolMessages: (response, toolResult, id) => [
        { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(toolResult) }
      ]
    };
    h = chatHarness({
      provider,
      overrides: {
        createToolExecutorWithApprovals: async (_event, _env, _requester, opts) => {
          const EventEmitter = require('events');
          const executor = new EventEmitter();
          executor.allowedDirectories = [];
          executor.execute = async () => {
            opts.onSubagentLlm({
              agentId: 'code-explorer',
              role: 'worker',
              calls: [{ ...metricsFor('worker-model', 0.003), role: 'worker' }, { ...metricsFor('worker-model', null), role: 'worker' }],
              totals: null
            });
            if (stopAfterTool) await h.stop();
            return { success: true, content: 'summary' };
          };
          return executor;
        }
      }
    });
    return h;
  }

  it('keeps the parent\'s calls, lists each sub-agent run, and totals both by role', async () => {
    const h = rollupHarness();
    await h.send({ agentMode: true });
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.strictEqual(reply.llm.calls.length, 2);
    assert.deepStrictEqual(reply.llm.subagents.map((s) => [s.agentId, s.role, s.calls.length]), [['code-explorer', 'worker', 2]]);
    assert.strictEqual(reply.llm.totals.costUsd, 0.033);
    assert.strictEqual(reply.llm.totals.unpriced, true);
    assert.deepStrictEqual(reply.llm.byRole.main, { calls: 2, totalTokens: 4, costUsd: 0.03 });
    assert.deepStrictEqual(reply.llm.byRole.worker, { calls: 2, totalTokens: 4, costUsd: 0.003, unpriced: true });
  });

  it('a stopped turn keeps the sub-agent calls that ran', async () => {
    const h = rollupHarness({ stopAfterTool: true });
    await h.send({ agentMode: true });
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.strictEqual(reply.stopped, true);
    assert.strictEqual(reply.llm.subagents[0].calls.length, 2);
    assert.strictEqual(reply.llm.byRole.worker.costUsd, 0.003);
    assert.strictEqual(reply.llm.totals.costUsd, 0.013);
  });
});

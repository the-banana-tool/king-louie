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

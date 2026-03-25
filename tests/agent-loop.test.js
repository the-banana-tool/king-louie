const { describe, it } = require('node:test');
const assert = require('node:assert');
const AgentLoop = require('../src/execution/agent-loop');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Provider that returns a canned sequence of responses, one per iteration. */
function sequenceProvider(responses) {
  let i = 0;
  return {
    sendMessageWithTools: async () => responses[i++],
    buildToolMessages: (response, toolResult, toolCallId) => [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) }
        }]
      },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ]
  };
}

/** Executor that always succeeds with a static result. */
function okExecutor(result = { ok: true, output: 'done' }) {
  return { execute: async () => result };
}

/** Executor that always throws. */
function throwingExecutor(message = 'tool exploded') {
  return { execute: async () => { throw new Error(message); } };
}

/** Executor that records calls and returns canned results. */
function recordingExecutor(results = []) {
  let i = 0;
  const calls = [];
  return {
    calls,
    execute: async (toolName, parameters, options) => {
      calls.push({ toolName, parameters, options });
      return results[i++] ?? { ok: true };
    }
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('AgentLoop', () => {
  describe('text response (no tools)', () => {
    it('returns complete with the provider content', async () => {
      const provider = sequenceProvider([
        { type: 'text', content: 'Hello world' }
      ]);
      const loop = new AgentLoop(provider, okExecutor());
      const result = await loop.run([{ role: 'user', content: 'hi' }], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'Hello world');
      assert.strictEqual(result.iterations, 1);
      assert.strictEqual(result.tools.length, 0);
    });

    it('returns empty string content without crashing', async () => {
      const provider = sequenceProvider([
        { type: 'text', content: '' }
      ]);
      const loop = new AgentLoop(provider, okExecutor());
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, '');
    });

    it('returns undefined content without crashing', async () => {
      const provider = sequenceProvider([
        { type: 'text', content: undefined }
      ]);
      const loop = new AgentLoop(provider, okExecutor());
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, undefined);
    });
  });

  describe('single tool call then text', () => {
    it('executes the tool and returns the final text', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'WebFetch', parameters: { url: 'https://example.com' } },
        { type: 'text', content: 'Here is the page summary' }
      ]);
      const executor = recordingExecutor([{ ok: true, content: '<html>page</html>' }]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'Here is the page summary');
      assert.strictEqual(result.iterations, 2);
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].name, 'WebFetch');
      assert.deepStrictEqual(result.tools[0].result, { ok: true, content: '<html>page</html>' });

      // Verify executor was called with correct args
      assert.strictEqual(executor.calls.length, 1);
      assert.strictEqual(executor.calls[0].toolName, 'WebFetch');
      assert.deepStrictEqual(executor.calls[0].parameters, { url: 'https://example.com' });
    });
  });

  describe('multiple sequential tool calls', () => {
    it('executes tools across iterations and preserves all results', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'WebSearch', parameters: { query: 'news' } },
        { type: 'tool_use', toolName: 'WebFetch', parameters: { url: 'https://cnn.com' } },
        { type: 'text', content: 'Summary of CNN' }
      ]);
      const executor = recordingExecutor([
        { ok: true, results: ['cnn.com'] },
        { ok: true, content: 'CNN page content' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 10 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.tools.length, 2);
      assert.strictEqual(result.tools[0].name, 'WebSearch');
      assert.strictEqual(result.tools[1].name, 'WebFetch');
      assert.strictEqual(result.iterations, 3);
    });
  });

  describe('tool executor returns error object', () => {
    it('passes error result back to provider as tool result without crashing', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'WebFetch', parameters: { url: 'https://bad.example' } },
        { type: 'text', content: 'Sorry, I could not fetch that page.' }
      ]);
      const executor = recordingExecutor([
        { success: false, error: 'Connection timed out' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'Sorry, I could not fetch that page.');
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].result.success, false);
      assert.strictEqual(result.tools[0].result.error, 'Connection timed out');
    });
  });

  describe('tool executor throws an exception', () => {
    it('propagates the error and does not silently swallow it', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'Bash', parameters: { command: 'ls' } }
      ]);
      const loop = new AgentLoop(provider, throwingExecutor('disk full'), { maxIterations: 5 });

      await assert.rejects(
        () => loop.run([], []),
        /disk full/
      );
    });
  });

  describe('max iterations', () => {
    it('returns max_iterations when tools keep being called', async () => {
      const provider = {
        sendMessageWithTools: async () => ({
          type: 'tool_use',
          toolName: 'WebFetch',
          parameters: { url: 'https://example.com' }
        }),
        buildToolMessages: (response, toolResult, toolCallId) => [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'WebFetch', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ]
      };
      const loop = new AgentLoop(provider, okExecutor(), { maxIterations: 3 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'max_iterations');
      assert.strictEqual(result.iterations, 3);
      assert.strictEqual(result.tools.length, 3);
    });

    it('preserves tool results collected before hitting max iterations', async () => {
      let callCount = 0;
      const provider = {
        sendMessageWithTools: async () => ({
          type: 'tool_use',
          toolName: `Tool${++callCount}`,
          parameters: {}
        }),
        buildToolMessages: (response, toolResult, toolCallId) => [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ]
      };
      const executor = recordingExecutor([
        { result: 'first' },
        { result: 'second' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 2 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'max_iterations');
      assert.strictEqual(result.tools.length, 2);
      assert.deepStrictEqual(result.tools[0].result, { result: 'first' });
      assert.deepStrictEqual(result.tools[1].result, { result: 'second' });
    });
  });

  describe('abort signal', () => {
    it('returns stopped immediately when already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const provider = sequenceProvider([{ type: 'text', content: 'should not reach' }]);
      const loop = new AgentLoop(provider, okExecutor(), { abortSignal: controller.signal });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'stopped');
      assert.ok(result.content.includes('stopped'));
    });

    it('returns stopped between iterations when aborted mid-run', async () => {
      const controller = new AbortController();
      let callCount = 0;

      const provider = {
        sendMessageWithTools: async () => {
          callCount++;
          if (callCount === 1) {
            // After first tool call completes, abort before next iteration
            controller.abort();
            return { type: 'tool_use', toolName: 'Bash', parameters: { command: 'echo hi' } };
          }
          return { type: 'text', content: 'should not reach' };
        },
        buildToolMessages: (response, toolResult, toolCallId) => [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ]
      };

      const loop = new AgentLoop(provider, okExecutor(), {
        maxIterations: 10,
        abortSignal: controller.signal
      });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'stopped');
      assert.strictEqual(result.tools.length, 1);
    });
  });

  describe('unsupported response type', () => {
    it('returns error for unknown response types', async () => {
      const provider = sequenceProvider([
        { type: 'unknown_thing', content: 'wat' }
      ]);
      const loop = new AgentLoop(provider, okExecutor());
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'error');
      assert.ok(result.content.includes('Unsupported'));
    });
  });

  describe('LLM metrics tracking', () => {
    it('accumulates metrics across multiple iterations', async () => {
      const provider = sequenceProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          parameters: { file: 'a.txt' },
          llmMetrics: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001, provider: 'openai', model: 'gpt-4' }
        },
        {
          type: 'text',
          content: 'done',
          llmMetrics: { inputTokens: 200, outputTokens: 80, totalTokens: 280, costUsd: 0.002, provider: 'openai', model: 'gpt-4' }
        }
      ]);
      const loop = new AgentLoop(provider, okExecutor(), { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.llm.calls.length, 2);
      assert.strictEqual(result.llm.totals.inputTokens, 300);
      assert.strictEqual(result.llm.totals.outputTokens, 130);
      assert.strictEqual(result.llm.totals.totalTokens, 430);
      assert.strictEqual(result.llm.totals.costUsd, 0.003);
    });

    it('handles missing llmMetrics gracefully', async () => {
      const provider = sequenceProvider([
        { type: 'text', content: 'no metrics' }
      ]);
      const loop = new AgentLoop(provider, okExecutor());
      const result = await loop.run([], []);

      assert.strictEqual(result.llm.calls.length, 0);
      assert.strictEqual(result.llm.totals.inputTokens, 0);
    });

    it('does not crash when onUsageRecorded callback throws', async () => {
      const provider = sequenceProvider([
        {
          type: 'text',
          content: 'ok',
          llmMetrics: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 }
        }
      ]);
      const mockTracker = {
        record: () => ({ id: 'usage-1' })
      };
      const loop = new AgentLoop(provider, okExecutor(), {
        usageTracker: mockTracker,
        onUsageRecorded: () => { throw new Error('callback boom'); }
      });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'ok');
    });
  });

  describe('conversation history building', () => {
    it('uses provider.buildToolMessages when available', async () => {
      const builtMessages = [];
      const provider = {
        sendMessageWithTools: async (history) => {
          if (history.length === 0) {
            return { type: 'tool_use', toolName: 'Grep', parameters: { pattern: 'foo' } };
          }
          return { type: 'text', content: 'found it' };
        },
        buildToolMessages: (response, toolResult, toolCallId) => {
          const msgs = [
            { role: 'assistant', custom: true, tool_calls: [{ id: toolCallId }] },
            { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
          ];
          builtMessages.push(...msgs);
          return msgs;
        }
      };
      const loop = new AgentLoop(provider, okExecutor(), { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.ok(builtMessages.length >= 2);
      assert.strictEqual(builtMessages[0].custom, true);
    });

    it('falls back to standard format when buildToolMessages is absent', async () => {
      let capturedHistory = [];
      const provider = {
        sendMessageWithTools: async (history) => {
          capturedHistory = [...history];
          if (history.length === 0) {
            return {
              type: 'tool_use',
              toolName: 'Read',
              parameters: { file: 'test.txt' },
              messageContent: 'Let me read that file'
            };
          }
          return { type: 'text', content: 'file contents here' };
        }
        // No buildToolMessages
      };
      const loop = new AgentLoop(provider, okExecutor({ content: 'file data' }), { maxIterations: 5 });
      await loop.run([], []);

      // After first tool call, history should have assistant + tool messages
      assert.ok(capturedHistory.length >= 2);
      const assistantMsg = capturedHistory.find(m => m.role === 'assistant');
      const toolMsg = capturedHistory.find(m => m.role === 'tool');
      assert.ok(assistantMsg);
      assert.ok(toolMsg);
      assert.strictEqual(assistantMsg.content, 'Let me read that file');
      assert.ok(assistantMsg.tool_calls.length > 0);
    });
  });

  describe('tool validation error mid-loop does not kill the session', () => {
    it('continues the loop when executor returns a validation error result', async () => {
      // Simulates the real scenario: LLM calls a tool with missing required param,
      // executor returns { success: false, error: 'Missing required parameter: content' },
      // LLM gets the error and retries or responds with text.
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'Write', parameters: { path: '/tmp/x' } }, // missing 'content'
        { type: 'text', content: 'Sorry, let me try again with the correct parameters.' }
      ]);
      const executor = recordingExecutor([
        { success: false, error: 'Missing required parameter: content' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'Sorry, let me try again with the correct parameters.');
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].result.success, false);
      assert.ok(result.tools[0].result.error.includes('Missing required parameter'));
      assert.strictEqual(result.iterations, 2);
    });

    it('preserves all tool history when validation error occurs mid-chain', async () => {
      // Tool 1 succeeds, tool 2 has validation error, LLM recovers with text
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'Read', parameters: { file: 'a.txt' } },
        { type: 'tool_use', toolName: 'Write', parameters: {} }, // missing required params
        { type: 'text', content: 'I encountered an error writing. Here is what I read.' }
      ]);
      const executor = recordingExecutor([
        { ok: true, content: 'file contents' },
        { success: false, error: 'Missing required parameter: content' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 10 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.tools.length, 2);
      assert.strictEqual(result.tools[0].result.ok, true);
      assert.strictEqual(result.tools[1].result.success, false);
      assert.strictEqual(result.iterations, 3);
    });

    it('LLM can retry the tool call after validation error', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'Write', parameters: { path: '/tmp/x' } }, // missing content
        { type: 'tool_use', toolName: 'Write', parameters: { path: '/tmp/x', content: 'hello' } }, // retry with content
        { type: 'text', content: 'File written successfully.' }
      ]);
      const executor = recordingExecutor([
        { success: false, error: 'Missing required parameter: content' },
        { ok: true, output: 'written' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 10 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'File written successfully.');
      assert.strictEqual(result.tools.length, 2);
      assert.strictEqual(result.tools[0].result.success, false);
      assert.strictEqual(result.tools[1].result.ok, true);
    });
  });

  describe('tool errors preserve accumulated state', () => {
    it('LLM metrics are preserved even when a tool call returns an error', async () => {
      const provider = sequenceProvider([
        {
          type: 'tool_use',
          toolName: 'Write',
          parameters: {},
          llmMetrics: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001, provider: 'openai', model: 'gpt-4' }
        },
        {
          type: 'text',
          content: 'Recovered from error.',
          llmMetrics: { inputTokens: 200, outputTokens: 80, totalTokens: 280, costUsd: 0.002, provider: 'openai', model: 'gpt-4' }
        }
      ]);
      const executor = recordingExecutor([
        { success: false, error: 'Missing required parameter: content' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.llm.calls.length, 2);
      assert.strictEqual(result.llm.totals.inputTokens, 300);
      assert.strictEqual(result.llm.totals.costUsd, 0.003);
    });

    it('tools executed before a max_iterations cutoff are all preserved', async () => {
      let callCount = 0;
      const provider = {
        sendMessageWithTools: async () => ({
          type: 'tool_use',
          toolName: 'Read',
          parameters: { file: `file${++callCount}.txt` }
        }),
        buildToolMessages: (response, toolResult, toolCallId) => [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ]
      };
      const executor = recordingExecutor([
        { ok: true, content: 'a' },
        { ok: true, content: 'b' },
        { success: false, error: 'file not found' },
        { ok: true, content: 'd' },
        { ok: true, content: 'e' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'max_iterations');
      assert.strictEqual(result.tools.length, 5);
      // The third tool had an error - verify it's preserved
      assert.strictEqual(result.tools[2].result.success, false);
      assert.strictEqual(result.tools[2].result.error, 'file not found');
      // Others succeeded
      assert.strictEqual(result.tools[0].result.ok, true);
      assert.strictEqual(result.tools[4].result.ok, true);
    });

    it('abort preserves tool history accumulated before abort', async () => {
      const controller = new AbortController();
      let callCount = 0;

      const provider = {
        sendMessageWithTools: async () => {
          callCount++;
          if (callCount === 2) controller.abort();
          return { type: 'tool_use', toolName: 'Bash', parameters: { command: `cmd${callCount}` } };
        },
        buildToolMessages: (response, toolResult, toolCallId) => [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ]
      };

      const executor = recordingExecutor([
        { ok: true, output: 'first' },
        { ok: true, output: 'second' }
      ]);

      const loop = new AgentLoop(provider, executor, {
        maxIterations: 10,
        abortSignal: controller.signal
      });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'stopped');
      // Should have the tools from iterations that completed before abort was checked
      assert.ok(result.tools.length >= 1, `expected at least 1 tool, got ${result.tools.length}`);
    });
  });

  describe('provider throws during sendMessageWithTools', () => {
    it('propagates the provider error', async () => {
      const provider = {
        sendMessageWithTools: async () => {
          throw new Error('API rate limit exceeded');
        }
      };
      const loop = new AgentLoop(provider, okExecutor());

      await assert.rejects(
        () => loop.run([], []),
        /API rate limit exceeded/
      );
    });
  });

  describe('null/undefined tool result', () => {
    it('handles null tool result without crashing', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'Bash', parameters: { command: 'true' } },
        { type: 'text', content: 'ok' }
      ]);
      const executor = { execute: async () => null };
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.tools[0].result, null);
    });

    it('handles undefined tool result without crashing', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'Bash', parameters: { command: 'true' } },
        { type: 'text', content: 'ok' }
      ]);
      const executor = { execute: async () => undefined };
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.tools[0].result, undefined);
    });
  });
});

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

  describe('parallel tool calls', () => {
    /** Provider that supports multi-tool responses via buildMultiToolMessages. */
    function multiToolProvider(responses) {
      let i = 0;
      return {
        sendMessageWithTools: async () => responses[i++],
        buildToolMessages: (response, toolResult, toolCallId) => [
          {
            role: 'assistant',
            content: response.messageContent || '',
            tool_calls: [{
              id: toolCallId,
              type: 'function',
              function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) }
            }]
          },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ],
        buildMultiToolMessages: (response, toolCallEntries) => {
          const messages = [{
            role: 'assistant',
            content: response.messageContent || '',
            tool_calls: toolCallEntries.map(e => ({
              id: e.toolCallId,
              type: 'function',
              function: { name: e.toolName, arguments: JSON.stringify(e.parameters || {}) }
            }))
          }];
          for (const entry of toolCallEntries) {
            messages.push({ role: 'tool', tool_call_id: entry.toolCallId, content: JSON.stringify(entry.result) });
          }
          return messages;
        }
      };
    }

    it('executes multiple tool calls from one response in parallel', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'a.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } },
            { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'b.txt' } },
            { toolName: 'Read', toolUseId: 'call_3', parameters: { file: 'c.txt' } }
          ],
          messageContent: 'Let me read all three files.'
        },
        { type: 'text', content: 'Here are the contents of all three files.' }
      ]);
      const executor = recordingExecutor([
        { ok: true, content: 'file a' },
        { ok: true, content: 'file b' },
        { ok: true, content: 'file c' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.iterations, 2);
      assert.strictEqual(result.tools.length, 3);
      assert.strictEqual(result.tools[0].name, 'Read');
      assert.strictEqual(result.tools[1].name, 'Read');
      assert.strictEqual(result.tools[2].name, 'Read');
      assert.deepStrictEqual(result.tools[0].parameters, { file: 'a.txt' });
      assert.deepStrictEqual(result.tools[1].parameters, { file: 'b.txt' });
      assert.deepStrictEqual(result.tools[2].parameters, { file: 'c.txt' });
      assert.strictEqual(result.tools[0].result.content, 'file a');
      assert.strictEqual(result.tools[1].result.content, 'file b');
      assert.strictEqual(result.tools[2].result.content, 'file c');
    });

    it('calls executor for each tool in a parallel batch', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'x.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'x.txt' } },
            { toolName: 'Bash', toolUseId: 'call_2', parameters: { command: 'ls' } }
          ],
          messageContent: ''
        },
        { type: 'text', content: 'done' }
      ]);
      const executor = recordingExecutor([
        { ok: true, content: 'x content' },
        { ok: true, output: 'file1 file2' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      await loop.run([], []);

      assert.strictEqual(executor.calls.length, 2);
      assert.strictEqual(executor.calls[0].toolName, 'Read');
      assert.strictEqual(executor.calls[1].toolName, 'Bash');
    });

    it('executes tools concurrently (not sequentially)', async () => {
      const executionLog = [];
      const executor = {
        execute: async (toolName, parameters) => {
          executionLog.push({ toolName, event: 'start', time: Date.now() });
          // Simulate async work
          await new Promise(resolve => setTimeout(resolve, 50));
          executionLog.push({ toolName, event: 'end', time: Date.now() });
          return { ok: true };
        }
      };

      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'a.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } },
            { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'b.txt' } },
            { toolName: 'Read', toolUseId: 'call_3', parameters: { file: 'c.txt' } }
          ],
          messageContent: ''
        },
        { type: 'text', content: 'done' }
      ]);

      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      await loop.run([], []);

      // All three starts should happen before any end if truly parallel
      const starts = executionLog.filter(e => e.event === 'start');
      const ends = executionLog.filter(e => e.event === 'end');
      assert.strictEqual(starts.length, 3);
      assert.strictEqual(ends.length, 3);

      // All starts should occur before the first end (concurrent execution)
      const lastStart = Math.max(...starts.map(e => e.time));
      const firstEnd = Math.min(...ends.map(e => e.time));
      assert.ok(lastStart <= firstEnd, 'All tool starts should occur before the first tool ends (parallel execution)');
    });

    it('handles mixed success and failure in parallel batch', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'good.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'good.txt' } },
            { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'bad.txt' } },
            { toolName: 'Read', toolUseId: 'call_3', parameters: { file: 'also-good.txt' } }
          ],
          messageContent: ''
        },
        { type: 'text', content: 'One file was not found.' }
      ]);
      const executor = recordingExecutor([
        { ok: true, content: 'good content' },
        { ok: false, error: 'File not found' },
        { ok: true, content: 'also good content' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.tools.length, 3);
      assert.strictEqual(result.tools[0].result.ok, true);
      assert.strictEqual(result.tools[1].result.ok, false);
      assert.strictEqual(result.tools[1].result.error, 'File not found');
      assert.strictEqual(result.tools[2].result.ok, true);
    });

    it('propagates exception when a tool in parallel batch throws', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'ok.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'ok.txt' } },
            { toolName: 'Bash', toolUseId: 'call_2', parameters: { command: 'fail' } }
          ],
          messageContent: ''
        }
      ]);

      let callCount = 0;
      const executor = {
        execute: async (toolName) => {
          callCount++;
          if (toolName === 'Bash') throw new Error('bash exploded');
          return { ok: true };
        }
      };

      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      await assert.rejects(() => loop.run([], []), /bash exploded/);
    });

    it('builds conversation history with buildMultiToolMessages for multi-tool responses', async () => {
      let capturedHistory = [];
      let callCount = 0;
      const provider = {
        sendMessageWithTools: async (history) => {
          callCount++;
          capturedHistory = [...history];
          if (callCount === 1) {
            return {
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'call_1',
              parameters: { file: 'a.txt' },
              toolCalls: [
                { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } },
                { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'b.txt' } }
              ],
              messageContent: 'Reading files.'
            };
          }
          return { type: 'text', content: 'done' };
        },
        buildToolMessages: (response, toolResult, toolCallId) => [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ],
        buildMultiToolMessages: (response, toolCallEntries) => {
          const messages = [{
            role: 'assistant',
            content: response.messageContent || '',
            tool_calls: toolCallEntries.map(e => ({
              id: e.toolCallId,
              type: 'function',
              function: { name: e.toolName, arguments: JSON.stringify(e.parameters || {}) }
            }))
          }];
          for (const entry of toolCallEntries) {
            messages.push({ role: 'tool', tool_call_id: entry.toolCallId, content: JSON.stringify(entry.result) });
          }
          return messages;
        }
      };
      const executor = recordingExecutor([{ ok: true, content: 'a' }, { ok: true, content: 'b' }]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      await loop.run([{ role: 'user', content: 'read files' }], []);

      // After the parallel call, history should have: user msg + 1 assistant msg + 2 tool msgs
      const assistantMsgs = capturedHistory.filter(m => m.role === 'assistant');
      const toolMsgs = capturedHistory.filter(m => m.role === 'tool');
      assert.strictEqual(assistantMsgs.length, 1, 'Should have exactly 1 assistant message for the batch');
      assert.strictEqual(assistantMsgs[0].tool_calls.length, 2, 'Assistant message should have 2 tool_calls');
      assert.strictEqual(toolMsgs.length, 2, 'Should have 2 tool result messages');
      assert.strictEqual(assistantMsgs[0].content, 'Reading files.');
    });

    it('uses buildToolMessages (not multi) for single-tool response with toolCalls array of 1', async () => {
      let usedBuildToolMessages = false;
      let usedBuildMultiToolMessages = false;

      const provider = {
        sendMessageWithTools: async (history) => {
          if (history.length === 0) {
            return {
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'call_1',
              parameters: { file: 'a.txt' },
              toolCalls: [{ toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } }],
              messageContent: ''
            };
          }
          return { type: 'text', content: 'done' };
        },
        buildToolMessages: (response, toolResult, toolCallId) => {
          usedBuildToolMessages = true;
          return [
            { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
            { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
          ];
        },
        buildMultiToolMessages: () => {
          usedBuildMultiToolMessages = true;
          return [];
        }
      };
      const loop = new AgentLoop(provider, okExecutor(), { maxIterations: 5 });
      await loop.run([], []);

      assert.strictEqual(usedBuildToolMessages, true, 'Should use buildToolMessages for single tool call');
      assert.strictEqual(usedBuildMultiToolMessages, false, 'Should NOT use buildMultiToolMessages for single tool call');
    });

    it('falls back to generic format when provider lacks buildMultiToolMessages', async () => {
      let capturedHistory = [];
      let callCount = 0;
      const provider = {
        sendMessageWithTools: async (history) => {
          callCount++;
          capturedHistory = [...history];
          if (callCount === 1) {
            return {
              type: 'tool_use',
              toolName: 'Read',
              toolUseId: 'call_1',
              parameters: { file: 'a.txt' },
              toolCalls: [
                { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } },
                { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'b.txt' } }
              ],
              messageContent: ''
            };
          }
          return { type: 'text', content: 'done' };
        }
        // No buildToolMessages or buildMultiToolMessages
      };
      const executor = recordingExecutor([{ ok: true }, { ok: true }]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      await loop.run([], []);

      // Generic fallback creates individual assistant+tool message pairs
      const assistantMsgs = capturedHistory.filter(m => m.role === 'assistant');
      const toolMsgs = capturedHistory.filter(m => m.role === 'tool');
      assert.ok(assistantMsgs.length >= 2, 'Generic fallback should create assistant messages for each call');
      assert.ok(toolMsgs.length >= 2, 'Generic fallback should create tool messages for each call');
    });

    it('merges injected tools from multiple parallel tool results', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'RequestTools',
          toolUseId: 'call_1',
          parameters: {},
          toolCalls: [
            { toolName: 'RequestTools', toolUseId: 'call_1', parameters: {} },
            { toolName: 'RequestTools', toolUseId: 'call_2', parameters: {} }
          ],
          messageContent: ''
        },
        { type: 'text', content: 'done' }
      ]);

      let callCount = 0;
      const executor = {
        execute: async () => {
          callCount++;
          return {
            ok: true,
            _injectedTools: callCount === 1
              ? [{ name: 'ToolA', description: 'A', parameters: {} }]
              : [{ name: 'ToolB', description: 'B', parameters: {} }, { name: 'ToolA', description: 'A dup', parameters: {} }]
          };
        }
      };

      let capturedTools = [];
      const origSendMessage = provider.sendMessageWithTools;
      provider.sendMessageWithTools = async (history, tools, options) => {
        capturedTools = tools;
        return origSendMessage(history, tools, options);
      };

      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      await loop.run([], [{ name: 'RequestTools', description: 'req', parameters: {} }]);

      const toolNames = capturedTools.map(t => t.name);
      assert.ok(toolNames.includes('ToolA'), 'ToolA should be injected');
      assert.ok(toolNames.includes('ToolB'), 'ToolB should be injected');
      // ToolA should not be duplicated
      assert.strictEqual(toolNames.filter(n => n === 'ToolA').length, 1, 'ToolA should not be duplicated');
    });

    it('tracks all parallel tool results for semantic compaction', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'a.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } },
            { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'b.txt' } },
            { toolName: 'Bash', toolUseId: 'call_3', parameters: { command: 'ls' } }
          ],
          messageContent: ''
        },
        { type: 'text', content: 'done' }
      ]);
      const executor = recordingExecutor([
        { ok: true, content: 'aaa' },
        { ok: true, content: 'bbb' },
        { ok: true, output: 'ccc' }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      await loop.run([], []);

      assert.strictEqual(loop._toolResultEntries.length, 3);
      assert.ok(loop._toolResultEntries[0].text.startsWith('Read:'));
      assert.ok(loop._toolResultEntries[1].text.startsWith('Read:'));
      assert.ok(loop._toolResultEntries[2].text.startsWith('Bash:'));
      assert.strictEqual(loop._toolResultEntries[0].compacted, false);
    });

    it('counts parallel batch as a single iteration', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'a.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } },
            { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'b.txt' } },
            { toolName: 'Read', toolUseId: 'call_3', parameters: { file: 'c.txt' } },
            { toolName: 'Read', toolUseId: 'call_4', parameters: { file: 'd.txt' } },
            { toolName: 'Read', toolUseId: 'call_5', parameters: { file: 'e.txt' } },
            { toolName: 'Read', toolUseId: 'call_6', parameters: { file: 'f.txt' } },
            { toolName: 'Read', toolUseId: 'call_7', parameters: { file: 'g.txt' } }
          ],
          messageContent: ''
        },
        { type: 'text', content: 'Read all 7 files.' }
      ]);
      const executor = recordingExecutor(Array(7).fill({ ok: true, content: 'data' }));
      const loop = new AgentLoop(provider, executor, { maxIterations: 5 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.iterations, 2, '7 parallel tools + 1 text = 2 iterations');
      assert.strictEqual(result.tools.length, 7);
    });

    it('handles parallel batch followed by sequential tool call', async () => {
      const provider = multiToolProvider([
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'call_1',
          parameters: { file: 'a.txt' },
          toolCalls: [
            { toolName: 'Read', toolUseId: 'call_1', parameters: { file: 'a.txt' } },
            { toolName: 'Read', toolUseId: 'call_2', parameters: { file: 'b.txt' } }
          ],
          messageContent: ''
        },
        {
          type: 'tool_use',
          toolName: 'Write',
          toolUseId: 'call_3',
          parameters: { file: 'out.txt', content: 'merged' },
          messageContent: ''
        },
        { type: 'text', content: 'Files merged.' }
      ]);
      const executor = recordingExecutor([
        { ok: true, content: 'a data' },
        { ok: true, content: 'b data' },
        { ok: true }
      ]);
      const loop = new AgentLoop(provider, executor, { maxIterations: 10 });
      const result = await loop.run([], []);

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.iterations, 3);
      assert.strictEqual(result.tools.length, 3);
      assert.strictEqual(result.tools[0].name, 'Read');
      assert.strictEqual(result.tools[1].name, 'Read');
      assert.strictEqual(result.tools[2].name, 'Write');
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

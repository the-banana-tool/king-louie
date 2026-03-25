const { describe, it } = require('node:test');
const assert = require('node:assert');
const AgentExecutor = require('../src/agents/agent-executor');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides = {}) {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'An agent for testing',
    model: 'gpt-4',
    systemPrompt: 'You are a test agent.',
    maxIterations: 10,
    allowedTools: ['WebFetch', 'WebSearch', 'Read', 'Bash'],
    autoApproveTools: [],
    canUseTool: (name) => {
      const allowed = overrides.allowedTools || ['WebFetch', 'WebSearch', 'Read', 'Bash'];
      return allowed.includes(name);
    },
    ...overrides
  };
}

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

function okExecutor(result = { ok: true }) {
  return { execute: async () => result };
}

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

describe('AgentExecutor', () => {
  describe('basic execution', () => {
    it('runs agent and returns complete result', async () => {
      const provider = sequenceProvider([
        { type: 'text', content: 'Agent response here' }
      ]);
      const executor = new AgentExecutor(provider, okExecutor());
      const agent = makeAgent();

      const result = await executor.execute(agent, 'Hello agent');

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'Agent response here');
    });

    it('throws when agent is null', async () => {
      const provider = sequenceProvider([]);
      const executor = new AgentExecutor(provider, okExecutor());

      await assert.rejects(
        () => executor.execute(null, 'hello'),
        /Agent is required/
      );
    });
  });

  describe('tool filtering', () => {
    it('only passes tools the agent is allowed to use', async () => {
      let receivedTools = [];
      const provider = {
        sendMessageWithTools: async (_messages, tools) => {
          receivedTools = tools;
          return { type: 'text', content: 'done' };
        }
      };
      const agent = makeAgent({
        allowedTools: ['Read'],
        canUseTool: (name) => name === 'Read'
      });
      const allTools = [
        { name: 'Read', description: 'read files' },
        { name: 'Bash', description: 'run commands' },
        { name: 'Write', description: 'write files' }
      ];

      const executor = new AgentExecutor(provider, okExecutor());
      await executor.execute(agent, 'test', { tools: allTools });

      assert.strictEqual(receivedTools.length, 1);
      assert.strictEqual(receivedTools[0].name, 'Read');
    });
  });

  describe('tool execution through agent', () => {
    it('executes tools and returns final response with tool history', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'WebFetch', parameters: { url: 'https://example.com' } },
        { type: 'text', content: 'Page loaded successfully' }
      ]);
      const toolExecutor = recordingExecutor([
        { ok: true, content: '<html>Example</html>' }
      ]);
      const executor = new AgentExecutor(provider, toolExecutor);
      const agent = makeAgent();

      const result = await executor.execute(agent, 'Check example.com', {
        tools: [{ name: 'WebFetch' }]
      });

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'Page loaded successfully');
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].name, 'WebFetch');
      assert.strictEqual(toolExecutor.calls.length, 1);
    });

    it('handles tool error results without losing the response', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'WebFetch', parameters: { url: 'https://bad.example' } },
        { type: 'text', content: 'The page could not be fetched.' }
      ]);
      const toolExecutor = recordingExecutor([
        { success: false, error: 'DNS resolution failed' }
      ]);
      const executor = new AgentExecutor(provider, toolExecutor);
      const agent = makeAgent();

      const result = await executor.execute(agent, 'Check bad.example', {
        tools: [{ name: 'WebFetch' }]
      });

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.content, 'The page could not be fetched.');
      assert.strictEqual(result.tools[0].result.success, false);
      assert.strictEqual(result.tools[0].result.error, 'DNS resolution failed');
    });

    it('preserves all tools when multiple are called sequentially', async () => {
      const provider = sequenceProvider([
        { type: 'tool_use', toolName: 'WebSearch', parameters: { query: 'cnn' } },
        { type: 'tool_use', toolName: 'WebFetch', parameters: { url: 'https://cnn.com' } },
        { type: 'tool_use', toolName: 'Read', parameters: { file: 'notes.txt' } },
        { type: 'text', content: 'Here is a summary of everything.' }
      ]);
      const toolExecutor = recordingExecutor([
        { ok: true, results: ['https://cnn.com'] },
        { ok: true, content: 'CNN headlines...' },
        { ok: true, content: 'My notes...' }
      ]);
      const executor = new AgentExecutor(provider, toolExecutor);
      const agent = makeAgent();

      const result = await executor.execute(agent, 'Summarize CNN and my notes', {
        tools: [{ name: 'WebSearch' }, { name: 'WebFetch' }, { name: 'Read' }]
      });

      assert.strictEqual(result.type, 'complete');
      assert.strictEqual(result.tools.length, 3);
      assert.strictEqual(result.tools[0].name, 'WebSearch');
      assert.strictEqual(result.tools[1].name, 'WebFetch');
      assert.strictEqual(result.tools[2].name, 'Read');
      assert.strictEqual(result.iterations, 4);
    });
  });

  describe('system prompt', () => {
    it('passes agent systemPrompt to the loop', async () => {
      let receivedOptions = {};
      const provider = {
        sendMessageWithTools: async (_messages, _tools, options) => {
          receivedOptions = options;
          return { type: 'text', content: 'ok' };
        }
      };
      const agent = makeAgent({ systemPrompt: 'You are a helpful bot.' });
      const executor = new AgentExecutor(provider, okExecutor());

      await executor.execute(agent, 'test', { tools: [] });

      assert.ok(receivedOptions.systemPrompt.includes('You are a helpful bot.'));
    });

    it('combines agent systemPrompt with options systemPrompt', async () => {
      let receivedOptions = {};
      const provider = {
        sendMessageWithTools: async (_messages, _tools, options) => {
          receivedOptions = options;
          return { type: 'text', content: 'ok' };
        }
      };
      const agent = makeAgent({ systemPrompt: 'Agent prompt.' });
      const executor = new AgentExecutor(provider, okExecutor());

      await executor.execute(agent, 'test', {
        tools: [],
        systemPrompt: 'Runtime context.'
      });

      assert.ok(receivedOptions.systemPrompt.includes('Agent prompt.'));
      assert.ok(receivedOptions.systemPrompt.includes('Runtime context.'));
    });
  });

  describe('usage tracking', () => {
    it('passes usageTracker through to the loop', async () => {
      const recorded = [];
      const mockTracker = {
        record: (evt) => { recorded.push(evt); return evt; }
      };
      const provider = sequenceProvider([
        {
          type: 'text',
          content: 'done',
          llmMetrics: { inputTokens: 50, outputTokens: 20, totalTokens: 70, costUsd: 0.001, provider: 'openai', model: 'gpt-4' }
        }
      ]);
      const executor = new AgentExecutor(provider, okExecutor(), { usageTracker: mockTracker });
      const agent = makeAgent();

      await executor.execute(agent, 'test', { tools: [] });

      assert.strictEqual(recorded.length, 1);
      assert.strictEqual(recorded[0].inputTokens, 50);
    });
  });

  describe('max iterations from agent config', () => {
    it('respects agent maxIterations setting', async () => {
      let callCount = 0;
      const provider = {
        sendMessageWithTools: async () => {
          callCount++;
          return { type: 'tool_use', toolName: 'Bash', parameters: { command: 'echo' } };
        },
        buildToolMessages: (response, toolResult, toolCallId) => [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ]
      };
      const agent = makeAgent({ maxIterations: 3 });
      const executor = new AgentExecutor(provider, okExecutor());

      const result = await executor.execute(agent, 'loop forever', {
        tools: [{ name: 'Bash' }]
      });

      assert.strictEqual(result.type, 'max_iterations');
      assert.strictEqual(callCount, 3);
    });
  });

  describe('autoApproveTools', () => {
    it('passes agent autoApproveTools to the loop options', async () => {
      let receivedOptions = {};
      const provider = {
        sendMessageWithTools: async (_messages, _tools, options) => {
          receivedOptions = options;
          return { type: 'text', content: 'ok' };
        }
      };
      const agent = makeAgent({ autoApproveTools: ['Bash', 'Read'] });
      const executor = new AgentExecutor(provider, okExecutor());

      await executor.execute(agent, 'test', { tools: [] });

      assert.deepStrictEqual(receivedOptions.autoApproveTools, ['Bash', 'Read']);
    });
  });
});

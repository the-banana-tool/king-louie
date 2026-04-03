const { describe, it } = require('node:test');
const assert = require('node:assert');
const SpawnAgentTool = require('../src/tools/builtin/spawn-agent-tool');

// ── helpers ──────────────────────────────────────────────────────────────────

const fakeAgents = {
  main: { id: 'main', name: 'Main', model: 'test-model', maxIterations: 10, canUseTool: () => true },
  'code-writer': { id: 'code-writer', name: 'Code Writer', model: 'test-model', maxIterations: 10, canUseTool: () => true },
  planner: { id: 'planner', name: 'Planner', model: 'test-model', maxIterations: 15, canUseTool: () => true }
};

function makeOptions(overrides = {}) {
  return {
    agentExecutorAdapter: {
      execute: async (agent, message, options) => ({
        type: 'complete',
        content: `Agent ${agent.id} executed: ${message}`,
        iterations: 2,
        tools: [{ name: 'Read' }, { name: 'Bash' }],
        llm: { totals: { inputTokens: 100, outputTokens: 200, costUsd: 0.01 } }
      }),
      ...(overrides.adapter || {})
    },
    getAgent: (id) => fakeAgents[id] || null,
    listAgents: () => Object.values(fakeAgents),
    toolRegistry: {},
    inferenceRouter: {},
    ...overrides
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('SpawnAgentTool', () => {
  describe('schema', () => {
    it('has the correct name', () => {
      assert.strictEqual(SpawnAgentTool.name, 'SpawnAgent');
    });

    it('does not require approval', () => {
      assert.strictEqual(SpawnAgentTool.requiresApproval, false);
    });

    it('requires task parameter', () => {
      assert.deepStrictEqual(SpawnAgentTool.parameters.required, ['task']);
    });

    it('has all expected parameters', () => {
      const props = SpawnAgentTool.parameters.properties;
      assert.ok(props.task);
      assert.ok(props.agentId);
      assert.ok(props.model);
      assert.ok(props.provider);
      assert.ok(props.maxIterations);
      assert.ok(props.systemPromptAppend);
      assert.ok(props.tools);
    });
  });

  describe('execute()', () => {
    it('spawns default agent and returns result', async () => {
      const result = await SpawnAgentTool.execute(
        { task: 'Find all TODO comments' },
        makeOptions()
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.agentId, 'main');
      assert.ok(result.content.includes('Find all TODO comments'));
      assert.strictEqual(result.iterations, 2);
      assert.deepStrictEqual(result.toolsUsed, ['Read', 'Bash']);
      assert.ok(result.llm);
    });

    it('spawns specified agent', async () => {
      const result = await SpawnAgentTool.execute(
        { task: 'Write a function', agentId: 'code-writer' },
        makeOptions()
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.agentId, 'code-writer');
      assert.ok(result.content.includes('code-writer'));
    });

    it('passes model override', async () => {
      let capturedOptions = {};
      const result = await SpawnAgentTool.execute(
        { task: 'Test', model: 'gpt-4o' },
        makeOptions({
          adapter: {
            execute: async (agent, msg, opts) => {
              capturedOptions = opts;
              return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
            }
          }
        })
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(capturedOptions.model, 'gpt-4o');
    });

    it('passes maxIterations override', async () => {
      let capturedOptions = {};
      await SpawnAgentTool.execute(
        { task: 'Test', maxIterations: 25 },
        makeOptions({
          adapter: {
            execute: async (agent, msg, opts) => {
              capturedOptions = opts;
              return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
            }
          }
        })
      );

      assert.strictEqual(capturedOptions.maxIterations, 25);
    });

    it('passes systemPromptAppend', async () => {
      let capturedOptions = {};
      await SpawnAgentTool.execute(
        { task: 'Test', systemPromptAppend: 'Be extra careful' },
        makeOptions({
          adapter: {
            execute: async (agent, msg, opts) => {
              capturedOptions = opts;
              return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
            }
          }
        })
      );

      assert.strictEqual(capturedOptions.systemPrompt, 'Be extra careful');
    });

    it('returns error for unknown agent', async () => {
      const result = await SpawnAgentTool.execute(
        { task: 'Test', agentId: 'nonexistent' },
        makeOptions()
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Unknown agent'));
      assert.ok(result.error.includes('nonexistent'));
      assert.ok(result.error.includes('main'));
    });

    it('returns error when agentExecutorAdapter is missing', async () => {
      const result = await SpawnAgentTool.execute(
        { task: 'Test' },
        { getAgent: () => null }
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('agentExecutorAdapter'));
    });

    it('returns error when getAgent is missing', async () => {
      const result = await SpawnAgentTool.execute(
        { task: 'Test' },
        { agentExecutorAdapter: { execute: async () => {} } }
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('getAgent'));
    });

    it('returns error when adapter throws', async () => {
      const result = await SpawnAgentTool.execute(
        { task: 'Test' },
        makeOptions({
          adapter: {
            execute: async () => { throw new Error('Provider timeout'); }
          }
        })
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Provider timeout'));
    });

    it('passes provider override through options', async () => {
      let capturedOptions = {};
      await SpawnAgentTool.execute(
        { task: 'Test', provider: 'gemini' },
        makeOptions({
          adapter: {
            execute: async (agent, msg, opts) => {
              capturedOptions = opts;
              return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
            }
          }
        })
      );

      assert.strictEqual(capturedOptions.provider, 'gemini');
    });

    it('passes tool filter through options', async () => {
      let capturedOptions = {};
      await SpawnAgentTool.execute(
        { task: 'Test', tools: ['Read', 'Grep'] },
        makeOptions({
          adapter: {
            execute: async (agent, msg, opts) => {
              capturedOptions = opts;
              return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
            }
          }
        })
      );

      assert.deepStrictEqual(capturedOptions.toolFilter, ['Read', 'Grep']);
    });
  });
});

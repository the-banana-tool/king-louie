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
      assert.ok(props.role);
      // A sub-agent names a role, never a provider (models spec 2026-09-27 §8).
      assert.strictEqual(props.provider, undefined);
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
      // The core checks the model against the turn's profile (M-D2).
      assert.strictEqual(capturedOptions.requireInProfile, true);
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

    it('passes the parent call abort signal to the child as abortSignal', async () => {
      let capturedOptions = {};
      const controller = new AbortController();
      await SpawnAgentTool.execute(
        { task: 'Test' },
        makeOptions({
          signal: controller.signal,
          adapter: {
            execute: async (agent, msg, opts) => {
              capturedOptions = opts;
              return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
            }
          }
        })
      );

      assert.strictEqual(capturedOptions.abortSignal, controller.signal);
    });
  });

  describe('roles (models spec 2026-09-27 §8)', () => {
    const capture = () => {
      const seen = [];
      const options = makeOptions({
        adapter: {
          execute: async (agent, msg, opts) => {
            seen.push({ agentId: agent.id, opts });
            return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { calls: [{ model: 'worker-model' }], totals: {} } };
          }
        }
      });
      return { seen, options };
    };

    it('runs a bare SpawnAgent on worker', async () => {
      const { seen, options } = capture();
      const result = await SpawnAgentTool.execute({ task: 'Find the config loader' }, options);
      assert.strictEqual(seen[0].opts.role, 'worker');
      assert.strictEqual(result.role, 'worker');
      assert.strictEqual(result.model, 'worker-model');
    });

    it('leaves a named agent on its own role unless a role is given', async () => {
      const { seen, options } = capture();
      await SpawnAgentTool.execute({ task: 'Plan it', agentId: 'planner' }, options);
      await SpawnAgentTool.execute({ task: 'Plan it', agentId: 'planner', role: 'utility' }, options);
      assert.strictEqual('role' in seen[0].opts, false);
      assert.strictEqual(seen[1].opts.role, 'utility');
    });

    it('asks the core to check a named model against the profile', async () => {
      const { seen, options } = capture();
      await SpawnAgentTool.execute({ task: 'x', model: 'openai/gpt-5.4-mini' }, options);
      assert.deepStrictEqual([seen[0].opts.model, seen[0].opts.requireInProfile], ['openai/gpt-5.4-mini', true]);
    });

    it('reports a refused model as a failed spawn', async () => {
      const refused = Object.assign(new Error('gpt-9 is not in the profile "Work". A sub-agent may use only models placed in a role: openai/gpt-5.5. Name a role instead.'), { code: 'MODEL_NOT_IN_PROFILE' });
      const result = await SpawnAgentTool.execute(
        { task: 'x', model: 'gpt-9' },
        makeOptions({ adapter: { execute: async () => { throw refused; } } })
      );
      assert.strictEqual(result.success, false);
      assert.match(result.error, /not in the profile "Work"/);
    });

    it('reports the child\'s calls to the parent turn, never an empty run (spec §10)', async () => {
      const reports = [];
      const requester = Object.assign(async () => true, { onSubagentLlm: (run) => reports.push(run) });
      const calls = [{ model: 'worker-model', role: 'worker', costUsd: 0.002 }];
      await SpawnAgentTool.execute({ task: 'look' }, makeOptions({
        approvalRequester: requester,
        adapter: { execute: async () => ({ type: 'complete', content: 'ok', iterations: 1, tools: [], llm: { calls, totals: { costUsd: 0.002 } } }) }
      }));
      await SpawnAgentTool.execute({ task: 'look again' }, makeOptions({
        approvalRequester: requester,
        adapter: { execute: async () => ({ type: 'complete', content: 'ok', iterations: 1, tools: [], llm: { calls: [], totals: {} } }) }
      }));
      assert.deepStrictEqual(reports, [{ agentId: 'main', role: 'worker', calls, totals: { costUsd: 0.002 } }]);
    });

    it('reports a failed child\'s calls-so-far instead of dropping them (fix round 1)', async () => {
      const reports = [];
      const requester = Object.assign(async () => true, { onSubagentLlm: (run) => reports.push(run) });
      const calls = [{ model: 'worker-model', role: 'worker', costUsd: 0.001 }, { model: 'worker-model', role: 'worker', costUsd: 0.002 }];
      const failed = Object.assign(new Error('Provider call failed (iteration 3, model "worker-model"): upstream exploded'), {
        llm: { calls, totals: { costUsd: 0.003 } }
      });
      const result = await SpawnAgentTool.execute({ task: 'look' }, makeOptions({
        approvalRequester: requester,
        adapter: { execute: async () => { throw failed; } }
      }));
      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(reports, [{ agentId: 'main', role: 'worker', calls, totals: { costUsd: 0.003 }, failed: true }]);
    });

    it('reports nothing for a failed child that never billed a call', async () => {
      const reports = [];
      const requester = Object.assign(async () => true, { onSubagentLlm: (run) => reports.push(run) });
      const failed = new Error('connection refused');
      const result = await SpawnAgentTool.execute({ task: 'look' }, makeOptions({
        approvalRequester: requester,
        adapter: { execute: async () => { throw failed; } }
      }));
      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(reports, []);
    });
  });
});

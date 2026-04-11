const { describe, it } = require('node:test');
const assert = require('node:assert');
const PlannerExecutor = require('../src/workflows/planner-executor');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockAdapter(response = {}) {
  return {
    execute: async (agent, message, options) => ({
      type: 'complete',
      content: JSON.stringify(response),
      iterations: 1,
      tools: [],
      llm: { totals: { inputTokens: 100, outputTokens: 200 } },
      ...response._raw
    })
  };
}

function makeMockWorkflowEngine() {
  const workflows = new Map();
  return {
    create: async (taskGraph) => {
      const wf = { id: 'wf-test-1', ...taskGraph, status: 'pending', tasks: taskGraph.tasks.map(t => ({ ...t, status: 'pending' })) };
      workflows.set(wf.id, wf);
      return wf;
    },
    run: async (id) => {
      const wf = workflows.get(id);
      if (wf) wf.status = 'completed';
      return wf;
    },
    get: (id) => workflows.get(id),
    workflows
  };
}

const fakePlannerAgent = {
  id: 'planner',
  name: 'Planner',
  model: 'test-model',
  maxIterations: 15,
  canUseTool: () => true
};

function makeGetAgent(agents = {}) {
  return (id) => agents[id] || (id === 'planner' ? fakePlannerAgent : null);
}

const validTaskGraph = {
  goal: 'Build a REST API',
  summary: 'Create API with auth and tests',
  tasks: [
    { id: 'task-1', title: 'Set up project', description: 'Initialize Node.js project', agentId: 'main', dependsOn: [], priority: 1 },
    { id: 'task-2', title: 'Write API routes', description: 'Create REST endpoints', agentId: 'code-writer', dependsOn: ['task-1'], priority: 2 },
    { id: 'task-3', title: 'Write tests', description: 'Add unit tests', agentId: 'code-writer', dependsOn: ['task-2'], priority: 3 }
  ],
  parallelGroups: [],
  estimatedTotalSteps: 3
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('PlannerExecutor', () => {
  describe('plan()', () => {
    it('runs the planner agent and returns a task graph', async () => {
      const adapter = makeMockAdapter({ ...validTaskGraph });
      const engine = makeMockWorkflowEngine();
      const executor = new PlannerExecutor({
        agentExecutorAdapter: adapter,
        workflowEngine: engine,
        getAgent: makeGetAgent()
      });

      const result = await executor.plan('Build a REST API');
      assert.strictEqual(result.goal, 'Build a REST API');
      assert.strictEqual(result.tasks.length, 3);
      assert.strictEqual(result.tasks[0].id, 'task-1');
      assert.deepStrictEqual(result.tasks[1].dependsOn, ['task-1']);
    });

    it('throws when planner agent is not found', async () => {
      const executor = new PlannerExecutor({
        agentExecutorAdapter: makeMockAdapter(),
        workflowEngine: makeMockWorkflowEngine(),
        getAgent: () => null
      });

      await assert.rejects(() => executor.plan('test'), /Planner agent not found/);
    });

    it('throws when agent execution fails', async () => {
      const adapter = {
        execute: async () => ({ type: 'error', content: 'LLM error' })
      };
      const executor = new PlannerExecutor({
        agentExecutorAdapter: adapter,
        workflowEngine: makeMockWorkflowEngine(),
        getAgent: makeGetAgent()
      });

      await assert.rejects(() => executor.plan('test'), /Planning failed/);
    });

    it('throws with plannerOutput when planner output is not JSON', async () => {
      const plannerText = 'I think we should build a REST API with authentication and tests.';
      const adapter = {
        execute: async () => ({
          type: 'complete',
          content: plannerText,
          iterations: 1
        })
      };
      const executor = new PlannerExecutor({
        agentExecutorAdapter: adapter,
        workflowEngine: makeMockWorkflowEngine(),
        getAgent: makeGetAgent()
      });

      let thrown;
      try {
        await executor.plan('Build a REST API');
      } catch (e) { thrown = e; }
      assert.ok(thrown, 'expected plan() to throw');
      assert.match(thrown.message, /JSON/);
      assert.strictEqual(thrown.plannerOutput, plannerText);
      assert.strictEqual(thrown.goal, 'Build a REST API');
    });
  });

  describe('_parseTaskGraph()', () => {
    const executor = new PlannerExecutor({
      agentExecutorAdapter: makeMockAdapter(),
      workflowEngine: makeMockWorkflowEngine(),
      getAgent: makeGetAgent()
    });

    it('parses JSON from markdown code block', () => {
      const content = '```json\n' + JSON.stringify(validTaskGraph) + '\n```';
      const result = executor._parseTaskGraph(content, 'test goal');
      assert.strictEqual(result.tasks.length, 3);
      assert.strictEqual(result.goal, 'Build a REST API');
    });

    it('parses raw JSON', () => {
      const result = executor._parseTaskGraph(JSON.stringify(validTaskGraph), 'test goal');
      assert.strictEqual(result.tasks.length, 3);
    });

    it('adds missing task IDs', () => {
      const graph = { tasks: [{ title: 'Do thing', description: 'Do the thing' }] };
      const result = executor._parseTaskGraph(JSON.stringify(graph), 'goal');
      assert.ok(result.tasks[0].id);
      assert.strictEqual(result.tasks[0].agentId, 'main');
    });

    it('rejects invalid dependency references with ORPHAN_DEPENDENCY', () => {
      const graph = {
        tasks: [
          { id: 'a', title: 'A', description: 'A', dependsOn: ['nonexistent'] }
        ]
      };
      let thrown;
      try { executor._parseTaskGraph(JSON.stringify(graph), 'goal'); } catch (e) { thrown = e; }
      assert.ok(thrown, 'expected throw');
      assert.strictEqual(thrown.validationCode, 'ORPHAN_DEPENDENCY');
      assert.strictEqual(thrown.validationDetails.taskId, 'a');
      assert.strictEqual(thrown.validationDetails.missingDep, 'nonexistent');
    });

    it('throws on circular dependencies', () => {
      const graph = {
        tasks: [
          { id: 'a', title: 'A', description: 'A', dependsOn: ['b'] },
          { id: 'b', title: 'B', description: 'B', dependsOn: ['a'] }
        ]
      };
      let thrown;
      try { executor._parseTaskGraph(JSON.stringify(graph), 'goal'); } catch (e) { thrown = e; }
      assert.ok(thrown, 'expected throw');
      assert.match(thrown.message, /circular/i);
      assert.strictEqual(thrown.validationCode, 'CYCLE');
    });

    it('throws with plannerOutput for empty tasks array', () => {
      const graph = { tasks: [] };
      const raw = JSON.stringify(graph);
      let thrown;
      try { executor._parseTaskGraph(raw, 'my goal'); } catch (e) { thrown = e; }
      assert.ok(thrown, 'expected _parseTaskGraph to throw');
      assert.match(thrown.message, /empty task graph/);
      assert.strictEqual(thrown.plannerOutput, raw);
      assert.strictEqual(thrown.goal, 'my goal');
    });

    it('throws with plannerOutput for invalid JSON', () => {
      const raw = 'not json at all {{{';
      let thrown;
      try { executor._parseTaskGraph(raw, 'my goal'); } catch (e) { thrown = e; }
      assert.ok(thrown, 'expected _parseTaskGraph to throw');
      assert.match(thrown.message, /JSON/);
      assert.strictEqual(thrown.plannerOutput, raw);
    });
  });

  describe('validateTaskGraph()', () => {
    const { validateTaskGraph } = require('../src/workflows/task-graph-validator');
    const wrap = (tasks) => ({ tasks: tasks.map((t) => ({ description: t.id, ...t })) });

    it('accepts an acyclic graph', () => {
      assert.strictEqual(validateTaskGraph(wrap([
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['a', 'b'] }
      ])), true);
    });

    it('rejects a direct cycle', () => {
      assert.throws(
        () => validateTaskGraph(wrap([
          { id: 'a', dependsOn: ['b'] },
          { id: 'b', dependsOn: ['a'] }
        ])),
        (err) => err.code === 'CYCLE'
      );
    });

    it('rejects an indirect cycle', () => {
      assert.throws(
        () => validateTaskGraph(wrap([
          { id: 'a', dependsOn: ['c'] },
          { id: 'b', dependsOn: ['a'] },
          { id: 'c', dependsOn: ['b'] }
        ])),
        (err) => err.code === 'CYCLE'
      );
    });

    it('rejects a self-loop', () => {
      assert.throws(
        () => validateTaskGraph(wrap([{ id: 'a', dependsOn: ['a'] }])),
        (err) => err.code === 'SELF_LOOP'
      );
    });

    it('rejects orphan dependencies', () => {
      assert.throws(
        () => validateTaskGraph(wrap([{ id: 'a', dependsOn: ['ghost'] }])),
        (err) => err.code === 'ORPHAN_DEPENDENCY'
      );
    });

    it('rejects duplicate task ids', () => {
      assert.throws(
        () => validateTaskGraph(wrap([
          { id: 'a', dependsOn: [] },
          { id: 'a', dependsOn: [] }
        ])),
        (err) => err.code === 'DUPLICATE_ID'
      );
    });

    it('rejects an empty task list', () => {
      assert.throws(() => validateTaskGraph({ tasks: [] }), (err) => err.code === 'EMPTY');
    });
  });

  describe('planAndExecute()', () => {
    it('plans and creates a workflow', async () => {
      const adapter = makeMockAdapter({ ...validTaskGraph });
      const engine = makeMockWorkflowEngine();
      const executor = new PlannerExecutor({
        agentExecutorAdapter: adapter,
        workflowEngine: engine,
        getAgent: makeGetAgent()
      });

      const result = await executor.planAndExecute('Build a REST API', { background: true });
      assert.ok(result.id);
      assert.strictEqual(result.tasks.length, 3);
    });
  });
});

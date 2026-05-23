const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WorkflowEngine, WORKFLOW_STATUS, TASK_STATUS } = require('../src/workflows/workflow-engine');
const { createInMemoryEventLedger, EVENT_TYPES } = require('../src/events/event-ledger');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wf-test-'));
}

function makeTaskGraph(overrides = {}) {
  return {
    goal: 'Test goal',
    summary: 'Test summary',
    tasks: [
      { id: 't1', title: 'Task 1', description: 'Do first thing', agentId: 'main', dependsOn: [], priority: 1 },
      { id: 't2', title: 'Task 2', description: 'Do second thing', agentId: 'main', dependsOn: ['t1'], priority: 2 }
    ],
    parallelGroups: [],
    estimatedTotalSteps: 2,
    ...overrides
  };
}

function makeAdapter(results = {}) {
  let callCount = 0;
  return {
    execute: async (agent, message) => {
      callCount++;
      if (results.error) throw new Error(results.error);
      return {
        type: 'complete',
        content: results.content || `Result for call ${callCount}`,
        iterations: 1,
        tools: [],
        llm: { totals: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 } }
      };
    },
    getCallCount: () => callCount
  };
}

const fakeAgent = {
  id: 'main',
  name: 'Main',
  model: 'test',
  maxIterations: 5,
  canUseTool: () => true
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('WorkflowEngine', () => {
  let tmpDir;
  let engine;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    engine = new WorkflowEngine({
      storageDir: tmpDir,
      agentExecutorAdapter: makeAdapter(),
      getAgent: (id) => id === 'main' ? fakeAgent : null,
      maxConcurrentTasks: 2
    });
    await engine.initialize();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('create()', () => {
    it('creates a workflow from a task graph', async () => {
      const wf = await engine.create(makeTaskGraph());
      assert.ok(wf.id.startsWith('wf-'));
      assert.strictEqual(wf.goal, 'Test goal');
      assert.strictEqual(wf.status, WORKFLOW_STATUS.PENDING);
      assert.strictEqual(wf.tasks.length, 2);
      assert.strictEqual(wf.tasks[0].status, TASK_STATUS.PENDING);
    });

    it('throws on invalid task graph', async () => {
      await assert.rejects(() => engine.create({}), /Invalid task graph/);
      await assert.rejects(() => engine.create({ tasks: 'not array' }), /Invalid task graph/);
    });

    it('persists workflow to disk', async () => {
      const wf = await engine.create(makeTaskGraph());
      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
      assert.strictEqual(files.length, 1);
      const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
      assert.strictEqual(saved.id, wf.id);
    });

    it('sets default values for task fields', async () => {
      const graph = {
        tasks: [{ id: 'x', title: 'X', description: 'Do X' }]
      };
      const wf = await engine.create(graph);
      const task = wf.tasks[0];
      assert.strictEqual(task.agentId, 'main');
      assert.deepStrictEqual(task.dependsOn, []);
      assert.strictEqual(task.priority, 999);
      assert.strictEqual(task.status, TASK_STATUS.PENDING);
      assert.strictEqual(task.result, null);
      assert.strictEqual(task.error, null);
    });
  });

  describe('run()', () => {
    it('executes tasks in dependency order', async () => {
      const callOrder = [];
      engine.agentExecutorAdapter = {
        execute: async (agent, message) => {
          callOrder.push(message);
          return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
        }
      };

      const wf = await engine.create(makeTaskGraph());
      await engine.run(wf.id);

      assert.strictEqual(wf.status, WORKFLOW_STATUS.COMPLETED);
      assert.strictEqual(wf.tasks[0].status, TASK_STATUS.COMPLETED);
      assert.strictEqual(wf.tasks[1].status, TASK_STATUS.COMPLETED);
      // t1 must execute before t2
      assert.ok(callOrder[0].includes('Do first thing'));
      assert.ok(callOrder[1].includes('Do second thing'));
    });

    it('executes independent tasks in parallel', async () => {
      const graph = makeTaskGraph({
        tasks: [
          { id: 't1', title: 'Task 1', description: 'Independent A', agentId: 'main', dependsOn: [], priority: 1 },
          { id: 't2', title: 'Task 2', description: 'Independent B', agentId: 'main', dependsOn: [], priority: 2 },
          { id: 't3', title: 'Task 3', description: 'Depends on both', agentId: 'main', dependsOn: ['t1', 't2'], priority: 3 }
        ]
      });

      const wf = await engine.create(graph);
      await engine.run(wf.id);

      assert.strictEqual(wf.status, WORKFLOW_STATUS.COMPLETED);
      assert.ok(wf.tasks.every(t => t.status === TASK_STATUS.COMPLETED));
    });

    it('passes dependency results as context', async () => {
      let secondTaskMessage = '';
      engine.agentExecutorAdapter = {
        execute: async (agent, message) => {
          if (message.includes('Do second thing')) {
            secondTaskMessage = message;
          }
          return { type: 'complete', content: 'Result from task', iterations: 1, tools: [], llm: { totals: {} } };
        }
      };

      const wf = await engine.create(makeTaskGraph());
      await engine.run(wf.id);

      assert.ok(secondTaskMessage.includes('Result from task'));
      assert.ok(secondTaskMessage.includes('Context from prior tasks'));
    });

    it('marks task as failed when agent throws', async () => {
      let callCount = 0;
      engine.agentExecutorAdapter = {
        execute: async () => {
          callCount++;
          if (callCount === 1) throw new Error('Agent crashed');
          return { type: 'complete', content: 'ok', iterations: 1, tools: [], llm: { totals: {} } };
        }
      };

      const graph = makeTaskGraph({
        tasks: [
          { id: 't1', title: 'Failing', description: 'Will fail', agentId: 'main', dependsOn: [], priority: 1 },
          { id: 't2', title: 'Independent', description: 'Should still run', agentId: 'main', dependsOn: [], priority: 2 }
        ]
      });

      const wf = await engine.create(graph);
      await engine.run(wf.id);

      assert.strictEqual(wf.tasks[0].status, TASK_STATUS.FAILED);
      assert.strictEqual(wf.tasks[0].error, 'Agent crashed');
      assert.strictEqual(wf.tasks[1].status, TASK_STATUS.COMPLETED);
    });

    it('marks task as failed when agent not found', async () => {
      const graph = {
        tasks: [
          { id: 't1', title: 'Bad agent', description: 'Uses unknown agent', agentId: 'nonexistent', dependsOn: [] }
        ]
      };

      const wf = await engine.create(graph);
      await engine.run(wf.id);

      assert.strictEqual(wf.tasks[0].status, TASK_STATUS.FAILED);
      assert.ok(wf.tasks[0].error.includes('not found'));
    });

    it('throws when workflow not found', async () => {
      await assert.rejects(() => engine.run('wf-nonexistent'), /not found/);
    });

    it('throws when workflow already completed', async () => {
      const wf = await engine.create(makeTaskGraph());
      wf.status = WORKFLOW_STATUS.COMPLETED;
      await assert.rejects(() => engine.run(wf.id), /already completed/);
    });

    it('throws when agentExecutorAdapter is missing', async () => {
      engine.agentExecutorAdapter = null;
      const wf = await engine.create(makeTaskGraph());
      await assert.rejects(() => engine.run(wf.id), /agentExecutorAdapter/);
    });

    it('emits lifecycle events', async () => {
      const events = [];
      engine.on('workflow:started', (d) => events.push(['started', d.workflowId]));
      engine.on('workflow:completed', (d) => events.push(['completed', d.workflowId]));
      engine.on('workflow:task:started', (d) => events.push(['task:started', d.taskId]));
      engine.on('workflow:task:completed', (d) => events.push(['task:completed', d.taskId]));

      const wf = await engine.create(makeTaskGraph());
      await engine.run(wf.id);

      assert.ok(events.some(([e]) => e === 'started'));
      assert.ok(events.some(([e]) => e === 'completed'));
      assert.ok(events.some(([e, id]) => e === 'task:started' && id === 't1'));
      assert.ok(events.some(([e, id]) => e === 'task:completed' && id === 't2'));
    });
  });

  describe('pause() / cancel()', () => {
    it('pauses a running workflow', async () => {
      // Create a workflow that will take some time
      engine.agentExecutorAdapter = {
        execute: async () => {
          await new Promise(r => setTimeout(r, 200));
          return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } };
        }
      };

      const graph = makeTaskGraph({
        tasks: [
          { id: 't1', title: 'Slow', description: 'Slow task', agentId: 'main', dependsOn: [] },
          { id: 't2', title: 'After', description: 'After slow', agentId: 'main', dependsOn: ['t1'] }
        ]
      });
      const wf = await engine.create(graph);

      // Start running but pause quickly
      const runPromise = engine.run(wf.id);
      await new Promise(r => setTimeout(r, 50));
      engine.pause(wf.id);
      await runPromise;

      assert.strictEqual(wf.status, WORKFLOW_STATUS.PAUSED);
    });

    it('cancels a workflow', async () => {
      const wf = await engine.create(makeTaskGraph());
      engine.cancel(wf.id);
      assert.strictEqual(wf.status, WORKFLOW_STATUS.CANCELLED);
      assert.ok(wf.completedAt);
    });
  });

  describe('list() / get() / getProgress()', () => {
    it('lists all workflows', async () => {
      await engine.create(makeTaskGraph());
      await engine.create(makeTaskGraph({ goal: 'Second' }));
      const list = engine.list();
      assert.strictEqual(list.length, 2);
    });

    it('filters by status', async () => {
      const wf1 = await engine.create(makeTaskGraph());
      await engine.create(makeTaskGraph());
      wf1.status = WORKFLOW_STATUS.COMPLETED;
      assert.strictEqual(engine.list({ status: WORKFLOW_STATUS.COMPLETED }).length, 1);
      assert.strictEqual(engine.list({ status: WORKFLOW_STATUS.PENDING }).length, 1);
    });

    it('gets workflow by id', async () => {
      const wf = await engine.create(makeTaskGraph());
      assert.strictEqual(engine.get(wf.id).id, wf.id);
      assert.strictEqual(engine.get('nonexistent'), null);
    });

    it('returns progress summary', async () => {
      const wf = await engine.create(makeTaskGraph());
      wf.tasks[0].status = TASK_STATUS.COMPLETED;
      const progress = engine.getProgress(wf.id);
      assert.strictEqual(progress.total, 2);
      assert.strictEqual(progress.completed, 1);
      assert.strictEqual(progress.pending, 1);
      assert.strictEqual(progress.percentage, 50);
    });

    it('returns null progress for unknown workflow', async () => {
      assert.strictEqual(engine.getProgress('nonexistent'), null);
    });
  });

  describe('delete()', () => {
    it('removes workflow from memory and disk', async () => {
      const wf = await engine.create(makeTaskGraph());
      const filePath = path.join(tmpDir, `${wf.id}.json`);
      assert.ok(fs.existsSync(filePath));

      await engine.delete(wf.id);
      assert.strictEqual(engine.get(wf.id), null);
      assert.ok(!fs.existsSync(filePath));
    });
  });

  describe('mintTaskId() — high-water-mark', () => {
    it('starts at the next id after creation', async () => {
      const wf = await engine.create(makeTaskGraph()); // 2 tasks → counter=2
      assert.strictEqual(engine.mintTaskId(wf.id), 'task-3');
      assert.strictEqual(engine.mintTaskId(wf.id), 'task-4');
    });

    it('does not reuse ids after deletion', async () => {
      const wf = await engine.create(makeTaskGraph());
      const id1 = engine.mintTaskId(wf.id);
      // Simulate a task being deleted in the UI
      wf.tasks.pop();
      const id2 = engine.mintTaskId(wf.id);
      assert.notStrictEqual(id1, id2);
      assert.strictEqual(id2, 'task-4');
    });
  });

  describe('structured dependency-result handoff', () => {
    it('passes summarized upstream results into downstream task message', async () => {
      const messages = [];
      engine.agentExecutorAdapter = {
        execute: async (agent, message) => {
          messages.push(message);
          // First call returns a long result; second call should see the
          // labeled, truncated upstream block.
          if (messages.length === 1) {
            return { type: 'complete', content: 'X'.repeat(5000), iterations: 1, tools: [], llm: { totals: {} } };
          }
          return { type: 'complete', content: 'ok', iterations: 1, tools: [], llm: { totals: {} } };
        }
      };

      const wf = await engine.create(makeTaskGraph());
      await engine.run(wf.id);

      assert.strictEqual(messages.length, 2);
      const downstream = messages[1];
      assert.match(downstream, /Result from upstream task/);
      assert.match(downstream, /\[t1\]/);
      assert.match(downstream, /truncated/);
      // Must NOT contain the full 5000-char blob.
      assert.ok(downstream.length < 5000, `expected truncation, got ${downstream.length}`);
      // The upstream task should now carry the cached summary.
      assert.ok(wf.tasks[0].resultSummary);
      assert.strictEqual(wf.tasks[0].resultTruncated, true);
    });

    it('does not truncate small results', async () => {
      engine.agentExecutorAdapter = makeAdapter({ content: 'short result' });
      const wf = await engine.create(makeTaskGraph());
      await engine.run(wf.id);
      assert.strictEqual(wf.tasks[0].resultTruncated, false);
      assert.strictEqual(wf.tasks[0].resultSummary, 'short result');
    });
  });

  describe('mode snapshot and allowedActions', () => {
    it('persists modeSnapshot from create options', async () => {
      const snapshot = { agentMode: true, sandboxMode: false, allowedDirectories: ['/tmp'], capturedAt: 'now' };
      const wf = await engine.create(makeTaskGraph(), { modeSnapshot: snapshot });
      assert.deepStrictEqual(wf.metadata.modeSnapshot, snapshot);
    });

    it('persists allowedActions from the task graph', async () => {
      const graph = makeTaskGraph({ allowedActions: ['run-tests', 'install-deps'] });
      const wf = await engine.create(graph);
      assert.deepStrictEqual(wf.metadata.allowedActions, ['run-tests', 'install-deps']);
    });

    it('injects allowedActions into the task message', async () => {
      const messages = [];
      engine.agentExecutorAdapter = {
        execute: async (agent, message) => {
          messages.push(message);
          return { type: 'complete', content: 'ok', iterations: 1, tools: [], llm: { totals: {} } };
        }
      };
      const graph = makeTaskGraph({ allowedActions: ['run-tests'] });
      const wf = await engine.create(graph);
      await engine.run(wf.id);
      assert.match(messages[0], /Pre-approved actions/);
      assert.match(messages[0], /run-tests/);
    });
  });

  describe('event ledger integration', () => {
    let ledgerEngine;
    let ledger;

    beforeEach(async () => {
      ledger = createInMemoryEventLedger();
      ledgerEngine = new WorkflowEngine({
        storageDir: tmpDir,
        agentExecutorAdapter: makeAdapter(),
        getAgent: (id) => id === 'main' ? fakeAgent : null,
        maxConcurrentTasks: 2,
        eventLedger: ledger,
      });
      await ledgerEngine.initialize();
    });

    it('records workflow lifecycle events', async () => {
      const wf = await ledgerEngine.create(makeTaskGraph());
      await ledgerEngine.run(wf.id);

      const replay = await ledger.replay(wf.id);
      assert.strictEqual(replay.complete, true);
      const types = replay.events.map((e) => e.type);
      assert.ok(types.includes(EVENT_TYPES.WORKFLOW_CREATED));
      assert.ok(types.includes(EVENT_TYPES.WORKFLOW_STARTED));
      assert.ok(types.includes(EVENT_TYPES.WORKFLOW_COMPLETED));
    });

    it('records task lifecycle events', async () => {
      const wf = await ledgerEngine.create(makeTaskGraph());
      await ledgerEngine.run(wf.id);

      const replay = await ledger.replay(wf.id);
      const taskEvents = replay.events.filter((e) => e.taskId);
      assert.ok(taskEvents.length >= 4); // 2 started + 2 completed
      assert.ok(taskEvents.some((e) => e.type === EVENT_TYPES.TASK_STARTED && e.taskId === 't1'));
      assert.ok(taskEvents.some((e) => e.type === EVENT_TYPES.TASK_COMPLETED && e.taskId === 't2'));
    });

    it('records task failure events', async () => {
      ledgerEngine.agentExecutorAdapter = {
        execute: async () => { throw new Error('boom'); },
      };
      const graph = makeTaskGraph({
        tasks: [{ id: 't1', title: 'Failing', description: 'Will fail', agentId: 'main', dependsOn: [] }],
      });
      const wf = await ledgerEngine.create(graph);
      await ledgerEngine.run(wf.id);

      const replay = await ledger.replay(wf.id);
      const failEvent = replay.events.find((e) => e.type === EVENT_TYPES.TASK_FAILED);
      assert.ok(failEvent);
      assert.strictEqual(failEvent.payload.error, 'boom');
    });

    it('records cancel event', async () => {
      const wf = await ledgerEngine.create(makeTaskGraph());
      ledgerEngine.cancel(wf.id);

      const replay = await ledger.replay(wf.id);
      assert.ok(replay.events.some((e) => e.type === EVENT_TYPES.WORKFLOW_CANCELLED));
    });

    it('cleans up ledger on workflow delete', async () => {
      const wf = await ledgerEngine.create(makeTaskGraph());
      await ledgerEngine.delete(wf.id);

      const replay = await ledger.replay(wf.id);
      assert.strictEqual(replay.events.length, 0);
    });

    it('getEventLog returns full replay', async () => {
      const wf = await ledgerEngine.create(makeTaskGraph());
      await ledgerEngine.run(wf.id);

      const log = await ledgerEngine.getEventLog(wf.id);
      assert.strictEqual(log.complete, true);
      assert.ok(log.events.length > 0);
    });

    it('getEventLog returns empty when no ledger configured', async () => {
      const plainEngine = new WorkflowEngine({
        storageDir: tmpDir,
        agentExecutorAdapter: makeAdapter(),
        getAgent: (id) => id === 'main' ? fakeAgent : null,
      });
      await plainEngine.initialize();
      const wf = await plainEngine.create(makeTaskGraph());
      const log = await plainEngine.getEventLog(wf.id);
      assert.strictEqual(log.complete, false);
      assert.strictEqual(log.events.length, 0);
    });

    it('workflow still completes if ledger append fails', async () => {
      const brokenLedger = {
        append: async () => { throw new Error('disk full'); },
        replay: async () => ({ complete: false, events: [] }),
        removeWorkflow: async () => {},
      };
      const brokenEngine = new WorkflowEngine({
        storageDir: tmpDir,
        agentExecutorAdapter: makeAdapter(),
        getAgent: (id) => id === 'main' ? fakeAgent : null,
        eventLedger: brokenLedger,
      });
      await brokenEngine.initialize();
      const wf = await brokenEngine.create(makeTaskGraph());
      await brokenEngine.run(wf.id);
      assert.strictEqual(wf.status, WORKFLOW_STATUS.COMPLETED);
    });

    it('events have correct chronological order', async () => {
      const wf = await ledgerEngine.create(makeTaskGraph());
      await ledgerEngine.run(wf.id);

      const replay = await ledger.replay(wf.id);
      for (let i = 1; i < replay.events.length; i++) {
        assert.ok(replay.events[i].seq > replay.events[i - 1].seq);
        assert.ok(replay.events[i].at >= replay.events[i - 1].at);
      }
    });
  });

  describe('persistence and recovery', () => {
    it('loads workflows from disk on initialize', async () => {
      const wf = await engine.create(makeTaskGraph());
      const wfId = wf.id;

      // Create a new engine pointing at the same directory
      const engine2 = new WorkflowEngine({
        storageDir: tmpDir,
        agentExecutorAdapter: makeAdapter(),
        getAgent: () => fakeAgent
      });
      await engine2.initialize();

      const loaded = engine2.get(wfId);
      assert.ok(loaded);
      assert.strictEqual(loaded.goal, 'Test goal');
    });

    it('resets running tasks to pending on load', async () => {
      const wf = await engine.create(makeTaskGraph());
      wf.tasks[0].status = TASK_STATUS.RUNNING;
      wf.status = WORKFLOW_STATUS.RUNNING;
      await engine._save(wf);

      const engine2 = new WorkflowEngine({ storageDir: tmpDir });
      await engine2.initialize();

      const loaded = engine2.get(wf.id);
      assert.strictEqual(loaded.tasks[0].status, TASK_STATUS.PENDING);
      assert.strictEqual(loaded.status, WORKFLOW_STATUS.PAUSED);
    });
  });
});

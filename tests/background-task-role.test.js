// tests/background-task-role.test.js
// BackgroundTask names a role the way SpawnAgent does (models spec
// 2026-09-27 §8): the role parameter, else the named agent's own role, else
// worker.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { BackgroundTaskTool } = require('../src/tools/builtin/background-task-tool');

// Runs the task at once instead of in the background, so the test can await it.
function fakeManager() {
  const runs = [];
  return {
    runs,
    appendOutput: () => {},
    spawn: async (_config, executor) => {
      const task = { id: 'bg-1', signal: new AbortController().signal };
      runs.push(executor(task));
      return task;
    }
  };
}

async function run(params) {
  const seen = [];
  const manager = fakeManager();
  const result = await BackgroundTaskTool.execute(params, {
    backgroundTaskManager: manager,
    agentExecutorAdapter: { execute: async (agent, _msg, opts) => { seen.push({ agentId: agent.id, opts }); return { content: 'done' }; } },
    getAgent: (id) => ({ id, name: id }),
    approvalRequester: async () => true,
    workingDirectory: process.cwd()
  });
  await Promise.all(manager.runs);
  return { result, seen };
}

describe('BackgroundTask roles', () => {
  it('runs a bare task on worker', async () => {
    const { result, seen } = await run({ task: 'Summarize the changelog' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(seen[0].opts.role, 'worker');
    // A background run outlives the turn: its cost is never rolled into the reply.
    assert.strictEqual(seen[0].opts.detached, true);
  });

  it('keeps a named agent on its own role unless a role is given', async () => {
    assert.strictEqual('role' in (await run({ task: 'x', agentId: 'code-writer' })).seen[0].opts, false);
    assert.strictEqual((await run({ task: 'x', agentId: 'code-writer', role: 'main' })).seen[0].opts.role, 'main');
  });

  it('declares the role parameter', () => {
    assert.ok(BackgroundTaskTool.parameters.properties.role);
  });
});

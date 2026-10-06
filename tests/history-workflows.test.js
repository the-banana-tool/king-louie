// tests/history-workflows.test.js
// Workflows and the planner recall from the chat's store (recall spec §12).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkflowEngine } = require('../src/workflows/workflow-engine');
const PlannerExecutor = require('../src/workflows/planner-executor');

const BLOCK = '<recalled_history>\nexcerpt\n</recalled_history>';
function fakeBuilder(calls) {
  return {
    build: async (args) => {
      calls.push(args);
      return {
        tail: [{ sender: 'user', text: 'earlier question' }, { sender: 'assistant', text: 'earlier answer' }],
        recalled: { text: BLOCK, chunkIds: [1], estTokens: 5 },
        stats: {}
      };
    }
  };
}
const agent = { id: 'main', name: 'Main', model: 'test', maxIterations: 5, canUseTool: () => true };
const plannerAgent = { id: 'planner', name: 'Planner', maxIterations: 5, canUseTool: () => true };
const graphReply = { type: 'complete', content: JSON.stringify({ tasks: [{ id: 't1', title: 'x', description: 'y' }] }) };

describe('workflows recall from the store', () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  it('a task of a chat-launched workflow gets the tail and the recalled block', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wf-history-'));
    dirs.push(dir);
    const builds = [];
    const seen = [];
    const engine = new WorkflowEngine({
      storageDir: dir,
      agentExecutorAdapter: { execute: async (_a, _m, options) => { seen.push(options); return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } }; } },
      getAgent: () => agent,
      maxConcurrentTasks: 1,
      getContextBuilder: () => fakeBuilder(builds)
    });
    await engine.initialize();
    const wf = await engine.create({
      goal: 'Fence', summary: 's', parallelGroups: [], estimatedTotalSteps: 1,
      tasks: [{ id: 't1', title: 'Task 1', description: 'Check the fence line', agentId: 'main', dependsOn: [], priority: 1 }]
    }, { chatId: 'chat-1' });
    await engine.run(wf.id);
    // run() ends with a fire-and-forget _save; queue behind it so the
    // teardown's rmdir never races the write (ENOTEMPTY on macOS).
    await engine._saveMutex.run(wf.id, async () => {});
    assert.deepStrictEqual(builds[0], { chatId: 'chat-1', message: 'Check the fence line' });
    assert.deepStrictEqual(seen[0].messages.slice(0, 2), [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }]);
    assert.strictEqual(seen[0].messages[2].role, 'user');
    assert.strictEqual(seen[0].systemPromptDynamic, BLOCK);
  });

  it('the planner plans from the chat tail and the recalled block', async () => {
    const builds = [];
    let seen = null;
    const planner = new PlannerExecutor({
      agentExecutorAdapter: { execute: async (_a, _g, options) => { seen = options; return graphReply; } },
      workflowEngine: {},
      getAgent: () => plannerAgent,
      getContextBuilder: () => fakeBuilder(builds)
    });
    await planner.plan('Plan the fence repair', { chatId: 'chat-1' });
    assert.deepStrictEqual(builds[0], { chatId: 'chat-1', message: 'Plan the fence repair' });
    assert.strictEqual(seen.messages.length, 3);
    assert.strictEqual(seen.messages[2].content, 'Produce a task graph for this goal:\n\nPlan the fence repair');
    assert.strictEqual(seen.systemPromptDynamic, BLOCK);
  });

  it('without a chat the planner uses the chat messages it was given', async () => {
    let seen = null;
    const planner = new PlannerExecutor({
      agentExecutorAdapter: { execute: async (_a, _g, options) => { seen = options; return graphReply; } },
      workflowEngine: {},
      getAgent: () => plannerAgent,
      getContextBuilder: () => { throw new Error('not used without a chat'); }
    });
    await planner.plan('Plan it', { chatMessages: [{ sender: 'user', text: 'context line' }] });
    assert.deepStrictEqual(seen.messages[0], { role: 'user', content: 'context line' });
    assert.strictEqual(seen.systemPromptDynamic, undefined);
  });

  it('nothing in src/ refers to the conversation compactor any more', () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /ConversationCompactor|getConversationCompactor|conversation-compactor/.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    assert.deepStrictEqual(hits, []);
  });
});

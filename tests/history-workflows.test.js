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

  it('stage H4 (N2): a task and the planner never recall from a chat the parent chat is linked to', async () => {
    const { ContextBuilder } = require('../src/history/context-builder');
    const { Retriever } = require('../src/history/retriever');
    const { TokenEstimator } = require('../src/history/token-estimator');
    const { resolveScope, OPEN_POLICY } = require('../src/history/scope');
    const { openTempStore, seedChat } = require('./helpers/history-fixture');
    const t = openTempStore();
    try {
      seedChat(t.store, { id: 'lot', title: 'Lot notes', messages: [{ sender: 'user', text: 'the gate code for the Lakeside lot is 4417' }] });
      seedChat(t.store, { id: 'parent', title: 'Parent', messages: [
        { sender: 'user', text: 'The fence along the Lakeside lot is forty meters.' },
        { sender: 'assistant', text: 'Noted.' },
        { sender: 'user', text: 'Unrelated message about the grocery list.' },
        { sender: 'assistant', text: 'Fine.' }
      ] });
      t.store.setHistoryScope('parent', 'linked');
      t.store.setLinks('parent', ['lot']);
      const estimator = new TokenEstimator();
      const builder = new ContextBuilder({
        store: t.store, retriever: new Retriever({ store: t.store, estimator }), estimator,
        getSettings: () => ({ history: { recall: { tailUserTurns: 1, rerank: { enabled: false } } } }),
        resolveScope: (chatId) => resolveScope({ store: t.store, chatId, policy: OPEN_POLICY })
      });
      const question = 'what is the gate code for the Lakeside lot';
      assert.ok((await builder.build({ chatId: 'parent', message: question, crossChat: true })).recalled.text.includes('4417'),
        'precondition: the turn of the chat itself does recall it');
      const builds = [];
      const real = builder.build.bind(builder);
      builder.build = async (args) => { builds.push(args); return real(args); };

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-wf-history-'));
      dirs.push(dir);
      const seen = [];
      const engine = new WorkflowEngine({
        storageDir: dir,
        agentExecutorAdapter: { execute: async (_a, _m, options) => { seen.push(options); return { type: 'complete', content: 'done', iterations: 1, tools: [], llm: { totals: {} } }; } },
        getAgent: () => agent,
        maxConcurrentTasks: 1,
        getContextBuilder: () => builder
      });
      await engine.initialize();
      const wf = await engine.create({
        goal: 'Gate', summary: 's', parallelGroups: [], estimatedTotalSteps: 1,
        tasks: [{ id: 't1', title: 'Task 1', description: question, agentId: 'main', dependsOn: [], priority: 1 }]
      }, { chatId: 'parent' });
      await engine.run(wf.id);
      await engine._saveMutex.run(wf.id, async () => {});

      let planned = null;
      const planner = new PlannerExecutor({
        agentExecutorAdapter: { execute: async (_a, _g, options) => { planned = options; return graphReply; } },
        workflowEngine: {},
        getAgent: () => plannerAgent,
        getContextBuilder: () => builder
      });
      await planner.plan(question, { chatId: 'parent' });

      assert.strictEqual(builds.length, 2);
      for (const args of builds) assert.ok(!('crossChat' in args), 'neither caller asks for the wider scope');
      for (const options of [seen[0], planned]) {
        assert.ok(String(options.systemPromptDynamic || '').includes('forty meters'), 'the parent chat itself is recalled from');
        assert.ok(!JSON.stringify(options).includes('4417'));
      }
    } finally {
      t.cleanup();
    }
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

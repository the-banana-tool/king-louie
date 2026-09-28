// tests/cases-executor-child.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { buildChildContext, childRuntimeOptions } = require('../src/agents/child-context');
const { getAgent } = require('../src/agents');
const { WorkflowEngine } = require('../src/workflows/workflow-engine');
const { configureCaseGuard } = require('../src/cases/executors/case-guard');
const ToolExecutor = require('../src/execution/tool-executor');
const { initializeTools } = require('../src/tools');
const { approvalSeam } = require('../src/approvals/executor-options');
const { WAKEUP_BASE_TOOLS } = require('../src/cases/chat-integration');

after(() => {
  configureCaseGuard({});
  fx.cleanup();
});

function parts(calls) {
  return {
    runtimeSection: 'RUNTIME',
    memorySection: async (m) => { calls.push(['memory', m]); return 'MEMORY'; },
    userSection: () => { calls.push(['user']); return 'USER'; },
    projectSection: () => { calls.push(['project']); return 'PROJECT'; },
    getUserProfile: () => { calls.push(['profile']); return { name: 'Owner' }; },
    baseTemplateContext: () => ({ user: { name: 'Owner' } })
  };
}

describe('child context', () => {
  it('an isolated prompt has no memory, user or project section', async () => {
    const calls = [];
    const r = await buildChildContext({ message: 'Find comps', options: { isolatedContext: true, templateContext: { task: 't1' } }, ...parts(calls) });
    assert.deepStrictEqual(r, { systemPrompt: 'RUNTIME', userProfile: null, templateContext: { task: 't1' } });
    assert.deepStrictEqual(calls, []);
  });

  it('an ordinary child keeps today\'s context', async () => {
    const calls = [];
    const r = await buildChildContext({ message: 'Find comps', options: {}, ...parts(calls) });
    assert.deepStrictEqual(r, { systemPrompt: 'RUNTIME\n\nMEMORY\n\nUSER\n\nPROJECT', userProfile: { name: 'Owner' }, templateContext: { user: { name: 'Owner' } } });
  });

  it('confines an isolated child to its agent\'s tools and carries the guard context', () => {
    const opts = childRuntimeOptions(getAgent('case-researcher'), { isolatedContext: true, guardContext: { caseId: 'case-1' }, workingDirectory: '/work' });
    assert.deepStrictEqual([opts.workingDirectory, opts.guardContext, [...opts.allowedToolNames]], ['/work', { caseId: 'case-1' }, ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']]);
    assert.deepStrictEqual(childRuntimeOptions(getAgent('main'), { workingDirectory: '/work' }), { workingDirectory: '/work' });
  });
});

describe('case-researcher', () => {
  it('is a read-only built-in agent with its template', () => {
    const agent = getAgent('case-researcher');
    assert.deepStrictEqual([agent.readOnly, agent.role, agent.maxIterations], [true, 'worker', 20]);
    const template = fs.readFileSync(path.join(__dirname, '..', agent.systemPromptTemplate), 'utf8');
    assert.match(template, /```facts/);
    assert.match(agent.systemPrompt, /facts/);
  });
});

describe('workflow executeExtras', () => {
  it('spreads the extras into every task\'s execute options', async () => {
    const dir = fx.tempDir('kl-wf-');
    const seen = [];
    const engine = new WorkflowEngine({
      storageDir: dir,
      getAgent: (id) => getAgent(id),
      agentExecutorAdapter: { execute: async (agent, message, options) => { seen.push([agent.id, options]); return { content: 'done' }; } }
    });
    await engine.initialize();
    const wf = await engine.create({ tasks: [{ id: 't1', title: 'Find comps', description: 'Search listings', agentId: 'case-researcher' }] }, {
      chatId: null, workingDirectory: dir, executeExtras: { isolatedContext: true, guardContext: { caseId: 'case-1' } }
    });
    assert.deepStrictEqual(wf.metadata.executeExtras, { isolatedContext: true, guardContext: { caseId: 'case-1' } });
    await engine.run(wf.id);
    assert.deepStrictEqual([seen[0][0], seen[0][1].isolatedContext, seen[0][1].guardContext, seen[0][1].workingDirectory], ['case-researcher', true, { caseId: 'case-1' }, dir]);
  });
});

describe('guarded child tools', () => {
  it('a child WebFetch carrying a private value is refused', async () => {
    initializeTools();
    const env = fx.setupExecutors();
    const meta = await fx.activeCase(env.runtime);
    env.runtime.ledger(meta.id).assert({
      stmt: 'Lowest acceptable price', subject: 'lot', attr: 'floor', value: 98000, unit: 'USD', provenance: 'user', category: 'financial', source: { kind: 'question', ref: 'q-0099' }
    });
    configureCaseGuard({ getCaseRuntime: () => env.runtime, dataDir: env.dataDir });
    const executor = new ToolExecutor({ requireApproval: false, extraToolOptions: { guardContext: { caseId: meta.id } } });
    const r = await executor.execute('WebFetch', { url: 'https://records.example.org/search?q=98000' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /WebFetch would send case data that may not leave/);
  });
});

describe('a child of a remote-origin case turn', () => {
  const REMOTE = { client: 'telegram', session: 'chat-9', job_id: null };

  function parentTurn() {
    const seam = approvalSeam({ remoteApprovals: 'deny', event: null, approvalRequester: null, executorOptions: { origin: REMOTE } });
    return new ToolExecutor({ requireApproval: true, ...seam.toolExecutorOptions, extraToolOptions: { caseContext: { caseId: 'case-1', dir: '/cases/case-1' } } });
  }

  it('carries the parent origin and stays remote (no escalation to local)', () => {
    const parent = parentTurn();
    assert.strictEqual(parent.localOrigin, false);
    const childOpts = childRuntimeOptions(getAgent('case-researcher'), {
      isolatedContext: true, guardContext: { caseId: 'case-1' }, workingDirectory: '/work', approvalRequester: parent._rethreadedRequester()
    });
    assert.deepStrictEqual(childOpts.origin, REMOTE);
    const seam = approvalSeam({ remoteApprovals: 'deny', event: null, approvalRequester: parent._rethreadedRequester(), executorOptions: childOpts });
    assert.strictEqual(seam.local, false);
    assert.deepStrictEqual(seam.origin, REMOTE);
    assert.strictEqual(seam.toolExecutorOptions.denyAutoApproval, true);
    const child = new ToolExecutor({ requireApproval: true, ...seam.toolExecutorOptions, allowedToolNames: childOpts.allowedToolNames, extraToolOptions: { guardContext: childOpts.guardContext } });
    assert.deepStrictEqual([child.origin, child.localOrigin, child._rethreadedRequester().origin], [REMOTE, false, REMOTE]);
  });

  it('cannot call a tool outside its allow-list, and never gains one a case turn lacks', async () => {
    const parent = parentTurn();
    const childOpts = childRuntimeOptions(getAgent('case-researcher'), {
      isolatedContext: true, guardContext: { caseId: 'case-1' }, workingDirectory: '/work', approvalRequester: parent._rethreadedRequester()
    });
    for (const name of childOpts.allowedToolNames) assert.ok(WAKEUP_BASE_TOOLS.includes(name), name);
    const seam = approvalSeam({ remoteApprovals: 'deny', event: null, approvalRequester: parent._rethreadedRequester(), executorOptions: childOpts });
    const child = new ToolExecutor({ requireApproval: true, ...seam.toolExecutorOptions, allowedToolNames: childOpts.allowedToolNames, extraToolOptions: { guardContext: childOpts.guardContext } });
    for (const name of ['Write', 'Edit', 'Bash', 'Ledger', 'Brief', 'Executor', 'Plan', 'SpawnAgent', 'BrowserPage']) {
      assert.deepStrictEqual(await child.execute(name, {}), { success: false, error: `Tool "${name}" is not available in this turn.` }, name);
    }
  });

  it("workflow extras cannot set a child's origin, tools or working directory", async () => {
    const dir = fx.tempDir('kl-wf-');
    const seen = [];
    const engine = new WorkflowEngine({
      storageDir: dir,
      getAgent: (id) => getAgent(id),
      agentExecutorAdapter: { execute: async (agent, message, options) => { seen.push(options); return { content: 'done' }; } }
    });
    await engine.initialize();
    const wf = await engine.create({ tasks: [{ id: 't1', title: 'Find comps', description: 'Search listings', agentId: 'case-researcher' }] }, {
      chatId: null,
      workingDirectory: dir,
      executeExtras: { isolatedContext: true, guardContext: { caseId: 'case-1' }, origin: { client: 'desktop' }, allowedToolNames: ['Bash'], workingDirectory: '/elsewhere' }
    });
    await engine.run(wf.id);
    assert.deepStrictEqual([seen[0].origin, seen[0].allowedToolNames, seen[0].workingDirectory, seen[0].isolatedContext], [undefined, undefined, dir, true]);
  });
});

describe('child tools never exceed the parent run', () => {
  it('intersects the child allow-list with the parent allowedToolNames', () => {
    const researcher = getAgent('case-researcher');
    const opts = childRuntimeOptions(researcher, { isolatedContext: true, allowedToolNames: new Set(['Read', 'WebFetch', 'Bash']) });
    assert.deepStrictEqual([...opts.allowedToolNames], ['WebFetch', 'Read']);
    assert.deepStrictEqual([...childRuntimeOptions(getAgent('main'), { allowedToolNames: ['Read'] }).allowedToolNames], ['Read']);
    assert.deepStrictEqual([...childRuntimeOptions(researcher, { isolatedContext: true, allowedToolNames: 'Bash' }).allowedToolNames], []);
  });
});

describe('a tampered workflow file cannot unguard a case child', () => {
  it('rebuilds the child extras from the case job index, not the workflow file', async () => {
    const env = fx.setupExecutors();
    const meta = await fx.activeCase(env.runtime);
    const dir = fx.tempDir('kl-wf-');
    const seen = [];
    const adapter = { execute: async (agent, message, options) => { seen.push([agent.id, options]); return { content: 'done' }; } };
    const resolveExecuteExtras = (wf) => env.registry.workflowChildExtras(wf.id);
    const first = new WorkflowEngine({ storageDir: dir, getAgent: (id) => getAgent(id), agentExecutorAdapter: adapter, resolveExecuteExtras });
    await first.initialize();
    const wf = await first.create({ tasks: [{ id: 't1', title: 'Find comps', description: 'Search listings', agentId: 'case-researcher' }] }, {
      chatId: null, workingDirectory: dir, executeExtras: { isolatedContext: true, guardContext: { caseId: meta.id } }
    });
    await env.registry.indexJob(meta.id, { id: 'job-0001', executor: 'workflow', externalId: wf.id, state: 'running' });

    const file = path.join(dir, `${wf.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.metadata.executeExtras = null;
    saved.tasks[0].agentId = 'code-writer';
    fs.writeFileSync(file, JSON.stringify(saved));

    const second = new WorkflowEngine({ storageDir: dir, getAgent: (id) => getAgent(id), agentExecutorAdapter: adapter, resolveExecuteExtras });
    await second.initialize();
    await second.run(wf.id);
    const [agentId, options] = seen[0];
    assert.deepStrictEqual([agentId, options.isolatedContext, options.guardContext], ['code-writer', true, { caseId: meta.id }]);
    const child = childRuntimeOptions(getAgent(agentId), options);
    for (const name of child.allowedToolNames) assert.ok(['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'].includes(name), name);
    assert.strictEqual(env.registry.workflowChildExtras('wf-unknown'), null);
  });

  it('runs no task when the trusted extras cannot be read', async () => {
    const dir = fx.tempDir('kl-wf-');
    const seen = [];
    const engine = new WorkflowEngine({
      storageDir: dir,
      getAgent: (id) => getAgent(id),
      agentExecutorAdapter: { execute: async (agent, message, options) => { seen.push(options); return { content: 'done' }; } },
      resolveExecuteExtras: () => { throw new Error('index unreadable'); }
    });
    await engine.initialize();
    const wf = await engine.create({ tasks: [{ id: 't1', title: 'Find comps', description: 'Search listings', agentId: 'case-researcher' }] }, { chatId: null, workingDirectory: dir });
    const done = await engine.run(wf.id);
    assert.deepStrictEqual([seen.length, done.status], [0, 'failed']);
  });
});

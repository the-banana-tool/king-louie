const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerAgentHandlers } = require('../src/ipc/agent-handlers');
const IPC = require('../src/ipc/constants');

// Regression coverage for the agent:execute / executeParallel / executeSerial /
// executeWithDeps IPC channels: each one builds its own AgentExecutor and must
// forward context.prompter to it, or agents run through these channels silently
// fall back to the headless prompter (AskUser fails, directory access is
// auto-denied) even when a live renderer window exists.

function createIpcMainMock() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
    on(channel, handler) { handlers.set(channel, handler); }
  };
}

function createContext(overrides = {}) {
  const executorCalls = [];

  class FakeAgentExecutor {
    constructor(provider, toolExecutor, options) {
      executorCalls.push(options);
      this.provider = provider;
      this.toolExecutor = toolExecutor;
      this.options = options;
    }
    async execute() {
      return { content: 'ok' };
    }
  }

  // Runs each agent (each task) through the executor it was given, as the
  // real AgentOrchestrator does.
  class FakeAgentOrchestrator {
    constructor(agentExecutor) {
      this.agentExecutor = agentExecutor;
    }
    async executeParallel(agents, message, options) {
      return Promise.all(agents.map((agent) => this.agentExecutor.execute(agent, message, options)));
    }
    async executeSerial(agents, message, options) {
      const out = [];
      for (const agent of agents) out.push(await this.agentExecutor.execute(agent, message, options));
      return out;
    }
    async executeWithDependencies(taskManager, agents, options) {
      const results = new Map();
      for (const task of taskManager.list()) {
        results.set(task.id, await this.agentExecutor.execute(agents[0], task.description || task.subject || '', options));
      }
      return results;
    }
  }

  const fakeAgent = {
    id: 'writer',
    name: 'Writer',
    maxIterations: 5,
    canUseTool: () => true,
    readOnly: false
  };

  const taskStore = new Map();
  const fakeTaskManager = {
    create(config) {
      const id = `task-${taskStore.size + 1}`;
      const task = { id, blocks: [], ...config };
      taskStore.set(id, task);
      return task;
    },
    get(id) { return taskStore.get(id); },
    update(id, updates) { Object.assign(taskStore.get(id), updates); },
    list() { return [...taskStore.values()]; }
  };

  return {
    executorCalls,
    AgentExecutor: FakeAgentExecutor,
    AgentOrchestrator: FakeAgentOrchestrator,
    getSettings: () => ({ inference: { activeTier: 'standard' } }),
    getAgent: () => fakeAgent,
    listAgents: () => [fakeAgent],
    createAgentRuntime: async () => ({
      provider: {},
      toolExecutor: {},
      tier: 'standard',
      model: 'test-model',
      timeoutMs: 1000,
      toolDefinitions: [],
      runtimeEnvironment: { workingDirectory: process.cwd() }
    }),
    withNotificationTiming: async (_label, fn) => fn(),
    buildAgentVoiceOptions: () => ({ enabled: false }),
    speakSummaryText: async () => null,
    buildAgentCompletionSummary: () => '',
    getUserProfile: () => ({}),
    buildTemplateContextFromSettings: () => ({}),
    buildRuntimeSystemPrompt: () => '',
    buildMemoryContextSection: async () => '',
    formatUserContextSection: () => '',
    formatProjectContextSection: () => '',
    getUsageTracker: () => null,
    getTaskManager: () => fakeTaskManager,
    ...overrides
  };
}

describe('agent-handlers prompter wiring', () => {
  it('passes context.prompter into AgentExecutor for agent:execute', async () => {
    const ipcMain = createIpcMainMock();
    const marker = { id: 'prompter-marker' };
    const context = createContext({ prompter: marker });
    registerAgentHandlers(ipcMain, context);

    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi' });

    assert.strictEqual(context.executorCalls.length, 1);
    assert.strictEqual(context.executorCalls[0].prompter, marker);
  });

  it('passes context.prompter into AgentExecutor for agent:executeParallel', async () => {
    const ipcMain = createIpcMainMock();
    const marker = { id: 'prompter-marker' };
    const context = createContext({ prompter: marker });
    registerAgentHandlers(ipcMain, context);

    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_PARALLEL)({}, { agentIds: ['writer'], message: 'hi' });

    assert.strictEqual(context.executorCalls.length, 1);
    assert.strictEqual(context.executorCalls[0].prompter, marker);
  });

  it('passes context.prompter into AgentExecutor for agent:executeSerial', async () => {
    const ipcMain = createIpcMainMock();
    const marker = { id: 'prompter-marker' };
    const context = createContext({ prompter: marker });
    registerAgentHandlers(ipcMain, context);

    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_SERIAL)({}, { agentIds: ['writer'], message: 'hi' });

    assert.strictEqual(context.executorCalls.length, 1);
    assert.strictEqual(context.executorCalls[0].prompter, marker);
  });

  it('passes context.prompter into AgentExecutor for agent:executeWithDeps', async () => {
    const ipcMain = createIpcMainMock();
    const marker = { id: 'prompter-marker' };
    const context = createContext({ prompter: marker });
    registerAgentHandlers(ipcMain, context);

    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_WITH_DEPS)({}, {
      agentId: 'writer',
      tasks: [{ id: 't1', subject: 'Do a thing' }]
    });

    assert.strictEqual(context.executorCalls.length, 1);
    assert.strictEqual(context.executorCalls[0].prompter, marker);
  });

  it('leaves AgentExecutor.prompter undefined when context has none (regression guard)', async () => {
    const ipcMain = createIpcMainMock();
    const context = createContext(); // no prompter override
    registerAgentHandlers(ipcMain, context);

    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi' });

    assert.strictEqual(context.executorCalls[0].prompter, undefined);
  });
});

describe('agent-handlers roles', () => {
  it('asks createAgentRuntime for a role, never a tier', async () => {
    const selections = [];
    const ipcMain = createIpcMainMock();
    const context = createContext({
      createAgentRuntime: async (selection) => {
        selections.push(selection);
        return { provider: {}, toolExecutor: {}, role: selection.role, model: 'test-model', timeoutMs: 1000, toolDefinitions: [], runtimeEnvironment: { workingDirectory: process.cwd() } };
      }
    });
    registerAgentHandlers(ipcMain, context);
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi', tier: 'fast' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE)({}, { agentId: 'writer', message: 'hi', role: 'main' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_PARALLEL)({}, { agentIds: ['writer'], message: 'hi' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_SERIAL)({}, { agentIds: ['writer'], message: 'hi' });
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_WITH_DEPS)({}, { agentId: 'writer', tasks: [{ id: 't1', subject: 'Do a thing' }] });
    // Parallel and serial runs now use each agent's own role (a role-less
    // agent is worker), not main; with-deps resolves once and reuses it.
    assert.deepStrictEqual(selections, [{ role: 'worker' }, { role: 'utility' }, { role: 'main' }, { role: 'worker' }, { role: 'worker' }, { role: 'worker' }]);
    assert.ok(context.executorCalls.every((opts) => opts.failoverPolicy && opts.failoverPolicy.plan(new Error('x')).action === 'abort'));
  });

  it('gives each agent of a parallel run its own runtime on its own role (one route per run)', async () => {
    const selections = [];
    const writer = { id: 'writer', name: 'Writer', canUseTool: () => true, role: 'main' };
    const explorer = { id: 'explorer', name: 'Explorer', canUseTool: () => true, role: 'worker' };
    const ipcMain = createIpcMainMock();
    const context = createContext({
      getAgent: (id) => ({ writer, explorer })[id],
      createAgentRuntime: async (selection) => {
        selections.push(selection.role);
        return { provider: { route: selections.length }, toolExecutor: {}, role: selection.role, model: 'm', timeoutMs: 1000, toolDefinitions: [], runtimeEnvironment: { workingDirectory: process.cwd() } };
      }
    });
    registerAgentHandlers(ipcMain, context);
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_PARALLEL)({}, { agentIds: ['writer', 'explorer'], message: 'hi' });
    assert.deepStrictEqual([...selections].sort(), ['main', 'worker']);
    assert.strictEqual(context.executorCalls.length, 2);
  });

  // Final review I2: a run's agents share the TurnModels taken when the run
  // started; a default-profile change mid-run applies to the next run.
  const snapshotRun = () => {
    let defaultProfile = 'p-first';
    const seen = [];
    const executed = [];
    const ipcMain = createIpcMainMock();
    const context = createContext({
      getAgent: (id) => ({ id, name: id, canUseTool: () => true, role: 'worker' }),
      snapshotModels: () => ({ profileId: defaultProfile }),
      // As the core does: runtimeOptions.turnModels, else a fresh snapshot.
      createAgentRuntime: async (selection, _event, _requester, runtimeOptions = {}) => {
        const turnModels = runtimeOptions.turnModels || context.snapshotModels({});
        seen.push(turnModels.profileId);
        return { provider: {}, toolExecutor: {}, role: selection.role, model: 'm', timeoutMs: 1000, toolDefinitions: [], runtimeEnvironment: { workingDirectory: process.cwd() } };
      },
      AgentExecutor: class {
        async execute(agent) {
          executed.push(agent.id);
          // The owner switches the default profile while the first agent runs.
          defaultProfile = 'p-second';
          return { content: 'ok' };
        }
      }
    });
    registerAgentHandlers(ipcMain, context);
    return { ipcMain, seen, executed, reset: () => { defaultProfile = 'p-first'; seen.length = 0; } };
  };

  it('keeps a serial run on the snapshot it started with when the default profile changes between agents', async () => {
    const { ipcMain, seen, executed } = snapshotRun();
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_SERIAL)({}, { agentIds: ['one', 'two'], message: 'hi' });
    assert.deepStrictEqual(executed, ['one', 'two']);
    assert.deepStrictEqual(seen, ['p-first', 'p-first']);
    // The next run takes the new default.
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_SERIAL)({}, { agentIds: ['one'], message: 'hi' });
    assert.deepStrictEqual(seen, ['p-first', 'p-first', 'p-second']);
  });

  it('keeps parallel and with-deps runs on one snapshot too', async () => {
    const { ipcMain, seen, reset } = snapshotRun();
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_PARALLEL)({}, { agentIds: ['one', 'two'], message: 'hi' });
    assert.deepStrictEqual(seen, ['p-first', 'p-first']);
    reset();
    await ipcMain.handlers.get(IPC.AGENT_EXECUTE_WITH_DEPS)({}, {
      agentId: 'one',
      tasks: [{ id: 't1', subject: 'First' }, { id: 't2', subject: 'Second', blockedBy: ['t1'] }, { id: 't3', subject: 'Third', blockedBy: ['t2'] }]
    });
    // One up front (reused by the first task), then one per later task.
    assert.deepStrictEqual(seen, ['p-first', 'p-first', 'p-first']);
  });

  it('lists agents by role, with no model or tier', async () => {
    const ipcMain = createIpcMainMock();
    registerAgentHandlers(ipcMain, createContext());
    const list = await ipcMain.handlers.get(IPC.AGENT_LIST)({});
    const agents = list.data || list;
    assert.deepStrictEqual(Object.keys(agents[0]).sort(), ['allowedTools', 'description', 'id', 'name', 'role']);
    assert.strictEqual(agents[0].role, 'worker');
  });
});

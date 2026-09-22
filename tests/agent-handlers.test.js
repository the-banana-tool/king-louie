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

  class FakeAgentOrchestrator {
    constructor(agentExecutor) {
      this.agentExecutor = agentExecutor;
    }
    async executeParallel(agents) {
      return agents.map(() => ({ content: 'ok' }));
    }
    async executeSerial(agents) {
      return agents.map(() => ({ content: 'ok' }));
    }
    async executeWithDependencies(taskManager) {
      const results = new Map();
      for (const task of taskManager.list()) {
        results.set(task.id, { content: 'ok' });
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

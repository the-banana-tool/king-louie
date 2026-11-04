// tests/helpers/tasks-harness.js
// A TaskManager over a real in-memory history store and a real TaskStore on a
// temp dir, with a scripted agent adapter, a fake clock whose timers fire on
// `advance`, and recording push and audit sinks.
//
// A script step is `async (turn) => result`. `turn` has the adapter call's
// `options`, `tool(name, params, result)` (the tool events, as a real turn
// fires them), `usage(event)` (onUsageRecorded) and `aborted()`, which settles
// when the turn's signal fires. A step's result defaults to a complete reply.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskManager } = require('../../src/tasks/manager');
const { TaskStore } = require('../../src/tasks/store');
const { ContextBuilder, Retriever, TokenEstimator } = require('../../src/history');
const { historyContext } = require('./history-context');

const TOOL_NAMES = ['Bash', 'Read', 'Write', 'BrowserPage', 'SpawnAgent', 'ListApps', 'Screenshot', 'list_cases',
  'answer_question', 'BackgroundTask', 'TaskStatus', 'Cron', 'RemoteDispatch', 'run_task', 'get_task', 'send_to_task', 'cancel_task', 'list_tasks', 'delegate', 'Click', 'Type',
  'Key', 'Scroll', 'Drag', 'LaunchApp', 'CloseApp', 'RequestLease', 'Take', 'sessions_spawn', 'sessions_list',
  'sessions_history', 'message'];

function fakeClock(start = Date.parse('2026-11-03T12:00:00.000Z')) {
  let now = start;
  const timers = new Set();
  const clock = () => now;
  return {
    clock,
    timers: {
      set(fn, ms) {
        const t = { fn, at: now + ms };
        timers.add(t);
        return t;
      },
      clear(t) { timers.delete(t); },
    },
    pending: () => timers.size,
    advance(ms) {
      now += ms;
      for (const t of [...timers]) {
        if (timers.has(t) && t.at <= now) {
          timers.delete(t);
          t.fn();
        }
      }
    },
  };
}

function tasksHarness({ script = [], callUtility = null, dataDir = null, history = null, clock = null, grants = null, nodeConfig = null } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tasks-'));
  const time = clock || fakeClock();
  const ctx = history || historyContext();
  const store = ctx.getHistoryStore();
  const estimator = new TokenEstimator();
  const builder = new ContextBuilder({ store, retriever: new Retriever({ store, estimator }), estimator });
  const calls = [];
  const steps = [...script];
  const adapter = {
    async execute(agent, message, options) {
      const signal = options.abortSignal;
      const turn = {
        agent, message, options,
        tool(toolName, parameters = {}, result = { success: true }) {
          options.executorOptions.toolEvents.pre({ toolName, parameters });
          options.executorOptions.toolEvents.post({ toolName, parameters, result });
        },
        usage(event) { options.onUsageRecorded(event); },
        aborted: () => new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      };
      calls.push(turn);
      const step = steps.shift();
      const out = step ? await step(turn) : undefined;
      return out === undefined ? { type: 'complete', content: 'finished' } : out;
    },
  };
  const core = {
    context: {
      ...ctx,
      getContextBuilder: () => builder,
      // The core's egressFor reads the chat's mark and its case's; here, the chat's. No chat, no mark, as there.
      egressFor: ({ chatId }) => (chatId && store.isPrivate(chatId) !== false ? { reason: 'private-chat' } : null),
      getAgentExecutorAdapter: () => adapter,
      getAgent: (id) => (id === 'main' ? { id: 'main' } : null),
      listAgents: () => [{ id: 'main' }],
    },
  };
  const pushes = [];
  const audits = [];
  const taskStore = new TaskStore({ dataDir: dir, clock: time.clock });
  const config = nodeConfig || { name: 'node-a', delegate: { agent: 'main', provider: null, model: null } };
  const build = (extra = {}) => new TaskManager({
    core,
    nodeConfig: config,
    dataDir: dir,
    store: taskStore,
    grants,
    push: { enqueue: (e) => pushes.push(e) },
    audit: { append: async (e) => { audits.push(e); return e; } },
    currentUrl: async () => null,
    callUtility,
    clock: time.clock,
    timers: time.timers,
    toolRegistry: { list: () => TOOL_NAMES.map((name) => ({ name })) },
    ...extra,
  });
  const nap = () => new Promise((resolve) => { setTimeout(resolve, 2); });
  return {
    manager: build(), build, core, store: taskStore, history: ctx, dir, time, calls, steps, pushes, audits,
    rows: (chatId) => ctx.getMessages(chatId),
    // Until the manager says the task's turn is over.
    settled: async (manager, id) => {
      for (let i = 0; i < 1000; i += 1) {
        const rec = taskStore.get(id);
        if (!manager.isChatRunning(rec.chat_id)) return rec;
        await nap();
      }
      throw new Error('the turn never ended');
    },
    // Until n adapter calls have started.
    started: async (n = 1) => {
      for (let i = 0; i < 1000 && calls.length < n; i += 1) await nap();
      if (calls.length < n) throw new Error('no turn started');
      return calls[n - 1];
    },
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { tasksHarness, fakeClock, TOOL_NAMES };

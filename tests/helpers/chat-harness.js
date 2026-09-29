// tests/helpers/chat-harness.js
// chat:sendMessage and chat:stopResponse against a minimal context, with the
// real AgentLoop, the real resolver and the real router. The profile's main
// is [{ providerType, model }] unless `roles` says otherwise; `providers`
// maps a provider name to the instance that answers for it, else `provider`
// answers for every one. Anything not given resolves to a function
// returning null, which the send path treats as "feature absent".
const EventEmitter = require('events');
const IPC = require('../../src/ipc/constants');
const { registerChatHandlers } = require('../../src/ipc/chat-handlers');
const { initializeTools, toolRegistry } = require('../../src/tools');
const AgentLoop = require('../../src/execution/agent-loop');
const InferenceRouter = require('../../src/providers/inference-router');
const { createTurnModels } = require('../../src/models/resolver');
const UsageTracker = require('../../src/tracking/usage-tracker');

initializeTools();

function chatHarness({ provider, providerType = 'openai', model = 'test-model', providers = null, roles = null, chat = null, overrides = {} } = {}) {
  const sent = [];
  const usage = [];
  const theChat = chat || { id: 'chat-1', title: 'Chat', messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  const profile = {
    id: 'p-test',
    name: 'Test profile',
    kind: 'user',
    roles: roles
      ? { main: [], worker: [], utility: [], ...roles }
      : { main: [{ provider: providerType, model, effort: null }], worker: [], utility: [] }
  };
  let nextId = 0;
  let ctx = null;
  const context = {
    getChat: (id) => (id === theChat.id ? theChat : null),
    listChats: () => [theChat],
    updateChat: (id, patch) => (id === theChat.id ? Object.assign(theChat, patch) : null),
    appendMessageToChat: (_chatId, sender, text, metadata = {}) => {
      theChat.messages.push({ id: `m${theChat.messages.length}`, sender, text, ...metadata });
      return theChat;
    },
    runHookEvent: async () => ({}),
    // The turn's models: read at snapshot time, so a test can switch the
    // main override between turns (or during one).
    snapshotModels: () => createTurnModels({
      profile,
      mainOverride: theChat.mainOverride || null,
      explain: (p, m, o) => {
        const availability = ctx.getAvailability();
        return availability && typeof availability.explain === 'function'
          ? availability.explain(p, m, o)
          : { usable: true, reasons: [], notes: [] };
      }
    }),
    routedProvider: ({ targets, signal, meta }) => new InferenceRouter({
      getProviderToken: () => 'test-token-123456',
      createProvider: (p) => (providers && providers[p]) || provider,
      sleep: async () => {},
      onProviderError: (p, err) => ctx.reportProviderError(p, err)
    }).routedProvider({ targets, signal, meta }),
    getUsageTracker: () => ({ record: (event) => { usage.push(event); return { ...event, cost: event.costUsd ?? null }; } }),
    createUsageRecordFromMetrics: (m) => UsageTracker.eventFromMetrics(m),
    getContextAssembler: () => null,
    getRuntimeEnvironment: async () => ({ platform: process.platform }),
    buildMemoryContextSection: async () => '',
    buildRuntimeSystemPrompt: () => 'BASE-PROMPT',
    createToolExecutorWithApprovals: async () => {
      const executor = new EventEmitter();
      executor.allowedDirectories = [];
      executor.execute = async () => ({ ok: true });
      return executor;
    },
    toolRegistry,
    withNotificationTiming: async (_label, fn) => fn(),
    AgentLoop,
    getSettings: () => ({}),
    getVoiceSettings: () => ({ enabled: false }),
    createId: () => `id-${++nextId}`,
    ...overrides
  };
  ctx = new Proxy(context, { get: (target, key) => (key in target ? target[key] : () => null) });
  const handlers = new Map();
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, ctx);
  const event = {
    sender: {
      send: (channel, payload) => {
        sent.push({ channel, payload });
        if (typeof context.onSend === 'function') context.onSend(channel, payload);
      },
      isDestroyed: () => false
    }
  };
  const send = (payload = {}) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: theChat.id, message: 'Hello', ...payload });
  const stop = () => handlers.get(IPC.CHAT_STOP_RESPONSE)(event, { chatId: theChat.id });
  return { chat: theChat, sent, usage, send, stop, context };
}

module.exports = { chatHarness };

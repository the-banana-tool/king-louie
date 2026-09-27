// tests/helpers/chat-harness.js
// chat:sendMessage and chat:stopResponse against a minimal context, with the
// real AgentLoop. Anything not given resolves to a function returning null,
// which the send path treats as "feature absent".
const EventEmitter = require('events');
const IPC = require('../../src/ipc/constants');
const { registerChatHandlers } = require('../../src/ipc/chat-handlers');
const { initializeTools, toolRegistry } = require('../../src/tools');
const AgentLoop = require('../../src/execution/agent-loop');

initializeTools();

function chatHarness({ provider, providerType = 'openai', model = 'test-model', chat = null, overrides = {} } = {}) {
  const sent = [];
  const usage = [];
  const theChat = chat || { id: 'chat-1', title: 'Chat', messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  let nextId = 0;
  const context = {
    getChats: () => [theChat],
    setChats: () => {},
    appendMessageToChat: (_chatId, sender, text, metadata = {}) => {
      theChat.messages.push({ id: `m${theChat.messages.length}`, sender, text, ...metadata });
      return theChat;
    },
    runHookEvent: async () => ({}),
    resolveInference: async () => ({ providerType, provider, model, tier: 'standard', timeoutMs: 1000 }),
    getUsageTracker: () => ({ record: (event) => { usage.push(event); return { ...event, cost: event.costUsd ?? null }; } }),
    createUsageRecordFromMetrics: (m) => ({
      provider: m.provider,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.totalTokens,
      costUsd: typeof m.costUsd === 'number' ? m.costUsd : null,
      ...(m.usagePartial ? { usagePartial: true } : {})
    }),
    getConversationCompactor: () => null,
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
  const ctx = new Proxy(context, { get: (target, key) => (key in target ? target[key] : () => null) });
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

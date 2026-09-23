// tests/cases-chat.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');
const { initializeTools, toolRegistry } = require('../src/tools');
const { CaseBusyError, CaseNotFoundError } = require('../src/cases');
const { CASE_TOOL_NAMES } = require('../src/cases/chat-integration');

initializeTools();

// A minimal context for chat:sendMessage. Anything not overridden resolves to
// a function returning null, which the send path treats as "feature absent".
// If the handler starts dereferencing another context function, add it here.
function harness({ caseId = 'case-1', beginError = null, loopError = null, hookResult = null, loopContent = 'Answer text' } = {}) {
  const calls = { begin: [], end: [], executorOptions: null, run: null, resolveInferenceCalls: 0 };
  const chat = { id: 'chat-1', title: 'Case chat', caseId, messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  const runtime = {
    beginTurn: async (id, opts) => {
      calls.begin.push({ id, ...opts });
      if (beginError) throw beginError;
      return { caseId: id, dir: '/cases/lakeside-lot', turnId: opts.turnId, title: 'Lakeside lot', orientation: 'ORIENTATION-BLOCK' };
    },
    endTurn: async (turn, opts) => { calls.end.push({ turn, ...opts }); return 'abc1234'; }
  };
  class FakeLoop {
    async run(messages, tools, options) {
      calls.run = { messages, tools, options };
      if (loopError) throw loopError;
      return { content: loopContent, llm: { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } } };
    }
  }
  const overrides = {
    getChats: () => [chat],
    setChats: () => {},
    appendMessageToChat: (_id, sender, text) => { chat.messages.push({ id: `m${chat.messages.length}`, sender, text }); return chat; },
    runHookEvent: async () => hookResult || {},
    resolveInference: async () => {
      calls.resolveInferenceCalls += 1;
      return {
        providerType: 'openai',
        provider: { sendMessageWithTools: async () => ({}), streamMessage: async () => ({}) },
        model: 'test-model', tier: 'standard', timeoutMs: 1000
      };
    },
    getConversationCompactor: () => null,
    getContextAssembler: () => null,
    getRuntimeEnvironment: async () => ({ platform: process.platform }),
    buildMemoryContextSection: async () => '',
    buildRuntimeSystemPrompt: () => 'BASE-PROMPT',
    createToolExecutorWithApprovals: async (_event, _env, _req, opts) => {
      calls.executorOptions = opts;
      return { on() {}, execute: async () => ({ ok: true }) };
    },
    toolRegistry,
    withNotificationTiming: async (_label, fn) => fn(),
    AgentLoop: FakeLoop,
    getSettings: () => ({}),
    getVoiceSettings: () => ({ enabled: false }),
    getCaseRuntime: () => runtime,
    createId: () => `id-${Math.random().toString(16).slice(2)}`
  };
  const context = new Proxy(overrides, { get: (target, key) => (key in target ? target[key] : () => null) });
  const handlers = new Map();
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  const event = { sender: { send() {}, isDestroyed: () => false } };
  const send = (payload = {}) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: 'chat-1', message: 'What should I do next?', ...payload });
  return { calls, send, chat };
}

describe('chat:sendMessage in case mode', () => {
  it('begins a turn, injects orientation and case tools, and ends the turn with the answer', async () => {
    const { calls, send } = harness();
    const result = await send({ agentMode: false });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.begin.length, 1);
    assert.strictEqual(calls.begin[0].id, 'case-1');
    assert.match(calls.begin[0].turnId, /^turn-/);
    const prompt = calls.run.options.systemPrompt;
    assert.ok(prompt.startsWith('Case mode.'), 'case prompt first');
    assert.ok(prompt.indexOf('ORIENTATION-BLOCK') < prompt.indexOf('BASE-PROMPT'));
    const toolNames = calls.run.tools.map((t) => t.name);
    for (const name of CASE_TOOL_NAMES) assert.ok(toolNames.includes(name), `${name} offered`);
    assert.strictEqual(calls.executorOptions.caseContext.caseId, 'case-1');
    assert.strictEqual(calls.executorOptions.caseContext.dir, '/cases/lakeside-lot');
    assert.strictEqual(calls.end.length, 1);
    assert.strictEqual(calls.end[0].journal, 'Answer text');
    assert.strictEqual(calls.end[0].summary, 'What should I do next?');
  });

  it('leaves chats without a case untouched', async () => {
    const { calls, send } = harness({ caseId: null });
    await send({ agentMode: true });
    assert.strictEqual(calls.begin.length, 0);
    assert.ok(!calls.run.tools.some((t) => CASE_TOOL_NAMES.includes(t.name)));
    assert.ok(!calls.run.options.systemPrompt.includes('Case mode.'));
    assert.strictEqual(calls.executorOptions.caseContext, null);
  });

  it('refuses the turn when the case is busy and runs nothing', async () => {
    const { calls, send, chat } = harness({ beginError: new CaseBusyError('Lakeside lot') });
    const result = await send();
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /busy/);
    assert.strictEqual(calls.run, null);
    assert.strictEqual(calls.end.length, 0);
    assert.strictEqual(chat.messages.length, 1, 'no orphan user message');
    assert.strictEqual(calls.resolveInferenceCalls, 0, 'no provider was ever resolved');
  });

  it('refuses the turn when the case is not found and runs nothing', async () => {
    const { calls, send, chat } = harness({ beginError: new CaseNotFoundError('case-1') });
    const result = await send();
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /not found/i);
    assert.strictEqual(calls.run, null);
    assert.strictEqual(calls.end.length, 0);
    assert.strictEqual(chat.messages.length, 1, 'no orphan user message');
    assert.strictEqual(calls.resolveInferenceCalls, 0, 'no provider was ever resolved');
  });

  it('ends the turn when a hook blocks the prompt, and runs nothing', async () => {
    const { calls, send, chat } = harness({ hookResult: { action: 'deny', message: 'not right now' } });
    const result = await send();
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /not right now/);
    assert.strictEqual(calls.run, null);
    assert.strictEqual(calls.end.length, 1);
    assert.match(calls.end[0].summary, /^turn blocked: not right now/);
    assert.strictEqual(calls.end[0].journal, null);
    assert.strictEqual(chat.messages.length, 1, 'no orphan user message');
  });

  it('ends the turn when the agent loop fails', async () => {
    const { calls, send } = harness({ loopError: new Error('provider exploded') });
    await send();
    assert.strictEqual(calls.end.length, 1);
    assert.match(calls.end[0].summary, /^turn failed: provider exploded/);
    assert.strictEqual(calls.end[0].journal, null);
  });

  it('does not journal the "(No response)" placeholder', async () => {
    const { calls, send } = harness({ loopContent: '' });
    const result = await send();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.end.length, 1);
    assert.strictEqual(calls.end[0].journal, null);
    assert.strictEqual(calls.end[0].summary, 'What should I do next?');
  });

  it('passes ownerMessages with the prior and new user messages, excluding the assistant greeting', async () => {
    const { calls, send } = harness();
    await send({ message: 'First message from the owner' });
    await send({ message: 'Second message from the owner' });
    const { ownerMessages } = calls.executorOptions.caseContext;
    assert.ok(Array.isArray(ownerMessages));
    assert.ok(ownerMessages.includes('First message from the owner'), 'includes prior user message');
    assert.ok(ownerMessages.includes('Second message from the owner'), 'includes new user message');
    assert.ok(!ownerMessages.includes('How can I help you?'), 'excludes the assistant greeting');
  });
});

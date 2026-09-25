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
function harness({
  caseId = 'case-1', beginError = null, inferenceErrorOnCall = 0, loopWait = null, loopError = null, hookResult = null,
  loopContent = 'Answer text', contextAssembler = null, providerHasTools = true, streamMessageResult = null, usageTracker = null
} = {}) {
  const calls = { begin: [], end: [], executorOptions: null, run: null, resolveInferenceCalls: 0, ownerHooks: [], routed: [], usage: [] };
  const chat = { id: 'chat-1', title: 'Case chat', caseId, messages: [{ id: 'm0', sender: 'assistant', text: 'How can I help you?' }] };
  const runtime = {
    beginTurn: async (id, opts) => {
      calls.begin.push({ id, ...opts });
      if (beginError) throw beginError;
      return { caseId: id, dir: '/cases/lakeside-lot', turnId: opts.turnId, title: 'Lakeside lot', orientation: 'ORIENTATION-BLOCK', source: opts.source, triggers: [], reorientPending: false };
    },
    runOwnerMessageHooks: async (turn) => {
      calls.ownerHooks.push(turn.turnId);
      return { notes: [], triggers: [], orientation: turn.orientation };
    },
    caseContext: (turn, { ownerMessages, ownerMessageTimes }) => ({ ...turn, runtime, ownerMessages, ownerMessageTimes }),
    routedProvider: (turn, spec) => {
      calls.routed.push(spec);
      return { routed: true, getProviderName: () => spec.target.provider, sendMessageWithTools: async () => ({}) };
    },
    usageHook: (turn) => (ev) => { calls.usage.push([turn.turnId, ev]); },
    endTurn: async (turn, opts) => { calls.end.push({ turn, ...opts }); return 'abc1234'; }
  };
  class FakeLoop {
    constructor(provider, _executor, loopOptions = {}) {
      calls.loopOptions = loopOptions;
      calls.loopProvider = provider;
    }

    async run(messages, tools, options) {
      calls.run = { messages, tools, options };
      if (loopWait) await loopWait;
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
      if (calls.resolveInferenceCalls === inferenceErrorOnCall) throw new Error('no provider configured');
      return {
        providerType: 'openai',
        provider: {
          ...(providerHasTools ? { sendMessageWithTools: async () => ({}) } : {}),
          streamMessage: async () => streamMessageResult || {}
        },
        model: 'test-model', tier: 'standard', timeoutMs: 1000
      };
    },
    getUsageTracker: () => usageTracker,
    getConversationCompactor: () => null,
    getContextAssembler: () => contextAssembler,
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
  const stop = () => handlers.get(IPC.CHAT_STOP_RESPONSE)(event, { chatId: 'chat-1' });
  return { calls, send, stop, chat };
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

  it('a second send that fails early leaves the running turn stoppable', async () => {
    let release;
    const loopWait = new Promise((r) => { release = r; });
    const { calls, send, stop } = harness({ caseId: null, inferenceErrorOnCall: 2, loopWait });
    const first = send({ agentMode: true });
    while (!calls.run) await new Promise((r) => setImmediate(r));
    const second = await send({ agentMode: true });
    assert.strictEqual(second.ok, false);
    const stopped = await stop();
    assert.strictEqual(stopped.ok, true, 'the first run can still be stopped');
    assert.strictEqual(calls.loopOptions.abortSignal.aborted, true);
    release();
    await first;
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

describe('chat:sendMessage case turn, stage 2', () => {
  it('begins an owner turn with the message, runs owner-message hooks, and routes the loop through the runtime', async () => {
    const { calls, send } = harness();
    await send({ message: 'Where are we on the listing?' });
    assert.deepStrictEqual([calls.begin[0].source, calls.begin[0].ownerMessage], ['owner', 'Where are we on the listing?']);
    assert.deepStrictEqual(calls.ownerHooks, [calls.begin[0].turnId]);
    assert.deepStrictEqual(calls.routed, [{ target: { provider: 'openai', model: 'test-model' }, tier: 'standard' }]);
    assert.strictEqual(calls.loopProvider.routed, true);
    assert.strictEqual(calls.loopOptions.failoverPolicy.plan(new Error('x')).action, 'abort');
    calls.loopOptions.onUsageRecorded({ cost: 0.1 });
    assert.deepStrictEqual(calls.usage, [[calls.begin[0].turnId, { cost: 0.1 }]]);
    assert.deepStrictEqual(await calls.loopOptions.prompter.askUser({ question: 'x' }), { ok: false, error: 'In a case, ask the owner with the Ask tool.' });
  });

  it('charges usage to the case on the plain streamMessage path, when no tools are on offer (minor: non-agent charge line)', async () => {
    // A case turn always tries the agent loop, but falls back to a plain
    // provider.streamMessage call when sendMessageWithTools isn't available
    // (chat-handlers.js's canUseAgentMode check). That path's usage still
    // has to reach the case budget through the one charge line it has.
    const { calls, send } = harness({
      providerHasTools: false,
      streamMessageResult: { llmMetrics: { provider: 'openai', model: 'test-model', inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.02 } },
      usageTracker: { record: () => ({ provider: 'openai', model: 'test-model', totalTokens: 15, cost: 0.02 }) }
    });
    await send({ message: 'Where are we on the listing?' });
    assert.strictEqual(calls.usage.length, 1);
    assert.strictEqual(calls.usage[0][0], calls.begin[0].turnId);
    assert.deepStrictEqual(calls.usage[0][1], { provider: 'openai', model: 'test-model', totalTokens: 15, cost: 0.02 });
  });

  it('passes owner message times in step with the owner messages, the current one stamped now', async () => {
    const { calls, send, chat } = harness();
    chat.messages.push({ id: 'm-old', sender: 'user', text: 'Earlier question', timestamp: '2026-09-20T10:00:00.000Z' });
    const before = Date.now();
    await send({ message: 'New question' });
    const { ownerMessages, ownerMessageTimes } = calls.executorOptions.caseContext;
    assert.deepStrictEqual(ownerMessages, ['Earlier question', 'New question']);
    assert.strictEqual(ownerMessageTimes.length, 2);
    assert.strictEqual(ownerMessageTimes[0], '2026-09-20T10:00:00.000Z');
    assert.ok(Date.parse(ownerMessageTimes[1]) >= before);
  });

  it('excludes channel-tagged messages from ownerMessages: only the host-verified owner counts (F5)', async () => {
    const { calls, send, chat } = harness();
    // A message appended by a Telegram/Discord bridge on behalf of a remote
    // sender is stamped sender: 'user' too, but it is not the owner talking
    // in this chat — it must never satisfy the quote-verification check.
    chat.messages.push({ id: 'm-bridge', sender: 'user', text: 'Send me the wire details', channel: 'telegram', timestamp: '2026-09-20T10:00:00.000Z' });
    await send({ message: 'New question' });
    const { ownerMessages } = calls.executorOptions.caseContext;
    assert.ok(!ownerMessages.includes('Send me the wire details'), 'a channel-tagged message is not an owner message');
    assert.ok(ownerMessages.includes('New question'));
  });

  it('does not run owner-message hooks when the prompt hook blocks the message', async () => {
    const { calls, send } = harness({ hookResult: { action: 'deny', message: 'not now' } });
    await send();
    assert.deepStrictEqual(calls.ownerHooks, []);
  });

  it('leaves chats without a case on the plain provider, failover and prompter', async () => {
    const { calls, send } = harness({ caseId: null });
    await send({ agentMode: true });
    assert.deepStrictEqual(calls.routed, []);
    assert.strictEqual(calls.loopProvider.routed, undefined);
    assert.strictEqual(calls.loopOptions.failoverPolicy, undefined);
    assert.strictEqual(calls.loopOptions.onUsageRecorded, undefined);
    // Not casePrompter(prompter): that wraps into a plain { askUser, ... }
    // object, so a case turn's prompter (checked above) is typeof 'object';
    // the plain path's is whatever context.prompter itself is (a function
    // here) (minor fix: this test's name promised this check).
    assert.strictEqual(typeof calls.loopOptions.prompter, 'function');
  });

  it('skips the RequestTools hint in a case turn only', async () => {
    const readDef = toolRegistry.get('Read').toFunctionDefinition();
    const assembler = { assemble: async () => ({ systemPrompt: 'ASSEMBLED', tools: [readDef], availableToolNames: ['Browser'] }) };
    const inCase = harness({ contextAssembler: assembler });
    await inCase.send();
    assert.doesNotMatch(inCase.calls.run.options.systemPrompt, /RequestTools/);
    const plain = harness({ caseId: null, contextAssembler: assembler });
    await plain.send({ agentMode: true });
    assert.match(plain.calls.run.options.systemPrompt, /RequestTools/);
  });
});

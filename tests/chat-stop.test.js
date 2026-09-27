// tests/chat-stop.test.js
// Stop (spec 2026-09-27 §9, §15): the request is aborted at the provider, the
// streamed text is kept as an assistant message marked stopped, nothing from
// the run is appended after it, and a cut-off call's usage is recorded as
// partial — never as $0.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const ProviderFactory = require('../src/providers/provider-factory');
const { chatHarness } = require('./helpers/chat-harness');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { sumLlmCalls } = require('../src/tracking/llm-totals');
const { partialMetricsOf, isAbortError } = require('../src/providers/abort');

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Stop in chat', () => {
  let server;
  const catalog = fixtureCatalog();
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  // Stops the run as soon as the first chunk reaches the renderer.
  function stoppingHarness(options) {
    let h = null;
    let stopping = null;
    h = chatHarness({
      ...options,
      overrides: {
        ...(options.overrides || {}),
        onSend: (channel) => { if (channel === 'chat:messageChunk' && !stopping) stopping = h.stop(); }
      }
    });
    return { h, stopped: () => stopping };
  }

  const anthropic = () => ProviderFactory.create('anthropic', 'sk-ant-test-123456', { baseUrl: `${server.url}/anthropic/v1`, catalog });

  it('a plain reply: aborts the request, keeps the partial text marked stopped, records partial usage', async () => {
    server.setHold(true);
    try {
      const { h, stopped } = stoppingHarness({ provider: anthropic(), providerType: 'anthropic', model: 'claude-haiku-4-5' });
      const before = server.closedCount();
      const result = await h.send({ agentMode: false });
      assert.deepStrictEqual(await stopped(), { ok: true });
      await server.waitForClosedStream(before + 1);
      assert.notStrictEqual(result.ok, false, JSON.stringify(result));
      const last = h.chat.messages[h.chat.messages.length - 1];
      assert.strictEqual(last.sender, 'assistant');
      assert.strictEqual(last.text, 'Hello');
      assert.strictEqual(last.stopped, true);
      assert.strictEqual(last.llm.calls.length, 1);
      assert.strictEqual(last.llm.calls[0].usagePartial, true);
      assert.strictEqual(last.llm.calls[0].inputTokens, 1200);
      assert.strictEqual(last.llm.calls[0].costUsd, 0.001205);
      assert.strictEqual(last.llm.totals.partial, true);
      assert.deepStrictEqual(h.usage.map((u) => [u.usagePartial, u.costUsd]), [[true, 0.001205]]);
      const complete = h.sent.filter((e) => e.channel === 'chat:messageComplete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual(complete[0].payload.stopped, true);
      assert.strictEqual(complete[0].payload.message, 'Hello');
    } finally {
      server.setHold(false);
    }
  });

  it('a plain reply cut off before the provider reported usage has no cost, not $0', async () => {
    server.setHold(true);
    try {
      const provider = ProviderFactory.create('openai', 'sk-test-123456', { baseUrl: `${server.url}/openai/v1`, catalog });
      const { h } = stoppingHarness({ provider, providerType: 'openai', model: 'gpt-5.5' });
      await h.send({ agentMode: false });
      const last = h.chat.messages[h.chat.messages.length - 1];
      assert.strictEqual(last.stopped, true);
      assert.strictEqual(last.llm.calls[0].costUsd, null);
      assert.strictEqual(last.llm.totals.unpriced, true);
      assert.strictEqual(last.llm.totals.partial, true);
      assert.deepStrictEqual(h.usage.map((u) => [u.usagePartial, u.costUsd]), [[true, null]]);
    } finally {
      server.setHold(false);
    }
  });

  it('an agent-mode reply: the loop stops at the provider and the cut-off call is recorded once', async () => {
    server.setHold(true);
    try {
      const { h } = stoppingHarness({ provider: anthropic(), providerType: 'anthropic', model: 'claude-haiku-4-5' });
      const before = server.closedCount();
      const result = await h.send({ agentMode: true });
      await server.waitForClosedStream(before + 1);
      assert.notStrictEqual(result.ok, false, JSON.stringify(result));
      const afterUser = h.chat.messages.slice(h.chat.messages.findIndex((m) => m.sender === 'user') + 1);
      assert.deepStrictEqual(afterUser.map((m) => [m.sender, m.text, m.stopped]), [['assistant', 'Hello', true]]);
      assert.strictEqual(afterUser[0].llm.calls[0].usagePartial, true);
      assert.strictEqual(h.usage.length, 1);
      assert.strictEqual(h.usage[0].usagePartial, true);
    } finally {
      server.setHold(false);
    }
  });

  it('a tool that finishes after Stop appends nothing', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const inTool = new Promise((resolve) => { entered = resolve; });
    const provider = {
      getProviderName: () => 'openai',
      sendMessageWithTools: async () => ({ type: 'tool_use', toolName: 'Read', toolUseId: 't1', parameters: { file_path: 'notes.txt' } }),
      buildToolMessages: (_response, result, id) => [
        { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'Read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(result) }
      ]
    };
    const h = chatHarness({
      provider,
      overrides: {
        createToolExecutorWithApprovals: async () => {
          const executor = new EventEmitter();
          executor.allowedDirectories = [];
          executor.execute = async (toolName, parameters) => {
            executor.emit('preExecute', { toolName, parameters });
            entered();
            await gate;
            executor.emit('postExecute', { toolName, result: { ok: true } });
            return { ok: true };
          };
          return executor;
        }
      }
    });
    const sending = h.send({ agentMode: true });
    await inTool;
    assert.deepStrictEqual(await h.stop(), { ok: true });
    release();
    const result = await sending;
    assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    assert.deepStrictEqual(h.chat.messages.slice(-3).map((m) => m.sender), ['user', 'toolUse', 'assistant']);
    assert.strictEqual(h.chat.messages[h.chat.messages.length - 1].stopped, true);
    assert.ok(!h.chat.messages.some((m) => m.sender === 'toolResult'));
    assert.ok(!h.sent.some((e) => e.channel === 'chat:toolResult'));
  });

  it('a stopped run that finishes late leaves a newer run of the same chat stoppable', async () => {
    const gates = [];
    let calls = 0;
    const provider = {
      getProviderName: () => 'openai',
      sendMessageWithTools: async () => {
        const n = calls++;
        await new Promise((resolve) => { gates[n] = resolve; });
        return { type: 'text', content: `late ${n}` };
      }
    };
    const h = chatHarness({ provider });
    const first = h.send({ agentMode: true, message: 'first' });
    while (!gates[0]) await tick();
    assert.deepStrictEqual(await h.stop(), { ok: true });
    const second = h.send({ agentMode: true, message: 'second' });
    while (!gates[1]) await tick();
    gates[0]();
    await first;
    assert.deepStrictEqual(await h.stop(), { ok: true }, 'the newer run is still registered');
    gates[1]();
    await second;
    assert.strictEqual(h.chat.messages.filter((m) => m.sender === 'assistant' && m.stopped).length, 2);
    assert.ok(!h.chat.messages.some((m) => m.text === 'late 0' || m.text === 'late 1'), 'no reply lands after its run was stopped');
  });

  it('an empty stopped reply stays out of the next turn\'s history', async () => {
    let seen = null;
    const provider = { streamMessage: async (messages) => { seen = messages; return {}; } };
    const chat = {
      id: 'chat-1',
      title: 'Chat',
      messages: [
        { id: 'a', sender: 'user', text: 'first question' },
        { id: 'b', sender: 'assistant', text: '', stopped: true },
        { id: 'c', sender: 'assistant', text: 'kept partial', stopped: true }
      ]
    };
    const h = chatHarness({ provider, chat });
    await h.send({ agentMode: false, message: 'second question' });
    assert.deepStrictEqual(seen.map((m) => m.text), ['first question', 'kept partial', 'second question']);
  });

  it('Stop with nothing running says so', async () => {
    const h = chatHarness({ provider: { streamMessage: async () => ({}) } });
    assert.deepStrictEqual(await h.stop(), { ok: false, error: 'No active response for this chat.' });
  });
});

describe('abort helpers and totals', () => {
  it('sums calls, marking partial and unpriced totals', () => {
    assert.deepStrictEqual(sumLlmCalls([
      { inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: 0.001 },
      { inputTokens: 1200, outputTokens: 1, totalTokens: 1201, costUsd: 0.001205, usagePartial: true }
    ]), { inputTokens: 1300, outputTokens: 11, totalTokens: 1311, costUsd: 0.002205, partial: true });
    assert.deepStrictEqual(sumLlmCalls([{ inputTokens: 5, outputTokens: 1, totalTokens: 6, costUsd: null }]), { inputTokens: 5, outputTokens: 1, totalTokens: 6, costUsd: 0, unpriced: true });
    assert.deepStrictEqual(sumLlmCalls([]), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
  });

  it('knows an abort, and builds an empty partial record when the provider had none', () => {
    assert.strictEqual(isAbortError(new DOMException('aborted', 'AbortError')), true);
    assert.strictEqual(isAbortError(new Error('fetch failed')), false);
    const own = { usagePartial: true, inputTokens: 5 };
    assert.strictEqual(partialMetricsOf(Object.assign(new Error('x'), { partialLlmMetrics: own })), own);
    assert.deepStrictEqual(partialMetricsOf(new Error('x'), { provider: 'openai', model: 'gpt-5.5' }), {
      provider: 'openai', model: 'gpt-5.5', inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, costUsd: null, usagePartial: true
    });
  });
});

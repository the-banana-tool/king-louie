// tests/chat-profiles.test.js
// The chat turn on profiles (spec 2026-09-27 §6.5–§6.7, §15): models frozen
// at launch, the main gate and its messages, an unusable override, and
// failover along main's list — any provider on the first call only.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chatHarness } = require('./helpers/chat-harness');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const ProviderFactory = require('../src/providers/provider-factory');
const IPC = require('../src/ipc/constants');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const t = (provider, model) => ({ provider, model, effort: null });
const errorEvent = (h) => h.sent.find((e) => e.channel === 'chat:messageError')?.payload;

function verdicts(unusable = {}) {
  return {
    ensureTested: async () => ({ ok: true }),
    explain: (p, m) => (unusable[`${p}/${m}`] ? { usable: false, reasons: [unusable[`${p}/${m}`]], notes: [] } : { usable: true, reasons: [], notes: [] })
  };
}

describe('chat turns on profiles', () => {
  it('a main switch during a run applies to the next turn', async () => {
    const seen = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const provider = {
      sendMessageWithTools: async (_messages, _tools, opts) => {
        calls += 1;
        seen.push(opts.model);
        if (calls === 1) {
          // Pause on the turn's first call, so the test can switch the main
          // override while the turn is still running; the tool_use makes
          // the loop call again inside the same turn, which is what proves
          // the switch didn't reach the run already in flight.
          await gate;
          return { type: 'tool_use', toolName: 'Read', toolUseId: 't1', parameters: { file_path: 'notes.txt' } };
        }
        return { type: 'text', content: `answered by ${opts.model}` };
      }
    };
    const h = chatHarness({ provider, model: 'model-a' });
    const first = h.send({ agentMode: true, message: 'first' });
    while (!seen.length) await tick();
    h.chat.mainOverride = t('openai', 'model-b');
    release();
    await first;
    // The turn's own second call (after the tool ran) still used model-a:
    // the switch made mid-run did not reach the run already in flight.
    assert.deepStrictEqual(seen, ['model-a', 'model-a']);
    await h.send({ agentMode: true, message: 'second' });
    assert.deepStrictEqual(seen, ['model-a', 'model-a', 'model-b']);
    const replies = h.chat.messages.filter((m) => m.sender === 'assistant').map((m) => m.text);
    assert.deepStrictEqual(replies.slice(-2), ['answered by model-a', 'answered by model-b']);
  });

  it('an unusable main override fails the turn with the reason and a one-click action, never a silent switch', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; } };
    const h = chatHarness({ provider, model: 'gpt-5.5', overrides: { getAvailability: () => verdicts({ 'groq/llama-3.3-70b': 'Groq connection test failed: Invalid API Key' }) } });
    h.chat.mainOverride = t('groq', 'llama-3.3-70b');
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /The main model override groq\/llama-3\.3-70b is not usable: Groq connection test failed: Invalid API Key/);
    assert.deepStrictEqual(errorEvent(h).action, { kind: 'use-profile-main' });
    assert.strictEqual(called, false);
  });

  it('no usable main fails before any call, listing every skipped target and its reason', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; } };
    const h = chatHarness({
      provider,
      roles: { main: [t('groq', 'a'), t('openai', 'b')] },
      overrides: { getAvailability: () => verdicts({ 'groq/a': 'No token saved for Groq.', 'openai/b': 'OpenAI connection test failed: timeout' }) }
    });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /No usable model for main in the profile "Test profile"\. Skipped: groq\/a \(No token saved for Groq\.\); openai\/b \(OpenAI connection test failed: timeout\)/);
    assert.deepStrictEqual(errorEvent(h).action, { kind: 'open-models' });
    assert.strictEqual(called, false);
  });

  it('an empty main points the owner to Models', async () => {
    const h = chatHarness({ provider: {}, roles: { main: [] } });
    const result = await h.send({ agentMode: false });
    assert.match(result.error, /main has no models in the profile "Test profile"\. Add one in Settings → Models/);
  });

  it('fails over along main on the turn\'s first call, to another provider', async () => {
    const providers = {
      groq: { streamMessage: async () => { throw new Error('upstream exploded'); } },
      openai: {
        streamMessage: async (_messages, opts, onChunk) => {
          onChunk('Hello');
          return { llmMetrics: { provider: 'openai', model: opts.model, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 } };
        }
      }
    };
    const h = chatHarness({ providers, roles: { main: [t('groq', 'down'), t('openai', 'up')] } });
    const result = await h.send({ agentMode: false });
    assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.deepStrictEqual([reply.text, reply.llm.calls[0].model], ['Hello', 'up']);
  });

  it('a turn cannot move to another provider after its first call, and says to retry with another model', async () => {
    let openaiCalls = 0;
    let anthropicCalled = false;
    const providers = {
      openai: {
        sendMessageWithTools: async () => {
          openaiCalls += 1;
          if (openaiCalls === 1) return { type: 'tool_use', toolName: 'Read', toolUseId: 't1', parameters: { file_path: 'notes.txt' } };
          throw new Error('upstream exploded');
        }
      },
      anthropic: { sendMessageWithTools: async () => { anthropicCalled = true; return { type: 'text', content: 'no' }; } }
    };
    const h = chatHarness({ providers, roles: { main: [t('openai', 'a'), t('anthropic', 'b')] } });
    const result = await h.send({ agentMode: true });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /cannot move to anthropic\/b after its first model call/);
    assert.match(result.error, /Retry with/);
    assert.strictEqual(anthropicCalled, false);
  });

  it('the advisor reviews on the turn\'s main model', async () => {
    const models = [];
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => { models.push(['loop', opts.model]); return { type: 'text', content: 'done' }; },
      sendMessage: async (_m, opts) => { models.push(['advisor', opts.model]); return 'VERDICT: approve\nLooks right.'; }
    };
    const h = chatHarness({ provider, model: 'gpt-5.5', overrides: { getSettings: () => ({ advisor: { enabled: true } }) } });
    await h.send({ agentMode: true });
    assert.ok(models.some(([who, m]) => who === 'advisor' && m === 'gpt-5.5'), JSON.stringify(models));
  });
});

// Sub-agents of a chat turn (spec §6.6): a SpawnAgent child resolves its
// role from the parent turn's frozen TurnModels, the chat's profile and
// main override as of turn launch, never the default profile at spawn time.
describe('sub-agents of a chat turn', () => {
  const FAKE = 'kl-test-subagents';
  const tempDirs = [];
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  afterEach(() => {
    ProviderFactory._registry.delete(FAKE);
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  // The parent's calls spawn the given agents one after another (onSpawn
  // runs just before each); a child's call answers with its model.
  function fakeProvider(calls, spawns, onSpawn) {
    return class {
      getProviderName() { return FAKE; }
      getDefaultModel() { return 'fake-default'; }
      async sendMessage() { return 'unused'; }
      async sendMessageWithTools(messages, _tools, options) {
        const first = messages.find((m) => m.sender === 'user' || m.role === 'user');
        const text = String(first?.text ?? first?.content ?? '');
        const who = text.startsWith('sub:') ? text : 'parent';
        calls.push([who, options.model]);
        if (who !== 'parent') {
          return { type: 'text', content: `answered by ${options.model}`, llmMetrics: { provider: FAKE, model: options.model, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 } };
        }
        const parentCalls = calls.filter(([w]) => w === 'parent').length;
        const agentId = spawns[parentCalls - 1];
        if (!agentId) return { type: 'text', content: 'parent done' };
        if (onSpawn) onSpawn(agentId, parentCalls);
        return { type: 'tool_use', toolName: 'SpawnAgent', toolUseId: `spawn-${parentCalls}`, parameters: { task: `sub:${agentId}`, agentId } };
      }
      buildToolMessages(response, toolResult, toolCallId) {
        return [
          { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) } }] },
          { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
        ];
      }
    };
  }

  async function startChatCore({ chat, spawns, onSpawn = null }) {
    const calls = [];
    let core = null;
    ProviderFactory.registerProvider(FAKE, fakeProvider(calls, spawns, (id, n) => onSpawn && onSpawn(core, n)));
    delete process.env.KL_CASES_ROOT;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-chat-subagents-'));
    tempDirs.push(dataDir);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    const roles = (prefix) => ({ main: [t(FAKE, `${prefix}-main`)], worker: [t(FAKE, `${prefix}-worker`)], utility: [t(FAKE, `${prefix}-utility`)] });
    store.set('settings', {
      models: {
        profiles: [
          { id: 'p-a', name: 'A', kind: 'user', roles: roles('a') },
          { id: 'p-b', name: 'B', kind: 'user', roles: roles('b') }
        ],
        defaultProfileId: 'p-a'
      }
    });
    store.set('chats', [{ id: 'chat-1', title: 'Chat', messages: [], ...chat }]);
    core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); }
    });
    await core.start();
    core.saveProviderToken(FAKE, 'fake-token-123456');
    const handlers = new Map();
    registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, core.context);
    const event = { sender: { send: () => {}, isDestroyed: () => false } };
    const send = () => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: 'chat-1', message: 'Hello', agentMode: true });
    return { core, calls, send };
  }

  it('a SpawnAgent child runs on the chat\'s non-default profile and its main override', async () => {
    const { core, calls, send } = await startChatCore({
      chat: { profileId: 'p-b', mainOverride: t(FAKE, 'b-override') },
      spawns: ['code-explorer', 'main']
    });
    try {
      const result = await send();
      assert.notStrictEqual(result?.ok, false, JSON.stringify(result));
      // code-explorer runs on worker, main on the chat's override; nothing
      // reaches the default profile A.
      assert.deepStrictEqual(calls, [
        ['parent', 'b-override'],
        ['sub:code-explorer', 'b-worker'],
        ['parent', 'b-override'],
        ['sub:main', 'b-override'],
        ['parent', 'b-override']
      ]);
    } finally {
      await core.shutdown();
    }
  });

  it('a profile edit made mid-turn does not reach a child spawned later in that turn', async () => {
    const { core, calls, send } = await startChatCore({
      chat: { profileId: 'p-b' },
      spawns: ['code-explorer', 'code-explorer'],
      // Before the second spawn the owner edits profile B's worker and
      // makes A the default: neither may reach this turn's children.
      onSpawn: (c, n) => {
        if (n !== 2) return;
        const profiles = c.context.getProfiles();
        profiles.update('p-b', { roles: { ...profiles.get('p-b').roles, worker: [t(FAKE, 'b-worker-edited')] } });
        profiles.setDefault('p-a');
      }
    });
    try {
      const result = await send();
      assert.notStrictEqual(result?.ok, false, JSON.stringify(result));
      assert.deepStrictEqual(calls.filter(([w]) => w !== 'parent').map(([, m]) => m), ['b-worker', 'b-worker']);
      assert.deepStrictEqual(core.context.getProfiles().get('p-b').roles.worker.map((x) => x.model), ['b-worker-edited']);
    } finally {
      await core.shutdown();
    }
  });

  it('a sub-agent\'s calls roll up into the reply, by role (spec §10)', async () => {
    const { core, send } = await startChatCore({ chat: { profileId: 'p-b' }, spawns: ['code-explorer'] });
    try {
      const result = await send();
      assert.notStrictEqual(result?.ok, false, JSON.stringify(result));
      const reply = core.context.getChats().find((c) => c.id === 'chat-1').messages.filter((m) => m.sender === 'assistant').pop();
      assert.deepStrictEqual(
        reply.llm.subagents.map((s) => [s.agentId, s.role, s.calls.map((c) => [c.model, c.role, c.profileId])]),
        [['code-explorer', 'worker', [['b-worker', 'worker', 'p-b']]]]
      );
      assert.strictEqual(reply.llm.byRole.worker.costUsd, 0.001);
    } finally {
      await core.shutdown();
    }
  });
});

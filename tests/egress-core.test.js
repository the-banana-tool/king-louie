// tests/egress-core.test.js
// The egress policy through the core (spec 2026-10-13-local-inference-design.md
// §7.1 to §7.3; R-LI-8, R-LI-22): a turn's snapshot carries its chat's
// private mark, a child run never has less policy than its parent, a run
// with a chat and no parent takes the chat's, and with only hosted models
// the call is refused before anything is sent. The local server is a fake
// on 127.0.0.1; the "hosted" provider is OpenAI behind a fetch stub that
// answers its model list and fails the test for anything else. The tests
// mark through the store.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const HI = [{ role: 'user', content: 'hi' }];
const t = (provider, model, effort = null) => ({ provider, model, effort });
const HOSTED = t('openai', 'gpt-5.5');
// The skill records what its provider did on globalThis.__klEgressProbe.
const SKILL_PROBE_SOURCE = `
class Probe {
  getMetadata() { return { id: 'kl-egress-probe', name: 'Egress probe', commands: ['klprobe'], version: '1.0.0' }; }
  async initialize(ctx) { this.ctx = ctx; globalThis.__klEgressProbe = this; }
  async use(p) {
    if (!p) return 'no-provider';
    try { return await p.sendMessage([{ role: 'user', content: 'hi' }], {}); } catch (err) { return 'refused:' + (err.code || err.message); }
  }
  async handleCommand(command, args) {
    const p = this.ctx.llmProvider;
    if (args[0] === 'keep') { this.kept = p; this.last = p ? p.getProviderName() : null; }
    else if (args[0] === 'kept') this.last = await this.use(this.kept);
    else this.last = await this.use(p);
    return { ok: true, message: 'done' };
  }
  async handleMessage(text) {
    this.last = await this.use(this.ctx.llmProvider);
    return { ok: true, message: 'done' };
  }
}
module.exports = Probe;
`;
const LOCAL = t('local', 'workstation/test-model');

describe('the egress policy in the core', () => {
  let box;
  let dataDir;
  let core;
  let ctx;
  const originalFetch = globalThis.fetch;
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  // Every request a hosted provider made: only OpenAI's model list (the
  // connection test, which carries no chat text) is ever answered.
  const fetched = [];
  const sent = () => fetched.filter((f) => f.method !== 'GET');

  before(async () => {
    box = await startFakeLlmServer();
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      fetched.push({ url: String(url), method });
      if (method === 'GET' && /api\.openai\.com\/v1\/models/.test(String(url))) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4-mini' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`no network in unit tests (${method} ${url})`);
    };
    delete process.env.KL_CASES_ROOT;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-egress-core-'));
    // A user skill that uses its context's llmProvider (review fix, item 4a).
    const probeDir = path.join(dataDir, 'skills', 'kl-egress-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'package.json'), JSON.stringify({ name: 'kl-egress-probe', main: 'index.js' }));
    fs.writeFileSync(path.join(probeDir, 'index.js'), SKILL_PROBE_SOURCE);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', {
      models: {
        localServers: [{
          id: 'workstation', name: 'workstation', kind: 'vllm', baseUrl: `${box.url}/vllm`, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
          pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT
        }],
        profiles: [
          { id: 'p-hosted', name: 'Hosted', kind: 'user', roles: { main: [HOSTED], worker: [], utility: [] } },
          { id: 'p-local', name: 'Local', kind: 'user', roles: { main: [LOCAL, HOSTED], worker: [], utility: [] } }
        ],
        defaultProfileId: 'p-hosted'
      }
    });
    core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }
    });
    core.saveProviderToken('openai', 'sk-test-openai-123456');
    await core.start();
    ctx = core.context;
    const chat = (id, extra = {}) => ctx.createChat({ id, title: id, createdAt: AT, updatedAt: AT, messages: [], ...extra });
    chat('chat-open');
    chat('chat-private');
    chat('chat-private-local', { profileId: 'p-local' });
    chat('chat-open-local', { profileId: 'p-local' });
    for (const id of ['chat-private', 'chat-private-local']) {
      assert.strictEqual(ctx.getHistoryStore().markPrivate(id).marked, true);
    }
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    if (core) await core.shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    await box.close();
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  beforeEach(() => { fetched.length = 0; });

  const refusedPrivate = (err) => {
    assert.strictEqual(err.code, 'PRIVATE_NO_LOCAL_MODEL');
    assert.match(err.message, /Nothing was sent to a hosted model\.$/);
    return true;
  };

  describe('review fix, item 4a: a skill\'s llmProvider follows the calling chat\'s policy', () => {
    const { registry: skills } = require('../src/skills/skill-registry');
    const probe = () => globalThis.__klEgressProbe;
    // The hosted provider's connection test, so an ordinary chat's skill has
    // the hosted model to be given (it carries no chat text).
    before(async () => { await ctx.resolveRole('main', { chatId: 'chat-open' }); });
    const run = async (chatId, arg, channel = 'ui') => {
      await skills.executeCommand('klprobe', arg ? [arg] : [], { chatId, channel, userId: chatId });
      return probe().last;
    };

    it('a private chat\'s skill gets no hosted model, and nothing is sent', async () => {
      assert.ok(probe(), 'the probe skill loaded');
      assert.strictEqual(await run('chat-private'), 'no-provider');
      await probe().handleMessage('hi', { chatId: 'chat-private', channel: 'ui' });
      assert.strictEqual(probe().last, 'no-provider');
      assert.strictEqual(await run('no-such-chat'), 'no-provider', 'a chat the store does not know is private');
      assert.deepStrictEqual(sent(), []);
    });

    it('a private chat on a profile with a local model answers from it', async () => {
      const before = box.requests.length;
      assert.strictEqual(await run('chat-private-local'), 'Hello there');
      assert.ok(box.requests.length > before);
      assert.deepStrictEqual(sent(), []);
    });

    it('an ordinary chat keeps the hosted model, as before', async () => {
      assert.strictEqual(await run('chat-open', 'keep'), 'openai');
      assert.strictEqual(await run('42', 'keep', 'telegram'), 'openai', 'a bridge chat is never private');
    });

    it('a provider kept from an ordinary chat is held to a private chat\'s policy when used there', async () => {
      await run('chat-open', 'keep');
      assert.strictEqual(await run('chat-private', 'kept'), 'refused:PRIVATE_NO_LOCAL_MODEL');
      assert.deepStrictEqual(sent(), []);
    });

    it('a call with no known caller is held to a policy while any chat is private', async () => {
      await run('chat-open', 'keep');
      assert.strictEqual(await probe().use(probe().kept), 'refused:PRIVATE_NO_LOCAL_MODEL');
      assert.deepStrictEqual(sent(), []);
    });
  });

  it('a snapshot carries its chat\'s mark: a private chat, an ordinary chat, a chat the store does not know', () => {
    const marked = ctx.snapshotModels({ chatId: 'chat-private' });
    assert.strictEqual(marked.egress.reason, 'private-chat');
    assert.strictEqual(marked.egress.chatId, 'chat-private');
    assert.strictEqual(Object.isFrozen(marked.egress), true);
    assert.strictEqual(ctx.snapshotModels({ chatId: 'chat-open' }).egress, null);
    assert.strictEqual(ctx.snapshotModels({}).egress, null, 'a run that belongs to no chat has no policy');
    const unknown = ctx.snapshotModels({ chatId: 'no-such-chat' });
    assert.strictEqual(unknown.egress.localOnly, true, 'a chat the store does not know is treated as private');
    assert.deepStrictEqual(ctx.egressFor({ chatId: 'chat-private' }), marked.egress);
    assert.strictEqual(ctx.egressFor({ chatId: 'chat-open' }), null);
    assert.strictEqual(ctx.egressFor({}), null);
  });

  it('a mark that cannot be read is an unknown-mark policy, never no policy', () => {
    const historyStore = ctx.getHistoryStore();
    const real = historyStore.isPrivate;
    historyStore.isPrivate = () => { throw new Error('the store is gone'); };
    try {
      assert.strictEqual(ctx.egressFor({ chatId: 'chat-open' }).reason, 'unknown-mark');
      assert.strictEqual(ctx.snapshotModels({ chatId: 'chat-open' }).egress.reason, 'unknown-mark');
    } finally {
      historyStore.isPrivate = real;
    }
    assert.strictEqual(ctx.egressFor({ chatId: 'chat-open' }), null);
  });

  it('a parent\'s policy given to snapshotModels wins over a chat that has none, and nothing given lifts a chat\'s own', () => {
    const parent = ctx.snapshotModels({ chatId: 'chat-private' }).egress;
    assert.strictEqual(ctx.snapshotModels({ chatId: 'chat-open', egress: parent }).egress, parent);
    assert.strictEqual(ctx.snapshotModels({ profileId: 'p-local', egress: parent }).egress, parent);
    assert.strictEqual(ctx.snapshotModels({ chatId: 'chat-private', egress: null }).egress.reason, 'private-chat');
  });

  it('R-LI-22: the turn is refused before any call', async () => {
    await assert.rejects(ctx.resolveRole('main', { chatId: 'chat-private' }), refusedPrivate);
    await assert.rejects(ctx.resolveRole('utility', { chatId: 'chat-private' }), refusedPrivate);
    assert.deepStrictEqual(fetched, [], 'not even a connection test went to the hosted provider');
    // The same role in an ordinary chat resolves to the hosted model.
    const open = await ctx.resolveRole('main', { chatId: 'chat-open' });
    assert.deepStrictEqual(open.targets, [HOSTED]);
    assert.strictEqual(open.egress, null);
    assert.strictEqual(open.provider.routed, undefined, 'with no policy the first target\'s own instance is handed out, as before');
    assert.deepStrictEqual(sent(), []);
  });

  it('under a policy resolveRole filters to the local model and hands out the routed provider', async () => {
    const before = box.requests.length;
    const resolved = await ctx.resolveRole('main', { chatId: 'chat-private-local' });
    assert.deepStrictEqual(resolved.targets, [LOCAL]);
    assert.deepStrictEqual(resolved.skipped.map((s) => s.target), [HOSTED]);
    assert.strictEqual(resolved.egress.reason, 'private-chat');
    assert.strictEqual(resolved.provider.routed, true);
    assert.strictEqual(resolved.provider, resolved.routed);
    assert.strictEqual(await resolved.provider.sendMessage(HI, {}), 'Hello there');
    assert.ok(box.requests.length > before);
    assert.deepStrictEqual(fetched, []);
    // The same profile in an ordinary chat keeps both targets.
    assert.deepStrictEqual((await ctx.resolveRole('main', { chatId: 'chat-open-local' })).targets, [LOCAL, HOSTED]);
  });

  it('R-LI-8: a hosted provider refuses under a policy', async () => {
    // A caller that got a hosted instance some other way and still passes the turn's policy.
    const open = await ctx.resolveRole('main', { chatId: 'chat-open' });
    const policy = ctx.snapshotModels({ chatId: 'chat-private' }).egress;
    await assert.rejects(open.provider.sendMessage(HI, { model: 'gpt-5.5', egress: policy }), (err) => err.code === 'PRIVATE_HOSTED_CALL');
    // And a hosted list handed to the core's router under the policy.
    await assert.rejects(
      ctx.routedProvider({ targets: [HOSTED], meta: { role: 'main' }, egress: policy }).sendMessage(HI, {}),
      (err) => err.code === 'PRIVATE_HOSTED_TARGET'
    );
    assert.deepStrictEqual(sent(), []);
  });

  it('a child of a private turn is private', async () => {
    const adapter = ctx.getAgentExecutorAdapter();
    const agent = ctx.getAgent('code-explorer');
    assert.ok(agent);
    const requester = async () => ({ approved: false });
    requester.turnModels = ctx.snapshotModels({ chatId: 'chat-private-local' });
    // Naming a hosted-only profile for the child does not drop the parent's policy.
    await assert.rejects(adapter.execute(agent, 'Look around.', { approvalRequester: requester, profileId: 'p-hosted' }), refusedPrivate);
    // Nor does a model named for it.
    await assert.rejects(
      adapter.execute(agent, 'Look around.', { approvalRequester: requester, provider: 'openai', model: 'gpt-5.5' }),
      refusedPrivate
    );
    assert.deepStrictEqual(fetched, []);
    const runtime = await ctx.createAgentRuntime({ role: 'worker', profileId: 'p-local' }, null, requester, { turnModels: requester.turnModels });
    assert.strictEqual(runtime.turnModels.egress, requester.turnModels.egress);
    assert.deepStrictEqual(runtime.targets, [LOCAL]);
    assert.strictEqual(runtime.provider.routed, true);
    assert.deepStrictEqual(sent(), []);
  });

  it('a run with a chat id and no parent takes the chat\'s policy', async () => {
    await assert.rejects(ctx.createAgentRuntime({ role: 'worker' }, null, null, { chatId: 'chat-private' }), refusedPrivate);
    await assert.rejects(ctx.createAgentRuntime({ role: 'worker', profileId: 'p-hosted' }, null, null, { chatId: 'chat-private-local' }), refusedPrivate);
    await assert.rejects(ctx.createAgentRuntime({ role: 'worker' }, null, null, { chatId: 'no-such-chat' }), refusedPrivate);
    const adapter = ctx.getAgentExecutorAdapter();
    await assert.rejects(
      adapter.execute(ctx.getAgent('code-explorer'), 'Look around.', { executorOptions: { chatId: 'chat-private' } }),
      refusedPrivate
    );
    assert.deepStrictEqual(fetched, []);
    const local = await ctx.createAgentRuntime({ role: 'worker', profileId: 'p-local' }, null, null, { chatId: 'chat-private' });
    assert.strictEqual(local.turnModels.egress.reason, 'private-chat');
    assert.deepStrictEqual(local.targets, [LOCAL]);
    // An ordinary chat's run, and a run with no chat, are as before.
    const open = await ctx.createAgentRuntime({ role: 'worker' }, null, null, { chatId: 'chat-open' });
    assert.strictEqual(open.turnModels.egress, null);
    assert.deepStrictEqual(open.targets, [HOSTED]);
    assert.strictEqual((await ctx.createAgentRuntime({ role: 'worker' })).turnModels.egress, null);
    assert.deepStrictEqual(sent(), []);
  });

  it('a fleet delegate turn\'s job id is not a chat, unless a chat has it', async () => {
    // src/fleet/delegate-sessions.js runs each turn with chatId "delegate:<job>".
    const job = await ctx.createAgentRuntime({ role: 'worker' }, null, null, { chatId: 'delegate:job-1' });
    assert.strictEqual(job.turnModels.egress, null);
    assert.deepStrictEqual(job.targets, [HOSTED]);
    ctx.createChat({ id: 'delegate:real-chat', title: 'x', createdAt: AT, updatedAt: AT, messages: [] });
    ctx.getHistoryStore().markPrivate('delegate:real-chat');
    await assert.rejects(ctx.createAgentRuntime({ role: 'worker' }, null, null, { chatId: 'delegate:real-chat' }), refusedPrivate);
    // A store that cannot be read gives the job id a policy too.
    const historyStore = ctx.getHistoryStore();
    const real = historyStore.chatRef;
    historyStore.chatRef = () => { throw new Error('the store is gone'); };
    try {
      await assert.rejects(ctx.createAgentRuntime({ role: 'worker' }, null, null, { chatId: 'delegate:job-1' }), refusedPrivate);
    } finally {
      historyStore.chatRef = real;
    }
    assert.deepStrictEqual(sent(), []);
  });

  it('a workflow started in a private chat sends nothing: its tasks are refused', async () => {
    const engine = ctx.getWorkflowEngine();
    const graph = (goal) => ({
      goal, summary: 's', parallelGroups: [], estimatedTotalSteps: 1,
      tasks: [{ id: 't1', title: 'Task 1', description: 'Check the fence line', agentId: 'code-explorer', dependsOn: [], priority: 1 }]
    });
    const failures = [];
    const onFailed = (data) => failures.push(data);
    engine.on('workflow:failed', onFailed);
    const run = async (chatId) => {
      const wf = await engine.create(graph('Fence'), { chatId });
      await engine.run(wf.id).catch(() => {});
      await engine._saveMutex.run(wf.id, async () => {});
      return engine.workflows.get(wf.id);
    };
    try {
      for (const chatId of ['chat-private', 'chat-private-local', 'no-such-chat']) {
        const done = await run(chatId);
        assert.notStrictEqual(done.status, 'completed', `${chatId}: the workflow did not run`);
        assert.notStrictEqual(done.tasks[0].status, 'completed');
        assert.match(failures.at(-1).error, /this chat is private/, chatId);
        assert.match(failures.at(-1).error, /Nothing was sent to a hosted model/);
      }
      assert.strictEqual(failures.length, 3);
      assert.deepStrictEqual(fetched, [], 'nothing went to a hosted model, not even a connection test');
      // The same workflow from an ordinary chat does reach for the hosted
      // model (the stub refuses the request), so the check above is not
      // looking at a path that never calls anything.
      await run('chat-open');
      assert.ok(sent().some((f) => /api\.openai\.com/.test(f.url)), 'an ordinary chat\'s workflow task called its model');
    } finally {
      engine.off('workflow:failed', onFailed);
    }
  });
});

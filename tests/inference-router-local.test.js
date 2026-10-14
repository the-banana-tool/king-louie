// tests/inference-router-local.test.js
// The router with local targets (spec 2026-10-13-local-inference-design.md
// §5.1, §9.3; R-LI-12): one provider key, one instance per server, and a
// local server that does not answer is left at once, with no retry and no
// wait. Local servers here are fake servers on 127.0.0.1; a server that is
// "down" is a port nothing listens on.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const InferenceRouter = require('../src/providers/inference-router');
const ProviderFactory = require('../src/providers/provider-factory');
const { classifyError, FailoverReason, RecoveryAction } = require('../src/providers/error-classifier');
const { FailoverPolicy, DEFAULT_BUDGETS } = require('../src/providers/failover-policy');
const { LocalServers } = require('../src/models/local-servers');
const { LocalTransportError } = require('../src/models/local-transport');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const HI = [{ role: 'user', content: 'hi' }];
const t = (provider, model, effort = null) => ({ provider, model, effort });

async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const serverEntry = (id, baseUrl) => ({
  id, name: id, kind: 'vllm', baseUrl, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
  pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT
});

describe('classifyError and FailoverPolicy: LOCAL_UNREACHABLE', () => {
  const unreachable = () => new LocalTransportError('LOCAL_UNREACHABLE', '127.0.0.1:9 did not answer (ECONNREFUSED).', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
  });

  it('is its own reason, and the answer is another model, not a retry', () => {
    const c = classifyError(unreachable(), { provider: 'local' });
    assert.strictEqual(FailoverReason.LOCAL_UNREACHABLE, 'local_unreachable');
    assert.strictEqual(c.reason, FailoverReason.LOCAL_UNREACHABLE);
    assert.strictEqual(c.action, RecoveryAction.FALLBACK_MODEL);
    assert.strictEqual(c.retryable, false);
  });

  it('is read through one wrapping error', () => {
    const wrapped = new Error('the call failed', { cause: unreachable() });
    assert.strictEqual(classifyError(wrapped).reason, FailoverReason.LOCAL_UNREACHABLE);
  });

  it('a hosted provider\'s refused connection is still a timeout that is retried', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const c = classifyError(err, { provider: 'openai' });
    assert.strictEqual(c.reason, FailoverReason.TIMEOUT);
    assert.strictEqual(c.action, RecoveryAction.RETRY);
  });

  it('a stopped call is still a stopped call', () => {
    const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', cause: unreachable() });
    assert.strictEqual(classifyError(aborted).reason, FailoverReason.ABORTED);
  });

  it('the policy escalates on the first failure, with no wait', () => {
    assert.strictEqual(DEFAULT_BUDGETS[FailoverReason.LOCAL_UNREACHABLE].attempts, 0);
    const plan = new FailoverPolicy().plan(unreachable(), { totalAttempts: 1, attemptsByReason: {}, provider: 'local', model: 'workstation/m' });
    assert.strictEqual(plan.action, RecoveryAction.FALLBACK_MODEL);
    assert.strictEqual(plan.reason, FailoverReason.LOCAL_UNREACHABLE);
    assert.strictEqual(plan.waitMs, 0);
  });
});

describe('InferenceRouter with local targets', () => {
  let hosted;
  let boxA;
  let boxB;
  let downPort;
  const catalog = fixtureCatalog();
  const open = [];

  before(async () => {
    hosted = await startFakeLlmServer();
    boxA = await startFakeLlmServer();
    boxB = await startFakeLlmServer();
    downPort = await closedPort();
  });
  after(async () => {
    for (const servers of open) servers.close();
    await Promise.all([hosted.close(), boxA.close(), boxB.close()]);
  });

  function harness(entries) {
    const servers = new LocalServers({ getEntries: () => entries, catalog });
    open.push(servers);
    const sleeps = [];
    const created = [];
    const tokensAsked = [];
    const router = new InferenceRouter({
      getProviderToken: (p) => { tokensAsked.push(p); return p === 'local' ? null : 'test-key-123456'; },
      createProvider: (provider, token, target) => {
        created.push({ provider, token, target });
        if (provider === 'local') return servers.providerFor(servers.splitModel(target.model).serverId);
        return ProviderFactory.create(provider, token, { catalog, baseUrl: `${hosted.url}/${provider}/v1` });
      },
      sleep: async (ms) => { sleeps.push(ms); }
    });
    return { router, servers, sleeps, created, tokensAsked };
  }

  it('two local targets on two servers get two instances, keyed by server', async () => {
    const { router, created } = harness([serverEntry('box-a', `http://127.0.0.1:${downPort}`), serverEntry('box-b', `${boxB.url}/vllm`)]);
    const state = router.newRouteState();
    const list = [t('local', 'box-a/test-model'), t('local', 'box-b/test-model'), t('local', 'box-b/other-model')];
    const text = await router.routeTargets(list, HI, {}, state);
    assert.strictEqual(text, 'Hello there');
    assert.deepStrictEqual([...state.instances.keys()], ['local:box-a', 'local:box-b']);
    assert.notStrictEqual(state.instances.get('local:box-a'), state.instances.get('local:box-b'));
    assert.deepStrictEqual(created.map((c) => c.target.model), ['box-a/test-model', 'box-b/test-model']);
    // Another model on the same server uses the same instance.
    state.index = 2;
    await router.routeTargets(list, HI, {}, state);
    assert.strictEqual(created.length, 2);
    const last = [...boxB.requests].reverse().find((r) => r.method === 'POST');
    assert.strictEqual(last.body.model, 'other-model');
  });

  it('a hosted provider is still keyed by its provider, and is handed the target too', async () => {
    const { router, created } = harness([]);
    const state = router.newRouteState();
    await router.routeTargets([t('openai', 'gpt-5.5')], HI, {}, state);
    await router.routeTargets([t('openai', 'gpt-5.4-mini')], HI, {}, state);
    assert.deepStrictEqual([...state.instances.keys()], ['openai']);
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(created[0].target, t('openai', 'gpt-5.5'));
  });

  it('R-LI-12: an unreachable local server fails over at once', async () => {
    const { router, sleeps } = harness([serverEntry('workstation', `http://127.0.0.1:${downPort}`)]);
    const sentBefore = hosted.requests.length;
    const started = Date.now();
    const res = await router.routeTargets(
      [t('local', 'workstation/test-model'), t('openai', 'gpt-5.5')],
      HI,
      { tools: [{ name: 'Lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } }] },
      router.newRouteState({ role: 'utility', profileId: 'p-1' })
    );
    assert.strictEqual(res.type, 'tool_use', 'the hosted fake answered');
    assert.strictEqual(res.llmMetrics.provider, 'openai');
    assert.strictEqual(res.llmMetrics.failover, true);
    assert.strictEqual('local' in res.llmMetrics, false);
    assert.deepStrictEqual(sleeps, [], 'the router never waited');
    assert.strictEqual(hosted.requests.length, sentBefore + 1);
    assert.ok(Date.now() - started < 5000);
  });

  it('with nothing else in the list, the unreachable error is the one thrown', async () => {
    const { router, sleeps } = harness([serverEntry('workstation', `http://127.0.0.1:${downPort}`)]);
    await assert.rejects(router.routeTargets([t('local', 'workstation/test-model')], HI), (err) => err.code === 'LOCAL_UNREACHABLE');
    assert.deepStrictEqual(sleeps, []);
  });

  it('a server that is not configured is skipped for the next target', async () => {
    const { router, sleeps } = harness([serverEntry('box-b', `${boxB.url}/vllm`)]);
    const text = await router.routeTargets([t('local', 'gone/test-model'), t('local', 'box-b/test-model')], HI);
    assert.strictEqual(text, 'Hello there');
    assert.deepStrictEqual(sleeps, []);
    await assert.rejects(router.routeTargets([t('local', 'gone/test-model')], HI), (err) => err.code === 'LOCAL_SERVER_UNKNOWN');
  });

  it('after a first answer from a local server, failover to the second local server is allowed and to openai is FAILOVER_BLOCKED', async () => {
    const flaky = await startFakeLlmServer();
    const { router, sleeps } = harness([serverEntry('box-a', `${flaky.url}/vllm`), serverEntry('box-b', `${boxB.url}/vllm`)]);
    const toB = router.newRouteState();
    const toHosted = router.newRouteState();
    const listB = [t('local', 'box-a/test-model'), t('openai', 'gpt-5.5'), t('local', 'box-b/test-model')];
    const listHosted = [t('local', 'box-a/test-model'), t('openai', 'gpt-5.5')];
    assert.strictEqual(await router.routeTargets(listB, HI, {}, toB), 'Hello there');
    assert.strictEqual(await router.routeTargets(listHosted, HI, {}, toHosted), 'Hello there');
    const flakyRequests = flaky.requests.length;
    await flaky.close(); // box-a goes away mid-turn

    const bBefore = boxB.requests.length;
    const hostedBefore = hosted.requests.length;
    assert.strictEqual(await router.routeTargets(listB, HI, {}, toB), 'Hello there');
    assert.strictEqual(boxB.requests.length, bBefore + 1, 'the second local server answered');
    assert.strictEqual(toB.index, 2);

    await assert.rejects(router.routeTargets(listHosted, HI, {}, toHosted), (err) => {
      assert.strictEqual(err.code, 'FAILOVER_BLOCKED');
      assert.strictEqual(err.cause.code, 'LOCAL_UNREACHABLE');
      return true;
    });
    assert.strictEqual(hosted.requests.length, hostedBefore, 'nothing went to the hosted model mid-turn');
    assert.strictEqual(flaky.requests.length, flakyRequests);
    assert.deepStrictEqual(sleeps, []);
  });

  it('a key one local server rejects does not skip another local server', async () => {
    const calls = [];
    const auth = () => Object.assign(new Error('Invalid API Key'), { status: 401 });
    const reported = [];
    const router = new InferenceRouter({
      getProviderToken: () => null,
      createProvider: (provider, _token, target) => {
        const serverId = target.model.split('/')[0];
        return {
          async sendMessage(_messages, opts) {
            calls.push(opts.model);
            if (serverId === 'box-a') throw auth();
            return `${provider}/${opts.model}`;
          }
        };
      },
      onProviderError: (p) => reported.push(p),
      sleep: async () => {}
    });
    const res = await router.routeTargets([t('local', 'box-a/m1'), t('local', 'box-a/m2'), t('local', 'box-b/m1')], HI);
    assert.strictEqual(res, 'local/box-b/m1');
    assert.deepStrictEqual(calls, ['box-a/m1', 'box-b/m1'], 'the rejected server\'s other model is skipped, the other server is not');
    assert.deepStrictEqual(reported, ['local']);
  });

  it('the routed provider names the local target it is on', async () => {
    const { router } = harness([serverEntry('box-b', `${boxB.url}/vllm`)]);
    const routed = router.routedProvider({ targets: [t('local', 'box-b/hf.co/org/name:tag')], meta: { role: 'utility', profileId: 'p-1' } });
    assert.strictEqual(routed.getProviderName(), 'local');
    assert.strictEqual(routed.getDefaultModel(), 'box-b/hf.co/org/name:tag');
    const res = await routed.sendMessageWithTools(HI, [{ name: 'Lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } }], {});
    assert.strictEqual(res.llmMetrics.model, 'box-b/hf.co/org/name:tag');
    assert.deepStrictEqual(res.llmMetrics.local, { server: 'box-b', class: 'loopback' });
    assert.strictEqual(res.llmMetrics.costUsd, 0);
    assert.strictEqual(res.llmMetrics.role, 'utility');
  });
});

describe('local servers in the core', () => {
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createCore } = require('../src/core');
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const { createAesGcmCipher } = require('../src/platform/cipher');
  const { createHeadlessPrompter } = require('../src/platform/prompter');
  const { setActiveCatalog } = require('../src/models');
  const { profileSettings } = require('./helpers/profile-settings');
  const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
  const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');

  let box;
  let dataDir;
  let core;
  const originalFetch = globalThis.fetch;
  const fetched = [];

  before(async () => {
    box = await startFakeLlmServer();
    globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error(`no network in unit tests (${url})`); };
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-local-core-'));
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    store.set('settings', profileSettings(
      { models: { localServers: [{ ...serverEntry('workstation', `${box.url}/ollama`), kind: 'ollama' }] } },
      { main: [t('local', 'workstation/test-model')], utility: [t('local', 'workstation/test-model'), t('local', 'gone/test-model')] }
    ));
    store.set('apiTokens', { __local_workstation: cipher.encryptString('key-for-workstation') });
    core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher,
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }
    });
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    if (core) await core.shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    await box.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the stored server and explains its models from the registry', () => {
    const servers = core.context.getLocalServers();
    const [row] = servers.list();
    assert.strictEqual(row.usable, true);
    assert.strictEqual(row.grade, 'guarantee');
    assert.strictEqual(core.context.explainTarget('local', 'workstation/test-model').usable, true);
    assert.strictEqual(core.context.explainTarget('local', 'gone/test-model').code, 'LOCAL_SERVER_UNKNOWN');
    assert.strictEqual(core.context.explainTarget('LOCAL', 'workstation/qwen3:cloud').code, 'LOCAL_CLOUD_MODEL');
    // The built-in ollama provider is still Availability's to explain (R-LI-31).
    assert.strictEqual('code' in core.context.explainTarget('ollama', 'test-model'), false);
  });

  it('resolveRole gives the server\'s own provider instance and a routed provider over it', async () => {
    const resolved = await core.context.resolveRole('utility');
    assert.deepStrictEqual(resolved.targets, [t('local', 'workstation/test-model')]);
    assert.deepStrictEqual(resolved.skipped.map((s) => s.target.model), ['gone/test-model']);
    assert.strictEqual(resolved.providerType, 'local');
    assert.strictEqual(resolved.provider, core.context.getLocalServers().providerFor('workstation'));
    assert.strictEqual(await resolved.routed.sendMessage(HI, {}), 'Hello there');
    const req = [...box.requests].reverse().find((r) => r.method === 'POST');
    assert.strictEqual(req.path, '/ollama/v1/chat/completions');
    assert.strictEqual(req.body.model, 'test-model');
    assert.strictEqual(req.headers.authorization, 'Bearer key-for-workstation');
    assert.deepStrictEqual(fetched, [], 'nothing went through the global fetch');
  });

  it('prices the server\'s models at $0 in the core\'s catalog, and no other local id', () => {
    assert.strictEqual(core.models.catalog.price('local', 'workstation/test-model', { input: 1000, output: 10 }).usd, 0);
    assert.strictEqual(core.models.catalog.price('local', 'gone/test-model', { input: 1000, output: 10 }), null);
  });

  it('shutdown closes the transports', async () => {
    const transport = core.context.getLocalServers().transportFor('workstation');
    await core.shutdown();
    core = null;
    await assert.rejects(transport.fetch(`${box.url}/ollama/v1/models`), (err) => err.code === 'LOCAL_TRANSPORT_CLOSED');
  });
});

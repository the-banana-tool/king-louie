// tests/egress-router.test.js
// The egress policy in the router and in every provider (spec
// 2026-10-13-local-inference-design.md §7.2 items 2 to 4, §9.3; R-LI-8,
// R-LI-12): under a policy a target that is not a guarantee-grade local
// model is never sent to, the route never moves to one, and a provider that
// has no pinned transport refuses to send. Local servers here are fake
// servers on 127.0.0.1; a server that is "down" is a port nothing listens on.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const InferenceRouter = require('../src/providers/inference-router');
const ProviderFactory = require('../src/providers/provider-factory');
const LocalServerProvider = require('../src/providers/local-server-provider');
const { LocalServers } = require('../src/models/local-servers');
const { egressPolicy } = require('../src/models/egress');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const HI = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ name: 'Lookup', description: 'Look up.', parameters: { type: 'object', properties: {} } }];
const t = (provider, model, effort = null) => ({ provider, model, effort });
const PRIVATE = egressPolicy({ reason: 'private-chat', chatId: 'chat-1' });

async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const serverEntry = (id, baseUrl, pinned = { addresses: ['127.0.0.1'], class: 'loopback', at: AT }) => ({
  id, name: id, kind: 'vllm', baseUrl, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
  pinned, markedLocalAt: AT
});

describe('the egress policy in the router', () => {
  let hosted;
  let box;
  let downPort;
  const catalog = fixtureCatalog();
  const open = [];
  const originalFetch = globalThis.fetch;
  const fetched = [];

  before(async () => {
    hosted = await startFakeLlmServer();
    box = await startFakeLlmServer();
    downPort = await closedPort();
    // Every hosted provider sends through the global fetch: what it is
    // asked for is recorded, and only the hosted fake is ever reached.
    globalThis.fetch = async (url, init) => {
      fetched.push(String(url));
      if (!String(url).startsWith(hosted.url)) throw new Error(`no network in unit tests (${url})`);
      return originalFetch(url, init);
    };
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    for (const servers of open) servers.close();
    await Promise.all([hosted.close(), box.close()]);
  });
  beforeEach(() => { fetched.length = 0; });

  function harness(entries, { guarantee = true } = {}) {
    const servers = new LocalServers({ getEntries: () => entries, catalog });
    open.push(servers);
    const sleeps = [];
    const created = [];
    const router = new InferenceRouter({
      getProviderToken: (p) => (p === 'local' ? null : 'test-key-123456'),
      createProvider: (provider, token, target) => {
        created.push(target);
        if (provider === 'local') return servers.providerFor(servers.splitModel(target.model).serverId);
        return ProviderFactory.create(provider, token, { catalog, baseUrl: `${hosted.url}/${provider}/v1` });
      },
      ...(guarantee ? { isGuaranteeTarget: (target) => servers.isGuaranteeTarget(target) } : {}),
      sleep: async (ms) => { sleeps.push(ms); }
    });
    return { router, servers, sleeps, created };
  }

  const up = () => serverEntry('workstation', `${box.url}/vllm`);
  const down = () => serverEntry('sleeper', `http://127.0.0.1:${downPort}`);
  // A LAN server over plain http: for cost only (R-LI-30). Never dialled here.
  const lan = () => serverEntry('lan-box', 'http://192.168.1.20:8000', { addresses: ['192.168.1.20'], class: 'lan', at: AT });

  it('R-LI-8: a hosted target under a policy never reaches fetch', async () => {
    const { router, created } = harness([down()]);
    await assert.rejects(router.routeTargets([t('openai', 'gpt-5.5')], HI, {}, router.newRouteState(null, PRIVATE)), (err) => {
      assert.strictEqual(err.code, 'PRIVATE_HOSTED_TARGET');
      assert.match(err.message, /openai\/gpt-5\.5/);
      assert.match(err.message, /Nothing was sent to a hosted model\.$/);
      return true;
    });
    assert.deepStrictEqual(created, [], 'no provider instance was built for it');

    await assert.rejects(
      router.routeTargets([t('local', 'sleeper/test-model'), t('openai', 'gpt-5.5')], HI, {}, router.newRouteState(null, PRIVATE)),
      (err) => err.code === 'LOCAL_MODEL_UNAVAILABLE'
    );
    assert.deepStrictEqual(fetched, []);
    assert.strictEqual(hosted.requests.length, 0);
  });

  it('R-LI-8: a hosted target first in the list stops the route; it does not move on to the local one', async () => {
    const { router } = harness([up()]);
    const before = box.requests.length;
    await assert.rejects(
      router.routeTargets([t('openai', 'gpt-5.5'), t('local', 'workstation/test-model')], HI, {}, router.newRouteState(null, PRIVATE)),
      (err) => err.code === 'PRIVATE_HOSTED_TARGET'
    );
    assert.strictEqual(box.requests.length, before);
    assert.deepStrictEqual(fetched, []);
  });

  it('R-LI-8: the built-in ollama provider is a hosted target under a policy (R-LI-31)', async () => {
    const { router } = harness([up()]);
    await assert.rejects(
      router.routeTargets([t('ollama', 'test-model')], HI, {}, router.newRouteState(null, PRIVATE)),
      (err) => err.code === 'PRIVATE_HOSTED_TARGET'
    );
    assert.deepStrictEqual(fetched, []);
  });

  it('R-LI-30: a cost-only local target under a policy is refused PRIVATE_HOSTED_TARGET, with the registry\'s sentence', async () => {
    const { router, created } = harness([lan()]);
    await assert.rejects(router.routeTargets([t('local', 'lan-box/test-model')], HI, {}, router.newRouteState(null, PRIVATE)), (err) => {
      assert.strictEqual(err.code, 'PRIVATE_HOSTED_TARGET');
      assert.match(err.message, /plain http on your network/);
      return true;
    });
    assert.deepStrictEqual(created, []);
  });

  it('a local server nobody configured, and a router with no registry, refuse every target under a policy', async () => {
    const { router } = harness([up()]);
    await assert.rejects(
      router.routeTargets([t('local', 'gone/test-model')], HI, {}, router.newRouteState(null, PRIVATE)),
      (err) => err.code === 'PRIVATE_HOSTED_TARGET'
    );
    const blind = harness([up()], { guarantee: false });
    const before = box.requests.length;
    await assert.rejects(
      blind.router.routeTargets([t('local', 'workstation/test-model')], HI, {}, blind.router.newRouteState(null, PRIVATE)),
      (err) => err.code === 'PRIVATE_HOSTED_TARGET'
    );
    assert.strictEqual(box.requests.length, before, 'a target nobody vouched for is not sent to');
  });

  it('R-LI-12: under a policy the call fails LOCAL_MODEL_UNAVAILABLE and no hosted request is made', async () => {
    const { router, sleeps } = harness([down()]);
    const list = [t('local', 'sleeper/test-model'), t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')];
    await assert.rejects(router.routeTargets(list, HI, { tools: TOOLS }, router.newRouteState({ role: 'main', profileId: 'p-1' }, PRIVATE)), (err) => {
      assert.strictEqual(err.code, 'LOCAL_MODEL_UNAVAILABLE');
      assert.match(err.message, /sleeper/);
      assert.match(err.message, /so nothing was sent to a hosted model\.$/);
      assert.strictEqual(err.cause.code, 'LOCAL_UNREACHABLE');
      return true;
    });
    assert.deepStrictEqual(fetched, []);
    assert.strictEqual(hosted.requests.length, 0);
    assert.deepStrictEqual(sleeps, []);
  });

  it('R-LI-12: without a policy the same list fails over to the hosted model', async () => {
    const { router } = harness([down()]);
    const res = await router.routeTargets(
      [t('local', 'sleeper/test-model'), t('openai', 'gpt-5.5')], HI, { tools: TOOLS }, router.newRouteState({ role: 'main', profileId: 'p-1' })
    );
    assert.strictEqual(res.llmMetrics.provider, 'openai');
    assert.strictEqual(res.llmMetrics.failover, true);
    assert.strictEqual(fetched.length, 1);
  });

  it('under a policy a route fails over to another guarantee target, and only to one', async () => {
    const { router } = harness([down(), up(), lan()]);
    const list = [t('local', 'sleeper/test-model'), t('openai', 'gpt-5.5'), t('local', 'lan-box/test-model'), t('local', 'workstation/test-model')];
    const state = router.newRouteState({ role: 'main', profileId: 'p-1' }, PRIVATE);
    const res = await router.routeTargets(list, HI, { tools: TOOLS }, state);
    assert.strictEqual(res.llmMetrics.model, 'workstation/test-model');
    assert.strictEqual(res.llmMetrics.failover, true);
    assert.strictEqual(state.index, 3);
    assert.deepStrictEqual(fetched, []);
  });

  it('the provider receives options.egress, and only under a policy', async () => {
    const seen = [];
    const router = new InferenceRouter({
      getProviderToken: () => null,
      createProvider: () => ({ async sendMessage(_messages, opts) { seen.push(opts.egress); return 'ok'; } }),
      isGuaranteeTarget: () => true,
      sleep: async () => {}
    });
    await router.routeTargets([t('local', 'workstation/m')], HI, {}, router.newRouteState(null, PRIVATE));
    await router.routedProvider({ targets: [t('local', 'workstation/m')], egress: PRIVATE }).sendMessage(HI, {});
    await router.routeTargets([t('local', 'workstation/m')], HI, {}, router.newRouteState());
    assert.deepStrictEqual(seen, [PRIVATE, PRIVATE, undefined]);
  });

  it('a caller\'s own options cannot lift the route\'s policy, and a policy in the options alone is honoured', async () => {
    const { router } = harness([up()]);
    for (const lifted of [null, false, undefined]) {
      await assert.rejects(
        router.routeTargets([t('openai', 'gpt-5.5')], HI, { egress: lifted }, router.newRouteState(null, PRIVATE)),
        (err) => err.code === 'PRIVATE_HOSTED_TARGET'
      );
    }
    await assert.rejects(
      router.routeTargets([t('openai', 'gpt-5.5')], HI, { egress: PRIVATE }, router.newRouteState()),
      (err) => err.code === 'PRIVATE_HOSTED_TARGET'
    );
    assert.deepStrictEqual(fetched, []);
  });

  it('a policy that cannot be read is a policy', async () => {
    const { router } = harness([up()]);
    for (const odd of [true, 'private', {}, { localOnly: false }]) {
      await assert.rejects(
        router.routeTargets([t('openai', 'gpt-5.5')], HI, {}, router.newRouteState(null, odd)),
        (err) => err.code === 'PRIVATE_HOSTED_TARGET'
      );
      await assert.rejects(
        router.routedProvider({ targets: [t('openai', 'gpt-5.5')], egress: odd }).sendMessage(HI, {}),
        (err) => err.code === 'PRIVATE_HOSTED_TARGET'
      );
    }
    assert.deepStrictEqual(fetched, []);
  });

  it('a routed provider under a policy answers from the local server and marks the call local', async () => {
    const { router } = harness([up()]);
    const routed = router.routedProvider({ targets: [t('local', 'workstation/test-model')], meta: { role: 'main', profileId: 'p-1' }, egress: PRIVATE });
    const res = await routed.sendMessageWithTools(HI, TOOLS, {});
    assert.deepStrictEqual(res.llmMetrics.local, { server: 'workstation', class: 'loopback' });
    assert.deepStrictEqual(fetched, []);
  });
});

describe('a provider under a policy', () => {
  const catalog = fixtureCatalog();
  const originalFetch = globalThis.fetch;
  const fetched = [];
  const PRIVATE_CASE = egressPolicy({ reason: 'private-case', caseId: 'case-1' });

  before(() => {
    globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error(`no network in unit tests (${url})`); };
  });
  after(() => { globalThis.fetch = originalFetch; });

  it('R-LI-8: every hosted provider refuses PRIVATE_HOSTED_CALL before any fetch, on every kind of call', async () => {
    const providers = ProviderFactory.listRegistered();
    assert.ok(providers.length >= 14);
    const refused = (err) => {
      assert.strictEqual(err.code, 'PRIVATE_HOSTED_CALL');
      assert.match(err.message, /Nothing was sent\.$/);
      return true;
    };
    for (const name of providers) {
      const instance = ProviderFactory.create(name, 'test-key-123456', { catalog });
      for (const options of [{ model: 'm', egress: PRIVATE }, { model: 'm', egress: PRIVATE_CASE }, { model: 'm', egress: true }]) {
        await assert.rejects(instance.sendMessage(HI, options), refused, `${name} sendMessage`);
        await assert.rejects(instance.streamMessage(HI, options, () => {}), refused, `${name} streamMessage`);
        if (typeof instance.sendMessageWithTools === 'function') await assert.rejects(instance.sendMessageWithTools(HI, TOOLS, options), refused, `${name} sendMessageWithTools`);
        if (typeof instance.streamMessageWithTools === 'function') await assert.rejects(instance.streamMessageWithTools(HI, TOOLS, options, () => {}), refused, `${name} streamMessageWithTools`);
      }
    }
    assert.deepStrictEqual(fetched, []);
  });

  it('a local server\'s provider sends under a policy only over a guarantee-grade transport', async () => {
    const sent = [];
    const transport = (grade) => ({
      grade,
      addressClass: grade === 'guarantee' ? 'loopback' : 'lan',
      fetch: async (url) => { sent.push(String(url)); throw Object.assign(new Error('stop here'), { code: 'TEST_STOP' }); }
    });
    const provider = (grade) => new LocalServerProvider(null, { baseUrl: 'http://127.0.0.1:9/v1', transport: transport(grade), serverId: 'workstation', kind: 'vllm', catalog });
    await assert.rejects(provider('cost-only').sendMessage(HI, { model: 'workstation/m', egress: PRIVATE }), (err) => err.code === 'PRIVATE_HOSTED_CALL');
    await assert.rejects(provider(undefined).sendMessage(HI, { model: 'workstation/m', egress: PRIVATE }), (err) => err.code === 'PRIVATE_HOSTED_CALL');
    assert.deepStrictEqual(sent, [], 'nothing was sent over a transport the guarantee does not accept');
    await assert.rejects(provider('guarantee').sendMessage(HI, { model: 'workstation/m', egress: PRIVATE }), (err) => err.code === 'TEST_STOP');
    await assert.rejects(provider('cost-only').sendMessage(HI, { model: 'workstation/m' }), (err) => err.code === 'TEST_STOP');
    assert.strictEqual(sent.length, 2);
  });
});

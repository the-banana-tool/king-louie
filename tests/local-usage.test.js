// tests/local-usage.test.js
// Usage and cost of local calls (spec 2026-10-13-local-inference-design.md
// §9; R-LI-12, R-LI-13): a call the local server provider made is counted
// as local, free and never unpriced, in a reply's totals and in the usage
// tracker. Nothing else becomes local or $0: an Ollama call stays $0 and not
// local, an unknown hosted model stays unpriced. A failover away from a
// local model names it, and a server that reports no usage is estimated.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { sumLlmCalls, costByRole, summarizeTurnLlm } = require('../src/tracking/llm-totals');
const UsageTracker = require('../src/tracking/usage-tracker');
const InferenceRouter = require('../src/providers/inference-router');
const ProviderFactory = require('../src/providers/provider-factory');
const LocalServerProvider = require('../src/providers/local-server-provider');
const OllamaProvider = require('../src/providers/ollama-provider');
const OpenAIProvider = require('../src/providers/openai-provider');
const { LocalServers } = require('../src/models/local-servers');
const { createLocalTransport } = require('../src/models/local-transport');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const HI = [{ role: 'user', content: 'hi' }];
const LOOKUP = { name: 'Lookup', description: 'Look something up.', parameters: { type: 'object', properties: { q: { type: 'string' } } } };

const memoryStore = () => ({
  data: {},
  get(key, fallbackValue = null) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallbackValue; },
  set(key, value) { this.data[key] = value; }
});

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

// Metrics as the providers build them.
const localCall = (server, tokens, role = 'utility') => ({
  provider: 'local', model: `${server}/qwen3:8b`, inputTokens: tokens - 10, outputTokens: 10, totalTokens: tokens,
  costUsd: 0, local: { server, class: 'loopback' }, role
});
const pricedCall = (cost, role = 'main') => ({ provider: 'openai', model: 'gpt-5.5', inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: cost, role });
const unknownCall = (role = 'main') => ({ provider: 'openai', model: 'no-such-model', inputTokens: 5, outputTokens: 1, totalTokens: 6, costUsd: null, unpriced: true, role });

describe('a reply\'s totals', () => {
  it('local, priced and unknown calls: the priced cost, unpriced because of the unknown one, one local call', () => {
    const totals = sumLlmCalls([localCall('workstation', 826), pricedCall(0.0412), unknownCall()]);
    assert.strictEqual(totals.costUsd, 0.0412);
    assert.strictEqual(totals.unpriced, true);
    assert.strictEqual(totals.localCalls, 1);
    assert.strictEqual(totals.localTokens, 826);
    assert.strictEqual(totals.totalTokens, 826 + 110 + 6);
  });

  it('only local calls: $0, not unpriced, every call counted local', () => {
    const totals = sumLlmCalls([localCall('workstation', 100), localCall('gpu-box', 50)]);
    assert.strictEqual(totals.costUsd, 0);
    assert.strictEqual('unpriced' in totals, false);
    assert.strictEqual(totals.localCalls, 2);
    assert.strictEqual(totals.localTokens, 150);
  });

  it('a local call never sets unpriced, whatever its cost field says', () => {
    const odd = { ...localCall('workstation', 20), costUsd: null };
    assert.strictEqual('unpriced' in sumLlmCalls([odd]), false);
    assert.strictEqual('unpriced' in costByRole([odd]).utility, false);
  });

  it('no local call: no local keys at all', () => {
    const totals = sumLlmCalls([pricedCall(0.01)]);
    assert.strictEqual('localCalls' in totals, false);
    assert.strictEqual('localTokens' in totals, false);
    assert.deepStrictEqual(costByRole([pricedCall(0.01)]).main, { calls: 1, totalTokens: 110, costUsd: 0.01 });
  });

  it('a call whose local field is not a server record is not local', () => {
    const totals = sumLlmCalls([{ ...pricedCall(0.01), local: true }, { ...pricedCall(0.01), local: { server: '' } }]);
    assert.strictEqual('localCalls' in totals, false);
  });

  it('cost by role names the local servers a role ran on', () => {
    const byRole = costByRole([localCall('workstation', 100), localCall('gpu-box', 40), localCall('workstation', 10), pricedCall(0.02)]);
    assert.deepStrictEqual(byRole.utility, {
      calls: 3, totalTokens: 150, costUsd: 0, localCalls: 3, localTokens: 150, localServerIds: ['workstation', 'gpu-box']
    });
    assert.deepStrictEqual(byRole.main, { calls: 1, totalTokens: 110, costUsd: 0.02 });
  });

  it('summarizeTurnLlm carries the local counts through sub-agent runs', () => {
    const out = summarizeTurnLlm({ calls: [pricedCall(0.01)], subagents: [{ agentId: 'a1', role: 'worker', calls: [localCall('workstation', 30, 'worker')] }] });
    assert.strictEqual(out.totals.localCalls, 1);
    assert.strictEqual(out.subagents[0].totals.localCalls, 1);
    assert.deepStrictEqual(out.byRole.worker.localServerIds, ['workstation']);
  });
});

describe('R-LI-13: what is $0 and what is local', () => {
  const catalog = fixtureCatalog();

  it('R-LI-13: an ollama call is $0 and not local', () => {
    const metrics = new OllamaProvider(null, { catalog }).buildLlmCallMetrics({ model: 'test-model', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    assert.strictEqual(metrics.costUsd, 0);
    assert.strictEqual('local' in metrics, false);
    const totals = sumLlmCalls([metrics]);
    assert.strictEqual(totals.costUsd, 0);
    assert.strictEqual('localCalls' in totals, false);
    assert.strictEqual('unpriced' in totals, false);
    const tracker = new UsageTracker(memoryStore());
    tracker.record(UsageTracker.eventFromMetrics(metrics));
    const s = tracker.getSessionUsage();
    assert.strictEqual(s.localCalls, 0);
    assert.strictEqual(s.unpricedCalls, 0);
    assert.deepStrictEqual(s.byServer, {});
    assert.strictEqual(s.providers.ollama.localCalls, 0);
  });

  it('R-LI-13: an unknown hosted model is still null, and counts as unpriced', () => {
    const metrics = new OpenAIProvider('test-key-123456', { catalog }).buildLlmCallMetrics({ model: 'no-such-model', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    assert.strictEqual(metrics.costUsd, null);
    assert.strictEqual(metrics.unpriced, true);
    assert.strictEqual('local' in metrics, false);
    assert.strictEqual(sumLlmCalls([metrics]).unpriced, true);
    const tracker = new UsageTracker(memoryStore());
    tracker.record(UsageTracker.eventFromMetrics(metrics));
    assert.strictEqual(tracker.getSessionUsage().unpricedCalls, 1);
    assert.strictEqual(tracker.getSessionUsage().localCalls, 0);
  });

  it('R-LI-13: local is set only by the local provider', () => {
    // A hosted provider's metrics never carry it, priced or not.
    const hosted = new OpenAIProvider('test-key-123456', { catalog }).buildLlmCallMetrics({ model: 'gpt-5.5', usage: { prompt_tokens: 10, completion_tokens: 2 } });
    assert.strictEqual('local' in hosted, false);
    assert.strictEqual('usageEstimated' in hosted, false);
  });
});

describe('the usage tracker', () => {
  it('the event carries local and usageEstimated, and only when the metrics have them', () => {
    const e = UsageTracker.eventFromMetrics({ ...localCall('workstation', 50), usageEstimated: true });
    assert.deepStrictEqual(e.local, { server: 'workstation', class: 'loopback' });
    assert.strictEqual(e.usageEstimated, true);
    const l2 = UsageTracker.eventFromMetrics({ ...localCall('workstation', 50), local: { server: 'workstation', class: 'lan', node: 'kl-1', nodeName: 'gpu-box', extra: 'dropped' } });
    assert.deepStrictEqual(l2.local, { server: 'workstation', class: 'lan', node: 'kl-1', nodeName: 'gpu-box' });
    const hosted = UsageTracker.eventFromMetrics(pricedCall(0.01));
    assert.strictEqual('local' in hosted, false);
    assert.strictEqual('usageEstimated' in hosted, false);
  });

  it('counts local calls by provider, role, model and server, never as unpriced', () => {
    const tracker = new UsageTracker(memoryStore());
    tracker.record(UsageTracker.eventFromMetrics(localCall('workstation', 100)));
    tracker.record(UsageTracker.eventFromMetrics(localCall('gpu-box', 40)));
    tracker.record(UsageTracker.eventFromMetrics(localCall('workstation', 10, 'main')));
    tracker.record(UsageTracker.eventFromMetrics(pricedCall(0.02)));
    for (const s of [tracker.getSessionUsage(), tracker.getDailyUsage(new Date())]) {
      assert.strictEqual(s.localCalls, 3);
      assert.strictEqual(s.localTokens, 150);
      assert.strictEqual(s.unpricedCalls, 0);
      assert.strictEqual(s.totalCost, 0.02);
      assert.deepStrictEqual(s.byServer, { workstation: { calls: 2, tokens: 110 }, 'gpu-box': { calls: 1, tokens: 40 } });
      assert.deepStrictEqual([s.providers.local.localCalls, s.providers.local.localTokens, s.providers.local.unpricedCalls], [3, 150, 0]);
      assert.strictEqual(s.providers.openai.localCalls, 0);
      assert.deepStrictEqual([s.roles.utility.localCalls, s.roles.utility.localTokens], [2, 140]);
      assert.deepStrictEqual([s.roles.main.localCalls, s.roles.main.localTokens, s.roles.main.turns], [1, 10, 2]);
      assert.deepStrictEqual([s.models['local:workstation/qwen3:8b'].localCalls, s.models['local:workstation/qwen3:8b'].localTokens], [2, 110]);
    }
  });

  it('a local event whose cost is missing is still not unpriced', () => {
    const tracker = new UsageTracker(memoryStore());
    tracker.record({ ...UsageTracker.eventFromMetrics(localCall('workstation', 20)), costUsd: null });
    const s = tracker.getSessionUsage();
    assert.strictEqual(s.unpricedCalls, 0);
    assert.strictEqual(s.localCalls, 1);
    assert.strictEqual(s.totalCost, 0);
  });

  it('a daily record stored before this stage reads with zeros, and takes local calls on top', () => {
    const store = memoryStore();
    const today = new Date().toISOString().slice(0, 10);
    const old = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, totalTokens: 12, totalCost: 0.01, turns: 1, unpricedCalls: 0 };
    store.set(`usage.daily.${today}`, {
      ...old,
      providers: { openai: { ...old } },
      roles: { main: { ...old, usage: { input: 10, cachedInput: 0, cacheWrite: 0, output: 2, reasoning: 0 } } },
      models: { 'openai:gpt-5.5': { ...old } }
    });
    const tracker = new UsageTracker(store);
    const daily = tracker.getDailyUsage(today);
    assert.deepStrictEqual([daily.localCalls, daily.localTokens], [0, 0]);
    assert.deepStrictEqual(daily.byServer, {});
    assert.deepStrictEqual([daily.providers.openai.localCalls, daily.roles.main.localCalls, daily.models['openai:gpt-5.5'].localTokens], [0, 0, 0]);
    assert.strictEqual(daily.turns, 1, 'the old data itself is preserved');

    tracker.record(UsageTracker.eventFromMetrics(localCall('workstation', 30, 'main')));
    const after = tracker.getDailyUsage(today);
    assert.deepStrictEqual([after.localCalls, after.localTokens, after.turns], [1, 30, 2]);
    assert.deepStrictEqual([after.roles.main.localCalls, after.roles.main.localTokens, after.roles.main.turns], [1, 30, 2]);
    assert.deepStrictEqual(after.byServer, { workstation: { calls: 1, tokens: 30 } });
  });
});

describe('R-LI-12: a failover away from a local model', () => {
  let hosted;
  let downPort;
  const catalog = fixtureCatalog();
  const open = [];
  before(async () => {
    hosted = await startFakeLlmServer();
    downPort = await closedPort();
  });
  after(async () => {
    for (const s of open) s.close();
    await hosted.close();
  });

  const routerOver = (entries) => {
    const servers = new LocalServers({ getEntries: () => entries, catalog });
    open.push(servers);
    return new InferenceRouter({
      getProviderToken: (p) => (p === 'local' ? null : 'test-key-123456'),
      createProvider: (provider, token, target) => (provider === 'local'
        ? servers.providerFor(servers.splitModel(target.model).serverId)
        : ProviderFactory.create(provider, token, { catalog, baseUrl: `${hosted.url}/${provider}/v1` })),
      sleep: async () => {}
    });
  };

  it('R-LI-12: failoverFrom names the local target', async () => {
    const router = routerOver([serverEntry('workstation', `http://127.0.0.1:${downPort}`)]);
    const state = router.newRouteState({ role: 'utility', profileId: 'p-1' });
    const list = [{ provider: 'local', model: 'workstation/qwen3:8b', effort: null }, { provider: 'openai', model: 'gpt-5.4-mini', effort: null }];
    const reply = await router.routeTargets(list, HI, { tools: [LOOKUP] }, state);
    assert.strictEqual(reply.llmMetrics.provider, 'openai');
    assert.strictEqual(reply.llmMetrics.failover, true);
    assert.strictEqual(reply.llmMetrics.failoverFrom, 'local/workstation/qwen3:8b');
    assert.strictEqual('local' in reply.llmMetrics, false);
    assert.strictEqual(router.callTags(state).failoverFrom, 'local/workstation/qwen3:8b');
  });

  it('a call with no failover has no failoverFrom', async () => {
    const router = routerOver([]);
    const state = router.newRouteState({ role: 'main', profileId: 'p-1' });
    const reply = await router.routeTargets([{ provider: 'openai', model: 'gpt-5.4-mini', effort: null }], HI, { tools: [LOOKUP] }, state);
    assert.strictEqual(reply.llmMetrics.failover, false);
    assert.strictEqual('failoverFrom' in reply.llmMetrics, false);
  });
});

describe('a local server that reports no usage', () => {
  let server;
  const catalog = fixtureCatalog();
  const transports = [];
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => {
    for (const t of transports) t.close();
    await server.close();
  });

  const make = () => {
    const transport = createLocalTransport({ baseUrl: `${server.url}/vllm`, addresses: ['127.0.0.1'] });
    transports.push(transport);
    return new LocalServerProvider(null, { baseUrl: `${server.url}/vllm/v1`, transport, serverId: 'workstation', addressClass: 'loopback', kind: 'vllm', catalog });
  };
  const lastBody = () => JSON.stringify([...server.requests].reverse().find((r) => r.method === 'POST').body);

  it('a streamed reply is estimated at one token per four characters, still $0', async () => {
    const chunks = [];
    const result = await make().streamMessage(HI, { model: 'workstation/no-usage-model' }, (c) => chunks.push(c));
    const m = result.llmMetrics;
    assert.strictEqual(m.usageEstimated, true);
    assert.strictEqual(m.inputTokens, Math.ceil(lastBody().length / 4));
    assert.strictEqual(m.outputTokens, Math.ceil(chunks.join('').length / 4));
    assert.strictEqual(m.totalTokens, m.inputTokens + m.outputTokens);
    assert.strictEqual(m.costUsd, 0);
    assert.strictEqual('unpriced' in m, false);
    assert.deepStrictEqual(m.local, { server: 'workstation', class: 'loopback' });
    assert.strictEqual(m.model, 'workstation/no-usage-model');
    assert.strictEqual(UsageTracker.eventFromMetrics(m).usageEstimated, true);
  });

  it('a tool call with no usage is estimated from the call it makes', async () => {
    const result = await make().sendMessageWithTools(HI, [LOOKUP], { model: 'workstation/no-usage-model' });
    assert.strictEqual(result.type, 'tool_use');
    assert.strictEqual(result.llmMetrics.usageEstimated, true);
    assert.strictEqual(result.llmMetrics.inputTokens, Math.ceil(lastBody().length / 4));
    assert.ok(result.llmMetrics.outputTokens > 0);
    assert.strictEqual(result.llmMetrics.costUsd, 0);
  });

  it('a server that reports usage is taken at its word, not estimated', async () => {
    const result = await make().streamMessage(HI, { model: 'workstation/test-model' }, () => {});
    assert.strictEqual('usageEstimated' in result.llmMetrics, false);
    assert.deepStrictEqual([result.llmMetrics.inputTokens, result.llmMetrics.outputTokens], [12, 2]);
  });
});

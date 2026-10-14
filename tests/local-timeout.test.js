// tests/local-timeout.test.js
// A local call's timeout (spec 2026-10-13-local-inference-design.md §6.4;
// owner ruling on Q-L1-3, 2026-10-14): a call to a local server is aborted
// through its own abort signal once its timeout passes. The timeout is the
// role's (`options.timeoutMs`), replaced by the server entry's `timeoutMs`
// when that is larger; with neither there is none. A timed-out call fails
// over only as the egress policy allows and is reported like any other
// failure. Hosted calls are unchanged. The "hang" model of the fake server
// never answers.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const InferenceRouter = require('../src/providers/inference-router');
const ProviderFactory = require('../src/providers/provider-factory');
const { classifyError, FailoverReason, RecoveryAction } = require('../src/providers/error-classifier');
const { FailoverPolicy, DEFAULT_BUDGETS } = require('../src/providers/failover-policy');
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

const serverEntry = (id, baseUrl, over = {}) => ({
  id, name: id, kind: 'vllm', baseUrl, tlsFingerprint: null, allowCgnat: false, maxConcurrent: 2, timeoutMs: null,
  pinned: { addresses: ['127.0.0.1'], class: 'loopback', at: AT }, markedLocalAt: AT, ...over
});

// A ref'd timer held across an await (CLAUDE.md): nothing else may be keeping
// the loop open while a test waits on a call that is meant to end by itself.
async function within(ms, promise) {
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms); });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

describe('classifyError and FailoverPolicy: LOCAL_TIMEOUT', () => {
  const timedOut = () => Object.assign(new Error('The local server workstation did not answer within 150 ms.'), { code: 'LOCAL_TIMEOUT' });

  it('is its own reason, and the answer is another model, never a retry of the same one', () => {
    const c = classifyError(timedOut(), { provider: 'local' });
    assert.strictEqual(FailoverReason.LOCAL_TIMEOUT, 'local_timeout');
    assert.strictEqual(c.reason, FailoverReason.LOCAL_TIMEOUT);
    assert.strictEqual(c.action, RecoveryAction.FALLBACK_MODEL);
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(classifyError(new Error('wrapped', { cause: timedOut() })).reason, FailoverReason.LOCAL_TIMEOUT);
  });

  it('the policy escalates on the first one, with no wait', () => {
    assert.strictEqual(DEFAULT_BUDGETS[FailoverReason.LOCAL_TIMEOUT].attempts, 0);
    const plan = new FailoverPolicy().plan(timedOut(), { totalAttempts: 1, attemptsByReason: {}, provider: 'local', model: 'workstation/m' });
    assert.strictEqual(plan.action, RecoveryAction.FALLBACK_MODEL);
    assert.strictEqual(plan.waitMs, 0);
  });
});

describe('a local call\'s timeout', () => {
  let box;
  let other;
  let hosted;
  const catalog = fixtureCatalog();
  const open = [];
  const originalFetch = globalThis.fetch;

  before(async () => {
    box = await startFakeLlmServer();
    other = await startFakeLlmServer();
    hosted = await startFakeLlmServer();
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith(hosted.url)) throw new Error(`no network in unit tests (${url})`);
      return originalFetch(url, init);
    };
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    for (const servers of open) servers.close();
    await Promise.all([box.close(), other.close(), hosted.close()]);
  });

  function registry(entries) {
    const servers = new LocalServers({ getEntries: () => entries, catalog });
    open.push(servers);
    return servers;
  }

  function harness(entries) {
    const servers = registry(entries);
    const sleeps = [];
    const router = new InferenceRouter({
      getProviderToken: (p) => (p === 'local' ? null : 'test-key-123456'),
      createProvider: (provider, token, target) => {
        if (provider === 'local') return servers.providerFor(servers.splitModel(target.model).serverId);
        return ProviderFactory.create(provider, token, { catalog, baseUrl: `${hosted.url}/${provider}/v1` });
      },
      isGuaranteeTarget: (target) => servers.isGuaranteeTarget(target),
      sleep: async (ms) => { sleeps.push(ms); }
    });
    return { router, servers, sleeps };
  }

  it('the role timeout ends a call to a server that never answers, as LOCAL_TIMEOUT', async () => {
    const provider = registry([serverEntry('workstation', `${box.url}/vllm`)]).providerFor('workstation');
    const started = Date.now();
    await within(5000, assert.rejects(
      provider.sendMessage(HI, { model: 'workstation/hang-model', timeoutMs: 150 }),
      (err) => {
        assert.strictEqual(err.code, 'LOCAL_TIMEOUT');
        assert.notStrictEqual(err.name, 'AbortError', 'a timeout is not a Stop');
        assert.strictEqual(err.timeoutMs, 150);
        assert.match(err.message, /workstation/);
        assert.match(err.message, /150 ms/);
        assert.strictEqual(err.partialLlmMetrics.model, 'workstation/hang-model');
        assert.strictEqual(err.partialLlmMetrics.local.server, 'workstation');
        return true;
      }
    ));
    assert.ok(Date.now() - started >= 140);
  });

  it('the entry\'s timeoutMs replaces the role timeout when it is larger, and only then', async () => {
    const servers = registry([
      serverEntry('slow-box', `${box.url}/vllm`, { timeoutMs: 400 }),
      serverEntry('quick-box', `${box.url}/vllm`, { timeoutMs: 50 })
    ]);
    const slow = servers.providerFor('slow-box');
    const quick = servers.providerFor('quick-box');
    assert.strictEqual(slow.callTimeoutMs(150), 400);
    assert.strictEqual(quick.callTimeoutMs(150), 150);
    assert.strictEqual(slow.callTimeoutMs(undefined), 400, 'with no role timeout the entry\'s applies');
    assert.strictEqual(registry([serverEntry('plain', `${box.url}/vllm`)]).providerFor('plain').callTimeoutMs(undefined), null);
    await within(5000, assert.rejects(slow.sendMessage(HI, { model: 'slow-box/hang-model', timeoutMs: 150 }), (err) => err.code === 'LOCAL_TIMEOUT' && err.timeoutMs === 400));
    await within(5000, assert.rejects(quick.sendMessage(HI, { model: 'quick-box/hang-model', timeoutMs: 150 }), (err) => err.code === 'LOCAL_TIMEOUT' && err.timeoutMs === 150));
  });

  it('a call that answers in time is unchanged, and leaves nothing armed', async () => {
    const provider = registry([serverEntry('workstation', `${box.url}/vllm`, { timeoutMs: 2000 })]).providerFor('workstation');
    assert.strictEqual(await provider.sendMessage(HI, { model: 'workstation/test-model', timeoutMs: 1000 }), 'Hello there');
    const res = await provider.sendMessageWithTools(HI, TOOLS, { model: 'workstation/test-model', timeoutMs: 1000 });
    assert.strictEqual(res.type, 'tool_use');
    assert.strictEqual(res.llmMetrics.local.server, 'workstation');
    let streamed = '';
    const out = await provider.streamMessage(HI, { model: 'workstation/slow-model', timeoutMs: 1000 }, (c) => { streamed += c; });
    assert.strictEqual(streamed, 'Hello there');
    assert.ok(out.llmMetrics);
  });

  it('with no timeout at all a call is not cut off, and Stop is still a Stop', async () => {
    const provider = registry([serverEntry('workstation', `${box.url}/vllm`)]).providerFor('workstation');
    const stop = new AbortController();
    const call = provider.sendMessage(HI, { model: 'workstation/hang-model', abortSignal: stop.signal });
    const state = await within(5000, Promise.race([
      call.then(() => 'answered', () => 'failed'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 300))
    ]));
    assert.strictEqual(state, 'pending');
    stop.abort('Stopped by the owner');
    await within(5000, assert.rejects(call, (err) => err.name === 'AbortError' && err.code !== 'LOCAL_TIMEOUT'));
  });

  it('a Stop before the timeout is a Stop, not a timeout', async () => {
    const provider = registry([serverEntry('workstation', `${box.url}/vllm`, { timeoutMs: 5000 })]).providerFor('workstation');
    const stop = new AbortController();
    const call = provider.sendMessage(HI, { model: 'workstation/hang-model', abortSignal: stop.signal, timeoutMs: 5000 });
    setTimeout(() => stop.abort('Stopped by the owner'), 50);
    await within(4000, assert.rejects(call, (err) => {
      assert.strictEqual(err.name, 'AbortError');
      assert.strictEqual(classifyError(err).reason, FailoverReason.ABORTED);
      return true;
    }));
  });

  it('time spent waiting for a free slot counts against the timeout', async () => {
    const provider = registry([serverEntry('workstation', `${box.url}/vllm`, { maxConcurrent: 1 })]).providerFor('workstation');
    const started = Date.now();
    const results = await within(5000, Promise.allSettled([
      provider.sendMessage(HI, { model: 'workstation/hang-model', timeoutMs: 200 }),
      provider.sendMessage(HI, { model: 'workstation/hang-model', timeoutMs: 200 })
    ]));
    assert.deepStrictEqual(results.map((r) => r.status), ['rejected', 'rejected']);
    assert.deepStrictEqual(results.map((r) => r.reason.code), ['LOCAL_TIMEOUT', 'LOCAL_TIMEOUT']);
    assert.ok(Date.now() - started < 1500, 'the queued call did not get a fresh timeout after the first ended');
  });

  it('an embedding call on the server is bounded by the entry\'s timeout too', async () => {
    // A server that takes every request and never answers it.
    const silent = http.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${silent.address().port}`;
      const provider = registry([serverEntry('workstation', url, { kind: 'ollama', timeoutMs: 150 })]).providerFor('workstation');
      await within(5000, assert.rejects(provider.embed(['a'], { model: 'workstation/embed-model' }), (err) => err.code === 'LOCAL_TIMEOUT' && err.timeoutMs === 150));
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  // A server that starts its reply at once and then takes longer than the
  // timeout to finish it: a stream of tokens 120 ms apart, or a JSON body
  // whose first bytes come at once and the rest 400 ms later.
  async function startDrippingServer() {
    const timers = new Set();
    const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const words = ['one', ' two', ' three', ' four'];
          words.forEach((w, i) => later(i * 120, () => res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: w } }] })}\n\n`)));
          later(words.length * 120, () => { res.write('data: [DONE]\n\n'); res.end(); });
          return;
        }
        const text = JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'a long reply' } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(text.slice(0, 10));
        later(400, () => res.end(text.slice(10)));
      });
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${srv.address().port}`,
      close: async () => { for (const t of timers) clearTimeout(t); srv.closeAllConnections(); await new Promise((resolve) => srv.close(resolve)); }
    };
  }

  it('Q-L1-5: a server that starts promptly and streams past the limit completes', async () => {
    const drip = await startDrippingServer();
    try {
      const provider = registry([serverEntry('workstation', drip.url)]).providerFor('workstation');
      let streamed = '';
      const started = Date.now();
      const out = await within(5000, provider.streamMessage(HI, { model: 'workstation/m', timeoutMs: 150 }, (c) => { streamed += c; }));
      assert.strictEqual(streamed, 'one two three four');
      assert.ok(out.llmMetrics);
      assert.ok(Date.now() - started >= 300, 'the reply ran well past the 150 ms timeout');
    } finally {
      await drip.close();
    }
  });

  it('Q-L1-5: a non-streamed reply whose body starts in time is not cut, however long the rest takes', async () => {
    const drip = await startDrippingServer();
    try {
      const provider = registry([serverEntry('workstation', drip.url)]).providerFor('workstation');
      const res = await within(5000, provider.sendMessageWithTools(HI, TOOLS, { model: 'workstation/m', timeoutMs: 150 }));
      assert.strictEqual(res.type, 'text');
      assert.strictEqual(res.llmMetrics.local.server, 'workstation');
    } finally {
      await drip.close();
    }
  });

  it('Q-L1-5: once output has started, Stop still stops', async () => {
    const drip = await startDrippingServer();
    try {
      const provider = registry([serverEntry('workstation', drip.url)]).providerFor('workstation');
      const stop = new AbortController();
      let streamed = '';
      const call = provider.streamMessage(HI, { model: 'workstation/m', timeoutMs: 5000, abortSignal: stop.signal }, (c) => {
        streamed += c;
        if (streamed === 'one') stop.abort('Stopped by the owner');
      });
      await within(4000, assert.rejects(call, (err) => err.name === 'AbortError' && err.code !== 'LOCAL_TIMEOUT'));
      assert.strictEqual(streamed, 'one');
    } finally {
      await drip.close();
    }
  });

  it('with no policy, a timed-out local target fails over at once and is named', async () => {
    const { router, sleeps } = harness([serverEntry('workstation', `${box.url}/vllm`)]);
    const before = hosted.requests.length;
    const res = await within(5000, router.routeTargets(
      [t('local', 'workstation/hang-model'), t('openai', 'gpt-5.5')],
      HI,
      { tools: TOOLS, timeoutMs: 150 },
      router.newRouteState({ role: 'utility', profileId: 'p-1' })
    ));
    assert.strictEqual(res.llmMetrics.provider, 'openai');
    assert.strictEqual(res.llmMetrics.failover, true);
    assert.strictEqual(res.llmMetrics.failoverFrom, 'local/workstation/hang-model');
    assert.strictEqual(hosted.requests.length, before + 1);
    assert.deepStrictEqual(sleeps, [], 'never retried, never waited');
  });

  it('under a policy, a timed-out local target fails over to another local target only', async () => {
    const { router, sleeps } = harness([serverEntry('workstation', `${box.url}/vllm`), serverEntry('backup', `${other.url}/vllm`)]);
    const hostedBefore = hosted.requests.length;
    const otherBefore = other.requests.length;
    const text = await within(5000, router.routeTargets(
      [t('local', 'workstation/hang-model'), t('openai', 'gpt-5.5'), t('local', 'backup/test-model')],
      HI,
      { timeoutMs: 150 },
      router.newRouteState(null, PRIVATE)
    ));
    assert.strictEqual(text, 'Hello there');
    assert.strictEqual(other.requests.length, otherBefore + 1);
    assert.strictEqual(hosted.requests.length, hostedBefore, 'nothing went to the hosted model');
    assert.deepStrictEqual(sleeps, []);
  });

  it('under a policy with no other local target, the turn ends LOCAL_MODEL_UNAVAILABLE and nothing is sent to a hosted model', async () => {
    const { router, sleeps } = harness([serverEntry('workstation', `${box.url}/vllm`)]);
    const provider = router.routedProvider({ targets: [t('local', 'workstation/hang-model'), t('openai', 'gpt-5.5')], egress: PRIVATE });
    const hostedBefore = hosted.requests.length;
    let streamed = '';
    await within(5000, assert.rejects(
      provider.streamMessageWithTools(HI, TOOLS, { timeoutMs: 150 }, (c) => { streamed += c; }),
      (err) => {
        assert.strictEqual(err.code, 'LOCAL_MODEL_UNAVAILABLE');
        assert.strictEqual(err.cause.code, 'LOCAL_TIMEOUT');
        assert.match(err.message, /nothing was sent to a hosted model/);
        return true;
      }
    ));
    assert.strictEqual(streamed, '');
    assert.strictEqual(hosted.requests.length, hostedBefore);
    assert.deepStrictEqual(sleeps, []);
  });

  it('hosted calls are unchanged: a role timeout shorter than the reply does not cut a hosted call', async () => {
    const provider = ProviderFactory.create('openai', 'test-key-123456', { catalog, baseUrl: `${hosted.url}/openai/v1` });
    let streamed = '';
    const out = await within(5000, provider.streamMessage(HI, { model: 'slow-model', timeoutMs: 10 }, (c) => { streamed += c; }));
    assert.strictEqual(streamed, 'Hello there');
    assert.ok(out.llmMetrics);
  });
});

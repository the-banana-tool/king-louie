// tests/inference-router-targets.test.js
// Failover over a resolved target list (spec 2026-09-27 §6.7): another
// target of the same provider on any call, another provider only before
// the first successful call; the routed provider a turn's loop talks to.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const InferenceRouter = require('../src/providers/inference-router');
const { NO_RETRY } = require('../src/providers/failover-policy');
const AgentExecutor = require('../src/agents/agent-executor');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model, effort = null) => ({ provider, model, effort });
const unknownFailure = () => new Error('upstream exploded'); // unclassified → fall back at once
const authFailure = () => Object.assign(new Error('Invalid API Key'), { status: 401 });

// One scripted instance per provider: each call pops the next behaviour for
// that model ('ok', an Error, or a function).
function harness(script = {}, extra = {}) {
  const calls = [];
  const reported = [];
  const prepared = [];
  const instances = {};
  const make = (provider) => ({
    provider,
    getProviderName: () => provider,
    buildToolMessages: (...args) => [{ builtBy: provider, args }],
    buildMultiToolMessages: () => [{ builtBy: provider }],
    async sendMessage(messages, opts) { return this._run('sendMessage', messages, opts); },
    async streamMessage(messages, opts, onChunk) { onChunk('chunk'); return this._run('streamMessage', messages, opts); },
    async sendMessageWithTools(messages, tools, opts) { return this._run('sendMessageWithTools', messages, opts, tools); },
    async streamMessageWithTools(messages, tools, opts, onChunk) { onChunk('chunk'); return this._run('streamMessageWithTools', messages, opts, tools); },
    async _run(method, messages, opts, tools) {
      calls.push({ provider, model: opts.model, method, opts, tools });
      const queue = script[`${provider}/${opts.model}`] || [];
      const next = queue.length ? queue.shift() : 'ok';
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(opts);
      return { type: 'text', content: `${provider}/${opts.model}`, llmMetrics: { provider, model: opts.model } };
    }
  });
  const router = new InferenceRouter({
    getProviderToken: (p) => `token-${p}`,
    createProvider: (p) => { instances[p] = instances[p] || make(p); return instances[p]; },
    prepareProvider: async (_instance, p) => { prepared.push(p); },
    onProviderError: (p, err) => reported.push([p, err.message]),
    sleep: async () => {},
    ...extra
  });
  return { router, calls, reported, prepared };
}

describe('InferenceRouter#routeTargets', () => {
  it('fails over to another provider on the first call, reporting the auth failure against the provider that failed', async () => {
    const { router, calls, reported } = harness({ 'groq/llama': [authFailure()] });
    const res = await router.routeTargets([t('groq', 'llama'), t('openai', 'gpt-5.5')], [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(res.content, 'openai/gpt-5.5');
    assert.deepStrictEqual(calls.map((c) => `${c.provider}/${c.model}`), ['groq/llama', 'openai/gpt-5.5']);
    assert.deepStrictEqual(reported, [['groq', 'Invalid API Key']]);
  });

  it('skips the rest of a provider whose key was rejected', async () => {
    const { router, calls } = harness({ 'openai/a': [authFailure()] });
    await router.routeTargets([t('openai', 'a'), t('openai', 'b'), t('anthropic', 'c')], []);
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'c']);
  });

  it('after a successful call, fails over only to targets of the same provider', async () => {
    const { router, calls } = harness({ 'openai/a': ['ok', unknownFailure()] });
    const state = router.newRouteState();
    const list = [t('openai', 'a'), t('anthropic', 'b'), t('openai', 'c')];
    await router.routeTargets(list, [], {}, state);
    const second = await router.routeTargets(list, [], {}, state);
    assert.strictEqual(second.content, 'openai/c');
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'a', 'c']);
  });

  it('refuses to move to another provider mid-turn, saying why', async () => {
    const { router } = harness({ 'openai/a': ['ok', unknownFailure()] });
    const state = router.newRouteState();
    const list = [t('openai', 'a'), t('anthropic', 'b')];
    await router.routeTargets(list, [], {}, state);
    await assert.rejects(router.routeTargets(list, [], {}, state), (err) => err.code === 'FAILOVER_BLOCKED'
      && err.cause.message === 'upstream exploded'
      && /cannot move to anthropic\/b after its first model call/.test(err.message)
      && /Retry with/.test(err.message));
  });

  it('starts every later call at the target that last answered', async () => {
    const { router, calls } = harness({ 'openai/a': [unknownFailure()] });
    const state = router.newRouteState();
    const list = [t('openai', 'a'), t('openai', 'b')];
    await router.routeTargets(list, [], {}, state);
    await router.routeTargets(list, [], {}, state);
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'b', 'b']);
  });

  it('retries the same target on a transient error before failing over', async () => {
    const busy = () => Object.assign(new Error('bad gateway'), { status: 502 });
    const { router, calls } = harness({ 'openai/a': [busy(), 'ok'] });
    const res = await router.routeTargets([t('openai', 'a'), t('anthropic', 'b')], []);
    assert.strictEqual(res.content, 'openai/a');
    assert.deepStrictEqual(calls.map((c) => c.model), ['a', 'a']);
  });

  it('throws the last error when the list runs out', async () => {
    const { router } = harness({ 'openai/a': [unknownFailure()], 'anthropic/b': [new Error('also down')] });
    await assert.rejects(router.routeTargets([t('openai', 'a'), t('anthropic', 'b')], []), /also down/);
  });

  it('never fails over once the run is aborted', async () => {
    const controller = new AbortController();
    const { router, calls } = harness({ 'openai/a': [() => { controller.abort(); throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }] });
    await assert.rejects(router.routeTargets([t('openai', 'a'), t('anthropic', 'b')], [], { abortSignal: controller.signal }), /aborted/);
    assert.deepStrictEqual(calls.map((c) => c.model), ['a']);
  });

  // Fix round 1: a stream that has already emitted a chunk must never be
  // retried or failed over — the user would see the same text twice.
  it('never retries or fails over a stream that has already emitted a chunk', async () => {
    const busy = () => Object.assign(new Error('bad gateway'), { status: 502 });
    const { router, calls } = harness({ 'openai/a': [busy()] });
    const chunks = [];
    await assert.rejects(
      router.routeTargets([t('openai', 'a'), t('anthropic', 'b')], [], { onChunk: (c) => chunks.push(c) }),
      /bad gateway/
    );
    assert.deepStrictEqual(calls.map((c) => c.model), ['a']);
    assert.deepStrictEqual(chunks, ['chunk']);
  });

  // Fix round 1: an abort that lands during the RETRY backoff wait must
  // stop the loop instead of making another call.
  it('stops instead of retrying when the run is aborted during the backoff wait', async () => {
    const busy = () => Object.assign(new Error('bad gateway'), { status: 502 });
    const controller = new AbortController();
    const { router, calls } = harness({ 'openai/a': [busy(), 'ok'] }, {
      sleep: async () => { controller.abort(); }
    });
    await assert.rejects(
      router.routeTargets([t('openai', 'a')], [], { abortSignal: controller.signal }),
      /bad gateway/
    );
    assert.deepStrictEqual(calls.map((c) => c.model), ['a']);
  });

  it('refuses an empty list', async () => {
    const { router } = harness();
    await assert.rejects(router.routeTargets([], []), /resolved list is empty/);
  });

  it('prepares each provider once per route state', async () => {
    const { router, prepared } = harness();
    const state = router.newRouteState();
    await router.routeTargets([t('anthropic', 'a')], [], {}, state);
    await router.routeTargets([t('anthropic', 'a')], [], {}, state);
    assert.deepStrictEqual(prepared, ['anthropic']);
  });
});

describe('InferenceRouter#routedProvider', () => {
  it('routes each method, the target model and effort winning over options', async () => {
    const { router, calls } = harness();
    const p = router.routedProvider({ targets: [t('openai', 'gpt-5.5', 'low')] });
    const chunks = [];
    await p.streamMessage([], { model: 'ignored' }, (c) => chunks.push(c));
    await p.sendMessageWithTools([], [{ name: 'Read' }], {});
    await p.streamMessageWithTools([], [{ name: 'Read' }], {}, (c) => chunks.push(c));
    await p.sendMessage([], {});
    assert.deepStrictEqual(calls.map((c) => c.method), ['streamMessage', 'sendMessageWithTools', 'streamMessageWithTools', 'sendMessage']);
    assert.ok(calls.every((c) => c.model === 'gpt-5.5' && c.opts.effort === 'low'));
    assert.deepStrictEqual(calls[1].tools, [{ name: 'Read' }]);
    assert.deepStrictEqual(chunks, ['chunk', 'chunk']);
    assert.strictEqual(p.routed, true);
    assert.deepStrictEqual([p.getProviderName(), p.getDefaultModel()], ['openai', 'gpt-5.5']);
  });

  it('attaches its signal unless the call brings one', async () => {
    const { router, calls } = harness();
    const own = new AbortController();
    const theirs = new AbortController();
    const p = router.routedProvider({ targets: [t('openai', 'a')], signal: own.signal });
    await p.sendMessage([], {});
    await p.sendMessage([], { abortSignal: theirs.signal });
    assert.strictEqual(calls[0].opts.abortSignal, own.signal);
    assert.strictEqual(calls[1].opts.abortSignal, theirs.signal);
  });

  it('builds tool messages with the instance that answered, and reports where it is', async () => {
    const { router } = harness({ 'groq/a': [unknownFailure()] });
    const p = router.routedProvider({ targets: [t('groq', 'a'), t('openai', 'b')] });
    assert.strictEqual(p.buildToolMessages, undefined, 'nothing has answered yet');
    await p.sendMessageWithTools([], [{ name: 'Read' }], {});
    assert.deepStrictEqual(p.current(), t('openai', 'b'));
    assert.strictEqual(p.getProviderName(), 'openai');
    assert.deepStrictEqual(p.buildToolMessages('x')[0].builtBy, 'openai');
    assert.deepStrictEqual(p.buildMultiToolMessages()[0].builtBy, 'openai');
    assert.deepStrictEqual(p.targets(), [t('groq', 'a'), t('openai', 'b')]);
  });

  it('needs at least one target', () => {
    const { router } = harness();
    assert.throws(() => router.routedProvider({ targets: [] }), /at least one target/);
  });
});

describe('NO_RETRY and AgentExecutor', () => {
  it('NO_RETRY aborts every failure without waiting', () => {
    assert.deepStrictEqual(NO_RETRY.plan(new Error('503')), { action: 'abort', reason: 'routed', waitMs: 0 });
    assert.strictEqual(require('../src/cases/roles').NO_RETRY, NO_RETRY);
  });

  it('AgentExecutor hands its failover policy to the agent loop', async () => {
    // A 502 is one the loop's own default policy would retry, after a wait;
    // with NO_RETRY it gives up on the first failure.
    let calls = 0;
    const provider = { sendMessageWithTools: async () => { calls += 1; throw Object.assign(new Error('bad gateway'), { status: 502 }); } };
    const executor = new AgentExecutor(provider, { execute: async () => ({}) }, { failoverPolicy: NO_RETRY });
    const agent = { id: 'a', canUseTool: () => true, readOnly: false, maxIterations: 2 };
    const started = Date.now();
    await assert.rejects(executor.execute(agent, 'hi', { tools: [{ name: 'Read' }] }), /bad gateway/);
    assert.strictEqual(calls, 1, 'NO_RETRY: the loop never retries');
    assert.ok(Date.now() - started < 900, 'NO_RETRY: no backoff wait inside the loop');
  });
});

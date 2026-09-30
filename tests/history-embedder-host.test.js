// tests/history-embedder-host.test.js
// EmbedderHost (recall spec §5.2, §15): which embedder is live, its states,
// one owner warning per failure, retries, a model switch mid-load, the
// reranker. A stub runner stands in for the worker.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { EmbedderHost } = require('../src/history/embedder-host');
const { EmbedError } = require('../src/history/embed-errors');

class StubRunner extends EventEmitter {
  constructor() {
    super();
    this.loads = [];
    this.resets = 0;
    this.stopped = false;
  }
  load(role, model, opts) {
    let resolve;
    let reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.loads.push({ role, model, opts, resolve, reject });
    return p;
  }
  async embed(model, texts, opts) { this.lastEmbed = { model, texts, opts }; return texts.map(() => Float32Array.from([3, 4])); }
  async rerank(model, query, texts, opts) { this.lastRerank = { model, query, texts, opts }; return texts.map((_, i) => i); }
  reset() { this.resets += 1; }
  async stop() { this.stopped = true; }
}

const flush = () => new Promise((r) => setImmediate(r));
const RETRY = 600000;

function setup(embedder = {}, extra = {}) {
  let settings = { history: { embedder } };
  let now = 0;
  const runner = new StubRunner();
  const notices = [];
  const warnings = [];
  const providers = [];
  const host = new EmbedderHost({
    getSettings: () => settings,
    modelsDir: '/data/models',
    createRunner: () => runner,
    createProvider: (kind, cfg) => {
      providers.push({ kind, cfg });
      return extra.provider || { async embed(inputs) { return { vectors: inputs.map(() => [1, 0]), usage: { input: inputs.length } }; } };
    },
    notify: (n) => notices.push(n),
    now: () => now,
    retryMs: RETRY,
    log: { warn: (m) => warnings.push(m), info() {}, debug() {} }
  });
  return {
    host, runner, notices, warnings, providers,
    set: (e) => { settings = { history: { embedder: e } }; },
    advance: (ms) => { now += ms; }
  };
}

describe('EmbedderHost', () => {
  it('is off until started, and with kind none', () => {
    const s = setup();
    assert.strictEqual(s.host.current(), null);
    assert.strictEqual(s.host.status().state, 'off');
    assert.strictEqual(s.host.reason(), null, 'off by choice is not a degradation');
    const none = setup({ kind: 'none' });
    none.host.start();
    assert.strictEqual(none.host.status().state, 'off');
    assert.strictEqual(none.runner.loads.length, 0);
  });

  it('local: starting, downloading with progress, then ready with the model under its key', async () => {
    const s = setup();
    s.host.start();
    assert.strictEqual(s.host.status().state, 'starting');
    assert.deepStrictEqual(s.runner.loads.map((l) => [l.role, l.model, l.opts.modelsDir]), [['embedder', 'Xenova/bge-small-en-v1.5', '/data/models']]);
    s.runner.emit('progress', { role: 'embedder', model: 'Xenova/bge-small-en-v1.5', file: 'onnx/model_quantized.onnx', loaded: 10, total: 40 });
    s.runner.emit('progress', { role: 'embedder', model: 'Xenova/bge-small-en-v1.5', file: 'tokenizer.json', loaded: 5, total: 10 });
    assert.deepStrictEqual(s.host.status().download, { loaded: 15, total: 50 });
    assert.strictEqual(s.host.status().state, 'downloading');
    s.runner.loads[0].resolve({ dim: 384 });
    await flush();
    const e = s.host.current();
    assert.strictEqual(s.host.status().state, 'ready');
    assert.strictEqual(e.dim, null, 'dim comes from the first vector, not the load reply');
    assert.strictEqual(e.tokens, 0, 'the local embedder is unpriced');
    assert.strictEqual(e.name, 'local:Xenova/bge-small-en-v1.5');
    assert.strictEqual(s.host.status().key, 'local:Xenova/bge-small-en-v1.5');
    const [q] = await e.embed(['gate code'], { kind: 'query' });
    assert.ok(Math.abs(q[0] - 0.6) < 1e-6, 'unit length');
    assert.strictEqual(e.dim, 2);
    assert.deepStrictEqual(s.runner.lastEmbed.texts, ['Represent this sentence for searching relevant passages: gate code']);
    assert.strictEqual(s.runner.lastEmbed.opts.priority, 'query');
    assert.strictEqual(s.host.reason(), null);
  });

  it('a download that fails: unavailable, one warning to the log and the owner, a retry after retryMs', async () => {
    const s = setup();
    s.host.start();
    s.runner.loads[0].reject(new EmbedError('MODEL_UNAVAILABLE', 'Xenova/bge-small-en-v1.5 could not be loaded: fetch failed (offline)'));
    await flush();
    assert.strictEqual(s.host.status().state, 'unavailable');
    assert.match(s.host.status().error, /offline/);
    assert.strictEqual(s.host.current(), null);
    assert.match(s.host.reason(), /embedding model not loaded/);
    assert.strictEqual(s.notices.length, 1);
    assert.match(s.notices[0].body, /keyword search only/);
    assert.strictEqual(s.warnings.length, 1);
    s.advance(RETRY - 1);
    assert.strictEqual(s.host.current(), null);
    assert.strictEqual(s.runner.loads.length, 1, 'no retry before retryMs');
    s.advance(1);
    s.host.current();
    assert.strictEqual(s.runner.loads.length, 2, 'retried');
    s.runner.loads[1].reject(new EmbedError('MODEL_UNAVAILABLE', 'still offline'));
    await flush();
    assert.strictEqual(s.notices.length, 1, 'the same failure is not shown twice');
    s.host.retry();
    assert.strictEqual(s.runner.loads.length, 3, 'Retry tries at once');
  });

  it('a model switch while loading: the old load is ignored, the new one wins', async () => {
    const s = setup();
    s.host.start();
    s.set({ model: 'Xenova/all-MiniLM-L6-v2' });
    assert.strictEqual(s.host.status().key, 'local:Xenova/all-MiniLM-L6-v2');
    assert.strictEqual(s.runner.loads.length, 2);
    s.runner.loads[0].resolve({ dim: 384 });
    await flush();
    assert.strictEqual(s.host.current(), null, 'the old model finishing does not make it live');
    s.runner.loads[1].resolve({ dim: 384 });
    await flush();
    assert.strictEqual(s.host.current().name, 'local:Xenova/all-MiniLM-L6-v2');
    s.runner.loads[0].reject(new EmbedError('MODEL_UNAVAILABLE', 'late'));
    await flush();
    assert.strictEqual(s.host.status().state, 'ready', 'a late failure of the old load changes nothing');
  });

  it('the worker disabled after crashes: disabled for the session; Retry resets the runner', async () => {
    const s = setup();
    s.host.start();
    s.runner.loads[0].resolve({ dim: 384 });
    await flush();
    s.runner.emit('disabled', { crashes: 3 });
    assert.strictEqual(s.host.status().state, 'disabled');
    assert.strictEqual(s.host.current(), null);
    s.advance(RETRY * 10);
    s.host.current();
    assert.strictEqual(s.runner.loads.length, 1, 'disabled is not retried on a timer');
    s.host.retry();
    assert.ok(s.runner.resets >= 1);
    assert.strictEqual(s.runner.loads.length, 2);
  });

  it('openai: built through createProvider, ready at once; a failed call reported with fail() makes it unavailable once', async () => {
    const s = setup({ kind: 'openai' });
    s.host.start();
    assert.strictEqual(s.host.status().state, 'ready');
    assert.deepStrictEqual(s.providers.map((p) => [p.kind, p.cfg.openai.model]), [['openai', 'text-embedding-3-small']]);
    assert.strictEqual(s.host.current().name, 'openai:text-embedding-3-small');
    s.host.fail(Object.assign(new Error('401 invalid key'), { status: 401 }));
    s.host.fail(Object.assign(new Error('401 invalid key'), { status: 401 }));
    assert.strictEqual(s.host.status().state, 'unavailable');
    assert.strictEqual(s.notices.length, 1);
    s.host.fail(new EmbedError('MODEL_CHANGED', 'switched'));
    assert.strictEqual(s.notices.length, 1, 'a switch race is not a failure');
  });

  it('a provider that cannot be built is unavailable with its message', () => {
    const s = setup({ kind: 'openai' });
    s.host.getSettings = () => ({ history: { embedder: { kind: 'openai' } } });
    s.host.createProvider = () => { throw new Error('No OpenAI key is saved'); };
    s.host.start();
    assert.strictEqual(s.host.status().state, 'unavailable');
    assert.match(s.host.status().error, /No OpenAI key/);
  });

  it('rerank loads the cross-encoder once and passes a deadline', async () => {
    const s = setup({ kind: 'none' });
    await assert.rejects(s.host.rerank('gate', ['a']), (err) => err.code === 'RERANK_UNAVAILABLE');
    s.host.start();
    const first = s.host.rerank('gate', ['a', 'b'], { maxMs: 500 });
    assert.deepStrictEqual(s.runner.loads.map((l) => [l.role, l.model]), [['reranker', 'Xenova/ms-marco-MiniLM-L-6-v2']]);
    s.runner.loads[0].resolve({ dim: null });
    assert.deepStrictEqual(await first, [0, 1]);
    assert.strictEqual(s.runner.lastRerank.opts.deadlineMs, 500);
    await s.host.rerank('gate', ['c']);
    assert.strictEqual(s.runner.loads.length, 1, 'loaded once');
    await s.host.stop();
    assert.strictEqual(s.runner.stopped, true);
  });
});

describe('FakeEmbedRunner', () => {
  it('serves the host in process: ready, unit vectors, a reranker', async () => {
    const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
    const runner = new FakeEmbedRunner();
    const host = new EmbedderHost({
      getSettings: () => ({ history: { embedder: { kind: 'local', model: 'Xenova/all-MiniLM-L6-v2' } } }),
      modelsDir: '/data/models',
      createRunner: () => runner,
      createProvider: () => { throw new Error('not used'); },
      log: { warn() {}, info() {}, debug() {} }
    });
    host.start();
    for (let i = 0; i < 5 && host.status().state !== 'ready'; i++) await flush();
    const e = host.current();
    assert.ok(e, 'ready');
    const [v] = await e.embed(['gate code']);
    assert.strictEqual(e.dim, v.length);
    assert.ok(Math.abs(v.reduce((s2, x) => s2 + x * x, 0) - 1) < 1e-5);
    const scores = await host.rerank('gate', ['gate code', 'lunch']);
    assert.strictEqual(scores.length, 2);
    await host.stop();
    assert.strictEqual(runner.stopped, true);
  });
});

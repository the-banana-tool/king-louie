// tests/history-embed-runner.test.js
// EmbedRunner over a real child process running the embed worker with the
// fake backend (recall spec §5.2, §15): priorities, crashes and restarts,
// the disable rule, timeouts, a model switch, stop, idle unref.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmbedRunner } = require('../src/history/embed-runner');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const BACKEND = require.resolve('./helpers/fake-embed-backend');
const MODELS = path.join(os.tmpdir(), 'kl-embed-models-unused');
const runners = [];
afterEach(async () => { while (runners.length) await runners.pop().stop(); });
const make = (opts = {}) => {
  const r = new EmbedRunner({ testBackend: BACKEND, backoffMs: [20, 20, 20], ...opts });
  runners.push(r);
  return r;
};
const load = (r, model = 'fake/one') => r.load('embedder', model, { modelsDir: MODELS });

describe('EmbedRunner', () => {
  it('loads with progress, then embeds in document slices, in order', async () => {
    const r = make();
    const progress = [];
    r.on('progress', (p) => progress.push([p.role, p.model, p.loaded]));
    assert.deepStrictEqual(await load(r), { dim: 28 });
    assert.deepStrictEqual(progress, [['embedder', 'fake/one', 50], ['embedder', 'fake/one', 100]]);
    const texts = Array.from({ length: 20 }, (_, i) => (i === 7 ? 'linen bandage' : `gate code ${i}`));
    const vecs = await r.embed('fake/one', texts);
    assert.strictEqual(vecs.length, 20);
    assert.ok(vecs.every((v) => v instanceof Float32Array && v.length === 28));
    assert.notDeepStrictEqual(Array.from(vecs[7]), Array.from(vecs[6]), 'each vector is its own text\'s');
    assert.strictEqual(r.state, 'running');
  });

  it('a query goes before document slices already queued', async () => {
    const r = make();
    await load(r);
    const order = [];
    const doc = (n) => r.embed('fake/one', Array.from({ length: 8 }, () => `__slow__ gate ${n}`)).then(() => order.push(`doc${n}`));
    const jobs = [doc(1), doc(2), doc(3)];
    await new Promise((resolve) => setImmediate(resolve));
    jobs.push(r.embed('fake/one', ['gate code'], { priority: 'query' }).then(() => order.push('query')));
    await Promise.all(jobs);
    assert.deepStrictEqual(order, ['doc1', 'query', 'doc2', 'doc3']);
  });

  it('a crash fails the request in flight; the next runs on a fresh worker with the model reloaded', async () => {
    const r = make();
    const crashes = [];
    r.on('crashed', (e) => crashes.push(e));
    await load(r);
    await assert.rejects(r.embed('fake/one', ['__crash__ gate']), (err) => err.code === 'EMBED_WORKER_CRASHED' && /code 70/.test(err.message));
    assert.strictEqual(crashes.length, 1);
    assert.strictEqual(crashes[0].code, 70);
    const [v] = await r.embed('fake/one', ['gate code']);
    assert.strictEqual(v.length, 28);
  });

  it('a query waits no longer than the query timeout, even behind a slow slice; the worker is not killed for it', async () => {
    const r = make({ timeouts: { query: 30 } });
    const crashes = [];
    r.on('crashed', (e) => crashes.push(e));
    await load(r);
    let docDone = false;
    const doc = r.embed('fake/one', ['__slow__ gate']).then((v) => { docDone = true; return v; });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(r.embed('fake/one', ['gate code'], { priority: 'query' }), (err) => err.code === 'EMBED_WORKER_TIMEOUT');
    assert.strictEqual(docDone, false, 'the query gave up before the slow slice finished');
    assert.strictEqual((await doc).length, 1);
    assert.deepStrictEqual(crashes, []);
  });

  it('three crashes in the window disable it for the session; reset() brings it back', async () => {
    const r = make();
    let disabled = 0;
    r.on('disabled', () => { disabled += 1; });
    await load(r);
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(r.embed('fake/one', ['__crash__']), (err) => err.code === 'EMBED_WORKER_CRASHED');
    }
    assert.strictEqual(disabled, 1);
    assert.strictEqual(r.disabled, true);
    assert.strictEqual(r.state, 'disabled');
    await assert.rejects(r.embed('fake/one', ['gate']), (err) => err.code === 'EMBED_DISABLED');
    r.reset();
    assert.strictEqual((await r.embed('fake/one', ['gate']))[0].length, 28);
  });

  it('crashes outside the window do not add up', async () => {
    let clock = 0;
    const r = make({ now: () => clock, crashWindowMs: 1000 });
    await load(r);
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(r.embed('fake/one', ['__crash__']), (err) => err.code === 'EMBED_WORKER_CRASHED');
      clock += 2000;
    }
    assert.strictEqual(r.disabled, false);
  });

  it('a request past its timeout kills the hung worker (EMBED_WORKER_TIMEOUT); the next works', async () => {
    const r = make({ timeouts: { document: 300 } });
    await load(r);
    await assert.rejects(r.embed('fake/one', ['__hang__']), (err) => err.code === 'EMBED_WORKER_TIMEOUT');
    assert.strictEqual((await r.embed('fake/one', ['gate']))[0].length, 28);
  });

  it('a model switch refuses the old model\'s queued slices; the one in flight finishes', async () => {
    const r = make();
    await load(r, 'fake/one');
    const first = r.embed('fake/one', ['__slow__ gate']);
    const queued = r.embed('fake/one', ['gate again']);
    const switched = load(r, 'fake/two');
    assert.strictEqual((await first).length, 1);
    await assert.rejects(queued, (err) => err.code === 'MODEL_CHANGED');
    await switched;
    assert.strictEqual((await r.embed('fake/two', ['gate']))[0].length, 28);
    await assert.rejects(r.embed('fake/one', ['gate']), (err) => err.code === 'MODEL_CHANGED');
  });

  it('a model that fails to load fails its load and the requests waiting on it', async () => {
    const r = make();
    const loading = load(r, 'fake/missing');
    const waiting = r.embed('fake/missing', ['gate']);
    await assert.rejects(loading, (err) => err.code === 'MODEL_UNAVAILABLE' && /offline/.test(err.message));
    await assert.rejects(waiting, (err) => err.code === 'MODEL_UNAVAILABLE');
  });

  it('reranks in length-sorted slices, scores back in the given order; a passed deadline rejects RERANK_TIMEOUT', async () => {
    const r = make();
    await r.load('reranker', 'fake/rr', { modelsDir: MODELS });
    const texts = ['a linen bandage and more linen', 'the tomb', ...Array.from({ length: 30 }, (_, i) => `filler ${i}`)];
    const scores = await r.rerank('fake/rr', 'linen bandage', texts);
    assert.strictEqual(scores.length, 32);
    assert.ok(scores[0] > scores[1]);
    await assert.rejects(r.rerank('fake/rr', 'linen', ['x'], { deadlineMs: Date.now() - 1 }), (err) => err.code === 'RERANK_TIMEOUT');
  });

  it('a worker that exits before any reply gets the packaged-app hint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-quick-exit-'));
    const workerPath = path.join(dir, 'exit.js');
    fs.writeFileSync(workerPath, 'process.exit(3);\n');
    try {
      const r = make({ workerPath });
      await assert.rejects(load(r), (err) => err.code === 'EMBED_WORKER_CRASHED' && /RunAsNode/.test(err.message) && /onnxruntime-node/.test(err.message));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() fails what is queued and in flight with EMBED_STOPPED, and later calls too', async () => {
    const r = make();
    await load(r);
    const hung = r.embed('fake/one', ['__hang__']);
    const queued = r.embed('fake/one', ['gate']);
    await new Promise((resolve) => setImmediate(resolve));
    // Watch both before stop() rejects them, so neither rejection goes unhandled.
    const hungFails = assert.rejects(hung, (err) => err.code === 'EMBED_STOPPED');
    const queuedFails = assert.rejects(queued, (err) => err.code === 'EMBED_STOPPED');
    await r.stop();
    await hungFails;
    await queuedFails;
    await assert.rejects(r.embed('fake/one', ['gate']), (err) => err.code === 'EMBED_STOPPED');
    assert.strictEqual(r.state, 'stopped');
  });

  it('idleUnref: a process that used the runner and never stopped it still exits', () => {
    const script = `
      const { EmbedRunner } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'history', 'embed-runner'))});
      const r = new EmbedRunner({ testBackend: ${JSON.stringify(BACKEND)}, idleUnref: true });
      r.load('embedder', 'fake/one', { modelsDir: ${JSON.stringify(MODELS)} })
        .then(() => r.embed('fake/one', ['gate']))
        .then((v) => process.stdout.write('embedded ' + v[0].length + '\\n'));
    `;
    const out = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /embedded 28/);
  });
});

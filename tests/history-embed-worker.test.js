// tests/history-embed-worker.test.js
// The embed worker's protocol (recall spec §5.2), in process: runWorker over
// a PassThrough stdin with the fake backend. The spawned process is Task 6's.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { runWorker } = require('../src/history/embed-worker');
const { encodeMessage, LineReader, base64ToVec, vecToBase64 } = require('../src/history/embed-protocol');
const { createBackend } = require('./helpers/fake-embed-backend');

const MODELS = require('path').join(require('os').tmpdir(), 'kl-embed-models-unused');

function harness() {
  const input = new PassThrough();
  const messages = [];
  const exits = [];
  let wake = () => {};
  const reader = new LineReader({ onMessage: (m) => { messages.push(m); wake(); }, onError: (err) => { throw err; } });
  runWorker({ input, write: (s) => reader.push(Buffer.from(s, 'utf8')), backend: createBackend({ inProcess: true }), exit: (code) => exits.push(code) });
  const send = (msg) => input.write(encodeMessage(msg));
  const reply = async (id) => {
    for (;;) {
      const r = messages.find((m) => m.id === id && m.event === undefined);
      if (r) return r;
      await new Promise((resolve) => { wake = resolve; });
    }
  };
  return { input, send, reply, messages, exits };
}

describe('embed protocol', () => {
  it('reads lines split anywhere, even inside a multi-byte character', () => {
    const got = [];
    const r = new LineReader({ onMessage: (m) => got.push(m), onError: (e) => { throw e; } });
    const bytes = Buffer.from(encodeMessage({ text: 'Lakeside lot · 4417' }) + encodeMessage({ n: 2 }), 'utf8');
    for (let i = 0; i < bytes.length; i += 3) r.push(bytes.subarray(i, i + 3));
    assert.deepStrictEqual(got, [{ text: 'Lakeside lot · 4417' }, { n: 2 }]);
  });

  it('fails on a line that is not a JSON object, or one over the size limit', () => {
    const errors = [];
    new LineReader({ onMessage: () => {}, onError: (e) => errors.push(e.message) }).push(Buffer.from('not json\n'));
    new LineReader({ onMessage: () => {}, onError: (e) => errors.push(e.message) }).push(Buffer.from('[1]\n'));
    new LineReader({ onMessage: () => {}, onError: (e) => errors.push(e.message), maxLineChars: 10 }).push(Buffer.from('{"a":"0123456789"'));
    assert.strictEqual(errors.length, 3);
  });

  it('round-trips a vector through base64', () => {
    assert.deepStrictEqual(Array.from(base64ToVec(vecToBase64(Float32Array.from([0.5, -2])))), [0.5, -2]);
  });
});

describe('runWorker', () => {
  it('load reports progress, then the dimension', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS, allowDownload: true });
    const r = await h.reply(1);
    assert.deepStrictEqual(r, { id: 1, ok: true, dim: 28 });
    assert.deepStrictEqual(h.messages.filter((m) => m.event === 'progress').map((m) => [m.id, m.loaded, m.total]), [[1, 50, 100], [1, 100, 100]]);
  });

  it('embed returns one unit vector per text, as base64 float32', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    h.send({ id: 2, op: 'embed', model: 'fake/one', texts: ['the linen bandage', 'the canopic jar'] });
    const r = await h.reply(2);
    assert.strictEqual(r.ok, true);
    const vecs = r.vectors.map(base64ToVec);
    assert.strictEqual(vecs.length, 2);
    assert.strictEqual(vecs[0].length, 28);
    assert.ok(Math.abs(vecs[0].reduce((s, x) => s + x * x, 0) - 1) < 1e-5);
  });

  it('refuses embed before a load, and for a model it does not hold', async () => {
    const h = harness();
    h.send({ id: 1, op: 'embed', model: 'fake/one', texts: ['gate'] });
    assert.strictEqual((await h.reply(1)).code, 'MODEL_NOT_LOADED');
    h.send({ id: 2, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    await h.reply(2);
    h.send({ id: 3, op: 'embed', model: 'fake/two', texts: ['gate'] });
    assert.strictEqual((await h.reply(3)).code, 'MODEL_CHANGED');
  });

  it('rerank scores each text against the query', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'reranker', model: 'fake/rr', modelsDir: MODELS });
    await h.reply(1);
    h.send({ id: 2, op: 'rerank', model: 'fake/rr', query: 'linen bandage', texts: ['the tomb', 'a linen bandage', 'linen'] });
    const { scores } = await h.reply(2);
    assert.strictEqual(scores.length, 3);
    assert.ok(scores[1] > scores[0] && scores[1] >= scores[2]);
  });

  it('a model that fails to load answers MODEL_UNAVAILABLE and the worker stays up', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/missing', modelsDir: MODELS });
    const r = await h.reply(1);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'MODEL_UNAVAILABLE');
    assert.match(r.message, /offline/);
    h.send({ id: 2, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    assert.strictEqual((await h.reply(2)).ok, true);
  });

  it('refuses a malformed request with BAD_REQUEST', async () => {
    const h = harness();
    h.send({ id: 1, op: 'load', role: 'embedder', model: 'fake/one', modelsDir: MODELS });
    await h.reply(1);
    h.send({ id: 2, op: 'embed', model: 'fake/one', texts: 'not a list' });
    assert.strictEqual((await h.reply(2)).code, 'BAD_REQUEST');
    h.send({ id: 3, op: 'dance' });
    assert.strictEqual((await h.reply(3)).code, 'BAD_REQUEST');
  });

  it('a line that is not JSON ends the worker; so does the end of stdin', async () => {
    const h = harness();
    h.input.write('garbage\n');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.exits, [1]);
    const g = harness();
    g.input.end();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(g.exits, [0]);
  });
});

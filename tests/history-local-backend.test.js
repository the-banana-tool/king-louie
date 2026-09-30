// tests/history-local-backend.test.js
// The local backend with a fake transformers.js: model folder, download
// marker, offline loads, dtypes, pooling, threads (recall spec §5.2, §15).
// No model is downloaded and no native runtime is loaded.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalBackend, modelDir, COMPLETE_MARKER } = require('../src/history/embedders/local-backend');

const MODEL = 'Xenova/bge-small-en-v1.5';
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const tempModels = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-models-')); dirs.push(d); return d; };

function fakeTransformers({ failWith = null } = {}) {
  const calls = [];
  const env = {};
  // transformers.js refuses before it reads its cache when local and remote
  // models are both off (hub.js getModelFile), so an offline load needs local on.
  const guard = () => {
    if (!env.allowLocalModels && !env.allowRemoteModels) throw new Error('Invalid configuration detected: both local and remote models are disabled.');
  };
  return {
    env,
    calls,
    async pipeline(task, model, opts) {
      calls.push({ task, model, dtype: opts.dtype, threads: opts.session_options.intraOpNumThreads, remote: env.allowRemoteModels, cacheDir: env.cacheDir });
      guard();
      if (failWith) throw failWith;
      opts.progress_callback({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 1, total: 2 });
      opts.progress_callback({ status: 'done', file: 'onnx/model_quantized.onnx' });
      return async (texts, o) => {
        calls.push({ run: texts.length, pooling: o.pooling, normalize: o.normalize });
        const d = 3;
        return { dims: [texts.length, d], data: Float32Array.from({ length: texts.length * d }, (_, i) => (i % d === 0 ? 1 : 0)) };
      };
    },
    AutoTokenizer: { from_pretrained: async () => (queries, { text_pair }) => ({ n: text_pair.length }) },
    AutoModelForSequenceClassification: {
      from_pretrained: async (model, opts) => {
        calls.push({ rerank: model, dtype: opts.dtype, remote: env.allowRemoteModels });
        guard();
        return async (inputs) => ({ logits: { data: Float32Array.from({ length: inputs.n }, (_, i) => i * 0.5) } });
      }
    }
  };
}

describe('local backend', () => {
  it('first load downloads (remote on), q8 on 2 threads with the model\'s pooling, then writes the marker; the next load is offline', async () => {
    const models = tempModels();
    const T = fakeTransformers();
    const backend = createLocalBackend({ load: () => T });
    const progress = [];
    const e = await backend.loadEmbedder({ model: MODEL, modelsDir: models, allowDownload: true, onProgress: (p) => progress.push(p.loaded) });
    assert.deepStrictEqual(T.calls[0], { task: 'feature-extraction', model: MODEL, dtype: 'q8', threads: 2, remote: true, cacheDir: models });
    assert.deepStrictEqual(progress, [1], 'only progress events are passed on');
    assert.ok(fs.existsSync(path.join(models, 'Xenova', 'bge-small-en-v1.5', COMPLETE_MARKER)));
    const vecs = await e.embed(['gate', 'fence']);
    assert.strictEqual(vecs.length, 2);
    assert.deepStrictEqual(Array.from(vecs[1]), [1, 0, 0]);
    assert.strictEqual(e.dim, 3);
    assert.deepStrictEqual(T.calls[1], { run: 2, pooling: 'cls', normalize: true });
    await backend.loadEmbedder({ model: MODEL, modelsDir: models, allowDownload: true });
    assert.strictEqual(T.calls[2].remote, false, 'a complete model loads with remote access off');
    assert.strictEqual(T.env.allowLocalModels, true, 'and from the models folder');
    assert.strictEqual(T.env.localModelPath, models);
  });

  it('a model folder without the marker is a stopped download: it is deleted before the next try', async () => {
    const models = tempModels();
    const dir = path.join(models, 'Xenova', 'bge-small-en-v1.5', 'onnx');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model_quantized.onnx'), 'half a file');
    const T = fakeTransformers({ failWith: new Error('fetch failed') });
    await assert.rejects(createLocalBackend({ load: () => T }).loadEmbedder({ model: MODEL, modelsDir: models }), (err) => err.code === 'MODEL_UNAVAILABLE' && /fetch failed/.test(err.message));
    assert.ok(!fs.existsSync(path.join(dir, 'model_quantized.onnx')), 'the partial file is gone');
    assert.ok(!fs.existsSync(path.join(models, 'Xenova', 'bge-small-en-v1.5', COMPLETE_MARKER)), 'a failed load writes no marker');
  });

  it('allowDownload false and nothing downloaded: MODEL_UNAVAILABLE without trying', async () => {
    const T = fakeTransformers();
    await assert.rejects(createLocalBackend({ load: () => T }).loadEmbedder({ model: MODEL, modelsDir: tempModels(), allowDownload: false }), (err) => err.code === 'MODEL_UNAVAILABLE');
    assert.strictEqual(T.calls.length, 0);
  });

  it('a runtime that does not load (no onnxruntime-node, a bad native binary) is MODEL_UNAVAILABLE naming the runtime', async () => {
    const load = () => { throw Object.assign(new Error('Cannot find module onnxruntime-node'), { code: 'MODULE_NOT_FOUND' }); };
    await assert.rejects(createLocalBackend({ load }).loadEmbedder({ model: MODEL, modelsDir: tempModels() }),
      (err) => err.code === 'MODEL_UNAVAILABLE' && /runtime/.test(err.message) && /MODULE_NOT_FOUND/.test(err.message));
  });

  it('refuses a model id that is not a plain org/name, and a relative models folder', async () => {
    for (const bad of ['../x', 'a/../b', 'a/b/c', 'C:\\x', 'org/name:tag']) {
      assert.throws(() => modelDir('/models', bad), (err) => err.code === 'MODEL_UNAVAILABLE', bad);
    }
    await assert.rejects(createLocalBackend({ load: () => fakeTransformers() }).loadEmbedder({ model: MODEL, modelsDir: 'models' }), (err) => err.code === 'MODEL_UNAVAILABLE');
  });

  it('the reranker loads fp32 and scores from the logits, one per text', async () => {
    const T = fakeTransformers();
    const r = await createLocalBackend({ load: () => T }).loadReranker({ model: 'Xenova/ms-marco-MiniLM-L-6-v2', modelsDir: tempModels() });
    assert.deepStrictEqual(T.calls[0], { rerank: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'fp32', remote: true });
    assert.deepStrictEqual(await r.score('gate', ['a', 'b', 'c']), [0, 0.5, 1]);
  });
});

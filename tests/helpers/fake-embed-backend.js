// tests/helpers/fake-embed-backend.js
// A stand-in for src/history/embedders/local-backend.js (tests only). The
// embed worker loads it when KL_EMBED_WORKER_BACKEND names this file, which
// EmbedRunner sets only for an explicit testBackend. Vectors are the
// bag-of-words of fake-embedder.js (28 dims). Texts steer it:
//   "__crash__"  the worker process exits (a native crash); in-process, the
//                call throws EMBED_WORKER_CRASHED instead
//   "__hang__"   never answers
//   "__slow__"   answers after 150 ms
// Model "fake/missing" fails to load like a download with no network. Every
// load reports two progress events.
const { createBagOfWordsEmbedder, DEFAULT_VOCAB } = require('./fake-embedder');

function createBackend({ inProcess = false } = {}) {
  const bow = createBagOfWordsEmbedder();
  const steer = async (texts) => {
    if (texts.some((t) => String(t).includes('__crash__'))) {
      if (!inProcess) process.exit(70);
      throw Object.assign(new Error('the embed worker exited (code 70)'), { code: 'EMBED_WORKER_CRASHED' });
    }
    if (texts.some((t) => String(t).includes('__hang__'))) await new Promise(() => {});
    if (texts.some((t) => String(t).includes('__slow__'))) await new Promise((r) => setTimeout(r, 150));
  };
  const load = async ({ model, onProgress = () => {} }) => {
    if (model === 'fake/missing') throw Object.assign(new Error('fake/missing could not be loaded: fetch failed (offline)'), { code: 'MODEL_UNAVAILABLE' });
    onProgress({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 50, total: 100 });
    onProgress({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 100, total: 100 });
  };
  return {
    async loadEmbedder(opts) {
      await load(opts);
      return {
        dim: DEFAULT_VOCAB.length,
        async embed(texts) {
          await steer(texts);
          return (await bow.embed(texts)).map((v) => Float32Array.from(v));
        }
      };
    },
    async loadReranker(opts) {
      await load(opts);
      return {
        dim: null,
        async score(query, texts) {
          await steer(texts);
          const [q, ...docs] = await bow.embed([query, ...texts]);
          return docs.map((d) => d.reduce((s, x, i) => s + x * q[i], 0));
        }
      };
    }
  };
}

module.exports = { createBackend };

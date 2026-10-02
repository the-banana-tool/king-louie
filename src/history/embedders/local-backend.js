// src/history/embedders/local-backend.js
// The local models, loaded only inside the embed worker (recall spec §5.2,
// §6.3 step 6): an embedding model through @huggingface/transformers'
// feature-extraction pipeline (int8, CPU) and the cross-encoder the H3 rerank
// probe measured (fp32, CPU; it was src/longhaul/rerank.js's
// loadCrossEncoder). Both run on the native onnxruntime-node; transformers.js
// has no WASM path in Node (Appendix A.3).
//
// Model files download once into <modelsDir>/<org>/<name>/ and load from
// there afterwards with remote access off, so a model that downloaded works
// offline. A load that finished writes COMPLETE_MARKER; a model folder
// without it is a download that stopped part way, and it is deleted before
// the next try (spec §15: partial files are discarded).
const fs = require('fs');
const path = require('path');
const { profileFor } = require('./profiles');
const { LOCAL_MODEL_RE } = require('../settings');

const COMPLETE_MARKER = '.kl-complete.json';
const EMBED_DTYPE = 'q8';
const RERANK_DTYPE = 'fp32';
// ONNX threads per session: background work on a desktop takes two cores,
// not all of them.
const WORKER_THREADS = 2;
const RERANK_MAX_LENGTH = 512;

const unavailable = (message) => Object.assign(new Error(message), { code: 'MODEL_UNAVAILABLE' });

function modelDir(modelsDir, model) {
  if (typeof model !== 'string' || !LOCAL_MODEL_RE.test(model) || model.split('/').some((seg) => /^\.+$/.test(seg))) {
    throw unavailable(`not a local model id (org/name): ${JSON.stringify(model)}`);
  }
  return path.join(modelsDir, ...model.split('/'));
}

function createLocalBackend({ load = () => require('@huggingface/transformers'), threads = WORKER_THREADS } = {}) {
  let T = null;
  const sessionOptions = { intraOpNumThreads: threads, interOpNumThreads: 1 };

  function prepare({ model, modelsDir, allowDownload }) {
    if (typeof modelsDir !== 'string' || !path.isAbsolute(modelsDir)) throw unavailable(`${model} could not be loaded: no models folder`);
    const dir = modelDir(modelsDir, model);
    const marker = path.join(dir, COMPLETE_MARKER);
    const complete = fs.existsSync(marker);
    if (!complete && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (!complete && !allowDownload) throw unavailable(`${model} is not downloaded`);
    if (!T) {
      try {
        T = load();
      } catch (err) {
        const why = [err && err.code, err && err.message].filter(Boolean).join(': ');
        throw unavailable(`the local model runtime did not load (${why}); @huggingface/transformers and onnxruntime-node must be installed with a native binary for this platform`);
      }
    }
    // A complete model loads with remote access off. transformers.js refuses
    // outright when local and remote are both off, before it reads its cache,
    // so local is on then, pointed at the same folder (its cache and local
    // layouts are both <dir>/<org>/<name>/), never the library's own models/.
    T.env.cacheDir = modelsDir;
    T.env.localModelPath = modelsDir;
    T.env.allowLocalModels = complete;
    T.env.allowRemoteModels = !complete;
    return { dir, marker, complete };
  }

  function finish({ dir, marker, complete }, model, dtype) {
    if (complete) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ model, dtype, at: new Date().toISOString() })}\n`);
  }

  const progressOf = (onProgress) => (e) => {
    if (e && e.status === 'progress') onProgress(e);
  };

  return {
    async loadEmbedder({ model, modelsDir, allowDownload = true, onProgress = () => {} }) {
      const p = prepare({ model, modelsDir, allowDownload });
      const { pooling } = profileFor(model);
      let extractor;
      try {
        extractor = await T.pipeline('feature-extraction', model, {
          dtype: EMBED_DTYPE, device: 'cpu', session_options: sessionOptions, progress_callback: progressOf(onProgress)
        });
      } catch (err) {
        throw unavailable(`${model} could not be loaded: ${err.message}`);
      }
      finish(p, model, EMBED_DTYPE);
      let dim = null;
      return {
        get dim() { return dim; },
        async embed(texts) {
          const out = await extractor(texts, { pooling, normalize: true });
          const [n, d] = out.dims;
          dim = d;
          const vecs = [];
          for (let i = 0; i < n; i++) vecs.push(Float32Array.from(out.data.subarray(i * d, (i + 1) * d)));
          return vecs;
        }
      };
    },

    async loadReranker({ model, modelsDir, allowDownload = true, onProgress = () => {} }) {
      const p = prepare({ model, modelsDir, allowDownload });
      let tokenizer;
      let net;
      try {
        const progress_callback = progressOf(onProgress);
        tokenizer = await T.AutoTokenizer.from_pretrained(model, { progress_callback });
        net = await T.AutoModelForSequenceClassification.from_pretrained(model, {
          dtype: RERANK_DTYPE, device: 'cpu', session_options: sessionOptions, progress_callback
        });
      } catch (err) {
        throw unavailable(`${model} could not be loaded: ${err.message}`);
      }
      finish(p, model, RERANK_DTYPE);
      return {
        dim: null,
        async score(query, texts) {
          const inputs = tokenizer(new Array(texts.length).fill(query), {
            text_pair: texts, padding: true, truncation: true, max_length: RERANK_MAX_LENGTH
          });
          const { logits } = await net(inputs);
          const width = logits.data.length / texts.length;
          return texts.map((_, k) => Number(logits.data[k * width]));
        }
      };
    }
  };
}

module.exports = {
  createLocalBackend, createBackend: () => createLocalBackend(), modelDir,
  COMPLETE_MARKER, EMBED_DTYPE, RERANK_DTYPE, WORKER_THREADS
};

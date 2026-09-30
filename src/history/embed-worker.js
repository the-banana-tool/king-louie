// src/history/embed-worker.js
// The embed worker process (recall spec §3, §5.2). EmbedRunner spawns it the
// way pdf-sandbox.js spawns the PDF worker: from process.execPath with
// ELECTRON_RUN_AS_NODE=1 (the app binary in a packaged build, plain node in
// the service and LongHaul), no IPC channel, requests on stdin and replies on
// fd 3 (embed-protocol.js). It holds at most one embedding model and one
// cross-encoder, loaded on request, and answers one request at a time, in
// order. Native onnxruntime runs here: a crash kills this process, never the
// app. It exits when stdin ends (the parent closed it or died), when the
// parent is gone, or on a line it cannot read.
const net = require('node:net');
const { LineReader, encodeMessage, vecToBase64 } = require('./embed-protocol');

const PARENT_POLL_MS = 5000;
const CODES = new Set(['MODEL_UNAVAILABLE', 'MODEL_NOT_LOADED', 'MODEL_CHANGED', 'BAD_REQUEST', 'EMBED_FAILED']);
const coded = (code, message) => Object.assign(new Error(message), { code });
const isTexts = (v) => Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === 'string');

function runWorker({ input, write, backend, exit = (code) => process.exit(code) }) {
  const loaded = { embedder: null, reranker: null };
  let queue = Promise.resolve();
  const reply = (msg) => write(encodeMessage(msg));
  const fail = (id, err) => reply({
    id,
    ok: false,
    code: CODES.has(err && err.code) ? err.code : 'EMBED_FAILED',
    message: String((err && err.message) || err).slice(0, 300)
  });

  const holding = (role, model) => {
    const cur = loaded[role];
    if (!cur) throw coded('MODEL_NOT_LOADED', `no ${role} model is loaded`);
    if (cur.model !== model) throw coded('MODEL_CHANGED', `${model} is not the loaded ${role} model (${cur.model})`);
    return cur.handle;
  };

  async function handle(msg) {
    const { id, op } = msg;
    if (op === 'load') {
      const role = msg.role === 'reranker' ? 'reranker' : 'embedder';
      if (typeof msg.model !== 'string' || !msg.model) throw coded('BAD_REQUEST', 'load needs a model');
      const cur = loaded[role];
      if (cur && cur.model === msg.model) return reply({ id, ok: true, dim: cur.handle.dim ?? null });
      const onProgress = (p) => {
        if (p && p.status === 'progress') reply({ event: 'progress', id, file: String(p.file || ''), loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
      };
      loaded[role] = null;
      const opts = { model: msg.model, modelsDir: msg.modelsDir, allowDownload: msg.allowDownload !== false, onProgress };
      const h = role === 'reranker' ? await backend.loadReranker(opts) : await backend.loadEmbedder(opts);
      loaded[role] = { model: msg.model, handle: h };
      return reply({ id, ok: true, dim: h.dim ?? null });
    }
    if (op === 'embed') {
      if (!isTexts(msg.texts)) throw coded('BAD_REQUEST', 'embed needs a list of texts');
      const vectors = await holding('embedder', msg.model).embed(msg.texts);
      return reply({ id, ok: true, vectors: vectors.map(vecToBase64) });
    }
    if (op === 'rerank') {
      if (!isTexts(msg.texts) || typeof msg.query !== 'string') throw coded('BAD_REQUEST', 'rerank needs a query and a list of texts');
      const scores = await holding('reranker', msg.model).score(msg.query, msg.texts);
      return reply({ id, ok: true, scores: Array.from(scores, Number) });
    }
    throw coded('BAD_REQUEST', `unknown op ${JSON.stringify(op)}`);
  }

  const reader = new LineReader({
    onMessage: (msg) => {
      queue = queue.then(() => handle(msg)).catch((err) => fail(msg.id, err));
    },
    onError: () => exit(1)
  });
  input.on('data', (chunk) => reader.push(chunk));
  input.on('end', () => exit(0));
  return { reader };
}

if (require.main === module) {
  const out = new net.Socket({ fd: 3, readable: false, writable: true });
  out.on('error', () => process.exit(1));
  const backendPath = process.env.KL_EMBED_WORKER_BACKEND;
  const backend = (backendPath ? require(backendPath) : require('./embedders/local-backend')).createBackend();
  runWorker({ input: process.stdin, write: (s) => out.write(s), backend });
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (err) {
      if (err.code !== 'EPERM') process.exit(0);
    }
  }, PARENT_POLL_MS).unref();
}

module.exports = { runWorker };

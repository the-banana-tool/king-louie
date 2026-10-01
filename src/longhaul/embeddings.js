'use strict';
// Embedding cache for the H3 probe (kl-recall-vec, `longhaul embed`). Vectors
// of a session's chunks and questions live under
// LONGHAUL_HOME/private/embeddings/<sessionId>/<model>/, never anywhere else:
//   meta.json       { model, provider, dim, chunk, maxChars, tokens, ... }
//   index.jsonl     one { messageId, idx, chars, truncated } per chunk row
//   vectors.f32     the rows, little-endian float32, dim per row, same order
//   questions.jsonl one { id, textSha256, vec (base64 LE float32) } per question
// Chunks are keyed by (messageId, idx), not by a store's chunk row id, so the
// cache lines up with any store built from the same session and chunk
// settings. Rows are appended a batch at a time (vectors first, then index
// lines), so an interrupted run resumes: on open, vectors past the last index
// line are cut off.
const fs = require('fs');
const path = require('path');
const { sha256Text, readJsonl } = require('./files');
const { UsageError } = require('./errors');
const { withRetries } = require('./retry');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/embeddings');

// text-embedding-3-* take at most 8191 tokens per input. 6000 characters is
// under that even at one character per token; a longer chunk is embedded
// from its first MAX_EMBED_CHARS characters (index.jsonl marks it truncated).
const MAX_EMBED_CHARS = 6000;
// Per request: at most --batch inputs and at most this many characters, well
// under the provider's per-request token cap.
const MAX_BATCH_CHARS = 400000;
// A model id, optionally org/name (the app's local models); a ':' tag is
// allowed for hosted ids. No dot-only segment: it becomes a folder.
const MODEL_RE = /^[A-Za-z0-9._:-]{1,100}(\/[A-Za-z0-9._-]{1,100})?$/;

const keyOf = (messageId, idx) => `${messageId}\u0000${idx}`;

function validateModelName(model) {
  const s = String(model || '');
  if (!MODEL_RE.test(s) || s.split('/').some((seg) => /^\.+$/.test(seg))) {
    throw new UsageError(`--model must be a plain model id (org/name; letters, digits, . _ : -), got ${JSON.stringify(model)}`);
  }
  return s;
}

function cacheDir(privateRoot, sessionId, model) {
  return path.join(privateRoot, 'embeddings', sessionId, validateModelName(model).replace(/:/g, '_').replace(/\//g, '__'));
}

const embedText = (text) => {
  const s = String(text || '');
  return s.length > MAX_EMBED_CHARS ? { text: s.slice(0, MAX_EMBED_CHARS), truncated: true } : { text: s, truncated: false };
};

function toBytes(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(Number(vec[i]), i * 4);
  return buf;
}

function fromBytes(buf, offset = 0, dim = (buf.length - offset) / 4) {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(offset + i * 4);
  return out;
}

// The chunk cache of one session and model. open() reads what is there;
// append() adds rows; nothing here prints or logs chunk text.
class EmbeddingCache {
  constructor(dir) {
    this.dir = dir;
    this.files = {
      meta: path.join(dir, 'meta.json'),
      index: path.join(dir, 'index.jsonl'),
      vectors: path.join(dir, 'vectors.f32'),
      questions: path.join(dir, 'questions.jsonl')
    };
    this.meta = null;
    this.rows = [];
    this.byKey = new Map();
    this.vectors = null; // Float32Array, rows * dim
    this.questions = new Map();
  }

  static open(dir) {
    const cache = new EmbeddingCache(dir);
    cache._load();
    return cache;
  }

  get dim() { return this.meta?.dim ?? null; }
  get exists() { return this.meta !== null; }

  _load() {
    if (!fs.existsSync(this.files.meta)) return;
    this.meta = JSON.parse(fs.readFileSync(this.files.meta, 'utf8'));
    const rows = readJsonl(this.files.index, { tornTail: true }); // a torn last line ends the file
    const dim = this.meta.dim;
    const bytes = fs.existsSync(this.files.vectors) ? fs.readFileSync(this.files.vectors) : Buffer.alloc(0);
    const whole = Number.isInteger(dim) && dim > 0 ? Math.floor(bytes.length / (dim * 4)) : 0;
    const n = Math.min(rows.length, whole);
    if (n < rows.length || n < whole) {
      log.warn('embedding cache had a torn tail; keeping the complete rows', { rows: rows.length, vectors: whole, kept: n });
    }
    this.rows = rows.slice(0, n);
    this.vectors = new Float32Array(n * (dim || 0));
    for (let r = 0; r < n; r++) this.vectors.set(fromBytes(bytes, r * dim * 4, dim), r * dim);
    this.byKey = new Map(this.rows.map((row, i) => [keyOf(row.messageId, row.idx), i]));
    for (const q of readJsonl(this.files.questions, { tornTail: true })) {
      if (q && typeof q.id === 'string' && typeof q.vec === 'string') this.questions.set(q.id, q);
    }
  }

  // The on-disk files cut to the rows open() kept, so appends line up.
  _repairTail() {
    if (!this.meta) return;
    const want = this.rows.length * this.meta.dim * 4;
    if (fs.existsSync(this.files.vectors) && fs.statSync(this.files.vectors).size !== want) fs.truncateSync(this.files.vectors, want);
    const lines = this.rows.map((r) => JSON.stringify(r)).join('\n');
    const current = fs.existsSync(this.files.index) ? fs.readFileSync(this.files.index, 'utf8') : '';
    const expected = lines ? `${lines}\n` : '';
    if (current !== expected) fs.writeFileSync(this.files.index, expected);
  }

  // Creates the cache, or checks that an existing one was made the same way.
  init({ model, provider, dim, chunk, sessionId }) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.meta) {
      if (this.meta.model !== model || JSON.stringify(this.meta.chunk) !== JSON.stringify(chunk)) {
        throw new UsageError(`The embedding cache in ${this.dir} was made with other settings (model or chunking); move it aside to start over.`);
      }
      if (dim !== null && this.meta.dim !== dim) throw new UsageError(`The embedding cache in ${this.dir} holds ${this.meta.dim}-dim vectors, not ${dim}.`);
      this._repairTail();
      return;
    }
    this.meta = { version: 1, sessionId, model, provider, dim, chunk, maxChars: MAX_EMBED_CHARS, tokens: 0, chunksTotal: null };
    this._writeMeta();
  }

  _writeMeta() {
    const tmp = `${this.files.meta}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.meta, null, 2)}\n`);
    fs.renameSync(tmp, this.files.meta);
  }

  setMeta(patch) {
    Object.assign(this.meta, patch);
    this._writeMeta();
  }

  has(messageId, idx) { return this.byKey.has(keyOf(messageId, idx)); }
  rowOf(messageId, idx) { return this.byKey.get(keyOf(messageId, idx)); }

  // rows: [{ messageId, idx, chars, truncated }], vectors: number[][] in the same order.
  append(rows, vectors, { tokens = 0 } = {}) {
    if (rows.length !== vectors.length) throw new Error('append: rows and vectors differ in length');
    if (!rows.length) return;
    if (this.meta.dim === null) this.setMeta({ dim: vectors[0].length });
    const dim = this.meta.dim;
    for (const v of vectors) if (v.length !== dim) throw new Error(`append: a ${v.length}-dim vector in a ${dim}-dim cache`);
    fs.appendFileSync(this.files.vectors, Buffer.concat(vectors.map(toBytes)));
    fs.appendFileSync(this.files.index, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const grown = new Float32Array((this.rows.length + rows.length) * dim);
    grown.set(this.vectors || new Float32Array(0));
    vectors.forEach((v, i) => grown.set(v, (this.rows.length + i) * dim));
    this.vectors = grown;
    for (const r of rows) {
      this.byKey.set(keyOf(r.messageId, r.idx), this.rows.length);
      this.rows.push(r);
    }
    if (tokens) this.setMeta({ tokens: (this.meta.tokens || 0) + tokens });
  }

  vector(row) {
    const dim = this.meta.dim;
    return this.vectors.subarray(row * dim, (row + 1) * dim);
  }

  // A cached question vector, only while its text is unchanged.
  question(id, text) {
    const q = this.questions.get(id);
    if (!q || q.textSha256 !== sha256Text(String(text))) return null;
    return fromBytes(Buffer.from(q.vec, 'base64'));
  }

  addQuestion(id, text, vec, { tokens = 0 } = {}) {
    const line = { id, textSha256: sha256Text(String(text)), dim: vec.length, vec: toBytes(vec).toString('base64') };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.files.questions, `${JSON.stringify(line)}\n`);
    this.questions.set(id, line);
    if (tokens && this.meta) this.setMeta({ questionTokens: (this.meta.questionTokens || 0) + tokens });
  }
}

// embedder: an object with embed(inputs, { model, kind }) (OpenAIProvider#embed,
// which ignores kind; the local embedder prefixes queries and documents).
// Retries 429, 5xx and transport failures with backoff (retry.js); anything
// else throws.
function createEmbedClient({ embedder, model, maxAttempts = 6, baseDelayMs = 1000, wait }) {
  if (!embedder || typeof embedder.embed !== 'function') throw new UsageError('This provider has no embeddings call; use --provider openai.');
  const onRetry = ({ err, attempt, delayMs }) => log.warn('embeddings request failed; retrying', { status: err.status ?? null, attempt, delayMs });
  return {
    model,
    embed: (inputs, { kind = 'document' } = {}) => withRetries(() => embedder.embed(inputs, { model, kind }), { retries: maxAttempts - 1, baseDelayMs, wait, onRetry })
  };
}

// Batches of at most `batch` inputs and MAX_BATCH_CHARS characters.
function batches(items, batch, maxChars = MAX_BATCH_CHARS) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= batch || chars + it.text.length > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Embeds the chunks the cache lacks. chunks: store rows ({ messageId, idx,
// text }). progress(done, total) after each batch. Returns counts and tokens.
async function embedChunks({ cache, client, chunks, batch = 100, progress = () => {} }) {
  const todo = [];
  for (const c of chunks) {
    if (cache.has(c.messageId, c.idx)) continue;
    const { text, truncated } = embedText(c.text);
    todo.push({ messageId: c.messageId, idx: c.idx, chars: String(c.text).length, truncated, text: text.trim() ? text : ' ' });
  }
  let tokens = 0;
  let done = 0;
  for (const group of batches(todo, batch)) {
    const res = await client.embed(group.map((g) => g.text), { kind: 'document' });
    const used = Number.isFinite(res.usage?.input) ? res.usage.input : 0;
    tokens += used;
    cache.append(group.map(({ messageId, idx, chars, truncated }) => ({ messageId, idx, chars, truncated })), res.vectors, { tokens: used });
    done += group.length;
    progress(done, todo.length);
  }
  return { embedded: todo.length, truncated: todo.filter((t) => t.truncated).length, tokens };
}

// Normalised rows of a store's chunks, in the store's chunk order, from the
// cache. Throws naming `longhaul embed` when any chunk has no vector.
function vectorIndexFor(cache, chunks, { sessionId, model }) {
  const hint = `run: longhaul embed --session ${sessionId} --provider openai --model ${model} --send-private`;
  if (!cache.exists || !cache.dim) throw new UsageError(`kl-recall-vec: no embedding cache for session ${sessionId} (${model}); ${hint}`);
  const dim = cache.dim;
  const n = chunks.length;
  const matrix = new Float32Array(n * dim);
  const chunkIds = new Int32Array(n);
  const seqs = new Int32Array(n);
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    const row = cache.rowOf(c.messageId, c.idx);
    if (row === undefined) { missing += 1; continue; }
    const v = cache.vector(row);
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) matrix[i * dim + d] = v[d] / norm;
    chunkIds[i] = c.id;
    seqs[i] = c.seq;
  }
  if (missing) throw new UsageError(`kl-recall-vec: the embedding cache for session ${sessionId} (${model}) is incomplete: ${missing} of ${n} chunks have no vector; ${hint}`);
  return { dim, matrix, chunkIds, seqs, size: n };
}

// Top k chunks by cosine to q among those with seq < upToSeq, as
// [{ chunkId, vectorRank, cosine }].
function topByCosine(index, q, { upToSeq = Infinity, k = 50 } = {}) {
  const { dim, matrix, chunkIds, seqs, size } = index;
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += q[d] * q[d];
  norm = Math.sqrt(norm) || 1;
  const scored = [];
  for (let i = 0; i < size; i++) {
    if (!(seqs[i] < upToSeq)) continue;
    let dot = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) dot += matrix[off + d] * q[d];
    scored.push({ i, cosine: dot / norm });
  }
  scored.sort((a, b) => b.cosine - a.cosine || chunkIds[a.i] - chunkIds[b.i]);
  return scored.slice(0, k).map((s, r) => ({ chunkId: chunkIds[s.i], vectorRank: r + 1, cosine: s.cosine }));
}

module.exports = {
  MAX_EMBED_CHARS, MAX_BATCH_CHARS, EmbeddingCache, cacheDir, validateModelName, embedText, toBytes, fromBytes,
  createEmbedClient, batches, embedChunks, vectorIndexFor, topByCosine, keyOf
};

// The app's local embedder (recall stage H3) for `embed` and kl-recall-vec:
// the embed worker through an EmbedRunner, models under modelsDir, the same
// prefixes the app uses. Nothing leaves this machine.
function localEmbedderFor({ runner, modelsDir }) {
  const { prefixTexts } = require('../history/embedders/profiles');
  const loading = new Map();
  return {
    local: true,
    async embed(inputs, { model, kind = 'document' } = {}) {
      if (!loading.has(model)) {
        loading.set(model, runner.load('embedder', model, { modelsDir }).catch((err) => {
          loading.delete(model);
          throw err;
        }));
      }
      await loading.get(model);
      const vectors = await runner.embed(model, prefixTexts(model, inputs, kind), { priority: kind === 'query' ? 'query' : 'document' });
      return { vectors, usage: { input: null }, model };
    }
  };
}

// Where LongHaul keeps downloaded local models (inside LONGHAUL_HOME).
const localModelsDir = (privateRoot) => path.join(privateRoot, 'models');

// The provider behind `embed` and kl-recall-vec: the key from the
// environment like model.js, an injected instance (tests), or 'local' (the
// app's embedder through an embed runner).
function embedderFromEnv({ provider, env = process.env, baseUrl = null, providerInstance = null, runner = null, modelsDir = null }) {
  if (providerInstance) return providerInstance;
  if (provider === 'local') {
    if (!runner || !modelsDir) throw new UsageError('local embedding needs an embed runner and a models folder');
    return localEmbedderFor({ runner, modelsDir });
  }
  if (!provider) throw new UsageError('--provider is required.');
  const ProviderFactory = require('../providers/provider-factory');
  let instance;
  try {
    instance = ProviderFactory.fromEnv(provider, { env, options: baseUrl ? { baseUrl } : {} });
  } catch (err) {
    if (err.code === 'NO_PROVIDER_KEY' || err.code === 'UNKNOWN_PROVIDER' || /Invalid API key/.test(err.message)) throw new UsageError(err.message);
    throw err;
  }
  if (typeof instance.embed !== 'function') throw new UsageError(`Provider ${provider} has no embeddings call here; use --provider openai.`);
  return instance;
}

// USD for `tokens` input tokens from the catalog, or null when it has no price.
function priceTokens(provider, model, tokens, catalog = null) {
  const c = catalog || require('../models').getActiveCatalog();
  const priced = c.price(provider, model, { input: tokens });
  return priced && Number.isFinite(priced.usd) ? priced.usd : null;
}

module.exports.embedderFromEnv = embedderFromEnv;
module.exports.localEmbedderFor = localEmbedderFor;
module.exports.localModelsDir = localModelsDir;
module.exports.priceTokens = priceTokens;

// src/history/embedder-host.js
// Which embedder recall uses now (recall spec §5.2, §15), from
// settings.history.embedder, and its state for the settings pane, the recall
// line and provenance. Hosts (create-core) build one; nothing loads or
// downloads until start(), which create-core calls from
// startModelsBackgroundChecks (skipped under KL_TEST_MODE).
//   off          kind none, or not started
//   starting     the local model is loading
//   downloading  the local model's files are downloading
//                (download: { role: 'embedder', loaded, total })
//   ready        embedding works
//   unavailable  the model did not load or a call failed; recall is BM25
//                only until retryMs passes, the settings change or retry()
//   disabled     the embed worker crashed three times in ten minutes; BM25
//                only for this session unless the settings change or retry()
// Each distinct failure is logged once and shown to the owner once per
// session (notify). Changing the embedder never deletes vectors: the new key
// fills in, and the old key's rows stay for a switch back. The reranker is
// always the local cross-encoder, whatever the embedder kind. When
// recall.rerank.search or rerank.enabled is on, preloadReranker() loads it at
// document priority; the core calls it when the embed indexer goes idle, so
// its one-time download (about 90 MB, the worker's only request while in
// flight) never starves the backfill or a turn's query embedding. With kind
// none nothing loads in the background: the reranker loads on the first
// SearchHistory. While it downloads, status().download is
// { role: 'reranker', loaded, total } and the state stays as it is. A
// reranker whose model did not load (MODEL_UNAVAILABLE) is RERANK_UNAVAILABLE
// (silent in the Retriever) until retryMs passes or retry(); a worker crash,
// timeout or stop during the load holds nothing off.
const { EventEmitter } = require('node:events');
const { mergeHistorySettings, embedderKey } = require('./settings');
const { createLocalEmbedder } = require('./embedders/local');
const { createRemoteEmbedder } = require('./embedders/remote');
const { EmbedError, NOT_FAILURES } = require('./embed-errors');
const { createLogger } = require('../logging');

const RETRY_MS = 10 * 60000;
const MESSAGE_MAX = 300;

function sumFiles(files) {
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  return { loaded, total };
}

class EmbedderHost extends EventEmitter {
  constructor({ getSettings, modelsDir, createRunner, createProvider, notify = () => {}, now = Date.now, retryMs = RETRY_MS, log = createLogger('history/embedder') }) {
    super();
    this.getSettings = getSettings;
    this.modelsDir = modelsDir;
    this.createRunner = createRunner;
    this.createProvider = createProvider;
    this.notify = notify;
    this.now = now;
    this.retryMs = retryMs;
    this.log = log;
    this.started = false;
    this.runner = null;
    this.key = null;
    this.kind = 'none';
    this.embedder = null;
    this.state = 'off';
    this.error = null;
    this.files = new Map();
    this.until = 0;
    this.loading = null;
    this.warned = new Set();
    this.rerankModel = null;
    this.rerankLoad = null;
    this.rerankFailed = null;
    this.rerankFiles = new Map();
  }

  _settings() {
    return mergeHistorySettings((this.getSettings() || {}).history);
  }

  start() {
    this.started = true;
    this._sync();
  }

  current() {
    this._sync();
    return this.state === 'ready' ? this.embedder : null;
  }

  status() {
    this._sync();
    let download = null;
    if (this.state === 'downloading') download = { role: 'embedder', ...sumFiles(this.files) };
    else if (this.rerankLoad && this.rerankFiles.size) download = { role: 'reranker', ...sumFiles(this.rerankFiles) };
    return { kind: this.kind, key: this.key, state: this.state, download, error: this.error, tokens: this.embedder ? this.embedder.tokens : 0 };
  }

  // Why this turn's recall cannot use vectors although they are on
  // (provenance, the recall line); null when ready or off by choice.
  reason() {
    switch (this.state) {
      case 'ready':
      case 'off': return null;
      case 'starting':
      case 'downloading': return 'the embedding model is loading';
      case 'unavailable': return `embedding model not loaded: ${this.error}`;
      case 'disabled': return 'the embedding worker kept crashing';
      default: return null;
    }
  }

  retry() {
    this.warned.clear();
    this.rerankFailed = null;
    this._switch(this.started ? embedderKey(this._settings().embedder) : null, this._settings().embedder);
  }

  // A caller's embed with the embedder under `key` failed. A failure for a
  // key that is no longer active (a hosted call that finished after a switch)
  // changes nothing; neither does a switch racing a call or a shutdown
  // (NOT_FAILURES).
  fail(err, key) {
    const code = err && err.code;
    if (NOT_FAILURES.has(code) || key !== this.key) return;
    this.embedder = null;
    this.loading = null;
    this.error = String((err && err.message) || err).slice(0, MESSAGE_MAX);
    if (code === 'EMBED_DISABLED') {
      this._set('disabled');
    } else {
      this.until = this.now() + this.retryMs;
      this._set('unavailable');
    }
    const warnKey = `${this.key}\u0000${code || (err && err.status) || 'error'}`;
    if (this.warned.has(warnKey)) return;
    this.warned.add(warnKey);
    const text = `Recall uses keyword search only: ${this.error}`;
    this.log.warn(text);
    try {
      this.notify({ title: 'King Louie', body: text });
    } catch (notifyErr) {
      this.log.warn(`Recall warning could not be shown: ${notifyErr.message}`);
    }
  }

  // The cross-encoder rerank() would use now (provenance names it).
  rerankModelName() {
    return this._settings().recall.rerank.model;
  }

  async rerank(query, texts, { maxMs = Infinity } = {}) {
    if (!this.started) throw new EmbedError('RERANK_UNAVAILABLE', 'the reranker is not started');
    const model = this._settings().recall.rerank.model;
    const failed = this._rerankFailedFor(model);
    if (failed) throw new EmbedError('RERANK_UNAVAILABLE', `the reranker did not load: ${failed.message}`);
    await this._loadReranker(model);
    return this._runner().rerank(model, query, texts, { deadlineMs: Number.isFinite(maxMs) ? this.now() + maxMs : Infinity });
  }

  // Loads the reranker in the background (see the header): only with a local
  // or hosted embedder ready, a rerank setting on, and no load in flight or
  // held off. The core calls it when the embed indexer goes idle.
  preloadReranker() {
    if (!this.started || this.kind === 'none' || this.state !== 'ready') return;
    const rerank = this._settings().recall.rerank;
    if (!rerank.search && !rerank.enabled) return;
    // Jev reranks instead (rerank.kind 'jev'): the cross-encoder's download
    // would buy nothing.
    if (rerank.kind === 'jev') return;
    if ((this.rerankLoad && this.rerankModel === rerank.model) || this._rerankFailedFor(rerank.model)) return;
    this._loadReranker(rerank.model, { priority: 'document' }).catch((err) => {
      this.log.debug(`The reranker did not preload; SearchHistory keeps the fused order: ${err.message}`);
    });
  }

  async stop() {
    this.started = false;
    if (this.runner) await this.runner.stop();
  }

  // ── internals ───────────────────────────────────────────────────────────

  _rerankFailedFor(model) {
    const f = this.rerankFailed;
    if (!f) return null;
    if (f.model !== model || this.now() >= f.until) {
      this.rerankFailed = null;
      return null;
    }
    return f;
  }

  // The reranker's load, shared by a preload and SearchHistory. Only a model
  // that did not load (MODEL_UNAVAILABLE) holds it off for retryMs; a worker
  // crash, timeout or stop leaves the next call free to load it again.
  _loadReranker(model, { priority } = {}) {
    if (this.rerankModel !== model || !this.rerankLoad) {
      this.rerankModel = model;
      this.rerankFiles = new Map();
      const settle = () => {
        if (this.rerankLoad !== load) return false;
        this.rerankFiles = new Map();
        return true;
      };
      const load = this._runner().load('reranker', model, { modelsDir: this.modelsDir, ...(priority ? { priority } : {}) }).then((out) => {
        settle();
        return out;
      }, (err) => {
        if (settle()) {
          this.rerankLoad = null;
          if (err && err.code === 'MODEL_UNAVAILABLE') {
            this.rerankFailed = { model, until: this.now() + this.retryMs, message: String(err.message || err).slice(0, MESSAGE_MAX) };
          }
        }
        throw err;
      });
      this.rerankLoad = load;
    }
    return this.rerankLoad;
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', { state, key: this.key, error: this.error });
  }

  _runner() {
    if (!this.runner) {
      this.runner = this.createRunner();
      this.runner.on('progress', (p) => {
        if (p.role === 'reranker') {
          if (this.rerankLoad && p.model === this.rerankModel) this.rerankFiles.set(p.file, { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
          return;
        }
        if (p.role !== 'embedder' || !this.loading || p.model !== this.loading.model) return;
        this.files.set(p.file, { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
        this._set('downloading');
      });
      this.runner.on('disabled', () => {
        if (this.kind === 'local') this.fail(new EmbedError('EMBED_DISABLED', 'the embedding worker crashed three times in ten minutes; local embedding is off for this session'), this.key);
      });
    }
    return this.runner;
  }

  _sync() {
    const cfg = this._settings().embedder;
    const key = this.started ? embedderKey(cfg) : null;
    if (key !== this.key || (this.state === 'unavailable' && this.now() >= this.until)) this._switch(key, cfg);
  }

  _switch(key, cfg) {
    this.key = key;
    this.kind = key ? cfg.kind : 'none';
    this.embedder = null;
    this.error = null;
    this.loading = null;
    this.files = new Map();
    if (!key) {
      this._set('off');
      return;
    }
    if (cfg.kind === 'local') {
      const runner = this._runner();
      runner.reset();
      const embedder = createLocalEmbedder({ runner, model: cfg.model, modelsDir: this.modelsDir });
      const token = { model: cfg.model };
      this.loading = token;
      this._set('starting');
      embedder.ready().then(() => {
        if (this.loading !== token) return;
        this.loading = null;
        this.embedder = embedder;
        this._set('ready');
      }, (err) => {
        if (this.loading !== token) return;
        this.fail(err, key);
      });
      return;
    }
    try {
      const model = cfg.kind === 'openai' ? cfg.openai.model : cfg.ollama.model;
      this.embedder = createRemoteEmbedder({ kind: cfg.kind, model, provider: this.createProvider(cfg.kind, cfg) });
      this._set('ready');
    } catch (err) {
      this.fail(err, key);
    }
  }
}

module.exports = { EmbedderHost, RETRY_MS };

// src/history/jev-reranker.js
// The hosted reranker (recall spec §6.3 step 6, §15): typesafe.ai's Jev,
// used when history.recall.rerank.kind is 'jev' (opt-in). It scores the
// top rerank.topM chunks through jevScores (batched) over TypesafeProvider.
// The host builds one and calls start() only from startHistoryEmbedding,
// which startModelsBackgroundChecks never calls under KL_TEST_MODE; under
// KL_TEST_MODE it also refuses on its own, before any request.
// Failures never fail a turn: rerank() throws and the Retriever keeps the
// fused order. Nothing sent: RERANK_UNAVAILABLE (no key, paused, held off,
// not started). A refused key (401/403) or an account out of credit (402,
// insufficient_quota) pauses Jev until reset() (a new key, a removed key,
// Retry); a 429/529 holds it off for the server's retry-after (slowDownMs
// without one); a call slower than maxMs is aborted at the provider. The
// owner gets one warning per failure episode (one toast and one log line);
// an episode ends at the next success or reset(). A failure that lands after
// reset() or after a switch away from 'jev' changes nothing. Messages carry
// statuses and codes only, never chat text.
const { mergeHistorySettings } = require('./settings');
const { EmbedError } = require('./embed-errors');
const { jevScores } = require('./jev-rerank');
const { createLogger } = require('../logging');

const SLOW_DOWN_MS = 30000;
const CONCURRENCY = 4;

class JevReranker {
  constructor({
    getSettings, getKey, createProvider, notify = () => {}, now = Date.now, env = process.env,
    slowDownMs = SLOW_DOWN_MS, concurrency = CONCURRENCY, log = createLogger('history/jev')
  }) {
    this.getSettings = getSettings;
    this.getKey = getKey;
    this.createProvider = createProvider;
    this.notify = notify;
    this.now = now;
    this.env = env || {};
    this.slowDownMs = slowDownMs;
    this.concurrency = concurrency;
    this.log = log;
    this.started = false;
    this.generation = 0;
    this.provider = null;
    this.providerKey = null;
    this.refused = null;
    this.slowUntil = 0;
    this.error = null;
    this.episode = false;
    this.tokens = 0;
    this.requests = 0;
    this.servedModel = null;
    this.inFlight = new Set();
  }

  start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
    for (const c of this.inFlight) c.abort(new EmbedError('EMBED_STOPPED', 'the hosted reranker stopped'));
    this.inFlight.clear();
  }

  // A new or removed key, or Retry: whatever paused or held Jev off is
  // lifted, the next failure warns again, and a call still in flight from
  // before can no longer change the state.
  reset() {
    this.generation += 1;
    this.refused = null;
    this.slowUntil = 0;
    this.error = null;
    this.episode = false;
    this.provider = null;
    this.providerKey = null;
  }

  status() {
    const rerank = this._rerankSettings();
    const hasKey = Boolean(this._key());
    let state;
    if (rerank.kind !== 'jev') state = 'off';
    else if (!this.started) state = 'not-started';
    else if (!hasKey) state = 'no-key';
    else if (this.refused && this.refused.generation === this.generation) state = 'refused';
    else if (this.error) state = 'failing';
    else state = 'ready';
    return { kind: rerank.kind, model: this.servedModel || rerank.jev.model, state, error: this.error, hasKey, tokens: this.tokens, requests: this.requests };
  }

  async rerank(query, texts, { maxMs = Infinity, info = null } = {}) {
    if (this.env.KL_TEST_MODE) throw new EmbedError('RERANK_UNAVAILABLE', 'hosted reranking is off under KL_TEST_MODE');
    if (!this.started) throw new EmbedError('RERANK_UNAVAILABLE', 'the hosted reranker is not started');
    const key = this._key();
    if (!key) {
      const message = 'no typesafe.ai key is saved (Settings > History and recall)';
      this._warn(message);
      throw new EmbedError('RERANK_UNAVAILABLE', message);
    }
    if (this.refused && this.refused.generation === this.generation) throw new EmbedError('RERANK_UNAVAILABLE', this.refused.message);
    if (this.now() < this.slowUntil) throw new EmbedError('RERANK_UNAVAILABLE', 'typesafe.ai asked to slow down; reranking resumes shortly');
    let provider;
    try {
      provider = this._providerFor(key);
    } catch {
      const message = 'the saved typesafe.ai key is not valid';
      this.refused = { generation: this.generation, message };
      this.error = message;
      this._warn(message);
      throw new EmbedError('RERANK_UNAVAILABLE', message);
    }
    const { model } = this._rerankSettings().jev;
    const gen = this.generation;
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = Number.isFinite(maxMs) && maxMs > 0
      ? setTimeout(() => controller.abort(new EmbedError('RERANK_TIMEOUT', `typesafe.ai took longer than ${maxMs} ms`)), maxMs)
      : null;
    try {
      const out = await jevScores({
        ask: (body, options) => provider.ask(body, options), model, query: String(query), texts: texts.map(String),
        mode: 'batched', concurrency: this.concurrency, abortSignal: controller.signal
      });
      this._count(out);
      if (gen === this.generation) {
        this.servedModel = out.model || model;
        this.error = null;
        this.episode = false;
      }
      if (info && typeof info === 'object') info.name = `jev:${out.model || model}`;
      return out.scores;
    } catch (err) {
      this._count(err && err.jevUsage);
      const failure = this._describe(err, controller.signal);
      if (gen === this.generation && this.started && this._rerankSettings().kind === 'jev') this._apply(failure);
      throw new EmbedError(failure.code, failure.message);
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  _rerankSettings() {
    return mergeHistorySettings((this.getSettings() || {}).history).recall.rerank;
  }

  _key() {
    try {
      const k = this.getKey();
      return typeof k === 'string' && k.trim() ? k.trim() : null;
    } catch (err) {
      this.log.debug(`The typesafe.ai key could not be read: ${err.message}`);
      return null;
    }
  }

  _providerFor(key) {
    if (!this.provider || this.providerKey !== key) {
      this.provider = this.createProvider(key);
      this.providerKey = key;
    }
    return this.provider;
  }

  _count(usage) {
    if (!usage) return;
    this.tokens += Number(usage.inputTokens) || 0;
    this.requests += Number(usage.requests) || 0;
  }

  _describe(err, signal) {
    const reason = signal.aborted ? signal.reason : null;
    if (reason && reason.code === 'RERANK_TIMEOUT') return { kind: 'failed', code: 'RERANK_TIMEOUT', message: reason.message };
    if (signal.aborted) return { kind: 'stopped', code: 'RERANK_FAILED', message: 'the hosted rerank was stopped' };
    const status = err && Number.isInteger(err.status) ? err.status : null;
    const ids = [err && err.type, err && err.code].map((v) => String(v || '').toLowerCase());
    if (status === 401 || status === 403) {
      return { kind: 'refused', code: 'RERANK_REFUSED', message: `typesafe.ai refused the key (${status}); save a new key or press Retry` };
    }
    if (status === 402 || ids.includes('insufficient_quota')) {
      return { kind: 'refused', code: 'RERANK_REFUSED', message: `typesafe.ai says the account is out of credit (${status ?? 'quota'}); add credit, then press Retry` };
    }
    if (status === 429 || status === 529) {
      return { kind: 'slow', code: 'RERANK_FAILED', message: `typesafe.ai asked to slow down (${status})`, retryAfterMs: err.retryAfterMs };
    }
    const what = status ? `HTTP ${status}` : (err && err.name === 'TypeError' ? 'network error' : (err && (err.code || err.name)) || 'error');
    return { kind: 'failed', code: 'RERANK_FAILED', message: `typesafe.ai failed (${what})` };
  }

  _apply(failure) {
    if (failure.kind === 'stopped') return;
    if (failure.kind === 'refused') this.refused = { generation: this.generation, message: failure.message };
    if (failure.kind === 'slow') {
      const wait = Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0 ? failure.retryAfterMs : this.slowDownMs;
      this.slowUntil = this.now() + wait;
    }
    this.error = failure.message;
    this._warn(failure.message);
  }

  _warn(message) {
    if (this.episode) return;
    this.episode = true;
    const text = `Recall reranking with typesafe.ai is skipped: ${message}`;
    this.log.warn(text);
    try {
      this.notify({ title: 'King Louie', body: text });
    } catch (err) {
      this.log.warn(`Recall warning could not be shown: ${err.message}`);
    }
  }
}

module.exports = { JevReranker, SLOW_DOWN_MS };

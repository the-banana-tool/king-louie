// src/providers/local-server-provider.js
// The provider "local" (spec 2026-10-13-local-inference-design.md §5.1, §5.5,
// §9.1): OllamaProvider's OpenAI-compatible code, sent through one local
// server's pinned transport. One instance per server, built only by the
// local server registry (src/models/local-servers.js); it is not in the
// provider factory, so nothing can build one without a transport.
//
// A target's model is "<serverId>/<model>". The part after the first slash
// is what the server is asked for; the whole id is what a call is recorded
// under. Only this class marks a call local and prices it at $0 (R-LI-13).
const OllamaProvider = require('./ollama-provider');
const { LOCAL_PROVIDER, isOllamaCloudModelId } = require('../models/provider-ids');

const SERVER_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
// A server that reports no usage is estimated at this rate (spec §9.1 rule 4).
const EST_CHARS_PER_TOKEN = 4;
const estimate = (chars) => Math.ceil(Math.max(0, chars) / EST_CHARS_PER_TOKEN);
const positiveMs = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

// What a finished, non-streamed reply said, for the estimate: its text and
// the calls it made.
function replyChars(result) {
  if (!result || typeof result !== 'object') return 0;
  let n = 0;
  for (const value of [result.content, result.messageContent]) {
    if (typeof value === 'string') n += value.length;
  }
  for (const call of Array.isArray(result.toolCalls) ? result.toolCalls : []) {
    if (typeof call?.toolName === 'string') n += call.toolName.length;
    try { n += JSON.stringify(call?.parameters ?? {}).length; } catch { /* unmeasurable: counted as nothing */ }
  }
  return n;
}

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

class LocalServerProvider extends OllamaProvider {
  /**
   * @param {string|null} apiKey - the server's key, when it wants one
   * @param {object} options
   * @param {string} options.baseUrl - the API base, `<server baseUrl>/v1`
   * @param {{ fetch: Function }} options.transport - the server's pinned transport
   * @param {string} options.serverId
   * @param {string} [options.addressClass] - recorded on each call's metrics
   * @param {string} [options.kind] - the server's kind; without it a cloud id is refused as on Ollama
   * @param {number|null} [options.timeoutMs] - the server entry's timeoutMs (§6.4)
   * @param {Function} [options.adapterRef] - (model, adapterId) → the adapter's ref, or throws (§12.3)
   * @param {object} [options.catalog]
   */
  constructor(apiKey, options = {}) {
    const transport = options.transport;
    if (!transport || typeof transport.fetch !== 'function') {
      throw coded('LOCAL_TRANSPORT_REQUIRED', 'A local server provider needs its server\'s pinned transport.');
    }
    if (typeof options.serverId !== 'string' || !SERVER_ID_RE.test(options.serverId)) {
      throw coded('LOCAL_SERVER_UNKNOWN', 'A local server provider needs a server id.');
    }
    if (typeof options.baseUrl !== 'string' || !options.baseUrl.trim()) {
      throw new Error('A local server provider needs its API base URL.');
    }
    const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
    super(key, options);
    this.transport = transport;
    this.serverId = options.serverId;
    this.addressClass = typeof options.addressClass === 'string' && options.addressClass
      ? options.addressClass
      : (typeof transport.addressClass === 'string' ? transport.addressClass : 'unknown');
    this.kind = typeof options.kind === 'string' ? options.kind : null;
    this.timeoutMs = positiveMs(options.timeoutMs);
    // (model, adapterId) → what the server calls that adapter; the registry
    // checks it is declared and made for the model's current version.
    this._adapterRef = typeof options.adapterRef === 'function' ? options.adapterRef : null;
    this._key = key;
    // Per call: the characters sent and received, for the estimate when the
    // server reports no usage. Keyed by the call's own options object, which
    // the parent hands to request() unchanged.
    this._sizes = new WeakMap();
  }

  getName() { return LOCAL_PROVIDER; }
  getLabel() { return 'Local server'; }

  getProviderName() {
    return LOCAL_PROVIDER;
  }

  getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this._key) headers.Authorization = `Bearer ${this._key}`;
    return headers;
  }

  // "<this server>/<model>" → the id the server is asked for. Anything else
  // is refused before a request is made (§5.5).
  _serverModel(id) {
    const text = typeof id === 'string' ? id : '';
    const prefix = `${this.serverId}/`;
    if (!text.startsWith(prefix) || text.length === prefix.length) {
      throw coded('LOCAL_SERVER_UNKNOWN', `A model on the local server ${this.serverId} is named "${this.serverId}/<model>".`);
    }
    const model = text.slice(prefix.length);
    // On an Ollama server an id that says "cloud" runs on Ollama's cloud,
    // not here. With no kind given this cannot be told apart, so it is refused.
    if ((this.kind === 'ollama' || this.kind === null) && isOllamaCloudModelId(model)) {
      throw coded('LOCAL_CLOUD_MODEL', `${model} runs on Ollama's cloud, not on the local server ${this.serverId}.`);
    }
    return model;
  }

  /**
   * The model a request names (spec §12.3, the adapter seam): the adapter's
   * `ref` when the target names one, else the server's own id for the model.
   * An adapter that is not declared for the model, or was made for another
   * version of it, throws (LOCAL_ADAPTER_UNKNOWN, LOCAL_ADAPTER_STALE) before
   * any request. If a server kind ever needs a request field instead, this
   * returns `{ model, extra }` and nothing else moves.
   * @param {{ model: string, adapter?: string|null }} target
   * @returns {string}
   */
  requestModelFor(target) {
    const model = this._serverModel(target && target.model);
    const adapter = target ? target.adapter : null;
    if (adapter === undefined || adapter === null) return model;
    if (!this._adapterRef) {
      throw coded('LOCAL_ADAPTER_UNKNOWN', `${model} on the local server ${this.serverId} has no adapter ${typeof adapter === 'string' ? adapter.slice(0, 40) : ''}.`);
    }
    return this._adapterRef(model, adapter);
  }

  // Counts what a call sends, for the estimate (see _call).
  request(url, init = {}, options = {}) {
    const sizes = options && typeof options === 'object' ? this._sizes.get(options) : null;
    if (sizes && init && typeof init.body === 'string') sizes.sent += init.body.length;
    return super.request(url, init, options);
  }

  /**
   * How long one call to this server may take (spec §6.4; owner ruling on
   * Q-L1-3, 2026-10-14): the role's timeout, replaced by the server entry's
   * `timeoutMs` when that is larger. With neither, null: no timeout, as
   * before. Hosted providers have no such rule.
   */
  callTimeoutMs(roleTimeoutMs) {
    const role = positiveMs(roleTimeoutMs);
    if (role === null) return this.timeoutMs;
    if (this.timeoutMs === null) return role;
    return Math.max(role, this.timeoutMs);
  }

  // The one abort path: a call's timeout aborts the call's own signal, which
  // the transport already honours while the call waits for a slot, while it
  // waits for the reply and while the reply streams. The caller's signal is
  // forwarded, so Stop still stops. Returns null when there is no timeout.
  _bound(callerSignal, ms) {
    if (ms === null) return null;
    const controller = new AbortController();
    let fired = false;
    const forward = () => controller.abort(callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) forward();
      else callerSignal.addEventListener('abort', forward, { once: true });
    }
    const message = `The local server ${this.serverId} did not answer within ${ms} ms.`;
    const timer = setTimeout(() => {
      fired = true;
      controller.abort(new DOMException(message, 'TimeoutError'));
    }, ms);
    return {
      signal: controller.signal,
      // A call that failed because the timeout fired (and not because the
      // caller stopped it) is LOCAL_TIMEOUT, never an AbortError: a Stop
      // ends a turn, a timeout fails over (error-classifier.js rule 1c).
      failure: (err) => {
        if (!fired || callerSignal?.aborted) return err;
        const timedOut = coded('LOCAL_TIMEOUT', message);
        timedOut.timeoutMs = ms;
        timedOut.serverId = this.serverId;
        timedOut.cause = err;
        if (err && typeof err === 'object' && err.partialLlmMetrics) timedOut.partialLlmMetrics = err.partialLlmMetrics;
        return timedOut;
      },
      done: () => {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener('abort', forward);
      }
    };
  }

  // Run one of the parent's calls with the server's own model id, and record
  // it under the id the target named (a server may call the model anything).
  // A finished call whose server reported no usage at all, with a reply that
  // has text, is estimated at one token per four characters of the request
  // body and of the reply, and marked usageEstimated (§9.1 rule 4). A call
  // cut off by Stop is left as it is (usagePartial, rule 5). A target that
  // names an adapter (§12) sends the adapter's ref and is recorded under the
  // base model, with `adapter` on its metrics.
  async _call(run, options, onChunk = null) {
    const { adapter: named = null, ...opts } = options || {};
    const adapter = named === undefined || named === null ? null : named;
    const model = this._serverModel(opts.model);
    const recorded = `${this.serverId}/${model}`;
    const sent = adapter === null ? model : this.requestModelFor({ model: opts.model, adapter });
    const tag = (metrics) => (adapter === null ? metrics : { ...metrics, adapter });
    const bound = this._bound(opts.abortSignal || null, this.callTimeoutMs(opts.timeoutMs));
    const callOptions = { ...opts, model: sent, ...(bound ? { abortSignal: bound.signal } : {}) };
    const sizes = { sent: 0, received: 0 };
    this._sizes.set(callOptions, sizes);
    const counting = typeof onChunk === 'function'
      ? (chunk) => { if (typeof chunk === 'string') sizes.received += chunk.length; return onChunk(chunk); }
      : onChunk;
    try {
      const result = await run(callOptions, counting);
      if (result && typeof result === 'object' && result.llmMetrics) {
        if (!counting) sizes.received += replyChars(result);
        result.llmMetrics = tag(this._estimated({ ...result.llmMetrics, model: recorded }, sizes));
      }
      return result;
    } catch (err) {
      if (err && typeof err === 'object' && err.partialLlmMetrics) err.partialLlmMetrics = tag({ ...err.partialLlmMetrics, model: recorded });
      throw bound ? bound.failure(err) : err;
    } finally {
      if (bound) bound.done();
    }
  }

  sendMessage(messages, options = {}) {
    return this._call((opts) => super.sendMessage(messages, opts), options);
  }

  sendMessageWithTools(messages, tools = [], options = {}) {
    return this._call((opts) => super.sendMessageWithTools(messages, tools, opts), options);
  }

  streamMessage(messages, options = {}, onChunk) {
    return this._call((opts, counting) => super.streamMessage(messages, opts, counting), options, onChunk);
  }

  _estimated(metrics, sizes) {
    if (metrics.usagePartial || sizes.received <= 0) return metrics;
    const reported = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheCreationInputTokens']
      .reduce((n, k) => n + (Number(metrics[k]) || 0), 0);
    if (reported > 0) return metrics;
    const input = estimate(sizes.sent);
    const output = estimate(sizes.received);
    return {
      ...metrics,
      ...this.buildLlmCallMetrics({
        model: metrics.model,
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
      }),
      usageEstimated: true
    };
  }

  // Embeddings stay on the server too (its /api/embed, through the transport).
  // Bounded by the call's timeout like a chat call.
  async embed(inputs, options = {}) {
    const opts = options || {};
    const model = this._serverModel(opts.model);
    const bound = this._bound(opts.abortSignal || null, this.callTimeoutMs(opts.timeoutMs));
    try {
      return await super.embed(inputs, { ...opts, model, ...(bound ? { abortSignal: bound.signal } : {}) });
    } catch (err) {
      throw bound ? bound.failure(err) : err;
    } finally {
      if (bound) bound.done();
    }
  }

  /**
   * One call's metrics (§9.1): tokens as the server reported them, $0, never
   * unpriced, and marked local with the server and its address class.
   */
  buildLlmCallMetrics({ model, usage, partial = false } = {}) {
    const prefix = `${this.serverId}/`;
    const named = typeof model === 'string' && model ? model : '';
    const base = super.buildLlmCallMetrics({ model: named || `${prefix}unknown`, usage, partial });
    delete base.unpriced;
    return {
      ...base,
      provider: LOCAL_PROVIDER,
      model: named.startsWith(prefix) ? named : `${prefix}${named || 'unknown'}`,
      costUsd: 0,
      local: { server: this.serverId, class: this.addressClass }
    };
  }
}

module.exports = LocalServerProvider;

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

  // Counts what a call sends, for the estimate (see _call).
  request(url, init = {}, options = {}) {
    const sizes = options && typeof options === 'object' ? this._sizes.get(options) : null;
    if (sizes && init && typeof init.body === 'string') sizes.sent += init.body.length;
    return super.request(url, init, options);
  }

  // Run one of the parent's calls with the server's own model id, and record
  // it under the id the target named (a server may call the model anything).
  // A finished call whose server reported no usage at all, with a reply that
  // has text, is estimated at one token per four characters of the request
  // body and of the reply, and marked usageEstimated (§9.1 rule 4). A call
  // cut off by Stop is left as it is (usagePartial, rule 5).
  async _call(run, options, onChunk = null) {
    const opts = options || {};
    const model = this._serverModel(opts.model);
    const recorded = `${this.serverId}/${model}`;
    const callOptions = { ...opts, model };
    const sizes = { sent: 0, received: 0 };
    this._sizes.set(callOptions, sizes);
    const counting = typeof onChunk === 'function'
      ? (chunk) => { if (typeof chunk === 'string') sizes.received += chunk.length; return onChunk(chunk); }
      : onChunk;
    try {
      const result = await run(callOptions, counting);
      if (result && typeof result === 'object' && result.llmMetrics) {
        if (!counting) sizes.received += replyChars(result);
        result.llmMetrics = this._estimated({ ...result.llmMetrics, model: recorded }, sizes);
      }
      return result;
    } catch (err) {
      if (err && typeof err === 'object' && err.partialLlmMetrics) err.partialLlmMetrics.model = recorded;
      throw err;
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
  embed(inputs, options = {}) {
    const opts = options || {};
    return super.embed(inputs, { ...opts, model: this._serverModel(opts.model) });
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

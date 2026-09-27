const { buildProviderError } = require('./provider-error');
const { getActiveCatalog } = require('../models');
const { createLogger } = require('../logging');

const log = createLogger('providers');

class BaseLLMProvider {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.authMode = options.authMode || 'api-key';
    // Prices come from the model catalog (spec 2026-09-27 §4.4). The core
    // injects its own; without one the bundled snapshot prices the call.
    this.catalog = options.catalog || null;
    if (this.authMode === 'api-key') {
      this.validateApiKey();
    }
  }

  /** A provider's API base: options.baseUrl when given, without trailing slashes. */
  static baseUrlFrom(options, fallback) {
    return String(options?.baseUrl || fallback).replace(/\/+$/, '');
  }

  getCatalog() {
    return this.catalog || getActiveCatalog();
  }

  /**
   * An abort as an Error named AbortError. A signal aborted with a string
   * reason (the case runtime does this) rejects fetch with that bare string.
   * A signal from AbortSignal.timeout() aborts with a DOMException named
   * TimeoutError — that must read as a timeout, not a generic "aborted",
   * so Stop and an unrelated hang are never confused in the message.
   */
  abortError(err, signal) {
    if (err && typeof err === 'object' && err.name === 'AbortError') return err;
    const reason = signal?.reason;
    const timeout = [reason, err].find((v) => v && typeof v === 'object' && v.name === 'TimeoutError');
    const message = timeout
      ? (timeout.message || 'The operation timed out.')
      : (typeof reason === 'string' && reason ? `Request aborted: ${reason}` : 'The operation was aborted.');
    const e = new Error(message);
    e.name = 'AbortError';
    if (err !== undefined) e.cause = err;
    return e;
  }

  /**
   * The one way a provider calls its API (spec 2026-09-27 §9). The call's
   * options.abortSignal goes on every fetch, streaming or not, so Stop cancels
   * the request at the provider instead of letting it run on and bill. An
   * abort before the response arrives carries a partial record with nothing
   * reported. fetch is looked up per call so tests can stub it.
   */
  async request(url, init = {}, options = {}) {
    const signal = options?.abortSignal || null;
    try {
      return await globalThis.fetch(url, signal ? { ...init, signal } : init);
    } catch (err) {
      if (signal?.aborted) {
        const aborted = this.abortError(err, signal);
        if (!aborted.partialLlmMetrics) {
          aborted.partialLlmMetrics = this.buildLlmCallMetrics({ model: options.model, usage: {}, partial: true });
        }
        throw aborted;
      }
      throw err;
    }
  }

  /**
   * Run a stream's read loop. Aborted mid-stream, rethrow as an AbortError
   * carrying the usage the provider had reported so far (snapshot() returns
   * { model, usage }), marked usagePartial (spec §9).
   */
  async guardStream(options, snapshot, read) {
    try {
      return await read();
    } catch (err) {
      const signal = options?.abortSignal || null;
      if (signal?.aborted || err?.name === 'AbortError') {
        const aborted = this.abortError(err, signal);
        const { model, usage } = (typeof snapshot === 'function' && snapshot()) || {};
        aborted.partialLlmMetrics = this.buildLlmCallMetrics({ model, usage: usage || {}, partial: true });
        throw aborted;
      }
      throw err;
    }
  }

  validateApiKey() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length < 8) {
      throw new Error('Invalid API key');
    }
  }

  normalizeMessages(chatHistory = []) {
    return chatHistory
      .map((msg) => {
        if (msg.role && msg.content) {
          return { role: msg.role, content: msg.content };
        }

        if (msg.sender && typeof msg.text === 'string') {
          return {
            role: msg.sender === 'assistant' ? 'assistant' : 'user',
            content: msg.text
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  formatMessages(chatHistory) {
    return this.normalizeMessages(chatHistory);
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  getDefaultModel() {
    throw new Error('getDefaultModel must be implemented by provider');
  }

  getProviderName() {
    return 'unknown';
  }

  normalizeUsage(usage = {}) {
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
    const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens) || 0;

    // Provider-specific cache reporting:
    //   OpenAI chat:      usage.prompt_tokens_details.cached_tokens (subset of prompt_tokens)
    //   OpenAI responses: usage.input_tokens_details.cached_tokens (subset of input_tokens)
    //   Anthropic:        usage.cache_read_input_tokens / cache_creation_input_tokens
    //                     (NOT included in input_tokens — separate counts)
    //   Gemini:           usage.cached_content_token_count (subset of prompt input)
    //   DeepSeek:         usage.prompt_cache_hit_tokens (subset of prompt_tokens)
    const cachedInputTokens =
      Number(
        usage?.prompt_tokens_details?.cached_tokens
        ?? usage?.input_tokens_details?.cached_tokens
        ?? usage?.cache_read_input_tokens
        ?? usage?.cached_content_token_count
        ?? usage?.prompt_cache_hit_tokens
        ?? 0
      ) || 0;
    const cacheCreationInputTokens =
      Number(usage?.cache_creation_input_tokens ?? 0) || 0;
    // Reasoning tokens are reported inside the output count.
    const reasoningTokens =
      Number(
        usage?.completion_tokens_details?.reasoning_tokens
        ?? usage?.output_tokens_details?.reasoning_tokens
        ?? 0
      ) || 0;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      reasoningTokens
    };
  }

  /**
   * Normalized usage → the catalog's usage shape. OpenAI-style providers
   * report cached input inside the input count; Anthropic overrides this.
   */
  usageForPricing(normalized) {
    return {
      input: Math.max(0, normalized.inputTokens - normalized.cachedInputTokens),
      cachedInput: normalized.cachedInputTokens,
      cacheWrite: normalized.cacheCreationInputTokens,
      output: normalized.outputTokens,
      reasoning: normalized.reasoningTokens
    };
  }

  /**
   * One call's metrics, priced by the catalog. An unknown model is unpriced
   * (costUsd null, unpriced true), never $0. A call cut off by Stop is
   * partial (usagePartial true); with nothing reported its cost is unknown.
   */
  buildLlmCallMetrics({ model, usage, partial = false } = {}) {
    const normalizedModel = model || this.getDefaultModel();
    const normalizedUsage = this.normalizeUsage(usage || {});
    const provider = this.getProviderName();

    let priced = null;
    try {
      priced = this.getCatalog().price(provider, normalizedModel, this.usageForPricing(normalizedUsage));
    } catch (err) {
      log.warn(`Pricing ${provider}/${normalizedModel} failed: ${err.message}`);
    }

    const reported = normalizedUsage.inputTokens
      + normalizedUsage.outputTokens
      + normalizedUsage.cachedInputTokens
      + normalizedUsage.cacheCreationInputTokens;
    const costUsd = priced && !(partial && reported === 0) ? priced.usd : null;

    return {
      provider,
      model: normalizedModel,
      ...normalizedUsage,
      costUsd,
      ...(priced ? {} : { unpriced: true }),
      ...(partial ? { usagePartial: true } : {})
    };
  }

  /**
   * Derive the human-readable message from a parsed error body.
   *
   * This is the union of what every provider's own `extractError` did:
   * OpenAI-shaped providers use `error.message`, Cohere puts it at the top
   * level as `message`, Copilot accepts either. Overriding is rarely needed.
   */
  messageFromErrorBody(body, response) {
    return (
      body?.error?.message
      || body?.message
      || `${response?.status ?? ''} ${response?.statusText ?? ''}`.trim()
    );
  }

  /**
   * Build a ProviderError from a failed Response.
   *
   * Providers previously threw `new Error(await this.extractError(response))`,
   * discarding the status code and `retry-after` header at the throw site and
   * forcing every consumer downstream to guess by substring-matching the
   * message. The message produced here is unchanged; the difference is that
   * the structured fields survive.
   *
   * Reads the body exactly once — a Response body is not re-readable, so this
   * must not be combined with a separate `extractError` call on the same
   * response.
   */
  async buildError(response, details = {}) {
    let body = null;
    let message = '';

    // Read the body through whichever accessor this response actually has.
    // Real fetch Responses expose both text() and json(), but transports and
    // test doubles frequently implement only one, and assuming text() would
    // silently degrade every such error to "401 Unauthorized".
    try {
      if (typeof response?.text === 'function') {
        const text = await response.text();
        try {
          body = JSON.parse(text);
        } catch {
          // Non-JSON error bodies (HTML error pages from proxies, plain text
          // from local runtimes) still carry signal worth keeping in the
          // message, but must not blow up parsing.
          body = null;
          if (text && text.length <= 500) message = text.trim();
        }
      } else if (typeof response?.json === 'function') {
        body = await response.json();
      }
    } catch {
      body = null;
    }

    if (!message || body) {
      message = this.messageFromErrorBody(body, response);
    }

    return buildProviderError(response, message, {
      provider: this.getProviderName(),
      body,
      ...details
    });
  }

  async sendMessage() {
    throw new Error('sendMessage must be implemented by provider');
  }

  async streamMessage() {
    throw new Error('streamMessage must be implemented by provider');
  }

  getModels() {
    return [];
  }

  /**
   * Discover available models from the provider's API.
   * Override in subclasses that support model discovery.
   * @returns {Promise<Array<{id: string, name: string, capabilities: string[]}>>}
   */
  async discoverModels() {
    // Default: return static model list from getModels()
    return this.getModels().map(m => ({
      id: typeof m === 'string' ? m : m.id,
      name: typeof m === 'string' ? m : (m.name || m.id),
      capabilities: ['chat', 'streaming']
    }));
  }

  async listModels(_options = {}) {
    throw new Error('listModels must be implemented by provider');
  }
}

module.exports = BaseLLMProvider;

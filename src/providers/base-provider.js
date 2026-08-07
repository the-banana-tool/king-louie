const { buildProviderError } = require('./provider-error');

class BaseLLMProvider {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.authMode = options.authMode || 'api-key';
    if (this.authMode === 'api-key') {
      this.validateApiKey();
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

  getModelPricingTable() {
    return {};
  }

  normalizeUsage(usage = {}) {
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
    const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens) || 0;

    // Provider-specific cache reporting:
    //   OpenAI:    usage.prompt_tokens_details.cached_tokens (subset of prompt_tokens)
    //   Anthropic: usage.cache_read_input_tokens / cache_creation_input_tokens
    //              (these are NOT included in input_tokens — they're separate counts)
    //   Gemini:    usage.cached_content_token_count (subset of prompt input)
    const cachedInputTokens =
      Number(
        usage?.prompt_tokens_details?.cached_tokens
        ?? usage?.cache_read_input_tokens
        ?? usage?.cached_content_token_count
        ?? 0
      ) || 0;
    const cacheCreationInputTokens =
      Number(usage?.cache_creation_input_tokens ?? 0) || 0;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens,
      cacheCreationInputTokens
    };
  }

  resolveModelPricing(model = '') {
    const pricingTable = this.getModelPricingTable();
    if (!pricingTable || typeof pricingTable !== 'object') return null;

    if (pricingTable[model]) {
      return pricingTable[model];
    }

    const normalizedModel = String(model).toLowerCase();
    const prefixMatch = Object.entries(pricingTable).find(([key]) =>
      normalizedModel.startsWith(String(key).toLowerCase())
    );

    return prefixMatch ? prefixMatch[1] : null;
  }

  calculateCostUsd(model, inputTokens, outputTokens, cacheMetrics = {}) {
    const pricing = this.resolveModelPricing(model);
    if (!pricing) return 0;

    // OpenAI/Gemini convention: cached tokens are a subset of inputTokens
    // and are billed at a discount (typically 50%, configurable via pricing
    // table as cachedInputPerMillion). Anthropic overrides this method
    // entirely because its cached tokens are reported as a separate count.
    const cachedInput = Number(cacheMetrics.cachedInputTokens || 0);
    const uncachedInput = Math.max(0, inputTokens - cachedInput);
    const cachedRate = pricing.cachedInputPerMillion
      ?? (pricing.inputPerMillion ? pricing.inputPerMillion * 0.5 : 0);

    const inputCost = (uncachedInput / 1_000_000) * (pricing.inputPerMillion || 0);
    const cachedCost = (cachedInput / 1_000_000) * cachedRate;
    const outputCost = (outputTokens / 1_000_000) * (pricing.outputPerMillion || 0);
    return Number((inputCost + cachedCost + outputCost).toFixed(8));
  }

  buildLlmCallMetrics({ model, usage } = {}) {
    const normalizedModel = model || this.getDefaultModel();
    const normalizedUsage = this.normalizeUsage(usage || {});

    return {
      provider: this.getProviderName(),
      model: normalizedModel,
      ...normalizedUsage,
      costUsd: this.calculateCostUsd(
        normalizedModel,
        normalizedUsage.inputTokens,
        normalizedUsage.outputTokens,
        {
          cachedInputTokens: normalizedUsage.cachedInputTokens,
          cacheCreationInputTokens: normalizedUsage.cacheCreationInputTokens
        }
      )
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

  async listModels() {
    throw new Error('listModels must be implemented by provider');
  }
}

module.exports = BaseLLMProvider;
class BaseLLMProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.validateApiKey();
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

    return {
      inputTokens,
      outputTokens,
      totalTokens
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

  calculateCostUsd(model, inputTokens, outputTokens) {
    const pricing = this.resolveModelPricing(model);
    if (!pricing) return 0;

    const inputCost = (inputTokens / 1_000_000) * (pricing.inputPerMillion || 0);
    const outputCost = (outputTokens / 1_000_000) * (pricing.outputPerMillion || 0);
    return Number((inputCost + outputCost).toFixed(8));
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
        normalizedUsage.outputTokens
      )
    };
  }

  async sendMessage() {
    throw new Error('sendMessage must be implemented by provider');
  }

  async streamMessage() {
    throw new Error('streamMessage must be implemented by provider');
  }

  async listModels() {
    throw new Error('listModels must be implemented by provider');
  }
}

module.exports = BaseLLMProvider;
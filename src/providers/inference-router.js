const { evaluateRules } = require('./smart-routing');

class InferenceRouter {
  constructor(options = {}) {
    this.getSettings = options.getSettings;
    this.getProviderModel = options.getProviderModel;
    this.getProviderToken = options.getProviderToken;
    this.createProvider = options.createProvider;

    this.fallbacks = {
      groq: { provider: 'openai', model: 'gpt-4o-mini' },
      ollama: { provider: 'groq', model: 'llama-3.3-70b-versatile' }
    };
  }

  getCapabilities(provider, model) {
    const normalizedProvider = String(provider || '').toLowerCase();
    const normalizedModel = String(model || '').toLowerCase();

    // Default base capabilities
    const capabilities = {
      vision: false,
      toolCalling: true,
      streaming: true
    };

    if (normalizedProvider === 'openai') {
      capabilities.vision = normalizedModel.includes('gpt-4') || normalizedModel.includes('o1');
    } else if (normalizedProvider === 'anthropic') {
      capabilities.vision = normalizedModel.includes('claude-3');
    } else if (normalizedProvider === 'gemini') {
      capabilities.vision = true;
    } else if (normalizedProvider === 'openrouter') {
      capabilities.vision = true; // OpenRouter handles capability routing
    } else if (normalizedProvider === 'groq') {
      capabilities.vision = normalizedModel.includes('vision');
    }

    // Some smaller models or specific ones might not support tool calling, but most modern ones do.
    if (normalizedProvider === 'ollama') {
      capabilities.toolCalling = normalizedModel.includes('llama') || normalizedModel.includes('mistral');
    }

    return capabilities;
  }

  getTierConfig(tier) {
    if (typeof this.getSettings !== 'function') {
      throw new Error('InferenceRouter requires getSettings()');
    }

    const settings = this.getSettings() || {};
    const inference = settings.inference || {};
    const tierMap = inference.tierMap || {};

    const requestedTier = String(tier || inference.activeTier || 'standard').toLowerCase();
    const resolvedTier = ['fast', 'standard', 'smart'].includes(requestedTier) ? requestedTier : 'standard';

    const tierConfig = tierMap[resolvedTier] || {};
    const provider = String(
      tierConfig.provider || settings.activeProvider || 'openai'
    ).toLowerCase();

    const providerModel = typeof this.getProviderModel === 'function' ? this.getProviderModel(provider) : '';
    const model = tierConfig.model || providerModel || '';

    return { provider, model, tier: resolvedTier };
  }

  async execute(config, messages, options = {}) {
    if (!config || !config.provider) {
      throw new Error('Execute requires a valid provider configuration.');
    }

    if (typeof this.getProviderToken !== 'function') {
      throw new Error('InferenceRouter requires getProviderToken()');
    }

    if (typeof this.createProvider !== 'function') {
      throw new Error('InferenceRouter requires createProvider()');
    }

    const token = this.getProviderToken(config.provider);
    const providerInstance = this.createProvider(config.provider, token);

    const mergedOptions = {
      ...options,
      model: config.model || options.model || providerInstance.getDefaultModel()
    };

    if (Array.isArray(mergedOptions.tools) && mergedOptions.tools.length > 0) {
      if (typeof providerInstance.sendMessageWithTools !== 'function') {
        throw new Error(`Provider ${config.provider} does not support tool calling.`);
      }
      return providerInstance.sendMessageWithTools(messages, mergedOptions.tools, mergedOptions);
    }

    return providerInstance.sendMessage(messages, mergedOptions);
  }

  async routeWithFallback(tier, messages, options) {
    const primary = this.getTierConfig(tier);
    try {
      return await this.execute(primary, messages, options);
    } catch (err) {
      const fallback = this.fallbacks[primary.provider];
      if (fallback) {
        console.warn(`[inference-router] ${primary.provider} failed, falling back to ${fallback.provider}`);
        return await this.execute(fallback, messages, options);
      }
      throw err;
    }
  }

  resolve(request = {}) {
    if (typeof this.getSettings !== 'function') {
      throw new Error('InferenceRouter requires getSettings()');
    }

    const settings = this.getSettings() || {};
    const inference = settings.inference || {};
    const tierMap = inference.tierMap || {};
    const timeoutsMs = inference.timeoutsMs || {};

    const requestedTier = String(request.tier || inference.activeTier || 'standard').toLowerCase();
    const tier = ['fast', 'standard', 'smart'].includes(requestedTier) ? requestedTier : 'standard';

    const tierConfig = tierMap[tier] || {};
    const providerType = String(
      request.provider || tierConfig.provider || settings.activeProvider || 'openai'
    ).toLowerCase();
    const tierModel = tierConfig.model || '';
    const providerModel = typeof this.getProviderModel === 'function' ? this.getProviderModel(providerType) : '';
    const model = request.model || tierModel || providerModel;

    const configuredTimeout = request.timeoutMs ?? timeoutsMs[tier];
    const timeoutMs = Number(configuredTimeout);
    const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;

    if (typeof this.getProviderToken !== 'function') {
      throw new Error('InferenceRouter requires getProviderToken()');
    }

    if (typeof this.createProvider !== 'function') {
      throw new Error('InferenceRouter requires createProvider()');
    }

    const token = this.getProviderToken(providerType);
    const provider = this.createProvider(providerType, token);

    return {
      tier,
      providerType,
      model,
      timeoutMs: normalizedTimeoutMs,
      provider
    };
  }
  /**
   * Set an LLM-powered router for intelligent model selection.
   * When enabled, this is tried before rule-based routing.
   */
  setLLMRouter(llmRouter) {
    this.llmRouter = llmRouter || null;
  }

  /**
   * Attempt LLM-powered routing. Returns null if disabled or fails.
   */
  async resolveLLMRouting(message) {
    if (!this.llmRouter) return null;

    const settings = this.getSettings() || {};
    const llmRouting = settings.inference?.llmRouting;
    if (!llmRouting || !llmRouting.enabled) return null;

    try {
      const classification = await this.llmRouter.classify(message);
      if (!classification) return null;

      const token = this.getProviderToken(classification.provider);
      if (!token) return null;

      const provider = this.createProvider(classification.provider, token);

      return {
        tier: 'llm-routing',
        providerType: classification.provider,
        model: classification.model,
        provider,
        routedBy: 'llm-routing',
        routingReason: classification.reason
      };
    } catch {
      return null;
    }
  }

  resolveWithSmartRouting(request = {}, message = '', context = {}) {
    if (typeof this.getSettings !== 'function') {
      throw new Error('InferenceRouter requires getSettings()');
    }

    const settings = this.getSettings() || {};
    const smartRouting = settings.inference?.smartRouting;

    if (!smartRouting || !smartRouting.enabled) {
      return { ...this.resolve(request), routedBy: 'tier' };
    }

    const rules = Array.isArray(smartRouting.rules) ? smartRouting.rules : [];
    const match = evaluateRules(message, rules, context);

    if (!match) {
      return { ...this.resolve(request), routedBy: 'tier' };
    }

    const { target, matchedRule } = match;
    const providerType = String(target.provider || '').toLowerCase();
    const model = target.model || '';

    // Verify the target provider has a token available
    if (typeof this.getProviderToken === 'function') {
      try {
        const token = this.getProviderToken(providerType);
        if (!token) {
          console.warn(`[inference-router] Smart routing rule "${matchedRule.name}" targets ${providerType} but no token is available, falling back to tier.`);
          return { ...this.resolve(request), routedBy: 'tier' };
        }
      } catch {
        return { ...this.resolve(request), routedBy: 'tier' };
      }
    }

    if (typeof this.createProvider !== 'function') {
      throw new Error('InferenceRouter requires createProvider()');
    }

    const token = this.getProviderToken(providerType);
    const provider = this.createProvider(providerType, token);

    const result = {
      tier: 'smart-routing',
      providerType,
      model,
      provider,
      routedBy: 'smart-routing',
      matchedRule: {
        id: matchedRule.id,
        name: matchedRule.name
      }
    };

    // Include matched prefix for prefix-type rules so the caller can strip it
    if (matchedRule.condition?.type === 'prefix' && matchedRule.condition?.prefix) {
      result.matchedPrefix = matchedRule.condition.prefix;
    }

    return result;
  }
}

module.exports = InferenceRouter;
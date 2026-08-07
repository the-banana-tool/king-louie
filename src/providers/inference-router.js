const { evaluateRules } = require('./smart-routing');
const { FailoverPolicy } = require('./failover-policy');
const { RecoveryAction } = require('./error-classifier');
const { createLogger } = require('../logging');
const log = createLogger('inference-router');

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

    this.policy = options.policy || new FailoverPolicy(options.failover || {});

    // Injectable so tests exercise the backoff logic without real waiting.
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Optional hooks. Absent hooks degrade to the next best action rather
    // than failing — King Louie currently holds one credential per provider,
    // so credential rotation has nothing to rotate to, and the honest
    // response is to fall back to another model instead of pretending.
    this.rotateCredential = typeof options.rotateCredential === 'function'
      ? options.rotateCredential
      : null;
    this.compressContext = typeof options.compressContext === 'function'
      ? options.compressContext
      : null;
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

  /**
   * Resolve the fallback target for a config, skipping targets already tried.
   * Returns null when there is nowhere left to go.
   */
  _nextFallback(config, triedTargets) {
    const fallback = this.fallbacks[config.provider];
    if (!fallback) return null;

    const key = `${fallback.provider}:${fallback.model}`;
    if (triedTargets.has(key)) return null;

    return fallback;
  }

  /**
   * Execute a tier request, recovering from failures according to what
   * actually went wrong.
   *
   * Previously this did a single static hop to a fallback provider on any
   * error, which meant a 429 burned the fallback instead of waiting for the
   * window to clear, a context-overflow retried the identical oversized
   * request, and a permanent auth failure looked exactly like a hiccup.
   * Now the classifier decides and FailoverPolicy budgets it.
   */
  async routeWithFallback(tier, messages, options = {}) {
    let config = this.getTierConfig(tier);
    let payload = messages;

    const triedTargets = new Set([`${config.provider}:${config.model}`]);
    const attemptsByReason = {};
    const state = {
      totalAttempts: 0,
      credentialRefreshed: false,
      contextCompressed: false
    };

    // Bounded by FailoverPolicy.maxTotalAttempts; the loop guard is a
    // backstop against a hook that never makes progress.
    for (let guard = 0; guard <= this.policy.maxTotalAttempts; guard += 1) {
      try {
        return await this.execute(config, payload, options);
      } catch (err) {
        state.totalAttempts += 1;

        const plan = this.policy.plan(err, {
          ...state,
          attemptsByReason,
          provider: config.provider,
          model: config.model,
          aborted: options.abortSignal?.aborted
        });

        attemptsByReason[plan.reason] = (attemptsByReason[plan.reason] || 0) + 1;

        let action = plan.action;

        // Degrade actions we have no hook for, rather than silently
        // succeeding at nothing.
        if (action === RecoveryAction.ROTATE_CREDENTIAL && !this.rotateCredential) {
          action = RecoveryAction.FALLBACK_MODEL;
        }
        if (action === RecoveryAction.COMPRESS_CONTEXT && !this.compressContext) {
          action = RecoveryAction.FALLBACK_MODEL;
        }

        if (action === RecoveryAction.ABORT) {
          log.warn(`${config.provider} failed permanently (${plan.reason}): ${plan.detail}`);
          throw err;
        }

        if (action === RecoveryAction.RETRY) {
          log.warn(
            `${config.provider} ${plan.reason} — retrying in ${plan.waitMs}ms `
            + `(attempt ${state.totalAttempts}/${this.policy.maxTotalAttempts})`
          );
          if (plan.waitMs > 0) await this.sleep(plan.waitMs);
          continue;
        }

        if (action === RecoveryAction.ROTATE_CREDENTIAL) {
          const rotated = await this.rotateCredential(config.provider, err);
          if (rotated) {
            state.credentialRefreshed = true;
            log.warn(`${config.provider} ${plan.reason} — rotated credential, retrying`);
            continue;
          }
          action = RecoveryAction.FALLBACK_MODEL;
        }

        if (action === RecoveryAction.COMPRESS_CONTEXT) {
          const compressed = await this.compressContext(payload, { config, error: err });
          if (compressed) {
            payload = compressed;
            state.contextCompressed = true;
            log.warn(`${config.provider} context overflow — compressed request, retrying`);
            continue;
          }
          action = RecoveryAction.FALLBACK_MODEL;
        }

        // FALLBACK_MODEL
        const fallback = this._nextFallback(config, triedTargets);
        if (!fallback) {
          log.warn(`${config.provider} failed (${plan.reason}) with no fallback available`);
          throw err;
        }

        log.warn(
          `${config.provider} failed (${plan.reason}), falling back to ${fallback.provider}`
        );
        config = fallback;
        triedTargets.add(`${fallback.provider}:${fallback.model}`);
        // A new target gets a clean slate: the previous target's rate limit
        // says nothing about this one's.
        state.credentialRefreshed = false;
        for (const key of Object.keys(attemptsByReason)) delete attemptsByReason[key];
      }
    }

    throw new Error('Failover loop exceeded its attempt ceiling without resolving.');
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
          log.warn(`Smart routing rule "${matchedRule.name}" targets ${providerType} but no token is available, falling back to tier.`);
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
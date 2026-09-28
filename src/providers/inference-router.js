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

    // Told about a 401/403 so availability can mark the provider unusable at
    // once (spec 2026-09-27 §5.3). Rate limits and timeouts are not reported.
    this.onProviderError = typeof options.onProviderError === 'function'
      ? options.onProviderError
      : null;

    // Runs once per provider per route state before its first call: the
    // core refreshes an Anthropic OAuth access token here.
    this.prepareProvider = typeof options.prepareProvider === 'function'
      ? options.prepareProvider
      : null;
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

    const { onChunk, ...rest } = options;
    const mergedOptions = {
      ...rest,
      model: config.model || rest.model || providerInstance.getDefaultModel()
    };

    if (Array.isArray(mergedOptions.tools) && mergedOptions.tools.length > 0) {
      if (typeof onChunk === 'function' && typeof providerInstance.streamMessageWithTools === 'function') {
        return providerInstance.streamMessageWithTools(messages, mergedOptions.tools, mergedOptions, onChunk);
      }
      if (typeof providerInstance.sendMessageWithTools !== 'function') {
        throw new Error(`Provider ${config.provider} does not support tool calling.`);
      }
      return providerInstance.sendMessageWithTools(messages, mergedOptions.tools, mergedOptions);
    }

    return providerInstance.sendMessage(messages, mergedOptions);
  }

  // ---- Resolved target lists (spec 2026-09-27 §6.7) ----

  newRouteState() {
    return { index: 0, answered: false, instances: new Map(), lastInstance: null };
  }

  async _instanceFor(provider, state) {
    if (state.instances.has(provider)) return state.instances.get(provider);
    if (typeof this.getProviderToken !== 'function' || typeof this.createProvider !== 'function') {
      throw new Error('InferenceRouter requires getProviderToken() and createProvider()');
    }
    const instance = this.createProvider(provider, this.getProviderToken(provider));
    if (this.prepareProvider) await this.prepareProvider(instance, provider);
    state.instances.set(provider, instance);
    return instance;
  }

  // One call to one target. The target decides the model; a caller's own
  // options.model never overrides it (the agent loop still passes one).
  async executeTarget(instance, target, messages, options = {}) {
    const { onChunk, tools, ...rest } = options || {};
    const opts = { ...rest, model: target.model, ...(target.effort ? { effort: target.effort } : {}) };
    if (Array.isArray(tools) && tools.length > 0) {
      if (typeof onChunk === 'function' && typeof instance.streamMessageWithTools === 'function') {
        return instance.streamMessageWithTools(messages, tools, opts, onChunk);
      }
      if (typeof instance.sendMessageWithTools !== 'function') {
        throw new Error(`Provider ${target.provider} does not support tool calling.`);
      }
      return instance.sendMessageWithTools(messages, tools, opts);
    }
    if (typeof onChunk === 'function' && typeof instance.streamMessage === 'function') {
      return instance.streamMessage(messages, opts, onChunk);
    }
    return instance.sendMessage(messages, opts);
  }

  _reportAuth(provider, err) {
    if (!this.onProviderError) return;
    try {
      this.onProviderError(provider, err);
    } catch (hookErr) {
      log.warn(`Reporting a ${provider} auth failure failed: ${hookErr.message}`);
    }
  }

  // The next target after a failure. Before the first answer any provider
  // may take over; after it, only the failed target's own provider, since
  // the history built so far is in that provider's format.
  _nextTarget(list, state, skipProviders, failed) {
    let crossProvider = null;
    for (let i = state.index + 1; i < list.length; i += 1) {
      const candidate = list[i];
      if (skipProviders.has(candidate.provider)) continue;
      if (!state.answered || candidate.provider === failed.provider) return { index: i, crossProvider: null };
      if (!crossProvider) crossProvider = candidate;
    }
    return { index: -1, crossProvider };
  }

  async routeTargets(targets, messages, options = {}, state = this.newRouteState()) {
    const list = (Array.isArray(targets) ? targets : []).filter((x) => x && x.provider && x.model);
    if (!list.length) throw new Error('No model to call: the resolved list is empty.');
    if (state.index >= list.length) state.index = 0;
    const label = (x) => `${x.provider}/${x.model}`;
    let payload = messages;
    const attemptsByReason = {};
    const flags = { totalAttempts: 0, credentialRefreshed: false, contextCompressed: false };
    const skipProviders = new Set();

    for (let guard = 0; guard <= this.policy.maxTotalAttempts; guard += 1) {
      const target = list[state.index];
      // A stream that has already emitted a chunk can never be retried or
      // failed over without duplicating what the user already saw, so this
      // attempt's onChunk is wrapped to remember whether that happened.
      let streamed = false;
      const attemptOptions = typeof options.onChunk === 'function'
        ? { ...options, onChunk: (chunk) => { streamed = true; return options.onChunk(chunk); } }
        : options;
      try {
        const instance = await this._instanceFor(target.provider, state);
        const response = await this.executeTarget(instance, target, payload, attemptOptions);
        state.answered = true;
        state.lastInstance = instance;
        return response;
      } catch (err) {
        if (options.abortSignal?.aborted) throw err;
        if (streamed) throw err;
        flags.totalAttempts += 1;
        const plan = this.policy.plan(err, { ...flags, attemptsByReason, provider: target.provider, model: target.model, aborted: false });
        attemptsByReason[plan.reason] = (attemptsByReason[plan.reason] || 0) + 1;
        const authFailure = plan.reason === 'auth' || plan.reason === 'auth_permanent';
        if (authFailure) {
          this._reportAuth(target.provider, err);
          // The key is rejected: the provider's other models fail the same way.
          skipProviders.add(target.provider);
        }
        let action = plan.action;
        if (action === RecoveryAction.ROTATE_CREDENTIAL && !this.rotateCredential) action = RecoveryAction.FALLBACK_MODEL;
        if (action === RecoveryAction.COMPRESS_CONTEXT && !this.compressContext) action = RecoveryAction.FALLBACK_MODEL;
        if (action === RecoveryAction.ABORT && authFailure) action = RecoveryAction.FALLBACK_MODEL;
        if (action === RecoveryAction.ABORT) {
          log.warn(`${label(target)} failed permanently (${plan.reason}): ${plan.detail}`);
          throw err;
        }
        if (action === RecoveryAction.RETRY) {
          log.warn(`${label(target)} ${plan.reason}; retrying in ${plan.waitMs}ms (attempt ${flags.totalAttempts}/${this.policy.maxTotalAttempts})`);
          if (plan.waitMs > 0) await this.sleep(plan.waitMs);
          if (options.abortSignal?.aborted) throw err;
          continue;
        }
        if (action === RecoveryAction.ROTATE_CREDENTIAL) {
          if (await this.rotateCredential(target.provider, err)) {
            flags.credentialRefreshed = true;
            continue;
          }
        }
        if (action === RecoveryAction.COMPRESS_CONTEXT) {
          const compressed = await this.compressContext(payload, { config: target, error: err });
          if (compressed) {
            payload = compressed;
            flags.contextCompressed = true;
            continue;
          }
        }
        const next = this._nextTarget(list, state, skipProviders, target);
        if (next.index === -1) {
          if (next.crossProvider) {
            const blocked = new Error(
              `${label(target)} failed (${plan.reason}: ${err.message}). The turn cannot move to ${label(next.crossProvider)} after its first model call; switch the main model or use Retry with… to try another model.`
            );
            blocked.code = 'FAILOVER_BLOCKED';
            blocked.cause = err;
            throw blocked;
          }
          log.warn(`${label(target)} failed (${plan.reason}) and the resolved list has nothing left.`);
          throw err;
        }
        log.warn(`${label(target)} failed (${plan.reason}); failing over to ${label(list[next.index])}.`);
        state.index = next.index;
        flags.credentialRefreshed = false;
        for (const key of Object.keys(attemptsByReason)) delete attemptsByReason[key];
      }
    }
    throw new Error('Failover loop exceeded its attempt ceiling without resolving.');
  }

  // A provider-shaped object over one resolved list, for an agent loop or a
  // single call. Its state (where it is in the list, whether anything has
  // answered) lives as long as the object: one per conversation history.
  routedProvider({ targets, signal = null } = {}) {
    const list = (Array.isArray(targets) ? targets : [])
      .filter((x) => x && x.provider && x.model)
      .map((x) => ({ provider: String(x.provider).toLowerCase(), model: String(x.model), effort: x.effort || null }));
    if (!list.length) throw new Error('A routed provider needs at least one target.');
    const state = this.newRouteState();
    const call = (messages, opts = {}, tools = null, onChunk = null) => this.routeTargets(list, messages, {
      ...(opts || {}),
      ...(Array.isArray(tools) ? { tools } : {}),
      ...(typeof onChunk === 'function' ? { onChunk } : {}),
      ...(!opts?.abortSignal && signal ? { abortSignal: signal } : {})
    }, state);
    const current = () => ({ ...list[Math.min(state.index, list.length - 1)] });
    const answered = (name) => {
      const instance = state.lastInstance;
      return instance && typeof instance[name] === 'function' ? instance[name].bind(instance) : undefined;
    };
    const provider = {
      routed: true,
      targets: () => list.map((x) => ({ ...x })),
      current,
      getProviderName: () => current().provider,
      getDefaultModel: () => current().model,
      sendMessage: (messages, opts) => call(messages, opts),
      streamMessage: (messages, opts, onChunk) => call(messages, opts, null, onChunk),
      sendMessageWithTools: (messages, tools, opts) => call(messages, opts, tools),
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
    Object.defineProperty(provider, 'buildToolMessages', { enumerable: true, get: () => answered('buildToolMessages') });
    Object.defineProperty(provider, 'buildMultiToolMessages', { enumerable: true, get: () => answered('buildMultiToolMessages') });
    return provider;
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
    // options.target ({ provider, model }) pins the first target (a case
    // role, or the owner's chat selection); fallbacks still apply after it.
    const { target, ...execOptions } = options || {};
    let config = target && target.provider
      ? { provider: String(target.provider).toLowerCase(), model: target.model || '', tier: this.getTierConfig(tier).tier }
      : this.getTierConfig(tier);
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
        return await this.execute(config, payload, execOptions);
      } catch (err) {
        state.totalAttempts += 1;

        const plan = this.policy.plan(err, {
          ...state,
          attemptsByReason,
          provider: config.provider,
          model: config.model,
          aborted: execOptions.abortSignal?.aborted
        });

        attemptsByReason[plan.reason] = (attemptsByReason[plan.reason] || 0) + 1;

        if (this.onProviderError && (plan.reason === 'auth' || plan.reason === 'auth_permanent')) {
          try {
            this.onProviderError(config.provider, err);
          } catch (hookErr) {
            log.warn(`Reporting a ${config.provider} auth failure failed: ${hookErr.message}`);
          }
        }

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
// src/providers/inference-router.js
// Calls a resolved list of models (spec 2026-09-27 §6.7). The resolver
// (src/models/resolver.js) decides which models a role may use; this walks
// the list, recovering from each failure as FailoverPolicy says — retry the
// same target, rotate a credential, compress the context, or fail over to
// the next target: any provider before the first answer, only the same
// provider after it. Tiers, smart routing and the LLM router are gone (§13).
const { FailoverPolicy } = require('./failover-policy');
const { RecoveryAction } = require('./error-classifier');
const { createLogger } = require('../logging');
const log = createLogger('inference-router');

class InferenceRouter {
  constructor(options = {}) {
    this.getProviderToken = options.getProviderToken;
    this.createProvider = options.createProvider;

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

  // ---- Resolved target lists (spec 2026-09-27 §6.7) ----

  newRouteState(tags = null) {
    return {
      index: 0,
      answered: false,
      instances: new Map(),
      lastInstance: null,
      tags: tags && typeof tags === 'object' ? { ...tags } : null
    };
  }

  // Cost records (spec 2026-09-27 §10): the role, profile and borrow a call
  // ran under, and whether a failover target (not the list's first)
  // answered. Only a route built with tags has them.
  callTags(state) {
    if (!state || !state.tags) return {};
    const { role = null, profileId = null, borrowedFrom = null, caseRole = null } = state.tags;
    return { role, profileId, borrowedFrom, failover: state.index > 0, ...(caseRole ? { caseRole } : {}) };
  }

  _stamp(metrics, state) {
    if (!state?.tags || !metrics || typeof metrics !== 'object') return metrics;
    return { ...metrics, ...this.callTags(state) };
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
        if (response && typeof response === 'object' && response.llmMetrics) {
          response.llmMetrics = this._stamp(response.llmMetrics, state);
        }
        return response;
      } catch (err) {
        if (options.abortSignal?.aborted) {
          // A stopped call's partial usage is recorded too (spec §9), tagged.
          if (err && typeof err === 'object' && err.partialLlmMetrics) err.partialLlmMetrics = this._stamp(err.partialLlmMetrics, state);
          throw err;
        }
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
  routedProvider({ targets, signal = null, meta = null } = {}) {
    const list = (Array.isArray(targets) ? targets : [])
      .filter((x) => x && x.provider && x.model)
      .map((x) => ({ provider: String(x.provider).toLowerCase(), model: String(x.model), effort: x.effort || null }));
    if (!list.length) throw new Error('A routed provider needs at least one target.');
    const state = this.newRouteState(meta);
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
      callTags: () => this.callTags(state),
      sendMessage: (messages, opts) => call(messages, opts),
      streamMessage: (messages, opts, onChunk) => call(messages, opts, null, onChunk),
      sendMessageWithTools: (messages, tools, opts) => call(messages, opts, tools),
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
    Object.defineProperty(provider, 'buildToolMessages', { enumerable: true, get: () => answered('buildToolMessages') });
    Object.defineProperty(provider, 'buildMultiToolMessages', { enumerable: true, get: () => answered('buildMultiToolMessages') });
    return provider;
  }
}

module.exports = InferenceRouter;
// src/providers/inference-router.js
// Calls a resolved list of models (spec 2026-09-27 §6.7). The resolver
// (src/models/resolver.js) decides which models a role may use; this walks
// the list, recovering from each failure as FailoverPolicy says — retry the
// same target, rotate a credential, compress the context, or fail over to
// the next target: any provider before the first answer, only the same
// provider after it. Tiers, smart routing and the LLM router are gone (§13).
const { FailoverPolicy } = require('./failover-policy');
const { RecoveryAction } = require('./error-classifier');
const { LOCAL_PROVIDER } = require('../models/provider-ids');
const { normalizePolicy, targetAllowed } = require('../models/egress');
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

    // The local server registry's answer to "may a private chat use this
    // target" (spec 2026-10-13 §5.3, §7.2 item 2): exactly `true`, or the
    // sentence that says why not. Without one, every target is refused
    // under an egress policy.
    this.isGuaranteeTarget = typeof options.isGuaranteeTarget === 'function'
      ? options.isGuaranteeTarget
      : null;
  }

  // ---- Resolved target lists (spec 2026-09-27 §6.7) ----

  // `egress` is the route's egress policy (src/models/egress.js) or null.
  // Anything else that is not a policy is a mark that could not be read,
  // and restricts like one.
  newRouteState(tags = null, egress = null) {
    return {
      index: 0,
      answered: false,
      instances: new Map(),
      lastInstance: null,
      tags: tags && typeof tags === 'object' ? { ...tags } : null,
      egress: normalizePolicy(egress),
      // The label of the first target this route failed over from.
      failoverFrom: null
    };
  }

  // The policy one call runs under: the route's, else one the caller put in
  // the call's own options. A caller's options never lift the route's.
  _egressOf(state, options) {
    return normalizePolicy(state ? state.egress : null) || normalizePolicy(options ? options.egress : null);
  }

  // The fail-closed line (spec 2026-10-13 §7.2 item 2): under a policy a
  // target that is not a guarantee-grade local model is never given an
  // instance. It holds when a caller built its list some other way than
  // through the resolver, which filters the same way.
  _assertMaySend(target, egress) {
    if (!egress) return;
    const verdict = targetAllowed(egress, target, this.isGuaranteeTarget);
    if (verdict === true) return;
    const err = new Error(`${verdict} Nothing was sent to a hosted model.`);
    err.code = 'PRIVATE_HOSTED_TARGET';
    throw err;
  }

  // Cost records (spec 2026-09-27 §10): the role, profile and borrow a call
  // ran under, and whether a failover target (not the list's first)
  // answered; after a failover, `failoverFrom` names the first target that
  // failed ("local/workstation/qwen3:8b", spec 2026-10-13 §9.3). Only a
  // route built with tags has them.
  callTags(state) {
    if (!state || !state.tags) return {};
    const { role = null, profileId = null, borrowedFrom = null, caseRole = null } = state.tags;
    const failover = state.index > 0;
    return {
      role, profileId, borrowedFrom, failover,
      ...(failover && state.failoverFrom ? { failoverFrom: state.failoverFrom } : {}),
      ...(caseRole ? { caseRole } : {})
    };
  }

  _stamp(metrics, state) {
    if (!state?.tags || !metrics || typeof metrics !== 'object') return metrics;
    return { ...metrics, ...this.callTags(state) };
  }

  // What one instance serves: a provider, or for `local` (one provider key
  // over many servers, spec 2026-10-13 §5.1) one server, named by the part
  // of the model id before its first slash.
  _instanceKey(target) {
    if (target.provider !== LOCAL_PROVIDER) return target.provider;
    const model = String(target.model || '');
    const slash = model.indexOf('/');
    return `${LOCAL_PROVIDER}:${slash === -1 ? model : model.slice(0, slash)}`;
  }

  async _instanceFor(target, state) {
    const key = this._instanceKey(target);
    if (state.instances.has(key)) return state.instances.get(key);
    if (typeof this.getProviderToken !== 'function' || typeof this.createProvider !== 'function') {
      throw new Error('InferenceRouter requires getProviderToken() and createProvider()');
    }
    const instance = this.createProvider(target.provider, this.getProviderToken(target.provider), { ...target });
    if (this.prepareProvider) await this.prepareProvider(instance, target.provider);
    state.instances.set(key, instance);
    return instance;
  }

  // One call to one target. The target decides the model; a caller's own
  // options.model never overrides it (the agent loop still passes one).
  async executeTarget(instance, target, messages, options = {}) {
    const { onChunk, tools, ...rest } = options || {};
    const opts = {
      ...rest,
      model: target.model,
      ...(target.effort ? { effort: target.effort } : {}),
      // A local target's adapter (spec 2026-10-13 §12): the local server's
      // provider sends the adapter's ref as the model. Never a caller's own.
      adapter: target.provider === LOCAL_PROVIDER && target.adapter ? target.adapter : undefined
    };
    if (opts.adapter === undefined) delete opts.adapter;
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
  // the history built so far is in that provider's format (every local
  // server speaks the same one, so another local server may take over).
  // skipProviders holds instance keys: a key one local server rejected says
  // nothing about another server. Under an egress policy only another
  // guarantee-grade local target may take over; every other one is passed by.
  _nextTarget(list, state, skipProviders, failed, egress = null) {
    let crossProvider = null;
    for (let i = state.index + 1; i < list.length; i += 1) {
      const candidate = list[i];
      if (skipProviders.has(this._instanceKey(candidate))) continue;
      if (egress && targetAllowed(egress, candidate, this.isGuaranteeTarget) !== true) continue;
      if (!state.answered || candidate.provider === failed.provider) return { index: i, crossProvider: null };
      if (!crossProvider) crossProvider = candidate;
    }
    return { index: -1, crossProvider };
  }

  async routeTargets(targets, messages, options = {}, state = this.newRouteState()) {
    const list = (Array.isArray(targets) ? targets : []).filter((x) => x && x.provider && x.model);
    if (!list.length) throw new Error('No model to call: the resolved list is empty.');
    if (state.index >= list.length) { state.index = 0; state.failoverFrom = null; }
    const label = (x) => `${x.provider}/${x.model}`;
    let payload = messages;
    const attemptsByReason = {};
    const flags = { totalAttempts: 0, credentialRefreshed: false, contextCompressed: false };
    const skipProviders = new Set();
    // The call's egress policy, handed to the provider too: a hosted
    // provider refuses to send under one (BaseLLMProvider#request).
    const egress = this._egressOf(state, options);
    const callOptions = egress ? { ...options, egress } : options;
    // Under a policy, a route that ran out of local targets says so, and
    // that nothing went to a hosted model (spec 2026-10-13 §9.3, R-LI-12).
    const unavailable = (target, err) => {
      if (!egress) return err;
      const slash = String(target.model).indexOf('/');
      const server = slash === -1 ? String(target.model) : String(target.model).slice(0, slash);
      const wrapped = new Error(
        `The local model ${label(target)} could not take this call (${err && err.message ? err.message : 'no answer'}), and no other local model on the list could. The local server ${server} was the last one tried, so nothing was sent to a hosted model.`
      );
      wrapped.code = 'LOCAL_MODEL_UNAVAILABLE';
      wrapped.cause = err;
      return wrapped;
    };

    for (let guard = 0; guard <= this.policy.maxTotalAttempts; guard += 1) {
      const target = list[state.index];
      // A stream that has already emitted a chunk can never be retried or
      // failed over without duplicating what the user already saw, so this
      // attempt's onChunk is wrapped to remember whether that happened.
      let streamed = false;
      const attemptOptions = typeof options.onChunk === 'function'
        ? { ...callOptions, onChunk: (chunk) => { streamed = true; return options.onChunk(chunk); } }
        : callOptions;
      // Outside the try: a refused target is never retried and the route
      // never moves on from it.
      this._assertMaySend(target, egress);
      try {
        const instance = await this._instanceFor(target, state);
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
          skipProviders.add(this._instanceKey(target));
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
        const next = this._nextTarget(list, state, skipProviders, target, egress);
        if (next.index === -1) {
          if (next.crossProvider) {
            const blocked = new Error(
              `${label(target)} failed (${plan.reason}: ${err.message}). The turn cannot move to ${label(next.crossProvider)} after its first model call; switch the main model or use Retry with… to try another model.`
            );
            blocked.code = 'FAILOVER_BLOCKED';
            blocked.cause = err;
            throw blocked;
          }
          log.warn(`${label(target)} failed (${plan.reason}) and the resolved list has nothing left${egress ? ' that may take a call under the egress policy' : ''}.`);
          throw unavailable(target, err);
        }
        log.warn(`${label(target)} failed (${plan.reason}); failing over to ${label(list[next.index])}.`);
        if (!state.failoverFrom) state.failoverFrom = label(target);
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
  routedProvider({ targets, signal = null, meta = null, egress = null } = {}) {
    const list = (Array.isArray(targets) ? targets : [])
      .filter((x) => x && x.provider && x.model)
      .map((x) => {
        const provider = String(x.provider).toLowerCase();
        const kept = { provider, model: String(x.model), effort: x.effort || null };
        // A local target's adapter goes with it (spec 2026-10-13 §12.2).
        if (provider === LOCAL_PROVIDER && typeof x.adapter === 'string' && x.adapter) kept.adapter = x.adapter;
        return kept;
      });
    if (!list.length) throw new Error('A routed provider needs at least one target.');
    const state = this.newRouteState(meta, egress);
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
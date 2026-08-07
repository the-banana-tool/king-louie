/**
 * Failover policy — turns a classification into an executable plan.
 *
 * The classifier says *what went wrong* and what kind of recovery fits.
 * This module owns the budgets: how many times a given reason may be
 * retried, how long to wait between attempts, and what to do once the
 * budget for that reason is spent.
 *
 * Still pure — it computes plans and never sleeps, calls, or logs. The
 * caller (inference-router, agent-loop) performs whatever the plan says.
 */

const { classifyError, FailoverReason, RecoveryAction } = require('./error-classifier');

/**
 * Per-reason retry budgets and backoff shape.
 *
 * `attempts` counts retries of the SAME target before escalating to
 * `escalateTo`. Reasons that can't be fixed by waiting get 0.
 *
 * Backoff is exponential from `baseMs`, capped at `maxMs`. A server-supplied
 * `retry-after` always wins over the computed value — the provider knows its
 * own window better than our curve does.
 */
const DEFAULT_BUDGETS = Object.freeze({
  [FailoverReason.RATE_LIMIT]: {
    attempts: 2, baseMs: 2000, maxMs: 60_000, escalateTo: RecoveryAction.ROTATE_CREDENTIAL
  },
  [FailoverReason.OVERLOADED]: {
    // Overload clears on its own but not quickly. Be patient before burning
    // a fallback: the primary model is usually the one the user asked for.
    attempts: 4, baseMs: 2000, maxMs: 30_000, escalateTo: RecoveryAction.FALLBACK_MODEL
  },
  [FailoverReason.SERVER_ERROR]: {
    attempts: 3, baseMs: 1000, maxMs: 15_000, escalateTo: RecoveryAction.FALLBACK_MODEL
  },
  [FailoverReason.TIMEOUT]: {
    attempts: 3, baseMs: 1000, maxMs: 10_000, escalateTo: RecoveryAction.FALLBACK_MODEL
  },
  [FailoverReason.CONTEXT_OVERFLOW]: {
    // One compression pass. If the request still doesn't fit, compressing
    // again is unlikely to help and a larger-context model is the real fix.
    attempts: 1, baseMs: 0, maxMs: 0, escalateTo: RecoveryAction.FALLBACK_MODEL
  },
  [FailoverReason.AUTH]: {
    attempts: 1, baseMs: 0, maxMs: 0, escalateTo: RecoveryAction.ABORT
  },
  [FailoverReason.BILLING]: {
    attempts: 1, baseMs: 0, maxMs: 0, escalateTo: RecoveryAction.FALLBACK_MODEL
  },
  [FailoverReason.UPSTREAM_RATE_LIMIT]: {
    // Never retry the same model — that's the thing that's throttled.
    attempts: 0, baseMs: 0, maxMs: 0, escalateTo: RecoveryAction.FALLBACK_MODEL
  },
  [FailoverReason.UNKNOWN]: {
    attempts: 0, baseMs: 0, maxMs: 0, escalateTo: RecoveryAction.FALLBACK_MODEL
  }
});

/** Hard ceiling on attempts across all reasons for one logical request. */
const DEFAULT_MAX_TOTAL_ATTEMPTS = 8;

function budgetFor(budgets, reason) {
  return budgets[reason] || { attempts: 0, baseMs: 0, maxMs: 0, escalateTo: RecoveryAction.ABORT };
}

/**
 * Exponential backoff with an optional server override.
 *
 * `retryAfterMs` wins outright when present: a 429 that says "wait 47s" means
 * 47s, and our curve guessing 4s just burns another rejected request. It is
 * still capped by `maxMs` so a pathological header can't stall the app —
 * except that we allow up to 2× maxMs for explicit server instructions, since
 * ignoring them entirely defeats the point.
 */
function computeWaitMs(budget, attemptForReason, retryAfterMs, jitterRatio, random) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, budget.maxMs * 2 || retryAfterMs);
  }

  if (!budget.baseMs) return 0;

  const exponential = budget.baseMs * Math.pow(2, Math.max(0, attemptForReason - 1));
  const capped = Math.min(exponential, budget.maxMs || exponential);

  if (!jitterRatio) return capped;

  // Jitter spreads a thundering herd of parallel agent calls that all got
  // rate limited at the same instant. Deterministic when `random` is stubbed.
  const jitter = capped * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

class FailoverPolicy {
  constructor(options = {}) {
    this.budgets = { ...DEFAULT_BUDGETS, ...(options.budgets || {}) };
    this.maxTotalAttempts = Number.isFinite(options.maxTotalAttempts)
      ? options.maxTotalAttempts
      : DEFAULT_MAX_TOTAL_ATTEMPTS;
    this.jitterRatio = Number.isFinite(options.jitterRatio) ? options.jitterRatio : 0;
    this.random = typeof options.random === 'function' ? options.random : Math.random;
  }

  /**
   * @param {Error} error   The provider failure.
   * @param {object} state
   * @param {number} state.totalAttempts        Attempts made so far for this
   *                                            logical request, all targets.
   * @param {object} state.attemptsByReason     reason -> count already spent.
   * @param {string} state.provider             Current target, for context.
   * @param {string} state.model
   * @param {boolean} state.credentialRefreshed
   * @param {boolean} state.contextCompressed
   * @returns {{action: string, reason: string, waitMs: number, detail: string,
   *            classification: object, exhausted: boolean}}
   */
  plan(error, state = {}) {
    const classification = classifyError(error, {
      provider: state.provider,
      model: state.model,
      credentialRefreshed: state.credentialRefreshed,
      contextCompressed: state.contextCompressed,
      aborted: state.aborted
    });

    const totalAttempts = Number(state.totalAttempts || 0);
    const attemptsByReason = state.attemptsByReason || {};
    const spent = Number(attemptsByReason[classification.reason] || 0);
    const budget = budgetFor(this.budgets, classification.reason);

    // A terminal classification is terminal regardless of budget.
    if (classification.action === RecoveryAction.ABORT) {
      return {
        action: RecoveryAction.ABORT,
        reason: classification.reason,
        waitMs: 0,
        detail: classification.detail,
        classification,
        exhausted: false
      };
    }

    if (totalAttempts >= this.maxTotalAttempts) {
      return {
        action: RecoveryAction.ABORT,
        reason: classification.reason,
        waitMs: 0,
        detail: `Giving up after ${totalAttempts} attempts: ${classification.detail}`,
        classification,
        exhausted: true
      };
    }

    // Budget for this reason spent — escalate rather than keep hammering.
    if (spent >= budget.attempts) {
      return {
        action: budget.escalateTo,
        reason: classification.reason,
        waitMs: 0,
        detail: `${classification.detail} (retry budget spent, escalating)`,
        classification,
        exhausted: true
      };
    }

    const waitMs = classification.action === RecoveryAction.RETRY
      ? computeWaitMs(budget, spent + 1, classification.retryAfterMs, this.jitterRatio, this.random)
      : 0;

    return {
      action: classification.action,
      reason: classification.reason,
      waitMs,
      detail: classification.detail,
      classification,
      exhausted: false
    };
  }
}

module.exports = {
  FailoverPolicy,
  DEFAULT_BUDGETS,
  DEFAULT_MAX_TOTAL_ATTEMPTS,
  computeWaitMs
};

/**
 * API error classification for smart failover and recovery.
 *
 * A structured taxonomy of provider failures plus a priority-ordered
 * classification pipeline that says which recovery action is correct:
 * retry, rotate credential, fall back to another model, compress the
 * context, or abort.
 *
 * This replaces the scattered inline substring matching that had grown
 * three independent copies (agent-loop's `isTransient`, tool-executor's
 * `extractErrorCode`, and inference-router's catch-all fallback), each
 * with slightly different ideas about what a 429 means.
 *
 * The classifier is PURE: it performs no I/O, sleeps for nothing, logs
 * nothing, and never carries out the recovery it recommends. That belongs
 * to failover-policy.js (what to do) and the router (doing it). Keeping it
 * pure is what makes it testable against recorded error payloads.
 */

/** Why an API call failed — determines the recovery strategy. */
const FailoverReason = Object.freeze({
  // Authentication / authorization
  AUTH: 'auth',                                 // 401/403 — refresh or rotate the credential
  AUTH_PERMANENT: 'auth_permanent',             // still failing after a refresh — abort

  // Billing / quota
  BILLING: 'billing',                           // 402 or confirmed credit exhaustion — rotate now
  RATE_LIMIT: 'rate_limit',                     // 429 against our key — back off, then rotate
  // Aggregator returned 429 for the upstream MODEL, not for our key. The
  // credential is healthy, so rotating it is pure waste — the fix is a
  // different model. Getting this wrong burns the fallback key on a problem
  // it cannot solve.
  UPSTREAM_RATE_LIMIT: 'upstream_rate_limit',

  // Server-side
  OVERLOADED: 'overloaded',                     // 503/529 — provider is shedding load, back off
  SERVER_ERROR: 'server_error',                 // 500/502/504 — retry

  // Transport
  TIMEOUT: 'timeout',                           // connect/read timeout, reset — rebuild client, retry
  TLS: 'tls',                                   // cert verification failure — deterministic per host

  // Request-shaped
  CONTEXT_OVERFLOW: 'context_overflow',         // too many tokens — compress and retry
  BAD_REQUEST: 'bad_request',                   // 400/404/422 — same payload fails identically

  // Control flow
  ABORTED: 'aborted',                           // user/AbortSignal cancelled — not a failure
  UNKNOWN: 'unknown'
});

/** What the runtime should do about it. */
const RecoveryAction = Object.freeze({
  RETRY: 'retry',                       // same target, after a wait
  ROTATE_CREDENTIAL: 'rotate_credential', // different key, same model
  FALLBACK_MODEL: 'fallback_model',     // different model/provider
  COMPRESS_CONTEXT: 'compress_context', // shrink the request, then retry
  ABORT: 'abort'                        // nothing will help
});

/**
 * Providers that front other providers. A 429 from these can mean either
 * "your account is throttled" or "the upstream model is throttled", and the
 * two want opposite recoveries.
 */
const AGGREGATOR_PROVIDERS = new Set([
  'openrouter',
  'together',
  'fireworks',
  'copilot'
]);

// Phrases an aggregator uses when the throttle belongs to the upstream model
// rather than to our account.
const UPSTREAM_MARKERS = [
  'upstream',
  'no available provider',
  'no allowed providers',
  'provider returned error',
  'all providers',
  'model is rate limited',
  'model is currently rate-limited',
  'temporarily rate-limited upstream'
];

const TLS_MARKERS = [
  'unable to verify the first certificate',
  'unable to get local issuer',
  'self signed certificate',
  'self-signed certificate',
  'cert_has_expired',
  'depth_zero_self_signed_cert',
  'err_tls',
  'certificate verify failed',
  'sslv3',
  'wrong version number'
];

const CONTEXT_OVERFLOW_MARKERS = [
  'context length',
  'context_length_exceeded',
  'maximum context',
  'context window',
  'too many tokens',
  'prompt is too long',
  'input is too long',
  'reduce the length of the messages',
  'exceeds the maximum',
  'string too long',
  'request too large'
];

const AUTH_MARKERS = [
  'invalid api key',
  'incorrect api key',
  'invalid_api_key',
  'unauthorized',
  'authentication',
  'invalid authentication',
  'no auth credentials',
  'permission denied',
  'invalid token',
  'expired token'
];

const BILLING_MARKERS = [
  'insufficient credit',
  'insufficient_quota',
  'insufficient funds',
  'billing',
  'payment required',
  'credit balance is too low',
  'exceeded your current quota',
  'add credits',
  'spending limit'
];

const RATE_LIMIT_MARKERS = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'quota exceeded',
  'requests per minute',
  'tokens per minute',
  'slow down'
];

const OVERLOADED_MARKERS = [
  'overloaded',
  'server is busy',
  'capacity',
  'temporarily unavailable',
  'service unavailable',
  'try again later'
];

const TIMEOUT_MARKERS = [
  'etimedout',
  'esockettimedout',
  'timeout',
  'timed out',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'enotfound',
  'eai_again',
  'ehostunreach',
  'enetunreach',
  'socket hang up',
  'fetch failed',
  'network error',
  'connection error',
  'premature close'
];

const ABORT_MARKERS = [
  'aborterror',
  'the operation was aborted',
  'request aborted',
  'operation cancelled',
  'operation canceled'
];

function includesAny(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

function errorText(error) {
  if (!error) return '';
  const parts = [
    error.message,
    error.code,
    error.type,
    typeof error === 'string' ? error : ''
  ];
  // A wrapped error (agent-loop wraps provider failures with context) hides
  // the real signal in `cause`. Look one level down so wrapping never
  // downgrades a precise classification to `unknown`.
  if (error.cause) {
    parts.push(error.cause.message, error.cause.code, error.cause.type);
  }
  return parts.filter(Boolean).map(String).join(' ').toLowerCase();
}

function statusOf(error) {
  if (!error) return null;
  const direct = error.status ?? error.statusCode ?? error.cause?.status ?? error.cause?.statusCode;
  return Number.isFinite(direct) ? direct : null;
}

function retryAfterOf(error) {
  const direct = error?.retryAfterMs ?? error?.cause?.retryAfterMs;
  return Number.isFinite(direct) ? direct : null;
}

function isAggregator(provider) {
  return AGGREGATOR_PROVIDERS.has(String(provider || '').toLowerCase());
}

function result(reason, action, error, detail, extra = {}) {
  return {
    reason,
    action,
    detail,
    status: statusOf(error),
    provider: String(error?.provider || extra.provider || '').toLowerCase(),
    model: error?.model || extra.model || '',
    retryAfterMs: retryAfterOf(error),
    // Convenience for callers that only care whether waiting could help.
    retryable: action === RecoveryAction.RETRY,
    permanent: action === RecoveryAction.ABORT
  };
}

/**
 * Classify a provider failure.
 *
 * @param {Error} error         The thrown error. A ProviderError gives the
 *                              most precise answer; a plain Error still
 *                              classifies via message heuristics.
 * @param {object} context
 * @param {string} context.provider          Provider key, when the error
 *                                           doesn't carry one.
 * @param {string} context.model             Model id, likewise.
 * @param {boolean} context.credentialRefreshed  True if we already refreshed
 *                                           or rotated the credential for
 *                                           this call — turns an auth failure
 *                                           from recoverable into permanent.
 * @param {boolean} context.contextCompressed    True if we already compressed
 *                                           once — a second overflow means
 *                                           compression isn't the answer.
 * @returns {{reason: string, action: string, detail: string, status: number|null,
 *            provider: string, model: string, retryAfterMs: number|null,
 *            retryable: boolean, permanent: boolean}}
 */
function classifyError(error, context = {}) {
  const status = statusOf(error);
  const text = errorText(error);
  const provider = String(error?.provider || context.provider || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();

  // ── Priority order matters. First match wins, most specific first. ──

  // 1. Cancellation is not a failure and must never trigger failover.
  if (name === 'aborterror' || includesAny(text, ABORT_MARKERS) || context.aborted) {
    return result(FailoverReason.ABORTED, RecoveryAction.ABORT, error,
      'Request was cancelled.', context);
  }

  // 2. TLS failures are deterministic for a given host — a TLS-inspecting
  //    proxy, a missing CA bundle, an expired cert. Retrying re-fails
  //    identically and failing over hides a fixable local misconfiguration.
  if (includesAny(text, TLS_MARKERS)) {
    return result(FailoverReason.TLS, RecoveryAction.ABORT, error,
      'TLS certificate verification failed — check for a proxy or missing CA bundle.', context);
  }

  // 3. Context overflow before generic 400 handling: it arrives as a 400 but
  //    is the one 400 that a changed request can fix.
  if (includesAny(text, CONTEXT_OVERFLOW_MARKERS)) {
    if (context.contextCompressed) {
      return result(FailoverReason.CONTEXT_OVERFLOW, RecoveryAction.FALLBACK_MODEL, error,
        'Still over the context limit after compression — need a larger-context model.', context);
    }
    return result(FailoverReason.CONTEXT_OVERFLOW, RecoveryAction.COMPRESS_CONTEXT, error,
      'Request exceeds the model context window.', context);
  }

  // 4. Billing before rate limit: a 402, or a 429 whose body says the account
  //    is out of credit rather than going too fast. Waiting never fixes that.
  if (status === 402 || includesAny(text, BILLING_MARKERS)) {
    return result(FailoverReason.BILLING, RecoveryAction.ROTATE_CREDENTIAL, error,
      'Billing or credit problem on this credential.', context);
  }

  // 5. Auth. A first 401/403 is worth one refresh — tokens expire, OAuth
  //    access tokens especially. A second one is a real credential problem.
  if (status === 401 || status === 403 || includesAny(text, AUTH_MARKERS)) {
    if (context.credentialRefreshed) {
      return result(FailoverReason.AUTH_PERMANENT, RecoveryAction.ABORT, error,
        'Authentication still failing after credential refresh.', context);
    }
    return result(FailoverReason.AUTH, RecoveryAction.ROTATE_CREDENTIAL, error,
      'Authentication rejected — refresh or rotate the credential.', context);
  }

  // 6. Rate limiting. The aggregator split is the important part: when the
  //    throttle belongs to the upstream model, our key is fine and only a
  //    different model helps.
  if (status === 429 || includesAny(text, RATE_LIMIT_MARKERS)) {
    if (isAggregator(provider) && includesAny(text, UPSTREAM_MARKERS)) {
      return result(FailoverReason.UPSTREAM_RATE_LIMIT, RecoveryAction.FALLBACK_MODEL, error,
        'Upstream model is rate limited — the credential is healthy, switch models.', context);
    }
    return result(FailoverReason.RATE_LIMIT, RecoveryAction.RETRY, error,
      'Rate limited — back off before retrying.', context);
  }

  // 7. Overload. Distinguished from a plain 5xx because it deserves a longer,
  //    more patient backoff rather than an immediate retry.
  if (status === 503 || status === 529 || includesAny(text, OVERLOADED_MARKERS)) {
    return result(FailoverReason.OVERLOADED, RecoveryAction.RETRY, error,
      'Provider is overloaded — back off and retry.', context);
  }

  // 8. Other server errors.
  if (status !== null && status >= 500) {
    return result(FailoverReason.SERVER_ERROR, RecoveryAction.RETRY, error,
      `Provider returned ${status}.`, context);
  }

  // 9. Transport failures. Checked after status codes so a 500 whose body
  //    happens to contain the word "timeout" is still a server error.
  if (includesAny(text, TIMEOUT_MARKERS)) {
    return result(FailoverReason.TIMEOUT, RecoveryAction.RETRY, error,
      'Network timeout or connection failure — rebuild the client and retry.', context);
  }

  // 10. Remaining 4xx. The request itself is wrong; an identical retry fails
  //     identically, and a different model usually rejects it the same way.
  if (status !== null && status >= 400 && status < 500) {
    return result(FailoverReason.BAD_REQUEST, RecoveryAction.ABORT, error,
      `Provider rejected the request (${status}).`, context);
  }

  // 11. Everything else. Falling back is the historical behaviour and stays
  //     the safe default — another provider may simply work.
  return result(FailoverReason.UNKNOWN, RecoveryAction.FALLBACK_MODEL, error,
    'Unclassified provider failure.', context);
}

module.exports = {
  classifyError,
  FailoverReason,
  RecoveryAction,
  AGGREGATOR_PROVIDERS
};

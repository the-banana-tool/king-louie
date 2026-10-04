'use strict';
// Retries for LongHaul's provider calls (benchmark spec §15: an answer or
// judge call is retried three times, then recorded as an error). A 429, a
// 5xx or a transport failure is retried with exponential backoff, or after
// the provider's retry-after; anything else (a 400, a refused key) is thrown
// at once. A refusal that means the account is out of credit or quota is
// never retried, though it often arrives as a 429: waiting adds no credit,
// and every later call would fail the same way, so a run stops on it as on
// a refused key (QUOTA).
const { UsageError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What a ProviderError carries (buildProviderError reads the body): OpenAI
// answers 429 with error.type and error.code "insufficient_quota"; Anthropic
// answers 402 billing_error, or 400 invalid_request_error whose message says
// the credit balance is too low; DeepSeek and OpenRouter answer 402. A plain
// rate limit (OpenAI rate_limit_exceeded, Anthropic rate_limit_error) is none
// of these, even when its message links the billing page, so the word
// "billing" alone is never read (unlike error-classifier.js's BILLING).
const QUOTA_IDS = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_error', 'billing_hard_limit_reached']);
const QUOTA_MESSAGE = /credit balance is too low|exceeded your current quota|insufficient[ _](quota|balance|credits?|funds)/i;
const QUOTA_MESSAGE_STATUSES = new Set([400, 403, 429]);

function isQuotaFailure(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.status === 402) return true;
  if ([err.code, err.type].some((v) => QUOTA_IDS.has(String(v || '').toLowerCase()))) return true;
  return QUOTA_MESSAGE_STATUSES.has(err.status) && QUOTA_MESSAGE.test(String(err.message || ''));
}

function retryable(err) {
  if (!err) return false;
  if (isQuotaFailure(err)) return false;
  if (err.status === 429 || (Number.isInteger(err.status) && err.status >= 500)) return true;
  if (Number.isInteger(err.status)) return false;
  // A transport failure (fetch rejects with a TypeError): reset, DNS, timeout.
  return err.name === 'TypeError' || /fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(String(err.message || ''));
}

// A refused key: every later call would fail the same way, so a run stops.
function isAuthFailure(err) {
  return Boolean(err) && (err.status === 401 || err.status === 403);
}

// The UsageError codes that stop a run (a refused key, an exhausted account).
const STOP_CODES = Object.freeze(['AUTH', 'QUOTA']);

// The record code for a model call that failed (answer, judge or summary):
// over-budget for the cap, else <stage>-failed with the HTTP status if any.
function callErrorCode(stage, err) {
  if (err && err.code === 'OVER_BUDGET') return 'over-budget';
  return `${stage}-failed${Number.isInteger(err?.status) ? `:${err.status}` : ''}`;
}

// The error that stops a run on a refused key; forWhat names the caller
// when it is not the answer or judge model ("the summarizer").
function authStopError(provider, status, forWhat = null) {
  return new UsageError(`${provider} refused the API key (${status})${forWhat ? ` for ${forWhat}` : ''}; the run stopped. `
    + 'Finished calls are cached, so running again costs only what is left.', 'AUTH');
}

// The error that stops a run on an account out of credit or quota.
function quotaStopError(provider, status, forWhat = null) {
  return new UsageError(`${provider} refused the call: the account is out of credit or quota`
    + `${Number.isInteger(status) ? ` (${status})` : ''}${forWhat ? ` for ${forWhat}` : ''}; the run stopped. `
    + 'Add credit, then run again: finished calls are cached, so running again costs only what is left.', 'QUOTA');
}

// The error that stops a run for this failure (QUOTA before AUTH: a 403 can
// say the credit is gone), or null when the run goes on.
function stopErrorFor(err, provider, forWhat = null) {
  if (isQuotaFailure(err)) return quotaStopError(provider, err.status, forWhat);
  if (isAuthFailure(err)) return authStopError(provider, err.status, forWhat);
  return null;
}

// onRetry({ err, attempt, delayMs }) runs before each wait (a caller's log
// line). isRetryable replaces retryable (Jev also retries its own timeouts).
async function withRetries(fn, { retries = 3, baseDelayMs = 1000, wait = sleep, onRetry = null, isRetryable = retryable } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : baseDelayMs * 2 ** (attempt - 1);
      if (onRetry) onRetry({ err, attempt, delayMs: delay });
      await wait(delay);
    }
  }
}

module.exports = {
  retryable, isQuotaFailure, isAuthFailure, STOP_CODES, callErrorCode, authStopError, quotaStopError, stopErrorFor, withRetries
};

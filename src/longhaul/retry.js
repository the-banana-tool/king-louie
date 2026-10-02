'use strict';
// Retries for LongHaul's provider calls (benchmark spec §15: an answer or
// judge call is retried three times, then recorded as an error). A 429, a
// 5xx or a transport failure is retried with exponential backoff, or after
// the provider's retry-after; anything else (a 400, a refused key) is thrown
// at once.
const { UsageError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(err) {
  if (!err) return false;
  if (err.status === 429 || (Number.isInteger(err.status) && err.status >= 500)) return true;
  if (Number.isInteger(err.status)) return false;
  // A transport failure (fetch rejects with a TypeError): reset, DNS, timeout.
  return err.name === 'TypeError' || /fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(String(err.message || ''));
}

// A refused key: every later call would fail the same way, so a run stops.
function isAuthFailure(err) {
  return Boolean(err) && (err.status === 401 || err.status === 403);
}

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

// onRetry({ err, attempt, delayMs }) runs before each wait (a caller's log line).
async function withRetries(fn, { retries = 3, baseDelayMs = 1000, wait = sleep, onRetry = null } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !retryable(err)) throw err;
      const delay = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : baseDelayMs * 2 ** (attempt - 1);
      if (onRetry) onRetry({ err, attempt, delayMs: delay });
      await wait(delay);
    }
  }
}

module.exports = { retryable, isAuthFailure, callErrorCode, authStopError, withRetries };

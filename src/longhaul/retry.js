'use strict';
// Retries for LongHaul's provider calls (benchmark spec §15: an answer or
// judge call is retried three times, then recorded as an error). A 429, a
// 5xx or a transport failure is retried with exponential backoff, or after
// the provider's retry-after; anything else (a 400, a refused key) is thrown
// at once.
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

async function withRetries(fn, { retries = 3, baseDelayMs = 1000, wait = sleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt > retries || !retryable(err)) throw err;
      const delay = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : baseDelayMs * 2 ** (attempt - 1);
      await wait(delay);
    }
  }
}

module.exports = { retryable, isAuthFailure, withRetries };

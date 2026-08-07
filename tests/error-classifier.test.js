const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  classifyError,
  FailoverReason,
  RecoveryAction
} = require('../src/providers/error-classifier');
const {
  ProviderError,
  buildProviderError,
  parseRetryAfter,
  parseRetryHintFromMessage
} = require('../src/providers/provider-error');
const {
  FailoverPolicy,
  computeWaitMs
} = require('../src/providers/failover-policy');

// Minimal stand-in for a fetch Response. Only the fields buildProviderError
// reads are present, so the test fails loudly if it starts reading more.
const fakeResponse = (status, statusText = '', headers = {}) => ({
  status,
  statusText,
  headers: {
    get: (name) => headers[String(name).toLowerCase()] ?? null
  }
});

const providerError = (status, message, extra = {}) =>
  new ProviderError(message, { status, ...extra });

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    assert.strictEqual(parseRetryAfter('120'), 120_000);
    assert.strictEqual(parseRetryAfter('0'), 0);
    assert.strictEqual(parseRetryAfter('1.5'), 1500);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const at = new Date(now + 30_000).toUTCString();
    const parsed = parseRetryAfter(at, now);
    // UTCString truncates to whole seconds.
    assert.ok(parsed >= 29_000 && parsed <= 30_000, `got ${parsed}`);
  });

  it('clamps a past HTTP-date to zero rather than going negative', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const at = new Date(now - 60_000).toUTCString();
    assert.strictEqual(parseRetryAfter(at, now), 0);
  });

  it('caps absurd values instead of stalling the app', () => {
    assert.strictEqual(parseRetryAfter('999999'), 5 * 60 * 1000);
  });

  it('returns null for junk', () => {
    assert.strictEqual(parseRetryAfter(null), null);
    assert.strictEqual(parseRetryAfter(''), null);
    assert.strictEqual(parseRetryAfter('soon'), null);
  });
});

describe('parseRetryHintFromMessage', () => {
  it('reads OpenAI-style inline hints', () => {
    assert.strictEqual(
      parseRetryHintFromMessage('Rate limit reached. Please try again in 1.5s'),
      1500
    );
  });

  it('reads minutes and milliseconds', () => {
    assert.strictEqual(parseRetryHintFromMessage('try again in 2 minutes'), 120_000);
    assert.strictEqual(parseRetryHintFromMessage('retry after 250ms'), 250);
  });

  it('ignores unrelated numbers', () => {
    assert.strictEqual(parseRetryHintFromMessage('model gpt-4o returned 3 choices'), null);
  });
});

describe('buildProviderError', () => {
  it('preserves the message and captures status, code and type', () => {
    const err = buildProviderError(
      fakeResponse(400, 'Bad Request'),
      'This model has a maximum context length of 8192 tokens',
      {
        provider: 'openai',
        body: { error: { code: 'context_length_exceeded', type: 'invalid_request_error' } }
      }
    );

    assert.ok(err instanceof ProviderError);
    assert.strictEqual(err.message, 'This model has a maximum context length of 8192 tokens');
    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.provider, 'openai');
    assert.strictEqual(err.code, 'context_length_exceeded');
    assert.strictEqual(err.type, 'invalid_request_error');
  });

  it('reads retry-after from the header', () => {
    const err = buildProviderError(
      fakeResponse(429, 'Too Many Requests', { 'retry-after': '47' }),
      'Rate limit exceeded',
      { provider: 'anthropic' }
    );
    assert.strictEqual(err.retryAfterMs, 47_000);
  });

  it('falls back to an inline hint when the header is absent', () => {
    const err = buildProviderError(
      fakeResponse(429, 'Too Many Requests'),
      'Rate limit reached. Please try again in 20s',
      { provider: 'openai' }
    );
    assert.strictEqual(err.retryAfterMs, 20_000);
  });

  it('marks transport failures as having no status', () => {
    const err = new ProviderError('fetch failed', { provider: 'groq' });
    assert.strictEqual(err.status, null);
    assert.strictEqual(err.isTransport, true);
  });
});

describe('classifyError — real provider payloads', () => {
  it('classifies an OpenAI 429 as a retryable rate limit', () => {
    const c = classifyError(providerError(
      429,
      'Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000',
      { provider: 'openai', retryAfterMs: 6000 }
    ));
    assert.strictEqual(c.reason, FailoverReason.RATE_LIMIT);
    assert.strictEqual(c.action, RecoveryAction.RETRY);
    assert.strictEqual(c.retryAfterMs, 6000);
    assert.strictEqual(c.retryable, true);
  });

  it('classifies an Anthropic 529 as overloaded', () => {
    const c = classifyError(providerError(
      529, 'Overloaded', { provider: 'anthropic' }
    ));
    assert.strictEqual(c.reason, FailoverReason.OVERLOADED);
    assert.strictEqual(c.action, RecoveryAction.RETRY);
  });

  it('classifies an OpenAI 402 / credit exhaustion as billing', () => {
    const c = classifyError(providerError(
      402, 'Your credit balance is too low to access the API', { provider: 'anthropic' }
    ));
    assert.strictEqual(c.reason, FailoverReason.BILLING);
    assert.strictEqual(c.action, RecoveryAction.ROTATE_CREDENTIAL);
  });

  it('does not mistake an insufficient_quota 429 for a rate limit', () => {
    // OpenAI returns 429 for "you are out of money", which no amount of
    // waiting fixes. Billing must win over rate limiting.
    const c = classifyError(providerError(
      429,
      'You exceeded your current quota, please check your plan and billing details',
      { provider: 'openai', code: 'insufficient_quota' }
    ));
    assert.strictEqual(c.reason, FailoverReason.BILLING);
    assert.notStrictEqual(c.action, RecoveryAction.RETRY);
  });

  it('classifies a 401 as recoverable auth, then permanent after a refresh', () => {
    const err = providerError(401, 'Incorrect API key provided', { provider: 'openai' });

    const first = classifyError(err);
    assert.strictEqual(first.reason, FailoverReason.AUTH);
    assert.strictEqual(first.action, RecoveryAction.ROTATE_CREDENTIAL);

    const second = classifyError(err, { credentialRefreshed: true });
    assert.strictEqual(second.reason, FailoverReason.AUTH_PERMANENT);
    assert.strictEqual(second.action, RecoveryAction.ABORT);
    assert.strictEqual(second.permanent, true);
  });

  it('classifies context overflow as compressible, then as needing a bigger model', () => {
    const err = providerError(
      400,
      "This model's maximum context length is 128000 tokens, however you requested 141000",
      { provider: 'openai', code: 'context_length_exceeded' }
    );

    const first = classifyError(err);
    assert.strictEqual(first.reason, FailoverReason.CONTEXT_OVERFLOW);
    assert.strictEqual(first.action, RecoveryAction.COMPRESS_CONTEXT);

    const second = classifyError(err, { contextCompressed: true });
    assert.strictEqual(second.action, RecoveryAction.FALLBACK_MODEL);
  });

  it('classifies Anthropic prompt-too-long as context overflow, not bad request', () => {
    const c = classifyError(providerError(
      400, 'prompt is too long: 210000 tokens > 200000 maximum', { provider: 'anthropic' }
    ));
    assert.strictEqual(c.reason, FailoverReason.CONTEXT_OVERFLOW);
  });

  it('classifies a generic 400 as a permanent bad request', () => {
    const c = classifyError(providerError(
      400, 'Invalid value for tool_choice', { provider: 'openai' }
    ));
    assert.strictEqual(c.reason, FailoverReason.BAD_REQUEST);
    assert.strictEqual(c.action, RecoveryAction.ABORT);
  });

  it('classifies a 500 as a retryable server error', () => {
    const c = classifyError(providerError(500, 'Internal server error', { provider: 'groq' }));
    assert.strictEqual(c.reason, FailoverReason.SERVER_ERROR);
    assert.strictEqual(c.action, RecoveryAction.RETRY);
  });

  it('classifies Ollama connection refusal as a timeout-class transport failure', () => {
    const c = classifyError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434'), {
      provider: 'ollama'
    });
    assert.strictEqual(c.reason, FailoverReason.TIMEOUT);
    assert.strictEqual(c.action, RecoveryAction.RETRY);
  });

  it('classifies TLS failures as permanent rather than retrying a certainty', () => {
    const c = classifyError(new Error('unable to verify the first certificate'), {
      provider: 'openai'
    });
    assert.strictEqual(c.reason, FailoverReason.TLS);
    assert.strictEqual(c.action, RecoveryAction.ABORT);
  });

  it('never fails over on user cancellation', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const c = classifyError(abort, { provider: 'anthropic' });
    assert.strictEqual(c.reason, FailoverReason.ABORTED);
    assert.strictEqual(c.action, RecoveryAction.ABORT);
  });

  it('falls back on an unclassifiable error, preserving old behaviour', () => {
    const c = classifyError(new Error('Groq failed'), { provider: 'groq' });
    assert.strictEqual(c.reason, FailoverReason.UNKNOWN);
    assert.strictEqual(c.action, RecoveryAction.FALLBACK_MODEL);
  });

  it('sees through a wrapped error to the real cause', () => {
    // agent-loop wraps provider failures with iteration/model context.
    const cause = providerError(529, 'Overloaded', { provider: 'anthropic' });
    const wrapped = new Error('Provider call failed (iteration 3, model "x"): Overloaded');
    wrapped.cause = cause;

    const c = classifyError(wrapped);
    assert.strictEqual(c.reason, FailoverReason.OVERLOADED);
  });
});

describe('classifyError — aggregator rate limits', () => {
  it('routes an upstream-model 429 to a model fallback, not a credential rotation', () => {
    const c = classifyError(providerError(
      429,
      'Provider returned error: upstream model is rate limited',
      { provider: 'openrouter' }
    ));
    assert.strictEqual(c.reason, FailoverReason.UPSTREAM_RATE_LIMIT);
    assert.strictEqual(c.action, RecoveryAction.FALLBACK_MODEL);
  });

  it('still treats an account-level 429 on an aggregator as a normal rate limit', () => {
    const c = classifyError(providerError(
      429, 'Rate limit exceeded for your account', { provider: 'openrouter' }
    ));
    assert.strictEqual(c.reason, FailoverReason.RATE_LIMIT);
    assert.strictEqual(c.action, RecoveryAction.RETRY);
  });

  it('does not apply the upstream split to first-party providers', () => {
    const c = classifyError(providerError(
      429, 'upstream connect error rate limited', { provider: 'openai' }
    ));
    assert.strictEqual(c.reason, FailoverReason.RATE_LIMIT);
  });
});

describe('computeWaitMs', () => {
  const budget = { attempts: 3, baseMs: 1000, maxMs: 10_000 };

  it('grows exponentially and caps', () => {
    assert.strictEqual(computeWaitMs(budget, 1, null, 0, Math.random), 1000);
    assert.strictEqual(computeWaitMs(budget, 2, null, 0, Math.random), 2000);
    assert.strictEqual(computeWaitMs(budget, 3, null, 0, Math.random), 4000);
    assert.strictEqual(computeWaitMs(budget, 9, null, 0, Math.random), 10_000);
  });

  it('lets a server-supplied retry-after win over the curve', () => {
    assert.strictEqual(computeWaitMs(budget, 1, 15_000, 0, Math.random), 15_000);
  });

  it('applies jitter deterministically when a random source is injected', () => {
    // random() === 1 -> full positive jitter.
    assert.strictEqual(computeWaitMs(budget, 1, null, 0.5, () => 1), 1500);
    assert.strictEqual(computeWaitMs(budget, 1, null, 0.5, () => 0), 500);
  });
});

describe('FailoverPolicy', () => {
  const policy = () => new FailoverPolicy();

  it('retries a rate limit until its budget is spent, then escalates', () => {
    const p = policy();
    const err = providerError(429, 'Rate limit exceeded', { provider: 'openai' });
    const attemptsByReason = {};

    const first = p.plan(err, { totalAttempts: 1, attemptsByReason });
    assert.strictEqual(first.action, RecoveryAction.RETRY);
    attemptsByReason[first.reason] = 1;

    const second = p.plan(err, { totalAttempts: 2, attemptsByReason });
    assert.strictEqual(second.action, RecoveryAction.RETRY);
    assert.ok(second.waitMs > first.waitMs, 'backoff should grow');
    attemptsByReason[second.reason] = 2;

    const third = p.plan(err, { totalAttempts: 3, attemptsByReason });
    assert.strictEqual(third.action, RecoveryAction.ROTATE_CREDENTIAL);
    assert.strictEqual(third.exhausted, true);
  });

  it('never retries an upstream rate limit — it falls back immediately', () => {
    const p = policy();
    const plan = p.plan(
      providerError(429, 'Provider returned error: upstream model is rate limited', {
        provider: 'openrouter'
      }),
      { totalAttempts: 1, attemptsByReason: {} }
    );
    assert.strictEqual(plan.action, RecoveryAction.FALLBACK_MODEL);
    assert.strictEqual(plan.waitMs, 0);
  });

  it('aborts immediately on a permanent classification regardless of budget', () => {
    const p = policy();
    const plan = p.plan(
      providerError(400, 'Invalid value for tool_choice', { provider: 'openai' }),
      { totalAttempts: 1, attemptsByReason: {} }
    );
    assert.strictEqual(plan.action, RecoveryAction.ABORT);
  });

  it('gives up once the total attempt ceiling is reached', () => {
    const p = new FailoverPolicy({ maxTotalAttempts: 2 });
    const plan = p.plan(
      providerError(500, 'Internal server error', { provider: 'groq' }),
      { totalAttempts: 2, attemptsByReason: {} }
    );
    assert.strictEqual(plan.action, RecoveryAction.ABORT);
    assert.strictEqual(plan.exhausted, true);
  });

  it('honours a server retry-after over its own backoff curve', () => {
    const p = policy();
    const plan = p.plan(
      providerError(429, 'Rate limit', { provider: 'anthropic', retryAfterMs: 9000 }),
      { totalAttempts: 1, attemptsByReason: {} }
    );
    assert.strictEqual(plan.waitMs, 9000);
  });
});

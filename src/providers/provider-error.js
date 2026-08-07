/**
 * ProviderError — a provider API failure that still carries its HTTP context.
 *
 * Providers used to throw `new Error(await this.extractError(response))`,
 * which reduced every failure to a human-readable string. The status code,
 * the `retry-after` header, and the provider identity were all discarded at
 * the throw site, so every downstream consumer had to guess by substring
 * matching on the message — which is exactly what agent-loop, tool-executor
 * and inference-router each grew their own copy of.
 *
 * ProviderError keeps `message` byte-identical to what those providers
 * produced before, so any existing message-based matching keeps working, and
 * attaches the structured fields the classifier actually wants.
 */

const RETRY_AFTER_MAX_MS = 5 * 60 * 1000;

/**
 * Parse an HTTP `Retry-After` header. Per RFC 9110 it is either a count of
 * seconds or an HTTP-date. Returns null when absent or unparseable — never
 * throws, and never returns a negative or absurd delay.
 */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  // Delta-seconds form: "120"
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const ms = Number(raw) * 1000;
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.min(ms, RETRY_AFTER_MAX_MS);
  }

  // HTTP-date form: "Wed, 21 Oct 2026 07:28:00 GMT"
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;

  const ms = at - now;
  if (ms <= 0) return 0;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

/**
 * Some providers put the wait in the message body rather than a header —
 * OpenAI's "Please try again in 1.5s", Anthropic's "retry after 20 seconds".
 * Only consulted when the header is absent.
 */
function parseRetryHintFromMessage(message, now = Date.now()) {
  const text = String(message || '');
  if (!text) return null;

  const match = text.match(/(?:try again|retry)(?:\s+\w+){0,3}?\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const unit = match[2].toLowerCase();
  let ms;
  if (unit === 'ms' || unit.startsWith('millisecond')) {
    ms = amount;
  } else if (unit === 'm' || unit.startsWith('min')) {
    ms = amount * 60 * 1000;
  } else {
    ms = amount * 1000;
  }

  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  // Plain-object headers (test doubles, non-fetch transports)
  const lowered = String(name).toLowerCase();
  const match = Object.keys(headers).find((key) => String(key).toLowerCase() === lowered);
  return match ? headers[match] : null;
}

class ProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderError';

    /** HTTP status, or null for transport-level failures. */
    this.status = Number.isFinite(details.status) ? details.status : null;
    this.statusText = details.statusText || '';
    /** Lowercased provider key, e.g. 'openai'. */
    this.provider = details.provider || '';
    this.model = details.model || '';
    /** Milliseconds the server asked us to wait, or null. */
    this.retryAfterMs = Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : null;
    /** Provider-specific error code from the response body, e.g. 'context_length_exceeded'. */
    this.code = details.code || '';
    /** Provider-specific error type from the response body, e.g. 'invalid_request_error'. */
    this.type = details.type || '';
    this.requestId = details.requestId || '';

    if (details.cause) this.cause = details.cause;
  }

  /** True when the failure never reached the provider (DNS, TLS, socket). */
  get isTransport() {
    return this.status === null;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      provider: this.provider,
      model: this.model,
      retryAfterMs: this.retryAfterMs,
      code: this.code,
      type: this.type,
      requestId: this.requestId
    };
  }
}

/**
 * Build a ProviderError from a fetch Response whose body has already been
 * read for its message.
 *
 * `message` must be the string the provider's own `extractError` produced, so
 * the user-visible text is unchanged from before this module existed.
 * `body` is the parsed JSON body when available — it carries the code/type
 * fields that make classification precise instead of heuristic.
 */
function buildProviderError(response, message, details = {}) {
  const body = details.body && typeof details.body === 'object' ? details.body : null;
  const errorBody = body?.error && typeof body.error === 'object' ? body.error : body;

  const headerRetry = parseRetryAfter(readHeader(response?.headers, 'retry-after'), details.now);
  const retryAfterMs = headerRetry === null
    ? parseRetryHintFromMessage(message, details.now)
    : headerRetry;

  return new ProviderError(message, {
    status: Number.isFinite(response?.status) ? response.status : null,
    statusText: response?.statusText || '',
    provider: details.provider || '',
    model: details.model || '',
    retryAfterMs,
    code: errorBody?.code || details.code || '',
    type: errorBody?.type || details.type || '',
    requestId:
      readHeader(response?.headers, 'x-request-id')
      || readHeader(response?.headers, 'request-id')
      || '',
    cause: details.cause
  });
}

module.exports = {
  ProviderError,
  buildProviderError,
  parseRetryAfter,
  parseRetryHintFromMessage,
  RETRY_AFTER_MAX_MS
};

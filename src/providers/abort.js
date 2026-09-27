// src/providers/abort.js
// Telling a Stop apart from a failure, and what a stopped call is recorded as
// (spec 2026-09-27 §9).

function isAbortError(err) {
  return Boolean(err) && typeof err === 'object' && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

// The usage the provider had reported before the abort (providers attach it
// as partialLlmMetrics), or, for a call cut off before any response, an
// empty partial record. Never priced as $0: its cost is unknown (null).
function partialMetricsOf(err, { provider = null, model = null } = {}) {
  if (err && typeof err === 'object' && err.partialLlmMetrics) return err.partialLlmMetrics;
  return {
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    usagePartial: true
  };
}

module.exports = { isAbortError, partialMetricsOf };

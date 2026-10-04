'use strict';
// A problem with how LongHaul was invoked or with its inputs. The CLI prints
// the message alone and exits 2; anything else is a failure (exit 1).
class UsageError extends Error {
  constructor(message, code = 'USAGE') {
    super(message);
    this.name = 'UsageError';
    this.code = code;
  }
}

// The UsageError codes from the Jev client and adapters (jev.js,
// adapters/kl-recall-jev-rerank.js) that stop a run (run.js RUN_STOP_CODES):
// a cache-only miss, the token cap, a served-model mismatch, no key. Here,
// not in jev.js, so run.js does not load the Jev client.
const JEV_STOP_CODES = Object.freeze(['JEV_SCORES_MISSING', 'JEV_OVER_TOKENS', 'JEV_MODEL_MISMATCH', 'JEV_NO_KEY']);

module.exports = { UsageError, JEV_STOP_CODES };

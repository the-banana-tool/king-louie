// src/history/token-estimator.js
// Characters to tokens per model (recall spec §6.6): default 4 chars per
// token, corrected after every response from the provider's reported input
// tokens by an exponential moving average, stored in `calibration`. Every
// budget in recall is in these estimated tokens.
const { createLogger } = require('../logging');

const log = createLogger('history-tokens');
const MIN_RATIO = 1;
const MAX_RATIO = 12;
const keyOf = (model) => (typeof model === 'string' && model ? model : null);

class TokenEstimator {
  constructor({ store = null, defaultCharsPerToken = 4, alpha = 0.2 } = {}) {
    this.store = store;
    this.defaultCharsPerToken = defaultCharsPerToken;
    this.alpha = alpha;
    this._cache = new Map();
  }

  _row(model) {
    const key = keyOf(model);
    if (!key) return null;
    if (!this._cache.has(key)) {
      let row = null;
      try {
        row = this.store && typeof this.store.calibration === 'function' ? this.store.calibration(key) : null;
      } catch (err) {
        log.warn(`Reading token calibration for ${key} failed: ${err.message}`);
      }
      this._cache.set(key, row);
    }
    return this._cache.get(key);
  }

  charsPerToken(model) {
    const row = this._row(model);
    return row && row.charsPerToken > 0 ? row.charsPerToken : this.defaultCharsPerToken;
  }

  estimate(text, model) {
    return this.fromChars(typeof text === 'string' ? text.length : 0, model);
  }

  fromChars(chars, model) {
    const n = Number(chars);
    return n > 0 ? Math.ceil(n / this.charsPerToken(model)) : 0;
  }

  observe(model, charsSent, inputTokens) {
    const key = keyOf(model);
    const chars = Number(charsSent);
    const tokens = Number(inputTokens);
    if (!key || !(chars > 0) || !(tokens > 0)) return null;
    const observed = Math.min(MAX_RATIO, Math.max(MIN_RATIO, chars / tokens));
    const row = this._row(key);
    const current = row && row.charsPerToken > 0 ? row.charsPerToken : this.defaultCharsPerToken;
    const next = { model: key, charsPerToken: current * (1 - this.alpha) + observed * this.alpha, samples: ((row && row.samples) || 0) + 1 };
    this._cache.set(key, next);
    try {
      if (this.store && typeof this.store.setCalibration === 'function') this.store.setCalibration(key, next.charsPerToken, next.samples);
    } catch (err) {
      log.warn(`Saving token calibration for ${key} failed: ${err.message}`);
    }
    return next;
  }
}

module.exports = { TokenEstimator };

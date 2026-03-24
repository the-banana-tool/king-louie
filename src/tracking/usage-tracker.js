const { getCost } = require('./pricing-tables');

const createTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  turns: 0
});

class UsageTracker {
  constructor(store) {
    this.store = store;
    this.sessionUsage = {
      ...createTotals(),
      providers: {}
    };
  }

  static normalizeDate(date = null) {
    if (!date) {
      return new Date().toISOString().slice(0, 10);
    }

    if (date instanceof Date) {
      return date.toISOString().slice(0, 10);
    }

    const normalized = String(date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return normalized;
    }

    return new Date(normalized).toISOString().slice(0, 10);
  }

  ensureProviderTotals(collection, provider) {
    const providerKey = String(provider || 'unknown').trim().toLowerCase() || 'unknown';
    if (!collection[providerKey]) {
      collection[providerKey] = createTotals();
    }

    return { key: providerKey, totals: collection[providerKey] };
  }

  applyToTotals(totals, event, resolvedCost = null) {
    const inputTokens = Number(event?.inputTokens) || 0;
    const outputTokens = Number(event?.outputTokens) || 0;
    const cacheReadTokens = Number(event?.cacheReadTokens) || 0;
    const totalTokens = Number(event?.totalTokens) || (inputTokens + outputTokens + cacheReadTokens);
    const cost = resolvedCost === null ? 0 : Number(resolvedCost) || 0;

    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheReadTokens += cacheReadTokens;
    totals.totalTokens += totalTokens;
    totals.totalCost = Number((totals.totalCost + cost).toFixed(8));
    totals.turns += 1;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      cost: resolvedCost
    };
  }

  record(event = {}) {
    const provider = String(event.provider || '').trim().toLowerCase();
    const model = String(event.model || '').trim();
    const inputTokens = Number(event.inputTokens) || 0;
    const outputTokens = Number(event.outputTokens) || 0;
    const cacheReadTokens = Number(event.cacheReadTokens) || 0;
    const eventCost = Number.isFinite(Number(event.costUsd)) ? Number(event.costUsd) : null;
    const pricedCost = getCost(provider, model, inputTokens, outputTokens, cacheReadTokens);
    const resolvedCost = pricedCost === null ? eventCost : pricedCost;

    const applied = this.applyToTotals(this.sessionUsage, event, resolvedCost);
    const providerSession = this.ensureProviderTotals(this.sessionUsage.providers, provider || 'unknown');
    this.applyToTotals(providerSession.totals, event, resolvedCost);

    const today = UsageTracker.normalizeDate();
    const dailyKey = `usage.daily.${today}`;
    const existingDaily = this.store.get(dailyKey, {
      ...createTotals(),
      providers: {}
    });

    const daily = {
      ...createTotals(),
      ...existingDaily,
      providers: {
        ...(existingDaily?.providers || {})
      }
    };

    this.applyToTotals(daily, event, resolvedCost);
    const providerDaily = this.ensureProviderTotals(daily.providers, provider || 'unknown');
    this.applyToTotals(providerDaily.totals, event, resolvedCost);
    this.store.set(dailyKey, daily);

    return {
      provider,
      model,
      ...applied,
      durationMs: Number(event.durationMs) || 0
    };
  }

  getSessionUsage() {
    return {
      ...this.sessionUsage,
      providers: {
        ...(this.sessionUsage.providers || {})
      }
    };
  }

  getDailyUsage(date = null) {
    const key = `usage.daily.${UsageTracker.normalizeDate(date)}`;
    const daily = this.store.get(key, null);
    if (!daily) return null;
    return {
      ...daily,
      providers: {
        ...(daily.providers || {})
      }
    };
  }

  reset() {
    this.sessionUsage = {
      ...createTotals(),
      providers: {}
    };
  }
}

module.exports = UsageTracker;
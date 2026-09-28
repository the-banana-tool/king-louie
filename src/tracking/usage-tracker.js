// UsageTracker totals what each call recorded. It never prices a call: the
// cost comes from the provider's catalog-priced metrics (spec 2026-09-27
// §4.4). A call without a known cost counts its tokens and no dollars, and
// counts as unpriced (§10). Totals are kept by provider, by role and by
// model ("provider:model"); role totals also keep the priceable usage, so
// the King Louie profile can reprice recent calls (§7.2).
const USAGE_PARTS = Object.freeze(['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning']);
const OTHER_ROLE = 'other';

const createTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  totalCost: 0,
  turns: 0,
  unpricedCalls: 0
});
const createUsage = () => Object.fromEntries(USAGE_PARTS.map((k) => [k, 0]));
const createRoleTotals = () => ({ ...createTotals(), usage: createUsage() });

const recordedCost = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

class UsageTracker {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
    this.sessionUsage = UsageTracker.emptyUsage();
  }

  static emptyUsage() {
    return { ...createTotals(), providers: {}, roles: {}, models: {} };
  }

  // One call's metrics (llmMetrics, as providers and the router build them)
  // as the event record() takes.
  static eventFromMetrics(metrics = {}, durationMs = 0) {
    const m = metrics && typeof metrics === 'object' ? metrics : {};
    const pricing = m.pricingUsage && typeof m.pricingUsage === 'object' ? m.pricingUsage : null;
    return {
      provider: m.provider,
      model: m.model,
      inputTokens: Number(m.inputTokens) || 0,
      outputTokens: Number(m.outputTokens) || 0,
      totalTokens: Number(m.totalTokens) || 0,
      cacheReadTokens: Number(m.cachedInputTokens) || 0,
      costUsd: recordedCost(m.costUsd),
      ...(typeof m.role === 'string' && m.role ? { role: m.role } : {}),
      ...(pricing ? { pricingUsage: Object.fromEntries(USAGE_PARTS.map((k) => [k, positive(pricing[k])])) } : {}),
      ...(m.usagePartial ? { usagePartial: true } : {}),
      durationMs: Number(durationMs) || 0
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
    if (resolvedCost === null) totals.unpricedCalls = (Number(totals.unpricedCalls) || 0) + 1;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      cost: resolvedCost
    };
  }

  // The provider, role and model breakdowns of one usage record.
  _applyBreakdowns(target, { provider, role, modelKey }, event, cost) {
    this.applyToTotals(this.ensureProviderTotals(target.providers, provider || 'unknown').totals, event, cost);
    const prevRole = target.roles[role];
    const roleTotals = prevRole
      ? { ...createRoleTotals(), ...prevRole, usage: { ...createUsage(), ...(prevRole.usage || {}) } }
      : createRoleTotals();
    this.applyToTotals(roleTotals, event, cost);
    if (event.pricingUsage) {
      for (const k of USAGE_PARTS) roleTotals.usage[k] += positive(event.pricingUsage[k]);
    }
    target.roles[role] = roleTotals;
    const modelTotals = target.models[modelKey] ? { ...createTotals(), ...target.models[modelKey] } : createTotals();
    this.applyToTotals(modelTotals, event, cost);
    target.models[modelKey] = modelTotals;
  }

  record(event = {}) {
    const provider = String(event.provider || '').trim().toLowerCase();
    const model = String(event.model || '').trim();
    const role = typeof event.role === 'string' && event.role.trim() ? event.role.trim() : OTHER_ROLE;
    const modelKey = `${provider || 'unknown'}:${model || 'unknown'}`;
    const resolvedCost = recordedCost(event.costUsd);

    const applied = this.applyToTotals(this.sessionUsage, event, resolvedCost);
    this._applyBreakdowns(this.sessionUsage, { provider, role, modelKey }, event, resolvedCost);

    const dailyKey = `usage.daily.${UsageTracker.normalizeDate(this.now())}`;
    const existingDaily = this.store.get(dailyKey, UsageTracker.emptyUsage());
    const daily = {
      ...UsageTracker.emptyUsage(),
      ...existingDaily,
      providers: { ...(existingDaily?.providers || {}) },
      roles: { ...(existingDaily?.roles || {}) },
      models: { ...(existingDaily?.models || {}) }
    };

    this.applyToTotals(daily, event, resolvedCost);
    this._applyBreakdowns(daily, { provider, role, modelKey }, event, resolvedCost);
    this.store.set(dailyKey, daily);

    return {
      provider,
      model,
      role,
      ...applied,
      ...(event.usagePartial ? { usagePartial: true } : {}),
      durationMs: Number(event.durationMs) || 0
    };
  }

  // The last `days` days of recorded usage by role, today included (the King
  // Louie profile's cost effect, spec §7.2).
  recentRoleUsage({ days = 30 } = {}) {
    const out = {};
    const nowMs = this.now().getTime();
    for (let i = 0; i < days; i += 1) {
      const daily = this.store.get(`usage.daily.${UsageTracker.normalizeDate(new Date(nowMs - i * 86400000))}`, null);
      for (const [role, t] of Object.entries(daily?.roles || {})) {
        const acc = out[role] || (out[role] = { calls: 0, unpricedCalls: 0, cost: 0, usage: createUsage() });
        acc.calls += Number(t.turns) || 0;
        acc.unpricedCalls += Number(t.unpricedCalls) || 0;
        acc.cost = Number((acc.cost + (Number(t.totalCost) || 0)).toFixed(8));
        for (const k of USAGE_PARTS) acc.usage[k] += positive(t.usage?.[k]);
      }
    }
    return out;
  }

  getSessionUsage() {
    return {
      ...this.sessionUsage,
      providers: { ...(this.sessionUsage.providers || {}) },
      roles: { ...(this.sessionUsage.roles || {}) },
      models: { ...(this.sessionUsage.models || {}) }
    };
  }

  getDailyUsage(date = null) {
    const key = `usage.daily.${UsageTracker.normalizeDate(date)}`;
    const daily = this.store.get(key, null);
    if (!daily) return null;
    return {
      ...daily,
      providers: { ...(daily.providers || {}) },
      roles: { ...(daily.roles || {}) },
      models: { ...(daily.models || {}) }
    };
  }

  reset() {
    this.sessionUsage = UsageTracker.emptyUsage();
  }
}

module.exports = UsageTracker;

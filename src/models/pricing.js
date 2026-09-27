// src/models/pricing.js
// The only price function (spec 2026-09-27 §4.4). Rates are USD per million
// tokens. usage: { input, cachedInput, cacheWrite, output, reasoning }, where
// input is the uncached input and reasoning is the part of output spent on
// reasoning (providers report reasoning tokens inside the output count).
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (v) => (isNum(v) && v > 0 ? v : 0);
const round8 = (n) => Number(n.toFixed(8));

function priceWithCost(cost, usage = {}) {
  if (!cost || !isNum(cost.input) || !isNum(cost.output)) return null;
  const u = {
    input: count(usage.input),
    cachedInput: count(usage.cachedInput),
    cacheWrite: count(usage.cacheWrite),
    output: count(usage.output),
    reasoning: count(usage.reasoning)
  };
  // The long-context tier applies when the whole request's input exceeds it.
  const requestInput = u.input + u.cachedInput + u.cacheWrite;
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  const tier = tiers
    .filter((t) => t && isNum(t.aboveContext) && requestInput > t.aboveContext)
    .sort((a, b) => b.aboveContext - a.aboveContext)[0] || null;
  const rate = (field) => {
    if (tier && isNum(tier[field])) return tier[field];
    return isNum(cost[field]) ? cost[field] : null;
  };
  const inputRate = rate('input');
  const outputRate = rate('output');
  // No listed cache rate: the provider bills those tokens as plain input.
  const cacheReadRate = rate('cacheRead') ?? inputRate;
  const cacheWriteRate = rate('cacheWrite') ?? inputRate;
  const reasoningRate = rate('reasoning');
  const reasoningTokens = reasoningRate === null ? 0 : Math.min(u.reasoning, u.output);
  const raw = {
    input: u.input * inputRate,
    cachedInput: u.cachedInput * cacheReadRate,
    cacheWrite: u.cacheWrite * cacheWriteRate,
    output: (u.output - reasoningTokens) * outputRate,
    reasoning: reasoningTokens * (reasoningRate || 0)
  };
  const parts = {};
  let total = 0;
  for (const [key, value] of Object.entries(raw)) {
    parts[key] = round8(value / 1e6);
    total += value / 1e6;
  }
  return { usd: round8(total), parts, tier: tier ? tier.aboveContext : null };
}

module.exports = { priceWithCost };

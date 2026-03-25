const PRICING = {
  openai: {
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1': { input: 2.0, output: 8.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
    'gpt-4o': { input: 2.5, output: 10.0, cacheRead: 1.25 }
  },
  anthropic: {
    'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3 },
    'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5 },
    'claude-haiku-4': { input: 0.8, output: 4.0, cacheRead: 0.08 },
    'claude-3-7-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3 },
    'claude-3-5-sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3 },
    'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheRead: 0.08 },
    'claude-3-opus': { input: 15.0, output: 75.0, cacheRead: 1.5 }
  },
  groq: {
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
    'llama-3.1-8b-instant': { input: 0.05, output: 0.08 }
  },
  mistral: {
    'mistral-large-latest': { input: 2.0, output: 6.0 },
    'mistral-small-latest': { input: 0.2, output: 0.6 },
    'codestral-latest': { input: 0.3, output: 0.9 }
  },
  gemini: {
    'gemini-2.0-flash': { input: 0.1, output: 0.4 },
    'gemini-2.0-pro': { input: 1.25, output: 5.0 }
  }
};

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function resolveModelPricing(provider, model) {
  const providerKey = normalizeKey(provider);
  const modelKey = normalizeKey(model);
  const providerPricing = PRICING[providerKey];
  if (!providerPricing || !modelKey) return null;

  if (providerPricing[modelKey]) {
    return providerPricing[modelKey];
  }

  const prefixMatch = Object.entries(providerPricing).find(([knownModel]) =>
    modelKey.startsWith(normalizeKey(knownModel))
  );

  return prefixMatch ? prefixMatch[1] : null;
}

function getCost(provider, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0) {
  const pricing = resolveModelPricing(provider, model);
  if (!pricing) return null;

  const normalizedInput = Number(inputTokens) || 0;
  const normalizedOutput = Number(outputTokens) || 0;
  const normalizedCacheRead = Number(cacheReadTokens) || 0;

  const inputCost = (normalizedInput / 1_000_000) * Number(pricing.input || 0);
  const outputCost = (normalizedOutput / 1_000_000) * Number(pricing.output || 0);
  const cacheCost = pricing.cacheRead
    ? (normalizedCacheRead / 1_000_000) * Number(pricing.cacheRead || 0)
    : 0;

  return Number((inputCost + outputCost + cacheCost).toFixed(8));
}

module.exports = {
  PRICING,
  getCost,
  resolveModelPricing
};
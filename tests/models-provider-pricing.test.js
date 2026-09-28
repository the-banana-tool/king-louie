// tests/models-provider-pricing.test.js
// Provider classes get their prices from the catalog (spec 2026-09-27 §4.4):
// one price function, no per-provider tables, unknown models unpriced.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ProviderFactory = require('../src/providers/provider-factory');
const OpenAIProvider = require('../src/providers/openai-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const DeepSeekProvider = require('../src/providers/deepseek-provider');
const UsageTracker = require('../src/tracking/usage-tracker');
const { getActiveCatalog } = require('../src/models');
const { fixtureCatalog } = require('./helpers/models-fixture');

const catalog = fixtureCatalog();
const round4 = (n) => Math.round(n * 1e4) / 1e4;

function memoryStore() {
  const data = {};
  return {
    get: (key, fallback = null) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback),
    set: (key, value) => { data[key] = value; }
  };
}

describe('providers price calls through the catalog', () => {
  it('prices an OpenAI chat call with cached input at the catalog rates', () => {
    const p = new OpenAIProvider('sk-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'gpt-5.5', usage: { prompt_tokens: 43193, completion_tokens: 185, total_tokens: 43378, prompt_tokens_details: { cached_tokens: 39552 } } });
    assert.strictEqual(round4(m.costUsd), 0.0435);
    assert.strictEqual(m.cachedInputTokens, 39552);
    // The priceable parts travel with the call, for repricing (spec §7.2).
    assert.deepStrictEqual(m.pricingUsage, { input: 3641, cachedInput: 39552, cacheWrite: 0, output: 185, reasoning: 0 });
    assert.strictEqual(m.unpriced, undefined);
    assert.strictEqual(m.usagePartial, undefined);
  });

  it('prices the Responses API usage shape the same way', () => {
    const p = new OpenAIProvider('sk-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'gpt-5.5', usage: { input_tokens: 43193, output_tokens: 185, input_tokens_details: { cached_tokens: 39552 }, output_tokens_details: { reasoning_tokens: 100 } } });
    assert.strictEqual(round4(m.costUsd), 0.0435);
    assert.strictEqual(m.reasoningTokens, 100);
  });

  it('prices a dated response model as its base model, and never by prefix', () => {
    const p = new OpenAIProvider('sk-test-123456', { catalog });
    assert.strictEqual(p.buildLlmCallMetrics({ model: 'gpt-5.4-mini-2026-03-17', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }).costUsd, 0.75);
    const unknown = p.buildLlmCallMetrics({ model: 'gpt-5.5-turbo', usage: { prompt_tokens: 1000, completion_tokens: 10 } });
    assert.strictEqual(unknown.costUsd, null);
    assert.strictEqual(unknown.unpriced, true);
  });

  it('prices Anthropic cache reads and writes as separate counts', () => {
    const p = new AnthropicProvider('sk-ant-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'claude-haiku-4-5', usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 100 } });
    assert.strictEqual(m.costUsd, 0.0043);
    assert.strictEqual(m.cacheReadInputTokens, 3000);
  });

  it('prices DeepSeek cache hits at the cache rate', () => {
    const p = new DeepSeekProvider('sk-test-123456', { catalog });
    const m = p.buildLlmCallMetrics({ model: 'deepseek-chat', usage: { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0 } });
    assert.strictEqual(m.costUsd, 0.028);
  });

  it('marks a partial call, and never prices one with nothing reported as $0', () => {
    const none = new OpenAIProvider('sk-test-123456', { catalog }).buildLlmCallMetrics({ model: 'gpt-5.5', usage: {}, partial: true });
    assert.strictEqual(none.costUsd, null);
    assert.strictEqual(none.usagePartial, true);
    const some = new AnthropicProvider('sk-ant-test-123456', { catalog }).buildLlmCallMetrics({ model: 'claude-haiku-4-5', usage: { input_tokens: 1200, output_tokens: 1 }, partial: true });
    assert.strictEqual(some.costUsd, 0.001205);
    assert.strictEqual(some.usagePartial, true);
  });

  it('uses the active catalog when none is injected', () => {
    assert.strictEqual(new OpenAIProvider('sk-test-123456').getCatalog(), getActiveCatalog());
  });

  it('no provider keeps a price table of its own', () => {
    for (const key of ProviderFactory.listRegistered()) {
      const p = ProviderFactory.create(key, 'test-key-123456');
      for (const method of ['getModelPricingTable', 'calculateCostUsd', 'resolveModelPricing']) {
        assert.strictEqual(typeof p[method], 'undefined', `${key}.${method}`);
      }
    }
    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'src', 'tracking', 'pricing-tables.js')), false);
  });
});

describe('provider construction options', () => {
  it('every provider takes a baseUrl option, without a trailing slash', () => {
    for (const key of ProviderFactory.listRegistered()) {
      const p = ProviderFactory.create(key, 'test-key-123456', { baseUrl: 'http://127.0.0.1:9/x/' });
      assert.strictEqual(p.baseUrl, 'http://127.0.0.1:9/x', key);
    }
  });

  it('every provider passes its options to the base class', () => {
    for (const key of ProviderFactory.listRegistered()) {
      assert.strictEqual(ProviderFactory.create(key, 'test-key-123456', { catalog }).getCatalog(), catalog, key);
    }
  });

  it('keeps each provider\'s real API base by default', () => {
    const base = (key) => ProviderFactory.create(key, 'test-key-123456').baseUrl;
    assert.strictEqual(base('openai'), 'https://api.openai.com/v1');
    assert.strictEqual(base('anthropic'), 'https://api.anthropic.com/v1');
    assert.strictEqual(base('cohere'), 'https://api.cohere.com/v2');
    assert.strictEqual(base('ollama'), 'http://127.0.0.1:11434/v1');
  });

  it('Ollama builds its API base from the server address', () => {
    assert.strictEqual(ProviderFactory.create('ollama', '', { serverUrl: 'http://192.0.2.5:11434/' }).baseUrl, 'http://192.0.2.5:11434/v1');
  });

  it('Copilot takes a token exchange URL', () => {
    const p = ProviderFactory.create('copilot', 'ghp_test123456', { tokenExchangeUrl: 'http://127.0.0.1:9/token' });
    assert.strictEqual(p.tokenExchangeUrl, 'http://127.0.0.1:9/token');
  });
});

describe('UsageTracker trusts the recorded cost', () => {
  it('records the call\'s own costUsd', () => {
    const tracker = new UsageTracker(memoryStore());
    const r = tracker.record({ provider: 'openai', model: 'gpt-5.5', inputTokens: 1000, outputTokens: 10, costUsd: 0.0053 });
    assert.strictEqual(r.cost, 0.0053);
    assert.strictEqual(tracker.getSessionUsage().totalCost, 0.0053);
  });

  it('records no cost for an unpriced call instead of guessing one', () => {
    const tracker = new UsageTracker(memoryStore());
    assert.strictEqual(tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 }).cost, null);
    assert.strictEqual(tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500, costUsd: null }).cost, null);
    assert.strictEqual(tracker.getSessionUsage().totalCost, 0);
  });
});

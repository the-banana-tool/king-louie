// tests/models-pricing.test.js
// The single price function (spec 2026-09-27 §4.4) and the §1.1 evidence:
// five gpt-5.5 calls at models.dev list price total $0.5437.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { priceWithCost } = require('../src/models/pricing');
const { fixtureCatalog } = require('./helpers/models-fixture');

const round4 = (n) => Math.round(n * 1e4) / 1e4;

// Spec §1.1: [input tokens, of which cached, output tokens, cost at list].
const SECTION_1_1_CALLS = [
  [39888, 0, 559, 0.2162],
  [43193, 39552, 185, 0.0435],
  [45211, 42624, 274, 0.0425],
  [45676, 44672, 264, 0.0353],
  [60765, 44672, 3446, 0.2062]
];

describe('Catalog.price', () => {
  it('prices the five §1.1 calls to $0.5437', () => {
    const catalog = fixtureCatalog();
    let total = 0;
    for (const [input, cached, output, expected] of SECTION_1_1_CALLS) {
      const r = catalog.price('openai', 'gpt-5.5', { input: input - cached, cachedInput: cached, output });
      assert.strictEqual(round4(r.usd), expected, `call with ${input} input tokens`);
      total += r.usd;
    }
    assert.strictEqual(round4(total), 0.5437);
  });

  it('returns the parts it priced separately', () => {
    const r = fixtureCatalog().price('anthropic', 'claude-haiku-4-5', { input: 1000, cachedInput: 3000, cacheWrite: 2000, output: 100 });
    assert.strictEqual(r.usd, 0.0043);
    assert.deepStrictEqual(r.parts, { input: 0.001, cachedInput: 0.0003, cacheWrite: 0.0025, output: 0.0005, reasoning: 0 });
    assert.strictEqual(r.tier, null);
  });

  it('applies the long-context tier only when the request\'s input exceeds it', () => {
    const c = fixtureCatalog();
    const over = c.price('openai', 'gpt-5.5', { input: 300000, output: 1000 });
    assert.strictEqual(over.usd, 3.045);
    assert.strictEqual(over.tier, 272000);
    assert.strictEqual(c.price('openai', 'gpt-5.5', { input: 272000 }).usd, 1.36, 'at the threshold, base rates');
    const cachedOver = c.price('openai', 'gpt-5.5', { input: 100000, cachedInput: 200000 });
    assert.strictEqual(cachedOver.tier, 272000, 'cached input counts toward the request size');
    assert.strictEqual(cachedOver.usd, 1.2);
  });

  it('prices reasoning at its own rate when the catalog has one, else as output', () => {
    const c = fixtureCatalog();
    assert.strictEqual(c.price('openai', 'o4-mini', { input: 1000, output: 500, reasoning: 200 }).usd, 0.00402);
    const plain = c.price('openai', 'gpt-5.5', { output: 500, reasoning: 200 });
    assert.strictEqual(plain.usd, 0.015);
    assert.strictEqual(plain.parts.reasoning, 0);
  });

  it('prices cached input at the input rate when no cache rate is listed', () => {
    assert.strictEqual(fixtureCatalog().price('groq', 'llama-3.3-70b', { cachedInput: 1000 }).usd, 0.00059);
  });

  it('returns null for an unpriced cost, never $0', () => {
    assert.strictEqual(priceWithCost(null, { input: 10 }), null);
    assert.strictEqual(priceWithCost({ input: 1, output: null }, { input: 10 }), null);
    assert.strictEqual(priceWithCost({ output: 1 }, { input: 10 }), null);
  });

  it('ignores negative and non-numeric counts', () => {
    assert.strictEqual(priceWithCost({ input: 1, output: 1 }, { input: -5, output: 'x' }).usd, 0);
  });
});

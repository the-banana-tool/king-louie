// tests/longhaul-cost.test.js
// Pricing a run before its first call (benchmark spec §8.1, B-D7), with the
// fixture catalog: openai/gpt-6-lite $0.3/$1 and
// anthropic/claude-haiku-4-5 $1/$5 per million tokens.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  EST_CHARS_PER_TOKEN, DEFAULT_MAX_USD, estInputTokens, priceCall, estimateCalls, checkBudget, SpendGuard, OverBudgetError, formatEstimate
} = require('../src/longhaul/cost');
const { UsageError } = require('../src/longhaul/errors');
const { fixtureCatalog } = require('./helpers/models-fixture');
const path = require('path');
const { ModelCache, cacheKey, cachedCall } = require('../src/longhaul/model-cache');
const { tmpDir } = require('./helpers/longhaul-helpers');

const catalog = fixtureCatalog();
const answerModel = { provider: 'openai', model: 'gpt-6-lite' };
const judgeModel = { provider: 'anthropic', model: 'claude-haiku-4-5' };

describe('estimateCalls', () => {
  it('prices each call on a close bound: input at 3 characters a token, output at maxTokens', () => {
    assert.strictEqual(EST_CHARS_PER_TOKEN, 3);
    assert.strictEqual(DEFAULT_MAX_USD, 50);
    const answer = { role: 'answer', adapter: 'kl-recall', ...answerModel, inputChars: 30000, maxTokens: 400 };
    const est = estimateCalls([answer, answer], catalog);
    // Per call: 10,000 input x $0.3/M = $0.003 and 400 output x $1/M = $0.0004.
    assert.deepStrictEqual(est.lines, [{ role: 'answer', adapter: 'kl-recall', provider: 'openai', model: 'gpt-6-lite', calls: 2, inputTokens: 20000, outputTokens: 800, usd: 0.0068 }]);
    assert.strictEqual(est.totalUsd, 0.0068);
    assert.strictEqual(est.calls, 2);
  });

  it('counts a judge reply not written yet at the answer model\'s max tokens', () => {
    const est = estimateCalls([{ role: 'judge', adapter: 'oracle', ...judgeModel, inputChars: 3000, extraInputTokens: 400, maxTokens: 200 }], catalog);
    // Input 1,000 + 400 = 1,400 x $1/M = $0.0014; output 200 x $5/M = $0.001.
    assert.strictEqual(est.lines[0].inputTokens, 1400);
    assert.strictEqual(est.totalUsd, 0.0024);
    assert.strictEqual(estInputTokens(3000, 400), 1400);
  });

  it('leaves an unpriced model unknown, never $0, prices the local fakes at $0, and orders summary, answer, judge', () => {
    const est = estimateCalls([
      { role: 'judge', adapter: 'a', ...judgeModel, inputChars: 3, maxTokens: 1 },
      { role: 'answer', adapter: 'a', provider: 'openai', model: 'no-such-model', inputChars: 3, maxTokens: 1 },
      { role: 'summary', adapter: 'summarize-compact', provider: 'fake', model: 'fake-summarizer', local: true, inputChars: 3, maxTokens: 1 }
    ], catalog);
    assert.deepStrictEqual(est.lines.map((l) => [l.role, l.usd]), [['summary', 0], ['answer', null], ['judge', 0.000006]]);
    assert.strictEqual(est.totalUsd, null);
    assert.strictEqual(est.knownUsd, 0.000006);
    assert.deepStrictEqual(est.unpriced, ['openai/no-such-model']);
    assert.strictEqual(priceCall(catalog, { provider: 'x', model: 'y', local: true }, { input: 1e9, output: 1e9 }), 0);
  });
});

describe('checkBudget', () => {
  it('refuses an estimate over the cap, and an unpriced plan unless allowed', () => {
    const over = { knownUsd: 51, totalUsd: 51, unpriced: [] };
    assert.throws(() => checkBudget(over, {}), (e) => e instanceof UsageError && e.code === 'OVER_BUDGET' && /\$50 cap/.test(e.message) && /nothing was sent/.test(e.message));
    assert.doesNotThrow(() => checkBudget(over, { maxUsd: 60 }));
    const unknown = { knownUsd: 1, totalUsd: null, unpriced: ['openai/x'] };
    assert.throws(() => checkBudget(unknown, {}), (e) => e.code === 'UNPRICED' && /--allow-unpriced/.test(e.message));
    assert.doesNotThrow(() => checkBudget(unknown, { allowUnpriced: true }));
  });
});

describe('SpendGuard', () => {
  it('stops at the cap: reserved estimates count, and once tripped every call is refused', () => {
    const guard = new SpendGuard({ maxUsd: 0.01, catalog });
    const h = guard.hooks();
    const client = { ...answerModel };
    const t1 = h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }); // reserves $0.0034
    const t2 = h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }); // $0.0068 reserved
    assert.throws(() => h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }), (e) => e.code === 'OVER_BUDGET'); // would be $0.0102
    h.afterCall(t1, { inputTokens: 900, outputTokens: 100, costUsd: 0.001 });
    h.cancel(t2);
    assert.throws(() => h.beforeCall({ client, promptChars: 3, maxTokens: 1 }), OverBudgetError, 'a tripped guard stays tripped');
    assert.deepStrictEqual(guard.totals(), { spentUsd: 0.001, calls: 1, unpricedCalls: 0, estimatedCalls: 0, overBudget: true });
  });

  it('counts calls with no known cost apart, never as $0 spent', () => {
    const guard = new SpendGuard({ maxUsd: 1, catalog });
    const h = guard.hooks();
    h.afterCall(h.beforeCall({ client: { provider: 'openai', model: 'no-such-model' }, promptChars: 3, maxTokens: 1 }), { costUsd: null });
    assert.deepStrictEqual(guard.totals(), { spentUsd: 0, calls: 1, unpricedCalls: 1, estimatedCalls: 0, overBudget: false });
  });

  it('settles a priced reply that reports no usage at its reservation, never at $0 (review Important 1)', () => {
    const guard = new SpendGuard({ maxUsd: 1, catalog });
    const h = guard.hooks();
    const client = { ...answerModel };
    // 30,000 chars / 3 = 10,000 input x $0.3/M + 400 output x $1/M = $0.0034 reserved.
    h.afterCall(h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }), { inputTokens: null, outputTokens: null, costUsd: null });
    h.afterCall(h.beforeCall({ client, promptChars: 30000, maxTokens: 400 }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    assert.deepStrictEqual(guard.totals(), { spentUsd: 0.0068, calls: 2, unpricedCalls: 0, estimatedCalls: 2, overBudget: false });
    // A local fake reporting nothing still costs nothing.
    h.afterCall(h.beforeCall({ client: { provider: 'fake', model: 'f', local: true }, promptChars: 3, maxTokens: 1 }), { costUsd: null });
    assert.deepStrictEqual(guard.totals(), { spentUsd: 0.0068, calls: 3, unpricedCalls: 0, estimatedCalls: 2, overBudget: false });
  });

  it('trips the cap on replies with no usage, through cachedCall', async () => {
    const guard = new SpendGuard({ maxUsd: 0.007, catalog });
    const cache = new ModelCache(path.join(tmpDir(), 'model-cache'));
    let calls = 0;
    const client = { ...answerModel, async complete() { calls += 1; return { text: 'ok' }; } };
    const prompt = 'x'.repeat(30000);
    const one = (i) => cachedCall({ cache, stage: 'answer', key: cacheKey({ i }), client, prompt, maxTokens: 400, hooks: guard.hooks(), retry: { wait: async () => {} } });
    await one(1);
    await one(2);
    assert.strictEqual(guard.totals().spentUsd, 0.0068);
    await assert.rejects(one(3), (e) => e.code === 'OVER_BUDGET');
    assert.strictEqual(calls, 2);
    assert.strictEqual(guard.totals().estimatedCalls, 2);
  });
});

describe('formatEstimate', () => {
  it('prints the plan in ASCII and names what it cannot price', () => {
    const est = estimateCalls([
      { role: 'answer', adapter: 'kl-recall', ...answerModel, inputChars: 30000, maxTokens: 400 },
      { role: 'judge', adapter: 'kl-recall', provider: 'openai', model: 'no-such-model', inputChars: 30, maxTokens: 20 }
    ], catalog);
    const text = formatEstimate(est, { maxUsd: 50, counts: { answers: 1, answersCached: 2, judgments: 1, judgmentsCached: 0, summaries: 0, summariesCached: 0 } });
    assert.ok(/^[\x00-\x7f]*$/.test(text), 'ASCII only');
    assert.match(text, /plan: 1 answers \(2 cached\), 1 judgments \(0 cached\), 0 summaries \(0 cached\)/);
    assert.match(text, /price unknown/);
    assert.match(text, /\$0\.0034 priced \+ unknown for openai\/no-such-model/);
    assert.match(text, /cap \$50 \(--max-usd\)/);
  });
});

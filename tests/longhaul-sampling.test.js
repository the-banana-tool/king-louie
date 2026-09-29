// tests/longhaul-sampling.test.js
// Stratified authoring samples (benchmark spec §6): by kind and by distance
// bucket, seeded, so the set is not dominated by recent prose.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { planAuthoring, ANCHOR_SENDERS } = require('../src/longhaul/sampling');
const { SYNTH_FIXTURES, generateSynthetic } = require('../src/longhaul/synthetic');
const { bucketFor, KINDS } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');

// synth-medium: about 1,100 messages and 110K estimated tokens.
const { index } = generateSynthetic(SYNTH_FIXTURES[1]);

describe('planAuthoring', () => {
  it('is deterministic for a seed and changes with it', () => {
    assert.deepStrictEqual(planAuthoring(index, { count: 60, seed: 1 }), planAuthoring(index, { count: 60, seed: 1 }));
    assert.notDeepStrictEqual(planAuthoring(index, { count: 60, seed: 1 }).items, planAuthoring(index, { count: 60, seed: 2 }).items);
  });

  it('splits the count evenly by kind, and lists what the session cannot hold as shortfall', () => {
    const { items, shortfall } = planAuthoring(index, { count: 60, seed: 1 });
    assert.strictEqual(items.length + shortfall.length, 60);
    for (const k of KINDS) {
      const n = items.filter((i) => i.kind === k).length + shortfall.filter((s) => s.kind === k).length;
      assert.strictEqual(n, 10, k);
    }
    assert.ok(items.every((i) => i.bucket !== '200K-1M' && i.bucket !== '>1M'), 'nothing is 200K tokens back in a 110K session');
    assert.ok(shortfall.some((s) => s.bucket === '>1M'));
    assert.ok(items.some((i) => i.bucket === '50K-200K'));
  });

  it('places every item at a user message, after its anchor, in its bucket, with a span before askAtSeq', () => {
    const { items } = planAuthoring(index, { count: 60, seed: 3 });
    for (const item of items) {
      assert.strictEqual(index.get(item.askAtSeq).sender, 'user');
      assert.ok(item.spanFrom >= 1 && item.spanFrom <= item.spanTo && item.spanTo < item.askAtSeq, JSON.stringify(item));
      if (item.kind === 'abstain') {
        assert.strictEqual(item.anchorSeq, null);
        assert.strictEqual(item.bucket, 'none');
        continue;
      }
      assert.ok(item.anchorSeq < item.askAtSeq);
      assert.ok(item.anchorSeq >= item.spanFrom && item.anchorSeq <= item.spanTo);
      assert.ok(ANCHOR_SENDERS[item.kind].includes(index.get(item.anchorSeq).sender));
      assert.strictEqual(bucketFor({ estTokens: index.tokensBetween(item.anchorSeq, item.askAtSeq) }), item.bucket);
    }
  });

  it('never repeats an anchor and question pair, and skips excluded anchors', () => {
    const first = planAuthoring(index, { count: 60, seed: 4 });
    const pairs = first.items.filter((i) => i.anchorSeq !== null).map((i) => `${i.anchorSeq}:${i.askAtSeq}`);
    assert.strictEqual(new Set(pairs).size, pairs.length);
    const excluded = first.items.map((i) => i.anchorSeq).filter((s) => s !== null);
    const second = planAuthoring(index, { count: 60, seed: 4, excludeSeqs: excluded });
    assert.ok(second.items.every((i) => !excluded.includes(i.anchorSeq)));
  });

  it('refuses a count that is not a positive whole number', () => {
    assert.throws(() => planAuthoring(index, { count: 0, seed: 1 }), UsageError);
  });
});

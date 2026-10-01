// tests/longhaul-answer-scoring.test.js
// Answer accuracy, abstain accuracy and false answers per adapter, by kind,
// distance and session (benchmark spec §8), from records whose numbers are
// exactly computable; the named whole-messages comparison.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { summarize, compareAdapters, COMPARISONS, renderSummaryMarkdown, adapterCost } = require('../src/longhaul/scoring');
const { scoreVerdict } = require('../src/longhaul/judge');

function rec(adapter, questionId, kind, verdict, extra = {}) {
  const abstain = kind === 'abstain';
  return {
    adapter, sessionId: 'S', questionId, kind, bucket: abstain ? 'none' : '<10K',
    evidenceSeqs: abstain ? [] : [1], evidenceRecall: abstain ? null : 1, evidencePartial: 0,
    answerContained: abstain ? null : true, answerTokensContained: abstain ? null : true, chunkEvidenceRecall: null,
    estTokens: 100, latencyMs: 1, cpuMs: 1, leaked: 0, error: null,
    verdict, ...(verdict ? scoreVerdict({ kind }, verdict) : { answerCorrect: null, abstainCorrect: null }),
    answerError: null, answerCached: false, answerInputTokens: 1000, answerOutputTokens: 10, answerCostUsd: 0.001, answerLatencyMs: 50,
    judgeCached: false, judgeInputTokens: 300, judgeOutputTokens: 20, judgeCostUsd: 0.0005,
    ...extra
  };
}

const records = [
  rec('a', 'q1', 'user-said', 'correct'),
  // A paraphrase: the answer text is not in the context, and the judge still finds the reply correct.
  rec('a', 'q2', 'decision', 'correct', { answerContained: false, answerTokensContained: false }),
  rec('a', 'q3', 'superseded', 'partial'),
  rec('a', 'q4', 'tool-observed', 'abstained'),
  rec('a', 'q5', 'abstain', 'abstained'),
  rec('a', 'q6', 'abstain', 'incorrect'),
  rec('a', 'q7', 'user-said', null, { answerError: 'judge-unparsed' }),
  rec('a', 'q8', 'multi-hop', null, { error: 'boom' })
];

describe('summarize with answers', () => {
  const s = summarize(records).a;

  it('scores answerable questions on correct and abstain questions on declining; errors stay out of the rates', () => {
    assert.strictEqual(s.answer.n, 4);
    assert.strictEqual(s.answer.accuracy, 0.5);
    assert.strictEqual(s.answer.partialRate, 0.25);
    assert.strictEqual(s.answer.incorrectRate, 0);
    assert.strictEqual(s.answer.declinedRate, 0.25);
    assert.deepStrictEqual(s.answer.abstain, { n: 2, accuracy: 0.5, falseAnswerRate: 0.5 });
    assert.strictEqual(s.answer.errors, 1);
    assert.deepStrictEqual(s.answer.errorsByCode, { 'judge-unparsed': 1 });
    assert.strictEqual(s.errors, 1, 'the context error is B0\'s error count');
  });

  it('counts a paraphrase as correct although containment misses it', () => {
    const p = summarize([rec('p', 'q2', 'decision', 'correct', { answerContained: false, answerTokensContained: false })]).p;
    assert.strictEqual(p.answerContainment, 0);
    assert.strictEqual(p.answer.accuracy, 1);
    assert.strictEqual(s.answerContainment, 0.8);
  });

  it('groups by kind, bucket and session, with abstain apart', () => {
    const g = (n, accuracy, abstainN = 0, abstainAccuracy = null) => ({ n, accuracy, abstainN, abstainAccuracy });
    assert.deepStrictEqual(s.answer.byKind, {
      'user-said': g(1, 1), decision: g(1, 1), superseded: g(1, 0), 'tool-observed': g(1, 0), abstain: g(0, null, 2, 0.5)
    });
    assert.deepStrictEqual(s.answer.byBucket, { '<10K': g(4, 0.5), none: g(0, null, 2, 0.5) });
    assert.deepStrictEqual(s.answer.bySession, { S: g(4, 0.5, 2, 0.5) });
    assert.strictEqual(s.bySession.S.evidenceRecall, 1);
  });

  it('costs what the replies cost to make, what this run paid, and what it could not price', () => {
    assert.deepStrictEqual(s.answer.cost, { answer: { usd: 0.007, spentUsd: 0.007, unknown: 0 }, judge: { usd: 0.0035, spentUsd: 0.0035, unknown: 0 } });
    const c = summarize([rec('c', 'q1', 'user-said', 'correct', { answerCached: true }), rec('c', 'q2', 'user-said', 'correct', { answerCostUsd: null })]).c;
    assert.deepStrictEqual(c.answer.cost.answer, { usd: 0.001, spentUsd: 0, unknown: 1 });
    assert.deepStrictEqual(adapterCost(c), { usd: 0.002, unknown: 1 });
    const withSetup = summarize([rec('sc', 'q1', 'user-said', 'correct')], { setupCosts: [{ adapter: 'sc', sessionId: 'S', calls: 3, cachedCalls: 1, costUsd: 0.02, unpricedCalls: 0 }] }).sc;
    assert.deepStrictEqual(withSetup.setup, { costUsd: 0.02, calls: 3, cachedCalls: 1, unpricedCalls: 0 });
    assert.deepStrictEqual(adapterCost(withSetup), { usd: 0.0215, unknown: 0 });
  });

  it('leaves answer null for a run without the answer stage', () => {
    const { verdict, ...b0 } = rec('b0', 'q1', 'user-said', 'correct');
    assert.strictEqual(summarize([b0]).b0.answer, null);
  });
});

describe('compareAdapters', () => {
  it('pairs the two adapters question by question', () => {
    const rs = [
      rec('kl-recall', 'q1', 'user-said', 'correct'), rec('kl-recall', 'q2', 'user-said', 'correct'),
      rec('kl-recall', 'q3', 'user-said', 'incorrect'), rec('kl-recall', 'q4', 'abstain', 'incorrect'),
      rec('kl-recall-whole', 'q1', 'user-said', 'correct'), rec('kl-recall-whole', 'q2', 'user-said', 'partial', { evidenceRecall: 0.5 }),
      rec('kl-recall-whole', 'q3', 'user-said', 'correct', { estTokens: 300 }), rec('kl-recall-whole', 'q4', 'abstain', 'abstained')
    ];
    const c = compareAdapters(rs, 'kl-recall', 'kl-recall-whole');
    assert.strictEqual(c.n, 4);
    assert.strictEqual(c.judged, 4);
    assert.deepStrictEqual(c.accuracy, { a: 0.5, b: 0.75, delta: 0.25 });
    assert.strictEqual(c.onlyA, 1);
    assert.strictEqual(c.onlyB, 2);
    assert.deepStrictEqual(c.evidenceRecall, { a: 1, b: 0.8333333333333334, delta: -0.16666667 });
    assert.deepStrictEqual(c.medianTokens, { a: 100, b: 100 });
    assert.strictEqual(compareAdapters(rs, 'kl-recall', 'nope'), null);
    assert.deepStrictEqual(COMPARISONS.map((x) => [x.id, x.a, x.b]), [['whole-messages', 'kl-recall', 'kl-recall-whole']]);
  });
});

describe('renderSummaryMarkdown with answers', () => {
  const config = {
    runId: 'R', budgetTokens: 6000, seed: 1, commit: 'c', includeUnverified: false,
    sessions: [{ sessionId: 'S', private: false, license: 'CC-BY-4.0', questions: 8 }],
    answer: {
      tier: 'grid', sample: { requested: null, questions: 8 },
      answerModel: { provider: 'openai', model: 'gpt-6-lite' }, judgeModel: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      prompts: { answer: { sha256: 'a'.repeat(64) }, judge: { sha256: 'b'.repeat(64) } }
    }
  };

  it('adds the answer tables, the named comparison and the spend', () => {
    const rs = [...records, ...records.map((r) => ({ ...r, adapter: 'kl-recall' })), ...records.map((r) => ({ ...r, adapter: 'kl-recall-whole' }))];
    const summary = summarize(rs);
    const comparisons = COMPARISONS.map((c) => ({ ...c, result: compareAdapters(rs, c.a, c.b) }));
    const md = renderSummaryMarkdown(config, summary, { spend: { spentUsd: 0.0315, calls: 42, unpricedCalls: 0, overBudget: false, estimateUsd: 0.05 }, comparisons });
    assert.match(md, /Metric: answer accuracy, judged by anthropic\/claude-haiku-4-5/);
    assert.match(md, /## Answer accuracy\n/);
    assert.match(md, /\| a \| 6 \| 0\.500 \| 0\.250 \| 0\.250 \| 0\.500 \| 0\.500 \| 1 \| 1000 \| 1000 \| 0\.0105 \|/);
    assert.match(md, /## Answer accuracy by kind/);
    assert.match(md, /## Named comparisons/);
    assert.match(md, /whole-messages: kl-recall 0\.500 vs kl-recall-whole 0\.500 answer accuracy over 6 paired questions/);
    assert.match(md, /Spent \$0\.0315 on 42 calls/);
  });

  it('keeps the B0 summary as it was when the run had no answer stage', () => {
    const { answer, ...b0config } = config;
    const md = renderSummaryMarkdown(b0config, summarize([rec('a', 'q1', 'user-said', undefined)]));
    assert.match(md, /No answer or judge model \(stage B0\)/);
    assert.ok(!md.includes('## Answer accuracy'));
  });
});

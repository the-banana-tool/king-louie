// tests/longhaul-judge.test.js
// The answer prompt and the judge (benchmark spec §8 steps 3 and 4). The
// judge grades meaning, not wording, never sees the context, and scores an
// abstain question on declining.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loadPrompt } = require('../src/longhaul/prompts');
const { buildAnswerPrompt, DONT_KNOW } = require('../src/longhaul/answer');
const { VERDICTS, JUDGE_KIND_RULES, JUDGE_RULES_SHA256, buildJudgePrompt, parseVerdict, scoreVerdict, isRight } = require('../src/longhaul/judge');
const { KINDS } = require('../src/longhaul/questions');

const answerPrompt = loadPrompt('answer').text;
const judgePrompt = loadPrompt('judge').text;
const q = (extra = {}) => ({
  id: 'synth-x-001', kind: 'decision',
  question: 'What did we decide to use for amber-heron, and why?',
  answer: 'SQLite, because it needs no server',
  acceptableAnswers: ['SQLite, because it needs no server', 'SQLite'],
  ...extra
});

describe('answer prompt', () => {
  it('holds the context and the question, and tells the model how to decline', () => {
    const p = buildAnswerPrompt(answerPrompt, { context: '[#12 user]\nUse SQLite for amber-heron.', question: q() });
    assert.ok(p.includes('<context>\n[#12 user]\nUse SQLite for amber-heron.\n</context>'));
    assert.ok(p.includes('Question: What did we decide to use for amber-heron, and why?'));
    assert.ok(p.includes(DONT_KNOW));
  });

  it('says so when the adapter showed nothing', () => {
    assert.ok(buildAnswerPrompt(answerPrompt, { context: '  ', question: q() }).includes('(the memory system showed nothing)'));
  });
});

describe('judge prompt', () => {
  it('has a rule for every kind, and hashes every string it splices into a prompt', () => {
    assert.deepStrictEqual(Object.keys(JUDGE_KIND_RULES).sort(), [...KINDS].sort());
    assert.match(JUDGE_RULES_SHA256, /^[0-9a-f]{64}$/);
  });

  it('shows the question, the reference, the other acceptable answers and the reply, never a context', () => {
    const p = buildJudgePrompt(judgePrompt, { question: q(), reply: 'We went with SQLite since no server is needed.' });
    assert.ok(p.includes('Reference answer: SQLite, because it needs no server'));
    assert.ok(p.includes('Also acceptable: "SQLite"'));
    assert.ok(p.includes('<reply>\nWe went with SQLite since no server is needed.\n</reply>'));
    assert.ok(p.includes(`Rule for this kind: ${JUDGE_KIND_RULES.decision}`));
    assert.ok(!p.includes('<context>'));
  });

  it('grades meaning, not wording, and a decision needs its reason', () => {
    assert.match(judgePrompt, /Wording does not matter: a paraphrase/);
    assert.match(JUDGE_KIND_RULES.decision, /without its reason is partial/);
    assert.match(JUDGE_KIND_RULES.decision, /even when an acceptable answer lists the decision alone/);
    assert.match(JUDGE_KIND_RULES.superseded, /earlier value is incorrect/);
  });

  it('gives an abstain question no reference to match', () => {
    const p = buildJudgePrompt(judgePrompt, { question: q({ kind: 'abstain', answer: 'not in the session', acceptableAnswers: [] }), reply: "I don't know." });
    assert.ok(p.includes('Reference answer: (none: the fact is never stated in the session)'));
    assert.ok(p.includes('Also acceptable: (none)'));
    assert.ok(p.includes(JUDGE_KIND_RULES.abstain));
  });

  it('marks an empty reply', () => {
    assert.ok(buildJudgePrompt(judgePrompt, { question: q(), reply: '' }).includes('<reply>\n(empty reply)\n</reply>'));
  });
});

describe('parseVerdict', () => {
  it('reads a JSON verdict, fenced or bare, in any case', () => {
    assert.deepStrictEqual(parseVerdict('{"verdict": "correct", "reason": "same choice and reason"}'), { verdict: 'correct', reason: 'same choice and reason' });
    assert.deepStrictEqual(parseVerdict('```json\n{"verdict":"PARTIAL","reason":"no reason given"}\n```'), { verdict: 'partial', reason: 'no reason given' });
  });

  it('returns null for prose, an unknown verdict or no JSON at all', () => {
    assert.strictEqual(parseVerdict('The reply is correct.'), null);
    assert.strictEqual(parseVerdict('{"verdict": "right"}'), null);
    assert.strictEqual(parseVerdict('{"reason": "x"}'), null);
    assert.strictEqual(parseVerdict(''), null);
  });

  it('keeps the reason to one line of at most 300 characters', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'incorrect', reason: `a\n${'b'.repeat(400)}` }));
    assert.strictEqual(v.reason.includes('\n'), false);
    assert.strictEqual(v.reason.length, 300);
  });

  it('knows the four verdicts of spec §8', () => {
    assert.deepStrictEqual([...VERDICTS], ['correct', 'partial', 'incorrect', 'abstained']);
  });
});

describe('scoreVerdict', () => {
  it('counts only correct as right on an answerable question', () => {
    assert.deepStrictEqual(scoreVerdict(q(), 'correct'), { answerCorrect: true, abstainCorrect: null });
    for (const v of ['partial', 'incorrect', 'abstained']) assert.deepStrictEqual(scoreVerdict(q(), v), { answerCorrect: false, abstainCorrect: null });
  });

  it('counts only abstained as right on an abstain question; any answer is a false answer', () => {
    const a = q({ kind: 'abstain' });
    assert.deepStrictEqual(scoreVerdict(a, 'abstained'), { answerCorrect: null, abstainCorrect: true });
    for (const v of ['correct', 'partial', 'incorrect']) assert.deepStrictEqual(scoreVerdict(a, v), { answerCorrect: null, abstainCorrect: false });
    assert.strictEqual(isRight({ kind: 'abstain', verdict: 'abstained' }), true);
    assert.strictEqual(isRight({ kind: 'decision', verdict: 'partial' }), false);
    assert.strictEqual(isRight({ kind: 'decision', verdict: 'correct' }), true);
  });
});

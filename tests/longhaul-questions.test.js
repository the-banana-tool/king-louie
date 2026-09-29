// tests/longhaul-questions.test.js
// Every validity constraint of benchmark spec §5, including the rejections.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { SessionIndex } = require('../src/longhaul/session-format');
const q = require('../src/longhaul/questions');
const { tmpDir } = require('./helpers/longhaul-helpers');

// 12 messages; each text is 40 characters (10 tokens), the tool call 8 tokens.
const SENDERS = ['user', 'assistant', 'toolUse', 'toolResult', 'user', 'assistant', 'user', 'assistant', 'user', 'status', 'user', 'assistant'];
function tiny() {
  const messages = SENDERS.map((sender, i) => ({
    id: `t-${i + 1}`, seq: i + 1, sender, timestamp: new Date(Date.UTC(2026, 0, 5, 9, i)).toISOString(),
    ...(sender === 'toolUse' ? { toolName: 'Bash', parameters: { command: 'x'.repeat(10) } }
      : sender === 'toolResult' ? { toolName: 'Bash', result: 'r'.repeat(40) } : { text: 't'.repeat(40) })
  }));
  return new SessionIndex(messages);
}
const index = tiny();
const ctx = { index, sessionId: 'T' };
const base = (over = {}) => ({
  id: 'T-1', sessionId: 'T', askAtSeq: 11, kind: 'user-said', question: 'What was said?', answer: 'it',
  acceptableAnswers: [], evidenceSeqs: [5], supersededBy: null, authoredBy: 'generated', verifiedBy: null, notes: '', ...over
});
const codes = (question) => q.validateQuestion(question, ctx).map((e) => e.split(':')[0]);

describe('valid questions of every kind', () => {
  for (const good of [
    base(),
    base({ kind: 'tool-observed', askAtSeq: 7, evidenceSeqs: [4] }),
    base({ kind: 'decision', askAtSeq: 9, evidenceSeqs: [6] }),
    base({ kind: 'superseded', evidenceSeqs: [1, 5], supersededBy: 12 }),
    base({ kind: 'multi-hop', evidenceSeqs: [2, 7] }),
    base({ kind: 'abstain', askAtSeq: 9, evidenceSeqs: [], answer: 'not in the session' }),
    base({ verifiedBy: 'human:SB' }),
    base({ verifiedBy: 'synthetic' })
  ]) {
    it(`accepts ${good.kind} (${good.verifiedBy})`, () => assert.deepStrictEqual(q.validateQuestion(good, ctx), []));
  }
});

describe('rejections', () => {
  const cases = [
    ['askAtSeq-not-user', base({ askAtSeq: 12 })],
    ['askAtSeq-range', base({ askAtSeq: 13 })],
    ['evidence-after-ask', base({ evidenceSeqs: [11] })],
    ['evidence-sender', base({ evidenceSeqs: [2] })],
    ['evidence-sender', base({ kind: 'tool-observed', askAtSeq: 7, evidenceSeqs: [5] })],
    ['evidence-sender', base({ kind: 'decision', evidenceSeqs: [10] })],
    ['evidence-count', base({ kind: 'superseded', evidenceSeqs: [5] })],
    ['evidence-count', base({ kind: 'multi-hop', evidenceSeqs: [2] })],
    ['evidence-count', base({ evidenceSeqs: [] })],
    ['abstain-evidence', base({ kind: 'abstain', evidenceSeqs: [5] })],
    ['evidence-duplicate', base({ kind: 'superseded', evidenceSeqs: [5, 5] })],
    ['evidence-type', base({ evidenceSeqs: ['5'] })],
    ['superseded-by', base({ kind: 'decision', evidenceSeqs: [6], supersededBy: 12 })],
    ['superseded-by', base({ kind: 'superseded', evidenceSeqs: [1, 5], supersededBy: 10 })],
    ['distance-mismatch', base({ distance: { messages: 99, estTokens: 48 } })],
    ['kind', base({ kind: 'guess' })],
    ['verified-by', base({ verifiedBy: 'bob' })],
    ['session', base({ sessionId: 'other' })],
    ['question', base({ question: '  ' })],
    ['authored-by', base({ authoredBy: 'model' })],
    ['acceptable-answers', base({ acceptableAnswers: [''] })]
  ];
  for (const [code, question] of cases) {
    it(`flags ${code} (${JSON.stringify(question).slice(0, 80)})`, () => assert.ok(codes(question).includes(code), codes(question).join(', ')));
  }

  it('flags duplicate ids in a set', () => {
    const problems = q.validateQuestionSet([base(), base()], ctx);
    assert.deepStrictEqual(problems, [{ id: 'T-1', errors: ['duplicate-id: T-1 appears more than once'] }]);
  });
});

describe('distance', () => {
  it('is measured from the nearest evidence, in messages and in tokens strictly between', () => {
    assert.deepStrictEqual(q.computeDistance(index, base()), { messages: 6, estTokens: 50 });
    assert.deepStrictEqual(q.computeDistance(index, base({ kind: 'multi-hop', evidenceSeqs: [2, 7] })), { messages: 4, estTokens: 30 });
    assert.strictEqual(q.computeDistance(index, base({ kind: 'abstain', evidenceSeqs: [] })), null);
  });

  it('accepts a stored distance that matches, whatever its key order', () => {
    assert.deepStrictEqual(q.validateQuestion(base({ distance: { estTokens: 50, messages: 6 } }), ctx), []);
  });

  it('buckets by estimated tokens', () => {
    assert.strictEqual(q.bucketFor({ estTokens: 9999 }), '<10K');
    assert.strictEqual(q.bucketFor({ estTokens: 10000 }), '10K-50K');
    assert.strictEqual(q.bucketFor({ estTokens: 50000 }), '50K-200K');
    assert.strictEqual(q.bucketFor({ estTokens: 999999 }), '200K-1M');
    assert.strictEqual(q.bucketFor({ estTokens: 1000000 }), '>1M');
    assert.strictEqual(q.bucketFor(null), 'none');
  });
});

describe('normalize, verified and files', () => {
  it('normalizes to the spec key order with sorted evidence and the computed distance', () => {
    const n = q.normalizeQuestion(base({ kind: 'multi-hop', evidenceSeqs: [7, 2], notes: undefined, acceptableAnswers: undefined }), index);
    assert.deepStrictEqual(Object.keys(n), ['id', 'sessionId', 'askAtSeq', 'kind', 'question', 'answer', 'acceptableAnswers', 'evidenceSeqs', 'supersededBy', 'distance', 'authoredBy', 'verifiedBy', 'notes']);
    assert.deepStrictEqual(n.evidenceSeqs, [2, 7]);
    assert.deepStrictEqual(n.distance, { messages: 4, estTokens: 30 });
    assert.deepStrictEqual(n.acceptableAnswers, []);
    assert.strictEqual(n.notes, '');
  });

  it('tells verified from unverified', () => {
    assert.strictEqual(q.isVerified(base()), false);
    assert.strictEqual(q.isVerified(base({ verifiedBy: 'human:SB' })), true);
    assert.strictEqual(q.isVerified(base({ verifiedBy: 'synthetic' })), true);
  });

  it('writes and reads a question file; a missing file is empty', async () => {
    const root = tmpDir();
    const file = q.questionsFile(root, 'T');
    assert.strictEqual(file, path.join(root, 'questions', 'T.jsonl'));
    assert.deepStrictEqual(await q.readQuestions(file), []);
    q.writeQuestions(file, [base(), base({ id: 'T-2' })]);
    assert.deepStrictEqual((await q.readQuestions(file)).map((x) => x.id), ['T-1', 'T-2']);
  });
});

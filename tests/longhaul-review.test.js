// tests/longhaul-review.test.js
// The review core shared by the terminal and web verify flows (benchmark
// spec §6): only a valid question is accepted, an edit is saved only when
// valid and never accepts by itself, and every decision is saved.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createReview } = require('../src/longhaul/review');
const { SYNTH_FIXTURES, generateSynthetic } = require('../src/longhaul/synthetic');
const { UsageError } = require('../src/longhaul/errors');

const NOW = () => new Date('2026-09-29T12:00:00.000Z');

function setup(mutate = (qs) => qs) {
  const gen = generateSynthetic(SYNTH_FIXTURES[0]);
  const session = { manifest: gen.manifest, messages: gen.messages, index: gen.index };
  const questions = mutate(gen.questions.map((q) => ({ ...q, verifiedBy: null })));
  const saves = [];
  const onSave = (current, rejected) => saves.push({ current: current.map((q) => ({ ...q })), rejected });
  const review = createReview({ session, questions, reviewer: 'TT', onSave, now: NOW });
  return { session, questions, review, saves };
}

describe('createReview', () => {
  it('queues unverified questions by askAtSeq, all pending', () => {
    const { review, questions } = setup();
    const queue = review.pending();
    assert.strictEqual(queue.length, questions.length);
    assert.deepStrictEqual(queue.map((q) => q.askAtSeq), [...questions].map((q) => q.askAtSeq).sort((a, b) => a - b));
    assert.ok(queue.every((q) => q.status === 'pending'));
    assert.deepStrictEqual(Object.keys(queue[0]).sort(), ['askAtSeq', 'id', 'kind', 'status']);
  });

  it('treats a question with no verifiedBy key as pending', () => {
    const { review, questions } = setup((qs) => qs.map(({ verifiedBy, ...q }, i) => (i === 0 ? { ...q, verifiedBy: 'human:XX' } : q)));
    assert.strictEqual(review.pending().length, questions.length - 1);
    assert.ok(review.current().slice(1).every((q) => q.verifiedBy === null));
  });

  it('refuses to accept an invalid question and saves nothing', () => {
    const { review, saves } = setup((qs) => qs.map((q, i) => (i === 0 ? { ...q, evidenceSeqs: [q.askAtSeq] } : q)));
    const id = review.current()[0].id;
    const res = review.accept(id);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'invalid');
    assert.match(res.errors.join('\n'), /evidence-after-ask/);
    assert.strictEqual(saves.length, 0);
    assert.strictEqual(review.counts().accepted, 0);
  });

  it('accepts a valid question: verifiedBy human:<reviewer>, normalized, saved', () => {
    const { review, saves } = setup();
    const id = review.pending()[0].id;
    const res = review.accept(id);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.question.verifiedBy, 'human:TT');
    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].rejected, null);
    assert.strictEqual(saves[0].current.find((q) => q.id === id).verifiedBy, 'human:TT');
    assert.strictEqual(review.pending()[0].status, 'accepted');
    assert.strictEqual(review.counts().accepted, 1);
  });

  it('edit with invalid fields returns the errors and saves nothing', () => {
    const { review, saves } = setup();
    const q = review.get(review.pending()[0].id);
    const res = review.edit(q.id, { evidenceSeqs: [q.askAtSeq + 1] });
    assert.strictEqual(res.ok, false);
    assert.match(res.errors.join('\n'), /evidence-after-ask/);
    assert.strictEqual(saves.length, 0);
    assert.deepStrictEqual(review.get(q.id).evidenceSeqs, q.evidenceSeqs);
  });

  it('edit refuses unknown fields and badly typed values', () => {
    const { review, saves } = setup();
    const id = review.pending()[0].id;
    assert.match(review.edit(id, { verifiedBy: 'human:TT' }).errors.join(), /verifiedBy/);
    assert.strictEqual(review.edit(id, { askAtSeq: 'x' }).ok, false);
    assert.strictEqual(saves.length, 0);
  });

  it('a valid edit is saved, recomputes distance and is not accepted', () => {
    const { review, saves } = setup();
    const q = review.get(review.pending()[0].id);
    const res = review.edit(q.id, { answer: 'Edited answer', acceptableAnswers: ['alt'] });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.question.answer, 'Edited answer');
    assert.strictEqual(res.question.verifiedBy, null);
    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].current.find((x) => x.id === q.id).answer, 'Edited answer');
    assert.strictEqual(review.pending()[0].status, 'edited');
    assert.deepStrictEqual(review.counts(), { accepted: 0, edited: 1, rejected: 0, skipped: 0 });
  });

  it('editing an accepted question unverifies it until Accept', () => {
    const { review } = setup();
    const id = review.pending()[0].id;
    review.accept(id);
    const res = review.edit(id, { answer: 'Changed' });
    assert.strictEqual(res.question.verifiedBy, null);
    assert.strictEqual(review.pending()[0].status, 'edited');
    assert.strictEqual(review.accept(id).question.answer, 'Changed');
  });

  it('an edit that moves the evidence recomputes a stale stored distance', () => {
    const { review, session } = setup();
    const q = review.pending().map((p) => review.get(p.id)).find((x) => x.kind === 'user-said');
    const earlier = session.index.userSeqs.filter((s) => s < q.evidenceSeqs[0]).at(-1);
    const res = review.edit(q.id, { evidenceSeqs: [earlier] });
    assert.strictEqual(res.ok, true, String(res.errors));
    assert.strictEqual(res.question.distance.messages, q.askAtSeq - earlier);
  });

  it('reject moves the question to the rejected entry', () => {
    const { review, saves } = setup();
    const id = review.pending()[1].id;
    const res = review.reject(id, 'too vague');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(saves.length, 1);
    assert.strictEqual(saves[0].current.find((q) => q.id === id), undefined);
    const r = saves[0].rejected;
    assert.deepStrictEqual({ id: r.id, by: r.rejectedBy, why: r.rejectReason, at: r.rejectedAt },
      { id, by: 'human:TT', why: 'too vague', at: '2026-09-29T12:00:00.000Z' });
    assert.strictEqual(review.pending()[1].status, 'rejected');
    assert.strictEqual(review.accept(id).code, 'decided');
    assert.strictEqual(review.counts().rejected, 1);
  });

  it('skip saves nothing; unknown ids are refused', () => {
    const { review, saves } = setup();
    const id = review.pending()[0].id;
    assert.strictEqual(review.skip(id).ok, true);
    assert.strictEqual(review.pending()[0].status, 'skipped');
    assert.strictEqual(review.counts().skipped, 1);
    assert.strictEqual(saves.length, 0);
    for (const fn of ['accept', 'skip', 'reject']) assert.strictEqual(review[fn]('nope').code, 'not-found');
    assert.strictEqual(review.edit('nope', {}).code, 'not-found');
  });

  it('requires reviewer initials', () => {
    const gen = generateSynthetic(SYNTH_FIXTURES[0]);
    const session = { manifest: gen.manifest, messages: gen.messages, index: gen.index };
    for (const reviewer of ['', 'a b', undefined]) {
      assert.throws(() => createReview({ session, questions: [], reviewer, onSave: () => {} }), UsageError);
    }
  });
});

// tests/longhaul-adapters.test.js
// sliding-window and oracle (benchmark spec §7, §14): both respect askAtSeq;
// sliding-window respects its window; oracle recovers every planted fact.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { SYNTH_FIXTURES, generateSynthetic } = require('../src/longhaul/synthetic');
const { SessionIndex, loadSession, estimateTokens } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');
const { FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

function generated(config) {
  const { manifest, messages, questions, index } = generateSynthetic(config);
  return { session: { manifest, messages, index }, questions };
}
async function fixture(id) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', id));
  return { session, questions: await readQuestions(questionsFile(FIXTURE_ROOT, id)) };
}

describe('sliding-window', () => {
  it('shows a contiguous run ending just before askAtSeq, inside the window', async () => {
    const { session, questions } = generated(SYNTH_FIXTURES[1]);
    const adapter = createAdapter('sliding-window', { budgetTokens: 2000 });
    assert.deepStrictEqual(adapter.describe(), { name: 'sliding-window', windowTokens: 8000 });
    const handle = await adapter.prepare(session, { upToSeq: Infinity });
    for (const q of questions) {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 2000 });
      const shown = [...r.evidenceSeqsShown, ...r.evidenceSeqsPartial].sort((a, b) => a - b);
      assert.ok(r.evidenceSeqsPartial.length <= 1, 'at most the newest message is cut');
      assert.ok(shown.every((s) => s < q.askAtSeq));
      assert.strictEqual(shown.at(-1), q.askAtSeq - 1);
      assert.deepStrictEqual(shown, Array.from({ length: shown.length }, (_, i) => shown[0] + i));
      assert.ok(r.estTokens <= 8000, `${r.estTokens} tokens`);
      assert.strictEqual(r.estTokens, estimateTokens(r.text));
      assert.ok(Number.isFinite(r.latencyMs) && Number.isFinite(r.cpuMs));
      assert.strictEqual(r.cost, 0);
    }
    await adapter.release(handle);
  });

  it('cuts a message larger than the window instead of showing nothing', async () => {
    const at = (i) => new Date(Date.UTC(2026, 0, 5, 9, i)).toISOString();
    const messages = [
      { id: 'b1', seq: 1, sender: 'user', text: 'start', timestamp: at(1) },
      { id: 'b2', seq: 2, sender: 'toolResult', toolName: 'Bash', result: 'x'.repeat(100000), timestamp: at(2) },
      { id: 'b3', seq: 3, sender: 'user', text: 'what now?', timestamp: at(3) }
    ];
    const session = { manifest: { sessionId: 'B' }, messages, index: new SessionIndex(messages) };
    const adapter = createAdapter('sliding-window', { windowTokens: 100 });
    const r = await adapter.context(await adapter.prepare(session), { question: {}, askAtSeq: 3, budgetTokens: 100 });
    assert.deepStrictEqual(r.evidenceSeqsShown, [], 'a cut message is not shown whole');
    assert.deepStrictEqual(r.evidenceSeqsPartial, [2]);
    assert.ok(r.estTokens <= 100);
    assert.match(r.text, /earlier part of #2 cut/);
  });
});

describe('sliding-window with a window too small for the cut marker', () => {
  it('leaves the message out entirely (--window-tokens 5)', async () => {
    const at = (i) => new Date(Date.UTC(2026, 0, 5, 9, i)).toISOString();
    const messages = [
      { id: 'c1', seq: 1, sender: 'user', text: 'start', timestamp: at(1) },
      { id: 'c2', seq: 2, sender: 'toolResult', toolName: 'Bash', result: 'y'.repeat(5000), timestamp: at(2) },
      { id: 'c3', seq: 3, sender: 'user', text: 'what now?', timestamp: at(3) }
    ];
    const session = { manifest: { sessionId: 'C' }, messages, index: new SessionIndex(messages) };
    const adapter = createAdapter('sliding-window', { windowTokens: 5 });
    const r = await adapter.context(await adapter.prepare(session), { question: {}, askAtSeq: 3, budgetTokens: 5 });
    assert.deepStrictEqual(r.evidenceSeqsShown, []);
    assert.deepStrictEqual(r.evidenceSeqsPartial, []);
    assert.ok(!r.text.includes('yyyy'), 'none of the message is shown');
    assert.ok(r.estTokens <= 5, `${r.estTokens} tokens`);
  });
});

describe('oracle', () => {
  for (const id of ['synth-small', 'synth-medium', 'synth-compacted']) {
    it(`${id}: shows every evidence message and every planted answer, nothing at or after askAtSeq`, async () => {
      const { session, questions } = await fixture(id);
      const adapter = createAdapter('oracle', { budgetTokens: 6000 });
      const handle = await adapter.prepare(session, { upToSeq: Infinity });
      for (const q of questions) {
        const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
        assert.ok(q.evidenceSeqs.every((s) => r.evidenceSeqsShown.includes(s)), q.id);
        assert.ok(r.evidenceSeqsShown.every((s) => s < q.askAtSeq), q.id);
        assert.deepStrictEqual(r.evidenceSeqsPartial, [], 'the oracle shows whole messages');
        if (q.kind !== 'abstain') assert.ok(q.acceptableAnswers.some((a) => r.text.includes(a)), `${q.id}: no acceptable answer in the oracle context`);
      }
      await adapter.release(handle);
    });
  }

  it('never shows evidence listed at or after askAtSeq', async () => {
    const { session, questions } = generated(SYNTH_FIXTURES[0]);
    const q = { ...questions[0], evidenceSeqs: [questions[0].askAtSeq, questions[0].askAtSeq + 1] };
    const adapter = createAdapter('oracle', {});
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
    assert.ok(r.evidenceSeqsShown.every((s) => s < q.askAtSeq));
  });

  it('shows only the tail for an abstain question', async () => {
    const { session, questions } = generated(SYNTH_FIXTURES[0]);
    const q = questions.find((x) => x.kind === 'abstain');
    const adapter = createAdapter('oracle', {});
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
    assert.ok(r.evidenceSeqsShown.length > 0 && r.evidenceSeqsShown.length <= 8);
    assert.ok(r.evidenceSeqsShown.every((s) => ['user', 'assistant'].includes(session.index.get(s).sender)));
  });
});

describe('adapter registry', () => {
  it('lists the built-in adapters and refuses an unknown one', () => {
    assert.deepStrictEqual(adapterNames(), ['kl-recall', 'kl-recall-vec', 'kl-recall-vec-only', 'oracle', 'sliding-window']);
    assert.throws(() => createAdapter('full-history'), UsageError);
  });
});

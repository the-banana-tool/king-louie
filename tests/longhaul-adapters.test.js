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
const { shownFromBuild } = require('../src/longhaul/adapters/kl-recall');
const { ContextBuilder } = require('../src/history/context-builder');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { openTempStore, seedChat } = require('./helpers/history-fixture');

function generated(config) {
  const { manifest, messages, questions, index } = generateSynthetic(config);
  return { session: { manifest, messages, index }, questions };
}
async function fixture(id) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', id));
  return { session, questions: await readQuestions(questionsFile(FIXTURE_ROOT, id)) };
}

describe('shownFromBuild with tailIncludeToolResults', () => {
  it('a whole tool result in the tail is shown whole, a shortened one partial', async () => {
    const t = openTempStore();
    try {
      seedChat(t.store, {
        messages: [
          { sender: 'user', text: 'Check the gate and the drainage log at the Lakeside lot.' },
          { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat gate.txt' } },
          { sender: 'toolResult', toolName: 'Bash', result: 'side gate code 4417' },
          { sender: 'toolUse', toolName: 'Bash', parameters: { command: 'cat drainage.log' } },
          { sender: 'toolResult', toolName: 'Bash', result: Array.from({ length: 40 }, (_, i) => `drainage line ${i} north fence`).join('\n') },
          { sender: 'assistant', text: 'The gate code is 4417 and the log is normal.' }
        ]
      });
      const estimator = new TokenEstimator();
      const builder = new ContextBuilder({
        store: t.store,
        retriever: new Retriever({ store: t.store, estimator }),
        estimator,
        getSettings: () => ({ history: { recall: { tailIncludeToolResults: true, tailToolResultMaxTokens: 50 } } })
      });
      const out = await builder.build({ chatId: 'chat-1', message: 'gate code', upToSeq: 7 });
      const rows = out.recalled.chunkIds.length ? t.store.chunks(out.recalled.chunkIds) : [];
      const shown = shownFromBuild(out, rows, 'chat-1', () => Infinity);
      assert.deepStrictEqual(shown.evidenceSeqsShown, [1, 3, 6], 'user, assistant and the small result are whole');
      assert.deepStrictEqual(shown.evidenceSeqsPartial, [2, 4, 5], 'the tool lines and the shortened result are partial');
      assert.deepStrictEqual(shown.tailWholeSeqs, [1, 3, 6]);
      assert.deepStrictEqual(shown.shortened.map((x) => x.seq), [5]);
    } finally {
      t.cleanup();
    }
  });
});

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
    assert.deepStrictEqual(adapterNames(), [
      'full-history', 'kl-recall', 'kl-recall-rerank', 'kl-recall-vec', 'kl-recall-vec-only', 'kl-recall-vec-rerank',
      'kl-recall-whole', 'oracle', 'real-compaction', 'sliding-window', 'summarize-compact'
    ]);
    assert.throws(() => createAdapter('no-such-adapter'), UsageError);
  });
});

describe('full-history', () => {
  it('shows every message before askAtSeq when the session fits the window', async () => {
    for (const id of ['synth-small', 'synth-medium', 'synth-compacted']) {
      const { session, questions } = await fixture(id);
      const adapter = createAdapter('full-history');
      assert.strictEqual(adapter.frontierOnly, true);
      assert.strictEqual(adapter.longContext, true);
      const handle = await adapter.prepare(session);
      for (const q of questions) {
        const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
        assert.deepStrictEqual(r.evidenceSeqsShown, Array.from({ length: q.askAtSeq - 1 }, (_, i) => i + 1), `${q.id}`);
        assert.strictEqual(r.truncated, false);
      }
    }
  });

  it('cuts the oldest messages at the window and says so', async () => {
    const { session, questions } = await fixture('synth-medium');
    const adapter = createAdapter('full-history', { windowTokens: 5000 });
    assert.deepStrictEqual(adapter.describe(), { name: 'full-history', windowTokens: 5000 });
    const q = questions.at(-1);
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.estTokens <= 5000, `${r.estTokens} tokens`);
    assert.strictEqual(Math.max(...r.evidenceSeqsShown), q.askAtSeq - 1);
    assert.ok(Math.min(...r.evidenceSeqsShown) > 1);
  });

  it('lowers its window to a cap, never raises it', () => {
    const capped = createAdapter('full-history').capWindow(5000);
    assert.strictEqual(capped.name, 'full-history');
    assert.strictEqual(capped.frontierOnly, true);
    assert.deepStrictEqual(capped.describe(), { name: 'full-history', windowTokens: 5000 });
    assert.strictEqual(createAdapter('full-history', { windowTokens: 3000 }).capWindow(5000).describe().windowTokens, 3000);
  });
});

describe('sliding-window truncated flag', () => {
  it('is true when older messages were left out, false when the whole prefix fits', async () => {
    const { session, questions } = await fixture('synth-small');
    const q = questions.at(-1);
    const small = createAdapter('sliding-window', { windowTokens: 500 });
    assert.strictEqual((await small.context(await small.prepare(session), { question: q, askAtSeq: q.askAtSeq })).truncated, true);
    const big = createAdapter('sliding-window', { windowTokens: 1000000 });
    assert.strictEqual((await big.context(await big.prepare(session), { question: q, askAtSeq: q.askAtSeq })).truncated, false);
  });
});

describe('real-compaction', () => {
  // synth-compacted: compaction summaries at #151 and #302
  // (tests/fixtures/longhaul/sessions/synth-compacted/manifest.json); their
  // text never mentions a planted fact.
  it('shows the latest summary before the question and only the messages after it', async () => {
    const { session, questions } = await fixture('synth-compacted');
    const adapter = createAdapter('real-compaction');
    assert.strictEqual(adapter.appliesTo(session), true);
    const handle = await adapter.prepare(session);
    const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
    // Asked at #303; its evidence (#208, #257) was condensed into #302.
    const q5 = byId['synth-compacted-005'];
    const r5 = await adapter.context(handle, { question: q5, askAtSeq: q5.askAtSeq });
    assert.strictEqual(r5.compactionSeq, 302);
    assert.match(r5.text, /^\[#302 compaction summary\]\n/);
    assert.deepStrictEqual(r5.evidenceSeqsShown, []);
    // Asked at #373; evidence #247 was condensed, #308 came after the summary.
    const q4 = byId['synth-compacted-004'];
    const r4 = await adapter.context(handle, { question: q4, askAtSeq: q4.askAtSeq });
    assert.deepStrictEqual(r4.evidenceSeqsShown, Array.from({ length: q4.askAtSeq - 303 }, (_, i) => 303 + i));
    assert.ok(r4.evidenceSeqsShown.includes(308) && !r4.evidenceSeqsShown.includes(247));
    assert.strictEqual(r4.truncated, false);
  });

  it('gives a question asked before the first compaction the whole prefix', async () => {
    const { session } = await fixture('synth-compacted');
    const askAtSeq = session.index.userSeqs.find((s) => s > 100 && s < 151);
    const adapter = createAdapter('real-compaction');
    const r = await adapter.context(await adapter.prepare(session), { question: { id: 'x', kind: 'abstain', evidenceSeqs: [] }, askAtSeq });
    assert.strictEqual(r.compactionSeq, null);
    assert.deepStrictEqual(r.evidenceSeqsShown, Array.from({ length: askAtSeq - 1 }, (_, i) => i + 1));
  });

  it('cuts the oldest messages after the summary at the window, and keeps the summary', async () => {
    const { session, questions } = await fixture('synth-compacted');
    const q = questions.find((x) => x.askAtSeq > 400);
    const adapter = createAdapter('real-compaction', { windowTokens: 1500 });
    const r = await adapter.context(await adapter.prepare(session), { question: q, askAtSeq: q.askAtSeq });
    assert.strictEqual(r.truncated, true);
    assert.match(r.text, /^\[#302 compaction summary\]\n/);
    assert.strictEqual(Math.max(...r.evidenceSeqsShown), q.askAtSeq - 1);
    assert.ok(Math.min(...r.evidenceSeqsShown) > 303);
    assert.ok(r.estTokens <= 1500, `${r.estTokens} tokens`);
  });

  it('does not apply to a session with no recorded compactions', async () => {
    const { session } = await fixture('synth-small');
    const adapter = createAdapter('real-compaction');
    assert.strictEqual(adapter.appliesTo(session), false);
    assert.strictEqual(adapter.skipReason, 'no recorded compactions');
  });

  it('lowers its window to a cap, never raises it', () => {
    const capped = createAdapter('real-compaction').capWindow(1500);
    assert.deepStrictEqual(capped.describe(), { name: 'real-compaction', windowTokens: 1500 });
    assert.strictEqual(capped.longContext, true);
    assert.strictEqual(createAdapter('real-compaction', { windowTokens: 1000 }).capWindow(1500).describe().windowTokens, 1000);
  });
});

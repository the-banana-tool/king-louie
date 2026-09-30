// tests/longhaul-adapter-kl-recall.test.js
// kl-recall (benchmark spec §7, §14): recall's ContextBuilder over a temp
// store. The leakage test: it never shows a message with seq >= askAtSeq.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { adapterNames } = require('../src/longhaul/adapters');
const { createKlRecallAdapter, shownFromBuild } = require('../src/longhaul/adapters/kl-recall');
const { SYNTH_FIXTURES, generateSynthetic } = require('../src/longhaul/synthetic');
const { SessionIndex, loadSession, estimateTokens } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');
const { TokenEstimator } = require('../src/history/token-estimator');
const { chunkMessage } = require('../src/history/chunker');
const { FIXTURE_ROOT, tmpDir, tmpHome, sink } = require('./helpers/longhaul-helpers');
const { mergeHistorySettings } = require('../src/history/settings');
const { main } = require('../src/longhaul/cli');

async function fixture(id) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', id));
  return { session, questions: await readQuestions(questionsFile(FIXTURE_ROOT, id)) };
}

describe('shownFromBuild', () => {
  it('takes the tail messages, the tool calls folded into the tail and the recalled chunks, never the stats.tail range', () => {
    // Tail messages 10, 11 (shortened) and 14; 12 is a tool call folded into
    // the tail; 13 is a tool result inside the range that the tail leaves out.
    const out = {
      tail: [{ seq: 10 }, { seq: 11 }, { seq: 14 }],
      recalled: { chunkIds: [7, 8, 9, 5] },
      stats: { tail: { fromSeq: 10, toSeq: 14, seqs: [10, 11, 12, 14], shortened: [{ seq: 11, shown: 1, total: 3 }] } }
    };
    const rows = [
      { id: 7, chatId: 'c', seq: 4 }, { id: 8, chatId: 'c', seq: 4 },
      { id: 5, chatId: 'c', seq: 6 },
      { id: 9, chatId: 'other', seq: 2 }
    ];
    const totals = { 4: 2, 6: 3 };
    const shown = shownFromBuild(out, rows, 'c', (seq) => totals[seq]);
    assert.deepStrictEqual(shown.evidenceSeqsShown, [4, 10, 14], 'whole: unshortened tail messages and fully recalled messages');
    assert.deepStrictEqual(shown.evidenceSeqsPartial, [6, 11, 12], 'partial: a shortened tail message, a folded tool call, some chunks of a message');
    assert.deepStrictEqual(shown.tailSeqs, [10, 11, 12, 14]);
    assert.deepStrictEqual(shown.recalledSeqs, [4, 6]);
    assert.deepStrictEqual(shown.shownBySeq, { 4: 2, 6: 1 });
    assert.deepStrictEqual(shown.totalBySeq, { 4: 2, 6: 3 });
    for (const list of [shown.evidenceSeqsShown, shown.evidenceSeqsPartial]) {
      assert.ok(!list.includes(13), 'a tool result inside the tail range but not in the tail is not shown');
      assert.ok(!list.includes(2), 'a chunk of another chat is not shown');
    }
  });
});

describe('kl-recall', () => {
  it('is registered next to the other adapters', () => {
    assert.deepStrictEqual(adapterNames(), ['kl-recall', 'kl-recall-jev-rerank', 'kl-recall-rerank', 'kl-recall-vec', 'kl-recall-vec-jev-rerank', 'kl-recall-vec-only', 'kl-recall-vec-rerank', 'oracle', 'sliding-window']);
  });

  it('refuses --recall recalledTokens: the budget comes from --budget-tokens', () => {
    assert.throws(() => createKlRecallAdapter({ recall: { recalledTokens: 100 }, tmpRoot: tmpDir() }), (err) => err instanceof UsageError && /--budget-tokens/.test(err.message));
  });

  it('refuses a recall value the settings merge would not keep', () => {
    const bad = [
      { tailMessages: -1 }, { tailMessages: 2.5 }, { tailMessages: 'many' }, { recencyWeight: 2 },
      { tailIncludeToolCalls: 'yes' }, { kindWeights: { bogus: 1 } }, { kindWeights: { user: -1 } }, { kindWeights: 3 }
    ];
    for (const recall of bad) {
      assert.throws(() => createKlRecallAdapter({ recall, tmpRoot: tmpDir() }), (err) => err instanceof UsageError && /--recall/.test(err.message), JSON.stringify(recall));
    }
  });

  it('records the effective merged recall settings', () => {
    const adapter = createKlRecallAdapter({ budgetTokens: 3000, recall: { tailMessages: 4, kindWeights: { user: 2 } }, tmpRoot: tmpDir() });
    const expected = mergeHistorySettings({ recall: { tailMessages: 4, kindWeights: { user: 2 }, recalledTokens: 3000 } }).recall;
    assert.deepStrictEqual(adapter.describe().recall, expected);
    assert.strictEqual(adapter.describe().recall.kindWeights.assistant, 1.0);
  });

  it('the CLI refuses --recall recalledTokens with exit 2', async () => {
    const stderr = sink();
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'kl-recall', '--recall', 'recalledTokens=100'], { stdout: sink(), stderr, env: tmpHome().env });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /--budget-tokens/);
  });

  it('chunk overrides history.chunk for the store and for the whole/partial count', async () => {
    assert.throws(() => createKlRecallAdapter({ chunk: { notAKey: 1 }, tmpRoot: tmpDir() }), UsageError);
    assert.throws(() => createKlRecallAdapter({ chunk: { targetChars: 100 }, tmpRoot: tmpDir() }), (err) => err instanceof UsageError && /targetChars/.test(err.message));
    assert.deepStrictEqual(createKlRecallAdapter({ tmpRoot: tmpDir() }).describe().chunk, { targetChars: 1500, minChars: 40 });
    const small = createKlRecallAdapter({ chunk: { targetChars: 600 }, tmpRoot: tmpDir() });
    assert.deepStrictEqual(small.describe().chunk, { targetChars: 600, minChars: 40 });

    const para = (i) => `Paragraph ${i} about the Lakeside lot drainage survey, with enough words to stand on its own as a piece of text here.`;
    // One paragraph of lines: targetChars splits a paragraph over it; it
    // never merges paragraphs.
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n');
    const messages = [
      { id: 'm1', seq: 1, sender: 'user', text: 'Please write up the drainage survey.', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', seq: 2, sender: 'assistant', text, timestamp: '2026-01-01T00:01:00.000Z' }
    ];
    const session = { manifest: { sessionId: 'chunk-override' }, messages, index: new SessionIndex(messages) };
    const counts = {};
    for (const [name, adapter] of [['default', createKlRecallAdapter({ tmpRoot: tmpDir() })], ['small', small]]) {
      const handle = await adapter.prepare(session);
      try {
        const rows = handle.store.chunksOfChat(handle.chatId).filter((c) => c.seq === 2);
        counts[name] = rows.length;
        assert.strictEqual(rows.length, chunkMessage(messages[1], adapter.describe().chunk).length, name);
      } finally {
        await adapter.release(handle);
      }
    }
    assert.ok(counts.small > counts.default, JSON.stringify(counts));
  });

  it('the CLI passes --chunk-target-chars to kl-recall', async () => {
    const stderr = sink();
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'kl-recall', '--chunk-target-chars', 'x'], { stdout: sink(), stderr, env: tmpHome().env });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /--chunk-target-chars/);
  });

  it('needs a tmpRoot: there is no default outside LONGHAUL_HOME', () => {
    assert.throws(() => createKlRecallAdapter({}), /tmpRoot/);
  });

  it('refuses a recall setting it does not know, and sets recalledTokens to the budget', () => {
    assert.throws(() => createKlRecallAdapter({ recall: { notASetting: 1 }, tmpRoot: tmpDir() }), UsageError);
    assert.strictEqual(createKlRecallAdapter({ budgetTokens: 4321, tmpRoot: tmpDir() }).describe().recall.recalledTokens, 4321);
  });

  it('never shows a message at or after askAtSeq (the leakage test)', async () => {
    const base = generateSynthetic(SYNTH_FIXTURES[0]);
    const messages = base.messages.map((m) => ({ ...m }));
    const askAtSeq = base.index.userSeqs[20];
    for (const m of messages) {
      if (m.seq < askAtSeq) continue;
      if (m.sender === 'toolResult') m.result = `${m.result}\nzephyr-quartz answered 18999`;
      else if (m.sender === 'user' || m.sender === 'assistant') m.text = `${m.text} zephyr-quartz is 18999.`;
    }
    const session = { manifest: base.manifest, messages, index: new SessionIndex(messages) };
    const q = {
      id: 'leak-1', sessionId: base.manifest.sessionId, askAtSeq, kind: 'abstain', question: 'What is zephyr-quartz set to?',
      answer: 'not in the session', acceptableAnswers: [], evidenceSeqs: [], supersededBy: null, authoredBy: 'human', verifiedBy: 'human:T', notes: ''
    };
    const adapter = createKlRecallAdapter({ budgetTokens: 6000, tmpRoot: tmpDir() });
    // Everything is in the store; only build's upToSeq keeps the later messages out.
    const handle = await adapter.prepare(session, { upToSeq: Infinity });
    try {
      const r = await adapter.context(handle, { question: q, askAtSeq, budgetTokens: 6000 });
      assert.ok(r.evidenceSeqsShown.length > 0);
      assert.deepStrictEqual([...r.evidenceSeqsShown, ...r.evidenceSeqsPartial].filter((s) => s >= askAtSeq), []);
      assert.ok(!r.text.includes('zephyr-quartz'));
    } finally {
      await adapter.release(handle);
    }
  });

  it('never leaks on any committed fixture question', async () => {
    for (const id of ['synth-small', 'synth-medium', 'synth-compacted']) {
      const { session, questions } = await fixture(id);
      const adapter = createKlRecallAdapter({ budgetTokens: 6000, tmpRoot: tmpDir() });
      const handle = await adapter.prepare(session, { upToSeq: Infinity });
      try {
        for (const q of questions) {
          const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
          assert.deepStrictEqual([...r.evidenceSeqsShown, ...r.evidenceSeqsPartial].filter((s) => s >= q.askAtSeq), [], q.id);
        }
      } finally {
        await adapter.release(handle);
      }
    }
  });

  it('finds a unique planted fact far beyond the tail and reports its chunks', async () => {
    const { session, questions } = await fixture('synth-medium');
    const q = questions.filter((x) => x.kind === 'user-said').sort((a, b) => b.distance.estTokens - a.distance.estTokens)[0];
    const [e] = q.evidenceSeqs;
    const adapter = createKlRecallAdapter({ budgetTokens: 6000, tmpRoot: tmpDir() });
    const handle = await adapter.prepare(session, { upToSeq: q.askAtSeq });
    try {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
      assert.ok(r.evidenceSeqsShown.includes(e), `BM25 recall missed #${e}, a unique codename ${q.distance.estTokens} tokens back`);
      assert.ok(!r.chunks.tailSeqs.includes(e), 'the evidence came from recall, not the tail');
      assert.ok(r.chunks.shownBySeq[e] >= 1);
      assert.strictEqual(r.chunks.totalBySeq[e], chunkMessage(session.index.get(e), handle.settings.history.chunk).length);
      assert.ok(r.chunks.totalBySeq[e] >= r.chunks.shownBySeq[e]);
      assert.strictEqual(r.estTokens, estimateTokens(r.text));
    } finally {
      await adapter.release(handle);
    }
  });

  it('reports a shortened tail message and a partly recalled message as partial, not shown', async () => {
    const at = (i) => new Date(Date.UTC(2026, 0, 5, 9, 0, i)).toISOString();
    const filler = (tag, n) => Array.from({ length: n }, (_, k) => `${tag}word${k}`).join(' ');
    const paragraphs = Array.from({ length: 8 }, (_, p) => (p === 3 ? `The zephyr-quartz port is 18777. ${filler(`p${p}`, 150)}` : filler(`p${p}`, 170)));
    const messages = [
      { id: 'p1', seq: 1, sender: 'user', text: 'start the notes', timestamp: at(1) },
      { id: 'p2', seq: 2, sender: 'assistant', text: paragraphs.join('\n\n'), timestamp: at(2) }
    ];
    for (let k = 3; k <= 30; k++) messages.push({ id: `p${k}`, seq: k, sender: k % 2 ? 'user' : 'assistant', text: `short turn ${k}`, timestamp: at(k) });
    messages.push({ id: 'p31', seq: 31, sender: 'user', text: Array.from({ length: 6 }, (_, p) => filler(`t${p}`, 170)).join('\n\n'), timestamp: at(31) });
    const session = { manifest: { sessionId: 'P' }, messages, index: new SessionIndex(messages) };
    const q = { id: 'p-q', question: 'Which port does zephyr-quartz use?', evidenceSeqs: [2] };
    const adapter = createKlRecallAdapter({ budgetTokens: 6000, tmpRoot: tmpDir() });
    const handle = await adapter.prepare(session, { upToSeq: 32 });
    try {
      const r = await adapter.context(handle, { question: q, askAtSeq: 32, budgetTokens: 6000 });
      assert.ok(r.evidenceSeqsPartial.includes(31), 'the tail message over tailMaxMessageTokens was shortened');
      assert.ok(!r.evidenceSeqsShown.includes(31));
      assert.ok(r.chunks.shownBySeq[2] >= 1 && r.chunks.shownBySeq[2] < r.chunks.totalBySeq[2], 'some, not all, chunks of #2 were recalled');
      assert.ok(r.evidenceSeqsPartial.includes(2));
      assert.ok(!r.evidenceSeqsShown.includes(2));
      assert.ok(r.evidenceSeqsShown.includes(30), 'a short tail message is shown whole');
    } finally {
      await adapter.release(handle);
    }
  });

  it('imports only the messages before upToSeq and removes its store on release', async () => {
    const { manifest, messages, index } = generateSynthetic(SYNTH_FIXTURES[0]);
    const adapter = createKlRecallAdapter({ tmpRoot: tmpDir() });
    const handle = await adapter.prepare({ manifest, messages, index }, { upToSeq: 50 });
    assert.deepStrictEqual(handle.store.getMessages(handle.chatId, { fromSeq: 50, toSeq: 60 }), []);
    assert.strictEqual(handle.store.getMessages(handle.chatId, { fromSeq: 49, toSeq: 49 }).length, 1);
    const { dir } = handle;
    await adapter.release(handle);
    assert.strictEqual(fs.existsSync(dir), false);
  });

  it('estimates tokens exactly as TokenEstimator does before any calibration', async () => {
    const { manifest, messages, index } = generateSynthetic(SYNTH_FIXTURES[0]);
    const adapter = createKlRecallAdapter({ tmpRoot: tmpDir() });
    const handle = await adapter.prepare({ manifest, messages, index }, { upToSeq: 5 });
    try {
      const estimator = new TokenEstimator({ store: handle.store });
      for (const text of ['', 'abcd', 'abcde', 'x'.repeat(1001), messages[3].result || messages[3].text]) {
        assert.strictEqual(estimator.estimate(text, 'longhaul-estimate'), estimateTokens(text), JSON.stringify(String(text).slice(0, 20)));
      }
    } finally {
      await adapter.release(handle);
    }
  });
});

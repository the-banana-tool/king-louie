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
const { FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

async function fixture(id) {
  const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', id));
  return { session, questions: await readQuestions(questionsFile(FIXTURE_ROOT, id)) };
}

describe('shownFromBuild', () => {
  it('takes seqs from the tail messages returned, not from the stats.tail range', () => {
    const out = {
      tail: [{ seq: 10 }, { seq: 11 }, { seq: 13 }],
      recalled: { chunkIds: [7, 8, 9] },
      stats: { tail: { fromSeq: 10, toSeq: 13 } }
    };
    const rows = [{ id: 7, chatId: 'c', seq: 4 }, { id: 8, chatId: 'c', seq: 4 }, { id: 9, chatId: 'other', seq: 2 }];
    const shown = shownFromBuild(out, rows, 'c');
    assert.deepStrictEqual(shown.evidenceSeqsShown, [4, 10, 11, 13]);
    assert.deepStrictEqual(shown.tailSeqs, [10, 11, 13]);
    assert.deepStrictEqual(shown.recalledSeqs, [4]);
    assert.deepStrictEqual(shown.shownBySeq, { 4: 2 });
    assert.ok(!shown.evidenceSeqsShown.includes(12), 'a tool result inside the tail range but not in the tail is not shown');
  });
});

describe('kl-recall', () => {
  it('is registered next to the other adapters', () => {
    assert.deepStrictEqual(adapterNames(), ['kl-recall', 'oracle', 'sliding-window']);
  });

  it('refuses a recall setting it does not know, and sets recalledTokens to the budget', () => {
    assert.throws(() => createKlRecallAdapter({ recall: { notASetting: 1 } }), UsageError);
    assert.strictEqual(createKlRecallAdapter({ budgetTokens: 4321 }).describe().recall.recalledTokens, 4321);
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
    const adapter = createKlRecallAdapter({ budgetTokens: 6000 });
    // Everything is in the store; only build's upToSeq keeps the later messages out.
    const handle = await adapter.prepare(session, { upToSeq: Infinity });
    try {
      const r = await adapter.context(handle, { question: q, askAtSeq, budgetTokens: 6000 });
      assert.ok(r.evidenceSeqsShown.length > 0);
      assert.deepStrictEqual(r.evidenceSeqsShown.filter((s) => s >= askAtSeq), []);
      assert.ok(!r.text.includes('zephyr-quartz'));
    } finally {
      await adapter.release(handle);
    }
  });

  it('never leaks on any committed fixture question', async () => {
    for (const id of ['synth-small', 'synth-medium', 'synth-compacted']) {
      const { session, questions } = await fixture(id);
      const adapter = createKlRecallAdapter({ budgetTokens: 6000 });
      const handle = await adapter.prepare(session, { upToSeq: Infinity });
      try {
        for (const q of questions) {
          const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
          assert.deepStrictEqual(r.evidenceSeqsShown.filter((s) => s >= q.askAtSeq), [], q.id);
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
    const adapter = createKlRecallAdapter({ budgetTokens: 6000 });
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

  it('imports only the messages before upToSeq and removes its store on release', async () => {
    const { manifest, messages, index } = generateSynthetic(SYNTH_FIXTURES[0]);
    const adapter = createKlRecallAdapter({});
    const handle = await adapter.prepare({ manifest, messages, index }, { upToSeq: 50 });
    assert.deepStrictEqual(handle.store.getMessages(handle.chatId, { fromSeq: 50, toSeq: 60 }), []);
    assert.strictEqual(handle.store.getMessages(handle.chatId, { fromSeq: 49, toSeq: 49 }).length, 1);
    const { dir } = handle;
    await adapter.release(handle);
    assert.strictEqual(fs.existsSync(dir), false);
  });

  it('estimates tokens exactly as TokenEstimator does before any calibration', async () => {
    const { manifest, messages, index } = generateSynthetic(SYNTH_FIXTURES[0]);
    const adapter = createKlRecallAdapter({});
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

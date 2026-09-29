// tests/longhaul-verify.test.js
// The verify loop (benchmark spec §6), driven with scripted input.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { verifyLoop } = require('../src/longhaul/verify');
const { SYNTH_FIXTURES, generateSynthetic, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { readQuestions, writeQuestions, questionsFile } = require('../src/longhaul/questions');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

function setup() {
  const gen = generateSynthetic(SYNTH_FIXTURES[0]);
  const session = { manifest: gen.manifest, messages: gen.messages, index: gen.index };
  const questions = gen.questions.map((q) => ({ ...q, verifiedBy: null }));
  return { session, questions };
}
const input = (lines) => Readable.from([lines.map((l) => `${l}\n`).join('')]);
function recorder() {
  const saves = [];
  return { saves, onSave: (current, rejected) => saves.push({ current: current.map((q) => ({ ...q })), rejected }) };
}
const NOW = () => new Date('2026-09-29T12:00:00.000Z');

describe('verifyLoop', () => {
  it('accepts, rejects, edits, skips and quits, saving after every decision', async () => {
    const { session, questions } = setup();
    const pending = [...questions].sort((a, b) => a.askAtSeq - b.askAtSeq);
    const [q1, q2, q3] = pending;
    const restore = q3.evidenceSeqs.length ? q3.evidenceSeqs.join(',') : '-';
    const out = sink();
    const rec = recorder();
    const counts = await verifyLoop({
      session, questions, reviewer: 'TT', output: out, onSave: rec.onSave, now: NOW,
      input: input([
        'a',
        'r', 'too vague',
        'e', '', 'Edited answer', '', String(q3.askAtSeq), '', '', '',
        'e', '', '', '', restore, '', '', '',
        'a',
        's',
        'q'
      ])
    });
    assert.deepStrictEqual(counts, { accepted: 2, edited: 1, rejected: 1, skipped: 1, stopped: true });
    assert.strictEqual(rec.saves.length, 4);
    const last = rec.saves.at(-1).current;
    assert.strictEqual(last.find((q) => q.id === q1.id).verifiedBy, 'human:TT');
    assert.strictEqual(last.find((q) => q.id === q2.id), undefined);
    const edited = last.find((q) => q.id === q3.id);
    assert.strictEqual(edited.answer, 'Edited answer');
    assert.strictEqual(edited.verifiedBy, 'human:TT');
    assert.deepStrictEqual(edited.evidenceSeqs, q3.evidenceSeqs);
    for (const q of pending.slice(3)) assert.strictEqual(last.find((x) => x.id === q.id).verifiedBy, null);
    const { rejected } = rec.saves.find((s) => s.rejected);
    assert.deepStrictEqual(
      { id: rejected.id, by: rejected.rejectedBy, why: rejected.rejectReason, at: rejected.rejectedAt },
      { id: q2.id, by: 'human:TT', why: 'too vague', at: '2026-09-29T12:00:00.000Z' }
    );
    assert.match(out.text, /Not valid yet \(not saved\):\n {2}evidence-after-ask/);
  });

  it('shows the question, the evidence and the message at askAtSeq, clipping long text', async () => {
    const { session, questions } = setup();
    const q = questions.find((x) => x.kind === 'tool-observed');
    session.index.get(q.evidenceSeqs[0]).result = 'y'.repeat(5000);
    const out = sink();
    await verifyLoop({ session, questions: [q], reviewer: 'TT', output: out, onSave: () => {}, input: input(['q']) });
    assert.ok(out.text.includes(`Q: ${q.question}`));
    assert.ok(out.text.includes(`[#${q.evidenceSeqs[0]} Bash result`));
    assert.ok(out.text.includes('[... 3500 more characters]'));
    assert.ok(out.text.includes(`At #${q.askAtSeq}`));
  });

  it('refuses to accept an invalid question', async () => {
    const { session, questions } = setup();
    const q = { ...questions[0], evidenceSeqs: [questions[0].askAtSeq] };
    const rec = recorder();
    const out = sink();
    const counts = await verifyLoop({ session, questions: [q], reviewer: 'TT', output: out, onSave: rec.onSave, input: input(['a', 'q']) });
    assert.match(out.text, /Cannot accept:/);
    assert.strictEqual(counts.accepted, 0);
    assert.strictEqual(rec.saves.length, 0);
  });

  it('keeps what was decided when the input ends', async () => {
    const { session, questions } = setup();
    const rec = recorder();
    const counts = await verifyLoop({ session, questions, reviewer: 'TT', output: sink(), onSave: rec.onSave, input: input(['a']) });
    assert.deepStrictEqual(counts, { accepted: 1, edited: 0, rejected: 0, skipped: 0, stopped: true });
    assert.strictEqual(rec.saves.length, 1);
  });

  it('offers a question with no verifiedBy key for review', async () => {
    const { session, questions } = setup();
    const missing = questions.map(({ verifiedBy, ...q }) => q);
    const rec = recorder();
    const counts = await verifyLoop({ session, questions: missing, reviewer: 'TT', output: sink(), onSave: rec.onSave, now: NOW, input: input(['a', 'q']) });
    assert.strictEqual(counts.accepted, 1);
    assert.strictEqual(rec.saves.at(-1).current.filter((q) => q.verifiedBy === 'human:TT').length, 1);
  });

  it('requires reviewer initials', async () => {
    const { session, questions } = setup();
    for (const reviewer of ['', 'a b', undefined]) {
      await assert.rejects(verifyLoop({ session, questions, reviewer, output: sink(), onSave: () => {}, input: input([]) }), UsageError);
    }
  });
});

describe('longhaul verify CLI', () => {
  it('saves accepted questions, appends rejects to their own file and reports the verified count', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const file = questionsFile(root, 'synth-small');
    writeQuestions(file, (await readQuestions(file)).map((q) => ({ ...q, verifiedBy: null })));
    const stdout = sink();
    const code = await main(['verify', '--session', 'synth-small', '--reviewer', 'TT'], { stdin: input(['a', 'r', 'duplicate', 'q']), stdout, stderr: sink(), env });
    assert.strictEqual(code, 0);
    const after = await readQuestions(file);
    assert.strictEqual(after.length, 5);
    assert.strictEqual(after.filter((q) => q.verifiedBy === 'human:TT').length, 1);
    const rejected = fs.readFileSync(path.join(root, 'questions', 'synth-small.rejected.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(rejected.length, 1);
    assert.match(stdout.text, /verified for synth-small: 1 /);
  });

  it('treats a question with no verifiedBy key as unverified', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    const file = questionsFile(root, 'synth-small');
    writeQuestions(file, (await readQuestions(file)).map(({ verifiedBy, ...q }) => q));
    const stdout = sink();
    const code = await main(['verify', '--session', 'synth-small', '--reviewer', 'TT'], { stdin: input(['a', 'q']), stdout, stderr: sink(), env });
    assert.strictEqual(code, 0);
    assert.doesNotMatch(stdout.text, /Nothing to verify/);
    const after = await readQuestions(file);
    assert.strictEqual(after.filter((q) => q.verifiedBy === 'human:TT').length, 1);
  });

  it('refuses without --reviewer', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    assert.strictEqual(await main(['verify', '--session', 'synth-small'], { stdin: input([]), stdout: sink(), stderr: sink(), env }), 2);
  });
});

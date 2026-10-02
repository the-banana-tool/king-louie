// tests/longhaul-spot-check.test.js
// Human spot-checks of the judge (benchmark spec §8 step 4), driven with
// scripted input.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { reviewSpotChecks, agreement, readSpotChecks } = require('../src/longhaul/spot-check');
const { spotCheckFile } = require('../src/longhaul/answer-stage');
const { writeFileAtomic } = require('../src/longhaul/files');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const input = (lines) => Readable.from([lines.map((l) => `${l}\n`).join('')]);
const row = (i, verdict) => ({
  runId: 'R', sessionId: 'S', questionId: `q${i}`, adapter: 'oracle', kind: 'user-said',
  question: `Which staging port for amber-heron ${i}?`, reference: '18001', acceptableAnswers: ['port 18001'],
  reply: 'Port 18001.', verdict, reason: 'same value', humanVerdict: null, reviewer: null
});

describe('reviewSpotChecks', () => {
  it('shows each judgment and records the reviewer\'s own verdict, saving after each', async () => {
    const saves = [];
    const out = sink();
    const counts = await reviewSpotChecks({
      rows: [row(1, 'correct'), row(2, 'correct'), row(3, 'incorrect')], reviewer: 'TT',
      input: input(['c', 'x', 'i', 's']), output: out, onSave: (rows) => saves.push(rows)
    });
    assert.deepStrictEqual(counts, { reviewed: 2, skipped: 1, stopped: false });
    assert.strictEqual(saves.length, 2);
    assert.deepStrictEqual(saves.at(-1).map((r) => [r.humanVerdict, r.reviewer]), [['correct', 'human:TT'], ['incorrect', 'human:TT'], [null, null]]);
    assert.match(out.text, /Reference: 18001/);
    assert.match(out.text, /Also accept: port 18001/);
    assert.match(out.text, /Judge: correct - same value/);
    assert.match(out.text, /Type c, p, i, a, s or q\./);
  });

  it('skips rows already reviewed, and stops on q or at the end of input', async () => {
    const reviewed = { ...row(1, 'correct'), humanVerdict: 'correct', reviewer: 'human:TT' };
    const counts = await reviewSpotChecks({ rows: [reviewed, row(2, 'correct')], reviewer: 'TT', input: input(['q']), output: sink(), onSave: () => {} });
    assert.deepStrictEqual(counts, { reviewed: 0, skipped: 0, stopped: true });
    const ended = await reviewSpotChecks({ rows: [row(2, 'correct')], reviewer: 'TT', input: input([]), output: sink(), onSave: () => {} });
    assert.strictEqual(ended.stopped, true);
  });

  it('refuses a missing or malformed reviewer', async () => {
    await assert.rejects(reviewSpotChecks({ rows: [], reviewer: '', input: input([]), output: sink(), onSave: () => {} }), UsageError);
    await assert.rejects(reviewSpotChecks({ rows: [], reviewer: 'a b', input: input([]), output: sink(), onSave: () => {} }), UsageError);
  });
});

describe('agreement', () => {
  it('counts reviewed rows whose human verdict matches the judge', () => {
    const rows = [{ ...row(1, 'correct'), humanVerdict: 'correct' }, { ...row(2, 'correct'), humanVerdict: 'partial' }, row(3, 'incorrect')];
    assert.deepStrictEqual(agreement(rows), { sampled: 3, reviewed: 2, agreed: 1, rate: 0.5 });
    assert.deepStrictEqual(agreement([]), { sampled: 0, reviewed: 0, agreed: 0, rate: null });
  });
});

describe('longhaul spot-check', () => {
  it('reviews a run\'s sample in place and prints the agreement', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    const runId = '20260930T101500Z-abcd';
    const file = spotCheckFile(home, runId);
    writeFileAtomic(file, `${[row(1, 'correct'), row(2, 'incorrect')].map((r) => JSON.stringify(r)).join('\n')}\n`);
    const stdout = sink();
    const code = await main(['spot-check', '--run', runId, '--reviewer', 'TT'], { stdout, stderr: sink(), env, stdin: input(['c', 'c']) });
    assert.strictEqual(code, 0);
    assert.match(stdout.text, /Judge agreement: 1\/2 \(0\.500\) of 2 sampled/);
    assert.deepStrictEqual(readSpotChecks(file).map((r) => r.humanVerdict), ['correct', 'correct']);
  });

  it('refuses a malformed run id, or a run with no sample', async () => {
    const { env } = tmpHome();
    const io = () => ({ stdout: sink(), stderr: sink(), env });
    assert.strictEqual(await main(['spot-check', '--run', '../x', '--reviewer', 'TT'], io()), 2);
    assert.strictEqual(await main(['spot-check', '--run', '20260930T101500Z-abcd', '--reviewer', 'TT'], io()), 2);
    assert.strictEqual(await main(['spot-check', '--run', '20260930T101500Z-abcd'], io()), 2);
  });
});

// tests/longhaul-run.test.js
// `longhaul run` for stage B0 (benchmark spec §8 steps 1, 2 and 5; §11; §15):
// evidence recall per question, exactly computable from fake adapters.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runBenchmark } = require('../src/longhaul/run');
const { evidenceRecall, chunkEvidenceRecall, percentile, summarize } = require('../src/longhaul/scoring');
const { exitCodeFor } = require('../src/longhaul/commands/run');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { readQuestions, writeQuestions, questionsFile } = require('../src/longhaul/questions');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink, FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

function fakeAdapter(name, pick) {
  return {
    name,
    describe: () => ({ name }),
    prepare: async (session) => ({ session }),
    context: async (handle, { question, askAtSeq }) => ({
      text: 'x'.repeat(40), evidenceSeqsShown: pick(question, askAtSeq), estTokens: 10, latencyMs: 2, cpuMs: 1, cost: 0
    }),
    release: async () => {}
  };
}
// Shows the first evidence message and the message just before the question.
const firstEvidence = fakeAdapter('first-evidence', (q, at) => [...q.evidenceSeqs.slice(0, 1), at - 1]);
const fixedNow = () => new Date('2026-09-29T10:15:00.000Z');

function setup() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
  return home;
}
const readRecords = (dir) => fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('scoring', () => {
  it('computes evidence recall per question', () => {
    assert.strictEqual(evidenceRecall([4, 9], [1, 4]), 0.5);
    assert.strictEqual(evidenceRecall([4], []), 0);
    assert.strictEqual(evidenceRecall([], [1]), null);
  });

  it('computes chunk evidence recall from the tail and the recalled chunks', () => {
    assert.strictEqual(chunkEvidenceRecall([4, 9], { tailSeqs: [9], shownBySeq: { 4: 1 }, totalBySeq: { 4: 4 } }), 0.625);
    assert.strictEqual(chunkEvidenceRecall([4], { tailSeqs: [], shownBySeq: {}, totalBySeq: {} }), 0);
    assert.strictEqual(chunkEvidenceRecall([4], undefined), null);
    assert.strictEqual(chunkEvidenceRecall([], { tailSeqs: [] }), null);
  });

  it('takes nearest-rank percentiles', () => {
    assert.strictEqual(percentile([5, 1, 3, 2, 4], 0.5), 3);
    assert.strictEqual(percentile([5, 1, 3, 2, 4], 0.9), 5);
    assert.strictEqual(percentile([], 0.5), null);
  });

  it('summarizes by kind and bucket, leaving errors and abstain out of the rates', () => {
    const r = (kind, bucket, er, extra = {}) => ({ adapter: 'a', kind, bucket, evidenceRecall: er, chunkEvidenceRecall: null, estTokens: 100, latencyMs: 1, cpuMs: 1, leaked: 0, error: null, ...extra });
    const s = summarize([
      r('user-said', '<10K', 1), r('user-said', '10K-50K', 0), r('superseded', '<10K', 0.5),
      r('abstain', 'none', null), r('decision', '<10K', null, { error: 'boom', estTokens: null })
    ]).a;
    assert.strictEqual(s.questions, 5);
    assert.strictEqual(s.errors, 1);
    assert.strictEqual(s.scored, 3);
    assert.strictEqual(s.abstain, 1);
    assert.strictEqual(s.evidenceRecall, 0.5);
    assert.deepStrictEqual(s.byKind, { 'user-said': { n: 2, evidenceRecall: 0.5 }, superseded: { n: 1, evidenceRecall: 0.5 } });
    assert.deepStrictEqual(s.byBucket, { '<10K': { n: 2, evidenceRecall: 0.75 }, '10K-50K': { n: 1, evidenceRecall: 0 } });
    assert.deepStrictEqual(s.estTokens, { median: 100, p90: 100, max: 100 });
    assert.strictEqual(s.chunkEvidenceRecall, null);
  });
});

describe('runBenchmark', () => {
  it('writes config, per-question records and an exactly computable summary', async () => {
    const home = setup();
    const out = await runBenchmark({ home, adapters: [firstEvidence], budgetTokens: 6000, seed: 7, now: fixedNow, commit: 'abc123' });
    assert.match(out.runId, /^20260929T101500Z-[0-9a-f]{4}$/);
    const config = JSON.parse(fs.readFileSync(path.join(out.dir, 'config.json'), 'utf8'));
    assert.strictEqual(config.metric, 'evidence recall');
    assert.strictEqual(config.commit, 'abc123');
    assert.strictEqual(config.budgetTokens, 6000);
    assert.strictEqual(config.seed, 7);
    assert.strictEqual(config.includeUnverified, false);
    assert.strictEqual(config.dataRoot, '$LONGHAUL_HOME');
    assert.deepStrictEqual(config.adapters, [{ name: 'first-evidence' }]);
    assert.strictEqual(config.sessions[0].sessionId, 'synth-small');
    assert.match(config.sessions[0].questionsSha256, /^[0-9a-f]{64}$/);

    const records = readRecords(out.dir);
    assert.strictEqual(records.length, 6);
    // user-said, tool-observed, decision: 1 each; superseded, multi-hop: 1 of 2; abstain: not scored.
    const s = JSON.parse(fs.readFileSync(path.join(out.dir, 'summary.json'), 'utf8'))['first-evidence'];
    assert.strictEqual(s.scored, 5);
    assert.strictEqual(s.abstain, 1);
    assert.strictEqual(s.evidenceRecall, 0.8);
    assert.deepStrictEqual(s.byKind.superseded, { n: 1, evidenceRecall: 0.5 });
    assert.strictEqual(s.leaks, 0);
    assert.match(fs.readFileSync(path.join(out.dir, 'summary.md'), 'utf8'), /\| first-evidence \| 6 \| 5 \| 0 \| 0\.800 \|/);

    const questions = await readQuestions(questionsFile(home.root, 'synth-small'));
    const raw = fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf8');
    for (const q of questions) assert.ok(!raw.includes(q.question), 'records carry ids and numbers, never text');
  });

  it('refuses a question set that fails validation, naming the question, and writes no run', async () => {
    const home = setup();
    const file = questionsFile(home.root, 'synth-small');
    const questions = await readQuestions(file);
    questions[0] = { ...questions[0], evidenceSeqs: [questions[0].askAtSeq] };
    writeQuestions(file, questions);
    await assert.rejects(
      runBenchmark({ home, adapters: [firstEvidence], now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.message.includes(`${questions[0].id}: evidence-after-ask`)
    );
    assert.deepStrictEqual(fs.readdirSync(home.runs), []);
  });

  it('counts only verified questions unless --include-unverified, which marks the run', async () => {
    const home = setup();
    const file = questionsFile(home.root, 'synth-small');
    const questions = await readQuestions(file);
    questions[1] = { ...questions[1], verifiedBy: null };
    writeQuestions(file, questions);
    const verifiedOnly = await runBenchmark({ home, adapters: [firstEvidence], now: fixedNow, commit: 'x' });
    assert.strictEqual(verifiedOnly.records.length, 5);
    const all = await runBenchmark({ home, adapters: [firstEvidence], includeUnverified: true, now: fixedNow, commit: 'x' });
    assert.strictEqual(all.records.length, 6);
    assert.strictEqual(all.config.includeUnverified, true);
    assert.strictEqual(all.records.find((r) => r.questionId === questions[1].id).verified, false);
    assert.match(fs.readFileSync(path.join(all.dir, 'summary.md'), 'utf8'), /UNVERIFIED QUESTIONS INCLUDED/);
  });

  it('refuses a run with no verified questions', async () => {
    const home = setup();
    const file = questionsFile(home.root, 'synth-small');
    writeQuestions(file, (await readQuestions(file)).map((q) => ({ ...q, verifiedBy: null })));
    await assert.rejects(runBenchmark({ home, adapters: [firstEvidence], now: fixedNow, commit: 'x' }), /--include-unverified/);
  });

  it('counts every shown seq at or after askAtSeq as a leak, and the CLI exits 1', async () => {
    const home = setup();
    const out = await runBenchmark({ home, adapters: [fakeAdapter('leaky', (q, at) => [at - 1, at])], now: fixedNow, commit: 'x' });
    assert.strictEqual(out.leaks, 6);
    assert.strictEqual(out.summary.leaky.leaks, 6);
    const stderr = sink();
    assert.strictEqual(exitCodeFor(out, stderr), 1);
    assert.match(stderr.text, /LEAK/);
  });

  it('records an adapter error for one question and leaves it out of the rates', async () => {
    const flaky = fakeAdapter('flaky', (q, at) => {
      if (q.kind === 'decision') throw new Error('boom');
      return [...q.evidenceSeqs, at - 1];
    });
    const out = await runBenchmark({ home: setup(), adapters: [flaky], now: fixedNow, commit: 'x' });
    const s = out.summary.flaky;
    assert.strictEqual(s.errors, 1);
    assert.strictEqual(s.scored, 4);
    assert.strictEqual(s.evidenceRecall, 1);
    assert.strictEqual(out.records.find((r) => r.kind === 'decision').error, 'boom');
  });
});

describe('longhaul run CLI', () => {
  it('refuses bad options with exit 2', async () => {
    const { env } = tmpHome();
    const io = () => ({ stdout: sink(), stderr: sink(), env });
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'full-history'], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle', '--budget-tokens', '0'], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle', '--session', 'nope'], io()), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'kl-recall', '--recall', 'noEquals'], io()), 2);
  });
});

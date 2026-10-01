// tests/longhaul-report.test.js
// `longhaul report` (benchmark spec §8, §10.1, §11, §14, B-D8): the paper's
// tables from run records, aggregate numbers only, byte-identical when
// regenerated, and --public refused for a run with a private session.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { writeReport, buildReport, loadRun, seriesOf } = require('../src/longhaul/report');
const { spotCheckFile } = require('../src/longhaul/answer-stage');
const { scoreVerdict } = require('../src/longhaul/judge');
const { stableStringify } = require('../src/longhaul/model-cache');
const { writeFileAtomic, sha256Text } = require('../src/longhaul/files');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { main } = require('../src/longhaul/cli');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const RUN_A = '20260930T100000Z-aaaa';
const RUN_B = '20260930T110000Z-bbbb';

function rec(runId, adapter, n, kind, verdict) {
  const abstain = kind === 'abstain';
  return {
    runId, sessionId: 'S1', questionId: `S1-q${n}`, adapter, kind, bucket: abstain ? 'none' : '<10K', askAtSeq: 10 + n,
    evidenceSeqs: abstain ? [] : [2], verified: true, evidenceSeqsShown: [], evidenceSeqsPartial: [],
    evidenceRecall: abstain ? null : 1, evidencePartial: 0, answerContained: abstain ? null : true, answerTokensContained: abstain ? null : true,
    chunkEvidenceRecall: null, estTokens: 1000, latencyMs: 5, cpuMs: 1, cost: 0, contextTruncated: false, leaked: 0, error: null, tier: 'grid',
    verdict, ...scoreVerdict({ kind }, verdict), answerError: null,
    answerCached: false, answerInputTokens: 1200, answerOutputTokens: 20, answerCostUsd: 0.01, answerLatencyMs: 100,
    judgeCached: false, judgeInputTokens: 400, judgeOutputTokens: 30, judgeCostUsd: 0.002
  };
}
const ADAPTERS = [
  { name: 'kl-recall', recall: { bm25TopK: 200, completeMessageTokens: 0 } },
  { name: 'kl-recall-whole', recall: { bm25TopK: 200, completeMessageTokens: 800 } }
];
const config = (runId, isPrivate) => ({
  runId, stage: 'B3', commit: 'abcdef1234567890', budgetTokens: 6000, seed: 1, adapters: ADAPTERS,
  sessions: [{ sessionId: 'S1', private: isPrivate, license: isPrivate ? 'private' : 'CC-BY-4.0', questions: 4 }],
  answer: {
    tier: 'grid', answerModel: { provider: 'openai', model: 'gpt-6-lite', maxTokens: 400 }, judgeModel: { provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 200 },
    prompts: { answer: { file: 'answer-v1.md', sha256: 'a'.repeat(64) }, judge: { file: 'judge-v1.md', sha256: 'b'.repeat(64) } }
  }
});
function writeRun(home, runId, cfg, records) {
  const dir = path.join(home.runs, runId);
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(cfg)}\n`);
  writeFileAtomic(path.join(dir, 'records.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}
function setup() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeRun(home, RUN_A, config(RUN_A, true), [
    rec(RUN_A, 'kl-recall', 1, 'user-said', 'correct'), rec(RUN_A, 'kl-recall', 2, 'user-said', 'incorrect'),
    rec(RUN_A, 'kl-recall', 3, 'decision', 'correct'), rec(RUN_A, 'kl-recall', 4, 'abstain', 'abstained'),
    rec(RUN_A, 'kl-recall-whole', 1, 'user-said', 'correct'), rec(RUN_A, 'kl-recall-whole', 2, 'user-said', 'correct'),
    rec(RUN_A, 'kl-recall-whole', 3, 'decision', 'incorrect'), rec(RUN_A, 'kl-recall-whole', 4, 'abstain', 'abstained')
  ]);
  return { env, home };
}
const cfg = (d) => sha256Text(stableStringify(d)).slice(0, 8);
const SETUP = sha256Text(stableStringify({
  commit: 'abcdef1234567890', answerMaxTokens: 400, judgeMaxTokens: 200,
  prompts: { answer: 'a'.repeat(64), judge: 'b'.repeat(64), judgeRules: null, summarize: null }
})).slice(0, 8);
const COHORT = `grid openai/gpt-6-lite judge:anthropic/claude-haiku-4-5 commit:abcdef123456 setup:${SETUP}`;
const KL = `kl-recall cfg:${cfg(ADAPTERS[0])} @ ${COHORT}`;
const WHOLE = `kl-recall-whole cfg:${cfg(ADAPTERS[1])} @ ${COHORT}`;
const readAll = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

describe('longhaul report', () => {
  it('writes the per-adapter table with accuracy, abstain accuracy and cost per point of accuracy', () => {
    const { home } = setup();
    const out = writeReport(home, [RUN_A]);
    assert.match(out.id, /^r-[0-9a-f]{12}$/);
    assert.deepStrictEqual(out.files, ['accuracy-vs-tokens.csv', 'adapters.csv', 'adapters.tex', 'by-distance.csv', 'by-kind.csv', 'by-session.csv', 'comparisons.csv', 'report.md']);
    const files = readAll(out.dir);
    const rows = files['adapters.csv'].trim().split('\n');
    assert.strictEqual(rows[0], 'series,questions,evidence_recall,answer_contained,answer_n,answer_accuracy,partial_rate,declined_rate,abstain_n,abstain_accuracy,false_answer_rate,answer_errors,contexts_cut,median_context_tokens,p90_context_tokens,median_answer_input_tokens,cost_usd,cost_unknown_calls,cost_per_accuracy_point_usd,median_context_ms,p90_context_ms,median_answer_ms,p90_answer_ms');
    // 2 of 3 answerable right; 4 answers at $0.01 and 4 judgments at $0.002 = $0.048; $0.048 / 66.7 points.
    assert.strictEqual(rows[1], `${KL},4,1.000,1.000,3,0.667,0.000,0.000,1,1.000,0.000,0,0,1000,1000,1200,0.0480,0,0.00072,5.0,5.0,100.0,100.0`);
    assert.strictEqual(files['comparisons.csv'].trim().split('\n')[1], `whole-messages,${KL},${WHOLE},4,4,0.750,0.750,0.000,1,1,1.000,1.000,1.000,1.000`);
    assert.ok(files['by-kind.csv'].includes(`${KL},abstain,0,,,1,1.000`));
    assert.match(files['report.md'], /## Per adapter/);
    assert.match(files['adapters.tex'], /\\begin\{tabular\}/);
  });

  it('carries aggregate numbers only: no question ids or text', () => {
    const { home } = setup();
    const files = readAll(writeReport(home, [RUN_A]).dir);
    for (const [name, text] of Object.entries(files)) assert.ok(!text.includes('S1-q'), `${name} names no question`);
  });

  it('regenerates byte-identical files from the same runs', () => {
    const { home } = setup();
    const first = readAll(writeReport(home, [RUN_A]).dir);
    const again = readAll(writeReport(home, [RUN_A]).dir);
    assert.deepStrictEqual(again, first);
  });

  it('counts the latest run when several answer the same question for one series, but never lets a failure replace a success', () => {
    const { home } = setup();
    writeRun(home, RUN_B, config(RUN_B, true), [
      rec(RUN_B, 'kl-recall', 2, 'user-said', 'correct'),
      // A later failed judgment of q1, which RUN_A judged correct: RUN_A's record stands.
      { ...rec(RUN_B, 'kl-recall', 1, 'user-said', 'correct'), verdict: null, answerCorrect: null, answerError: 'answer-failed:500' }
    ]);
    const built = buildReport([RUN_B, RUN_A].map((r) => loadRun(home, r)));
    assert.strictEqual(built.summary[KL].answer.accuracy, 1);
    assert.strictEqual(built.summary[KL].answer.errors, 0);
    assert.strictEqual(built.summary[KL].questions, 4);
  });

  it('shows the judge spot-check agreement per run', () => {
    const { home } = setup();
    const row = (verdict, humanVerdict) => ({ questionId: 'x', verdict, humanVerdict });
    writeFileAtomic(spotCheckFile(home, RUN_A), `${[row('correct', 'correct'), row('correct', null)].map((r) => JSON.stringify(r)).join('\n')}\n`);
    assert.match(readAll(writeReport(home, [RUN_A]).dir)['report.md'], /1\/1 agreed \(2 sampled\)/);
  });

  it('with --public, refuses a run with a private session before writing anything', () => {
    const { home } = setup();
    assert.throws(() => writeReport(home, [RUN_A], { publicOnly: true }), (err) => err instanceof UsageError && err.code === 'PRIVATE_IN_PUBLIC');
    assert.deepStrictEqual(fs.readdirSync(home.reports), []);
  });

  it('names a series by adapter, its config, tier, answer model, judge model and commit, and keeps evidence-only runs apart', () => {
    const base = config(RUN_A, false);
    assert.strictEqual(seriesOf(base, 'kl-recall'), KL);
    assert.strictEqual(seriesOf(base, 'oracle'), `oracle cfg:unknown @ ${COHORT}`);
    const other = (patch) => seriesOf({ ...base, ...patch }, 'kl-recall');
    assert.notStrictEqual(other({ answer: { ...base.answer, judgeModel: { provider: 'openai', model: 'gpt-6-flex' } } }), KL);
    assert.notStrictEqual(other({ commit: '0123456789abcdef' }), KL);
    assert.notStrictEqual(other({ adapters: [{ ...ADAPTERS[0], recall: { bm25TopK: 100 } }] }), KL);
    assert.notStrictEqual(other({ answer: { ...base.answer, tier: 'frontier' } }), KL);
    const b0 = { stage: 'B0', commit: 'c0ffee', adapters: [{ name: 'oracle' }] };
    assert.strictEqual(seriesOf(b0, 'oracle'), `oracle cfg:${cfg({ name: 'oracle' })} @ evidence-only commit:c0ffee setup:${sha256Text(stableStringify({ commit: 'c0ffee' })).slice(0, 8)}`);
  });

  it('keeps apart runs whose max tokens, prompts or full commit differ (review Important 3)', () => {
    const base = config(RUN_A, false);
    const other = (patch) => seriesOf({ ...base, ...patch }, 'kl-recall');
    const answer = (patch) => other({ answer: { ...base.answer, ...patch } });
    assert.notStrictEqual(answer({ answerModel: { ...base.answer.answerModel, maxTokens: 100 } }), KL);
    assert.notStrictEqual(answer({ judgeModel: { ...base.answer.judgeModel, maxTokens: 100 } }), KL);
    assert.notStrictEqual(answer({ prompts: { ...base.answer.prompts, answer: { sha256: 'c'.repeat(64) } } }), KL);
    assert.notStrictEqual(answer({ prompts: { ...base.answer.prompts, judge: { sha256: 'b'.repeat(64), rulesSha256: 'd'.repeat(64) } } }), KL);
    assert.notStrictEqual(answer({ prompts: { ...base.answer.prompts, summarize: { sha256: 'e'.repeat(64) } } }), KL);
    // Same first 12 hex, another commit; and the same commit with a dirty tree.
    assert.notStrictEqual(other({ commit: 'abcdef1234567891' }), KL);
    const dirty = other({ commit: 'abcdef1234567890-dirty' });
    assert.notStrictEqual(dirty, KL);
    assert.match(dirty, /commit:abcdef123456-dirty setup:[0-9a-f]{8}$/);
  });

  it('never merges two runs that differ only in answer max tokens', () => {
    const { home } = setup();
    const cfgB = config(RUN_B, true);
    cfgB.answer.answerModel.maxTokens = 100;
    writeRun(home, RUN_B, cfgB, [rec(RUN_B, 'kl-recall', 2, 'user-said', 'correct')]);
    const built = buildReport([RUN_A, RUN_B].map((r) => loadRun(home, r)));
    assert.strictEqual(built.summary[KL].answer.accuracy, 2 / 3, 'RUN_A keeps its own series');
    assert.strictEqual(built.series.length, 3);
  });

  it('runs from the CLI, and refuses an unknown run or a bad id', async () => {
    const { env } = setup();
    const io = () => ({ stdout: sink(), stderr: sink(), env });
    const ok = io();
    assert.strictEqual(await main(['report', '--runs', RUN_A, '--id', 'b3-test'], ok), 0, ok.stderr.text);
    assert.match(ok.stdout.text, /report b3-test/);
    assert.strictEqual(await main(['report', '--runs', '20260930T120000Z-cccc'], io()), 2);
    assert.strictEqual(await main(['report', '--runs', RUN_A, '--id', '../x'], io()), 2);
    assert.strictEqual(await main(['report'], io()), 2);
  });
});

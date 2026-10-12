// tests/longhaul-floor.test.js
// The floor check (benchmark spec §7, §8 addendum 2026-10-12): the
// no-context adapter shows nothing from the session; an answerable question
// judged correct under it is flagged answerableWithoutEvidence; the summary
// and the report give answer accuracy over all answerable questions and with
// the flagged ones left out; the report bands questions by how many adapters
// got them right. A run without no-context reports none of it.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runBenchmark } = require('../src/longhaul/run');
const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { NO_CONTEXT } = require('../src/longhaul/adapters/no-context');
const { summarize, renderSummaryMarkdown, floorFrom, stampFloor, difficultyBands } = require('../src/longhaul/scoring');
const { writeReport, buildReport, loadRun } = require('../src/longhaul/report');
const { NOTHING_SHOWN } = require('../src/longhaul/answer');
const { scoreVerdict } = require('../src/longhaul/judge');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { loadSession } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { writeFileAtomic } = require('../src/longhaul/files');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { REPO, FIXTURE_ROOT, tmpHome } = require('./helpers/longhaul-helpers');

function rec(adapter, n, kind, verdict, extra = {}) {
  const abstain = kind === 'abstain';
  return {
    runId: 'r', sessionId: 'S1', questionId: `S1-q${n}`, adapter, kind, bucket: abstain ? 'none' : '<10K', askAtSeq: 10 + n,
    evidenceSeqs: abstain ? [] : [2], verified: true, evidenceSeqsShown: [], evidenceSeqsPartial: [],
    evidenceRecall: abstain ? null : (adapter === NO_CONTEXT ? 0 : 1), evidencePartial: 0,
    answerContained: abstain ? null : adapter !== NO_CONTEXT, answerTokensContained: abstain ? null : adapter !== NO_CONTEXT,
    chunkEvidenceRecall: null, estTokens: adapter === NO_CONTEXT ? 0 : 1000, latencyMs: 5, cpuMs: 1, cost: 0, contextTruncated: null, leaked: 0, error: null, tier: 'grid',
    verdict, ...(verdict ? scoreVerdict({ kind }, verdict) : { answerCorrect: null, abstainCorrect: null }), answerError: null,
    answerCached: false, answerInputTokens: 1200, answerOutputTokens: 20, answerCostUsd: 0.01, answerLatencyMs: 100,
    judgeCached: false, judgeInputTokens: 400, judgeOutputTokens: 30, judgeCostUsd: 0.002,
    ...extra
  };
}

// Five answerable questions and one abstain. no-context gets q1 right (a
// guessable question), declines q2..q4, fails on q5 (not checked), and
// answers the abstain question q6 (a false answer, never a flag).
//            q1        q2         q3          q4          q5         q6 (abstain)
// no-context correct   abstained  abstained   abstained   (error)    incorrect
// kl-recall  correct   correct    incorrect   incorrect   correct    abstained
// sliding    correct   correct    correct     incorrect   incorrect  abstained
// oracle     correct   correct    correct     correct     correct    abstained
const row = (adapter, verdicts) => verdicts.map((v, i) => rec(adapter, i + 1, i === 5 ? 'abstain' : 'user-said', v, v ? {} : { answerError: 'answer-failed:500' }));
const HAND = [
  ...row(NO_CONTEXT, ['correct', 'abstained', 'abstained', 'abstained', null, 'incorrect']),
  ...row('kl-recall', ['correct', 'correct', 'incorrect', 'incorrect', 'correct', 'abstained']),
  ...row('sliding-window', ['correct', 'correct', 'correct', 'incorrect', 'incorrect', 'abstained']),
  ...row('oracle', ['correct', 'correct', 'correct', 'correct', 'correct', 'abstained'])
];
const withoutFloor = HAND.filter((r) => r.adapter !== NO_CONTEXT);
const copy = (records) => records.map((r) => ({ ...r }));

describe('no-context adapter', () => {
  it('is registered and shows nothing from the session: no text, no seqs, no tokens', async () => {
    assert.ok(adapterNames().includes('no-context'));
    assert.strictEqual(NO_CONTEXT, 'no-context');
    const adapter = createAdapter('no-context', { budgetTokens: 6000, tmpRoot: 'unused' });
    assert.deepStrictEqual(adapter.describe(), { name: 'no-context' });
    assert.ok(!adapter.usesModel && !adapter.frontierOnly && !adapter.longContext);
    for (const { sessionId: id } of SYNTH_FIXTURES) {
      const session = await loadSession(path.join(FIXTURE_ROOT, 'sessions', id));
      const questions = await readQuestions(questionsFile(FIXTURE_ROOT, id));
      const handle = await adapter.prepare(session, { upToSeq: session.index.maxSeq });
      for (const q of questions) {
        const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq, budgetTokens: 6000 });
        assert.strictEqual(r.text, '');
        assert.deepStrictEqual(r.evidenceSeqsShown, []);
        assert.deepStrictEqual(r.evidenceSeqsPartial, []);
        assert.strictEqual(r.estTokens, 0);
        assert.strictEqual(r.cost, 0);
        assert.ok(Number.isFinite(r.latencyMs) && Number.isFinite(r.cpuMs));
      }
      await adapter.release(handle);
    }
  });

  it('scores evidence recall 0 and never leaks in an evidence-only run', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    const out = await runBenchmark({ home, dataRoot: FIXTURE_ROOT, adapterNames: ['no-context', 'oracle'], includeUnverified: true, commit: 'abc' });
    const s = out.summary['no-context'];
    assert.strictEqual(s.evidenceRecall, 0);
    assert.strictEqual(s.answerContainment, 0);
    assert.strictEqual(s.leaks, 0);
    assert.strictEqual(s.errors, 0);
    assert.strictEqual(s.estTokens.max, 0);
    assert.strictEqual(s.questions, out.summary.oracle.questions);
    assert.strictEqual(out.summary.oracle.evidenceRecall, 1);
    assert.strictEqual(out.leaks, 0);
    assert.ok(out.records.every((r) => !('answerableWithoutEvidence' in r)), 'no flag without an answer stage');
    assert.ok(!fs.readFileSync(path.join(out.dir, 'summary.md'), 'utf8').includes('Floor check'));
  });
});

describe('floor flag', () => {
  it('flags only an answerable question judged correct under no-context', () => {
    const floor = floorFrom(HAND.filter((r) => r.adapter === NO_CONTEXT));
    assert.deepStrictEqual([...floor.flagged], ['S1\u0000S1-q1']);
    assert.strictEqual(floor.checked.size, 5, 'q5 has no verdict: not checked');
    assert.strictEqual(floorFrom([]), null);
    assert.strictEqual(floorFrom(HAND.filter((r) => r.adapter === 'oracle').map((r) => ({ ...r, verdict: null }))), null, 'no verdict, no floor');

    const stamped = stampFloor(copy(HAND));
    const flag = (adapter, n) => stamped.find((r) => r.adapter === adapter && r.questionId === `S1-q${n}`).answerableWithoutEvidence;
    for (const adapter of [NO_CONTEXT, 'kl-recall', 'sliding-window', 'oracle']) {
      assert.strictEqual(flag(adapter, 1), true);
      assert.strictEqual(flag(adapter, 2), false);
      assert.strictEqual(flag(adapter, 5), null, 'no-context has no verdict for it: not known');
      assert.strictEqual(flag(adapter, 6), false, 'an abstain question is never flagged, whatever no-context replied');
    }
    assert.strictEqual(stamped.length, HAND.length, 'flagged questions stay in the records');
  });

  it('leaves records alone when no-context did not run', () => {
    const stamped = stampFloor(copy(withoutFloor));
    assert.ok(stamped.every((r) => !('answerableWithoutEvidence' in r)));
  });

  it('gives accuracy over all answerable questions and with the flagged ones left out', () => {
    const s = summarize(HAND);
    // The existing figures are unchanged by the floor.
    const plain = summarize(withoutFloor);
    for (const name of ['kl-recall', 'sliding-window', 'oracle']) {
      const { floor, ...rest } = s[name].answer;
      assert.deepStrictEqual(rest, plain[name].answer);
      assert.ok(!('floor' in plain[name].answer), 'no floor key without no-context');
      assert.ok(floor);
    }
    assert.strictEqual(s['kl-recall'].answer.n, 5);
    assert.strictEqual(s['kl-recall'].answer.accuracy, 3 / 5);
    assert.deepStrictEqual(s['kl-recall'].answer.floor, { flagged: 1, n: 4, accuracy: 2 / 4, unchecked: 1 });
    assert.strictEqual(s['sliding-window'].answer.accuracy, 3 / 5);
    assert.deepStrictEqual(s['sliding-window'].answer.floor, { flagged: 1, n: 4, accuracy: 2 / 4, unchecked: 1 });
    assert.deepStrictEqual(s.oracle.answer.floor, { flagged: 1, n: 4, accuracy: 1, unchecked: 1 });
    // no-context itself: 1 of its 4 judged answerable questions; none left right.
    assert.strictEqual(s[NO_CONTEXT].answer.accuracy, 1 / 4);
    assert.deepStrictEqual(s[NO_CONTEXT].answer.floor, { flagged: 1, n: 3, accuracy: 0, unchecked: 0 });
    assert.deepStrictEqual(s[NO_CONTEXT].answer.abstain, { n: 1, accuracy: 0, falseAnswerRate: 1 });
  });

  it('prints the floor check in the run summary only when no-context ran', () => {
    const config = {
      runId: 'r', budgetTokens: 6000, seed: 1, commit: 'abc', sessions: [{ sessionId: 'S1', private: false, license: 'CC0', questions: 6 }],
      answer: {
        tier: 'grid', answerModel: { provider: 'openai', model: 'gpt-6-lite' }, judgeModel: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        prompts: { answer: { sha256: 'a'.repeat(64) }, judge: { sha256: 'b'.repeat(64) } }
      }
    };
    const md = renderSummaryMarkdown(config, summarize(HAND));
    assert.match(md, /## Floor check \(no-context\)/);
    assert.ok(md.includes('1 of 4 answerable questions'), md);
    assert.ok(md.includes('| Adapter | Flagged | Accuracy, all answerable (n) | Accuracy, flagged left out (n) | Not checked |'));
    assert.ok(md.includes('| kl-recall | 1 | 0.600 (n=5) | 0.500 (n=4) | 1 |'));
    assert.ok(md.includes('| oracle | 1 | 1.000 (n=5) | 1.000 (n=4) | 1 |'));
    // Everything above the floor check is the same with and without no-context's rows.
    const rows = (text) => text.slice(0, text.includes('## Floor check') ? text.indexOf('## Floor check') : undefined)
      .split('\n').filter((l) => l.startsWith('| kl-recall |'));
    const plain = renderSummaryMarkdown(config, summarize(withoutFloor));
    assert.ok(!plain.includes('Floor check'));
    assert.deepStrictEqual(rows(md), rows(plain));
  });
});

describe('difficulty bands', () => {
  it('bands answerable questions by the adapters other than oracle, no-context and full-history', () => {
    const extra = row('full-history', ['correct', 'correct', 'correct', 'correct', 'correct', 'abstained']);
    // kl-recall and sliding-window: q1 both, q2 both, q3 one, q4 none, q5 one; q6 is abstain.
    assert.deepStrictEqual(difficultyBands([...HAND, ...extra]), { adapters: 2, questions: 5, none: 1, some: 2, all: 2 });
    assert.strictEqual(difficultyBands(HAND.filter((r) => r.adapter === 'oracle' || r.adapter === NO_CONTEXT)), null, 'no adapter to band by');
    // A question an adapter has no verdict for is banded by the ones that judged it.
    const partial = HAND.map((r) => (r.adapter === 'kl-recall' && r.questionId === 'S1-q3' ? { ...r, verdict: null, answerError: 'judge-unparsed' } : r));
    assert.deepStrictEqual(difficultyBands(partial), { adapters: 2, questions: 5, none: 1, some: 1, all: 3 });
    // The adapter's own name, not the series name, decides who is left out.
    const series = HAND.map((r) => ({ ...r, base: r.adapter, adapter: `${r.adapter} cfg:x` }));
    assert.deepStrictEqual(difficultyBands(series, (r) => r.base), { adapters: 2, questions: 5, none: 1, some: 2, all: 2 });
  });
});

describe('floor check in the report', () => {
  const RUN_A = '20261012T100000Z-aaaa';
  const RUN_OLD = '20260930T100000Z-0001';
  const names = [NO_CONTEXT, 'kl-recall', 'sliding-window', 'oracle'];
  const config = (runId, adapters, commit = 'abcdef1234567890') => ({
    runId, stage: 'B3', commit, budgetTokens: 6000, seed: 1, adapters: adapters.map((name) => ({ name })),
    sessions: [{ sessionId: 'S1', private: false, license: 'CC-BY-4.0', questions: 6 }],
    answer: {
      tier: 'grid', answerModel: { provider: 'openai', model: 'gpt-6-lite', maxTokens: 400 }, judgeModel: { provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 200 },
      prompts: { answer: { file: 'answer-v1.md', sha256: 'a'.repeat(64) }, judge: { file: 'judge-v1.md', sha256: 'b'.repeat(64) } }
    }
  });
  function writeRun(home, runId, cfg, records) {
    const dir = path.join(home.runs, runId);
    writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(cfg)}\n`);
    writeFileAtomic(path.join(dir, 'records.jsonl'), records.map((r) => `${JSON.stringify({ ...r, runId })}\n`).join(''));
  }
  const newHome = () => ensureDirs(resolveHome(tmpHome().env));
  const readAll = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const seriesFor = (built, name) => built.series.find((s) => s.startsWith(`${name} cfg:`));

  it('shows the flagged count, both accuracies and the bands, aggregate only', () => {
    const home = newHome();
    writeRun(home, RUN_A, config(RUN_A, names), stampFloor(copy(HAND)));
    const built = buildReport([loadRun(home, RUN_A)]);
    const kl = seriesFor(built, 'kl-recall');
    assert.strictEqual(built.summary[kl].answer.accuracy, 3 / 5, 'the headline number is unchanged');
    assert.deepStrictEqual(built.summary[kl].answer.floor, { flagged: 1, n: 4, accuracy: 0.5, unchecked: 1 });
    assert.strictEqual(built.bands.length, 1);
    assert.deepStrictEqual(built.bands[0].bands, { adapters: 2, questions: 5, none: 1, some: 2, all: 2 });

    const out = writeReport(home, [RUN_A], { publicOnly: true });
    assert.ok(out.files.includes('floor-check.csv') && out.files.includes('difficulty-bands.csv'));
    const files = readAll(out.dir);
    const floorRows = files['floor-check.csv'].trim().split('\n');
    assert.strictEqual(floorRows[0], 'series,answerable_without_evidence,answer_n,answer_accuracy,answer_n_flagged_left_out,answer_accuracy_flagged_left_out,not_checked');
    assert.ok(floorRows.includes(`${kl},1,5,0.600,4,0.500,1`));
    assert.ok(floorRows.includes(`${seriesFor(built, NO_CONTEXT)},1,4,0.250,3,0.000,0`));
    assert.strictEqual(floorRows.length, 5);
    const bandRows = files['difficulty-bands.csv'].trim().split('\n');
    assert.strictEqual(bandRows[0], 'cohort,series_counted,questions,none,some,all');
    assert.match(bandRows[1], /,2,5,1,2,2$/);
    const md = files['report.md'];
    assert.match(md, /## Floor check \(no-context\)/);
    assert.ok(md.includes(`| ${kl} | 1 | 0.600 (5) | 0.500 (4) | 1 |`), md);
    assert.match(md, /## Difficulty bands/);
    assert.match(md, /\| 2 \| 5 \| 1 \| 2 \| 2 \|/);
    assert.ok(md.includes('Reported, not scored: answer containment'), 'says which columns are scored');
    for (const [name, text] of Object.entries(files)) assert.ok(!text.includes('S1-q'), `${name} names no question`);
    assert.deepStrictEqual(readAll(writeReport(home, [RUN_A]).dir), files, 'byte-identical when regenerated');
  });

  it('reports an old-shape run with the new columns absent, not zero, beside a run that has them', () => {
    const home = newHome();
    // An older run: no no-context adapter, no answerableWithoutEvidence field, another commit.
    writeRun(home, RUN_OLD, config(RUN_OLD, ['kl-recall', 'oracle'], '0123456789abcdef'), withoutFloor.filter((r) => r.adapter !== 'sliding-window'));
    const alone = buildReport([loadRun(home, RUN_OLD)]);
    const oldKl = seriesFor(alone, 'kl-recall');
    assert.strictEqual(alone.summary[oldKl].answer.accuracy, 3 / 5);
    assert.ok(!('floor' in alone.summary[oldKl].answer));
    const files = readAll(writeReport(home, [RUN_OLD]).dir);
    assert.strictEqual(files['floor-check.csv'].trim().split('\n').length, 1, 'the header alone');
    assert.ok(!files['report.md'].includes('## Floor check'));
    assert.match(files['report.md'], /## Difficulty bands/, 'bands need no no-context');
    assert.match(files['report.md'], /\| 1 \| 5 \| 2 \| 0 \| 3 \|/);

    writeRun(home, RUN_A, config(RUN_A, names), stampFloor(copy(HAND)));
    const both = buildReport([RUN_OLD, RUN_A].map((r) => loadRun(home, r)));
    const olds = both.series.filter((s) => s.includes('commit:0123456789ab'));
    assert.strictEqual(olds.length, 2);
    for (const s of olds) assert.ok(!('floor' in both.summary[s].answer), 'another cohort\'s no-context flags nothing here');
    const mixed = readAll(writeReport(home, [RUN_OLD, RUN_A]).dir);
    const rows = mixed['floor-check.csv'].trim().split('\n');
    assert.strictEqual(rows.length, 5, 'only the four series of the run with no-context');
    assert.ok(rows.every((r) => !r.includes('commit:0123456789ab')));
    assert.ok(mixed['report.md'].includes('not listed'), 'says the older series are absent');
  });

  it('flags across runs of one cohort: no-context run apart from the adapters it checks', () => {
    const home = newHome();
    const RUN_B = '20261012T110000Z-bbbb';
    writeRun(home, RUN_A, config(RUN_A, ['kl-recall']), HAND.filter((r) => r.adapter === 'kl-recall'));
    writeRun(home, RUN_B, config(RUN_B, [NO_CONTEXT]), HAND.filter((r) => r.adapter === NO_CONTEXT));
    const built = buildReport([RUN_A, RUN_B].map((r) => loadRun(home, r)));
    assert.deepStrictEqual(built.summary[seriesFor(built, 'kl-recall')].answer.floor, { flagged: 1, n: 4, accuracy: 0.5, unchecked: 1 });
  });
});

describe('floor check in a run', () => {
  const catalog = fixtureCatalog();
  const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge'), summarize: loadPrompt('summarize') };
  const price = (provider, model, input, output) => catalog.price(provider, model, { input, output }).usd;
  const find = (questions, prompt) => questions.find((q) => prompt.includes(`Question: ${q.question}`));

  it('prices no-context in the plan, sends only the question, and stamps the flag on every record of a flagged question', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
    const questions = await readQuestions(questionsFile(home.root, SYNTH_FIXTURES[0].sessionId));
    const answerable = questions.filter((q) => q.kind !== 'abstain');
    const guessable = answerable[0];
    const seen = [];
    // Answers from the context; the guessable question it answers from nowhere.
    const answerClient = {
      provider: 'openai', model: 'gpt-6-lite',
      async complete(prompt) {
        seen.push(prompt);
        const q = find(questions, prompt);
        const ctx = prompt.slice(prompt.indexOf('<context>'), prompt.indexOf('</context>'));
        const knows = q.kind !== 'abstain' && (q.id === guessable.id || ctx.includes(q.acceptableAnswers[0]));
        const text = knows ? `It is ${q.acceptableAnswers[0]}.` : "I don't know";
        const input = Math.ceil(prompt.length / 4);
        return { text, llmMetrics: { inputTokens: input, outputTokens: 5, costUsd: price('openai', 'gpt-6-lite', input, 5) } };
      }
    };
    const judgeClient = {
      provider: 'anthropic', model: 'claude-haiku-4-5',
      async complete(prompt) {
        const q = find(questions, prompt);
        const reply = prompt.slice(prompt.indexOf('<reply>') + '<reply>'.length, prompt.indexOf('</reply>'));
        const verdict = /I don't know/.test(reply) ? 'abstained' : (q.kind !== 'abstain' && reply.includes(q.acceptableAnswers[0]) ? 'correct' : 'incorrect');
        const input = Math.ceil(prompt.length / 4);
        return { text: JSON.stringify({ verdict, reason: 'fake' }), llmMetrics: { inputTokens: input, outputTokens: 12, costUsd: price('anthropic', 'claude-haiku-4-5', input, 12) } };
      }
    };
    let plan = null;
    const out = await runBenchmark({
      home, adapterNames: ['no-context', 'oracle'], commit: 'abc', now: () => new Date('2026-10-12T10:15:00.000Z'),
      answer: {
        answerClient, judgeClient, prompts, catalog, cache: ModelCache.forHome(home), concurrency: 1, retry: { wait: async () => {} },
        onPlan: (p) => { plan = p; }
      }
    });
    // The plan prices an answer and a judgment for every question of both adapters.
    assert.strictEqual(plan.counts.answers, questions.length * 2);
    assert.strictEqual(plan.counts.judgments, questions.length * 2);
    assert.ok(plan.estimate.totalUsd > 0);
    assert.ok(out.spend.spentUsd <= plan.estimate.totalUsd);
    assert.strictEqual(out.spend.calls, questions.length * 4);

    // What no-context sent: the prompt with nothing in its context.
    const empty = seen.filter((p) => p.includes(`<context>\n${NOTHING_SHOWN}\n</context>`));
    assert.strictEqual(empty.length, questions.length);

    const nc = out.summary['no-context'];
    assert.strictEqual(nc.evidenceRecall, 0);
    assert.strictEqual(nc.leaks, 0);
    assert.strictEqual(nc.answer.n, answerable.length);
    assert.strictEqual(nc.answer.accuracy, 1 / answerable.length);
    assert.strictEqual(nc.answer.abstain.accuracy, 1);
    assert.deepStrictEqual(nc.answer.floor, { flagged: 1, n: answerable.length - 1, accuracy: 0, unchecked: 0 });
    assert.strictEqual(out.summary.oracle.answer.accuracy, 1);
    assert.deepStrictEqual(out.summary.oracle.answer.floor, { flagged: 1, n: answerable.length - 1, accuracy: 1, unchecked: 0 });

    const onDisk = fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(onDisk.length, questions.length * 2, 'flagged questions stay in the records');
    for (const r of onDisk) assert.strictEqual(r.answerableWithoutEvidence, r.questionId === guessable.id, `${r.adapter} ${r.questionId}`);
    assert.match(fs.readFileSync(path.join(out.dir, 'summary.md'), 'utf8'), /## Floor check \(no-context\)/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(out.dir, 'config.json'), 'utf8')).adapters.some((a) => a.name === 'no-context'));
  });
});

describe('floor check from the CLI', () => {
  const run = (root, args) => spawnSync(process.execPath, [path.join('bin', 'longhaul.js'), 'run', '--sessions', path.join('tests', 'fixtures', 'longhaul'), ...args],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, LONGHAUL_HOME: root } });

  it('the evidence-only smoke run passes with no-context added', () => {
    const { root } = tmpHome();
    const out = run(root, ['--adapters', 'sliding-window,oracle,no-context']);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /oracle\s+evidence recall 1\.000/);
    assert.match(out.stdout, /no-context\s+evidence recall 0\.000 .*median 0 tokens .*errors 0 {2}leaks 0/);
    assert.ok(!out.stdout.includes('floor check'));
  });

  it('the --fake-models smoke run passes with no-context added: the fake answer model declines, so nothing is flagged', () => {
    const { root } = tmpHome();
    const out = run(root, ['--adapters', 'sliding-window,oracle,summarize-compact,real-compaction,no-context', '--fake-models']);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /floor check \(no-context\): 0 of \d+ answerable questions flagged answerableWithoutEvidence/);
    const [runId] = fs.readdirSync(path.join(root, 'runs'));
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'summary.json'), 'utf8'));
    assert.strictEqual(summary['no-context'].leaks, 0);
    assert.strictEqual(summary['no-context'].answer.accuracy, 0);
    assert.strictEqual(summary['no-context'].answer.abstain.accuracy, 1);
    for (const s of Object.values(summary)) assert.strictEqual(s.answer.floor.flagged, 0);
    const records = fs.readFileSync(path.join(root, 'runs', runId, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(records.every((r) => r.answerableWithoutEvidence === false));
  });
});

// tests/longhaul-answer-run.test.js
// The answer stage end to end with fake models (benchmark spec §8, §8.1,
// §10, §11, §14, §15): records and summary exactly computable; no text in
// records; a crash resumed without paying twice; a private session refused
// before any call; a plan over the cap refused before any call; the
// estimate not below the spend on the fixtures, judge included; the tiers;
// the long-context cap at the answer model's window; spend.json on disk
// when a run stops; a failing summarizer.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runBenchmark } = require('../src/longhaul/run');
const { createAdapter } = require('../src/longhaul/adapters');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { ModelCache } = require('../src/longhaul/model-cache');
const { loadPrompt } = require('../src/longhaul/prompts');
const { spotCheckFile } = require('../src/longhaul/answer-stage');
const { JUDGE_RULES_SHA256 } = require('../src/longhaul/judge');
const { UsageError } = require('../src/longhaul/errors');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, makePrivate } = require('./helpers/longhaul-helpers');

const catalog = fixtureCatalog();
const prompts = { answer: loadPrompt('answer'), judge: loadPrompt('judge'), summarize: loadPrompt('summarize') };
const fixedNow = () => new Date('2026-09-30T10:15:00.000Z');
const priced = (provider, model, input, output) => catalog.price(provider, model, { input, output }).usd;

function setup(fixtures = [SYNTH_FIXTURES[0]]) {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, fixtures);
  return home;
}
async function allQuestions(home) {
  const out = [];
  for (const id of fs.readdirSync(path.join(home.root, 'sessions'))) out.push(...await readQuestions(questionsFile(home.root, id)));
  return out;
}
// Only the prompt's own "Question: " line names the question: earlier
// questions appear in contexts as plain user messages.
const findQuestion = (questions, prompt) => questions.find((q) => prompt.includes(`Question: ${q.question}`));

// Answers with the planted value when the context holds it, else declines.
// replyChars pads every reply to that length (and reports maxTokens output).
function answerFake(questions, { crashAt = null, replyChars = null } = {}) {
  const seen = [];
  return {
    provider: 'openai', model: 'gpt-6-lite', prompts: seen,
    async complete(prompt, { maxTokens }) {
      seen.push(prompt);
      if (crashAt !== null && seen.length === crashAt) throw Object.assign(new Error('unauthorized'), { status: 401 });
      const q = findQuestion(questions, prompt);
      const ctx = prompt.slice(prompt.indexOf('<context>'), prompt.indexOf('</context>'));
      let text = q && q.kind !== 'abstain' && ctx.includes(q.acceptableAnswers[0]) ? `It is ${q.acceptableAnswers[0]}.` : "I don't know";
      if (replyChars) text = text.padEnd(replyChars, '.');
      const input = Math.ceil(prompt.length / 4);
      const output = replyChars ? maxTokens : 5;
      return { text, llmMetrics: { inputTokens: input, outputTokens: output, costUsd: priced('openai', 'gpt-6-lite', input, output) } };
    }
  };
}

// Correct when the reply holds the planted value, abstained on a decline,
// incorrect otherwise; raw(q) may return a raw reply instead.
function judgeFake(questions, { raw = () => null } = {}) {
  const seen = [];
  return {
    provider: 'anthropic', model: 'claude-haiku-4-5', prompts: seen,
    async complete(prompt) {
      seen.push(prompt);
      const q = findQuestion(questions, prompt);
      const reply = prompt.slice(prompt.indexOf('<reply>') + '<reply>'.length, prompt.indexOf('</reply>'));
      const verdict = /I don't know/.test(reply) ? 'abstained' : (q.kind !== 'abstain' && reply.includes(q.acceptableAnswers[0]) ? 'correct' : 'incorrect');
      const text = raw(q) ?? JSON.stringify({ verdict, reason: 'fake reason' });
      const input = Math.ceil(prompt.length / 4);
      return { text, llmMetrics: { inputTokens: input, outputTokens: 12, costUsd: priced('anthropic', 'claude-haiku-4-5', input, 12) } };
    }
  };
}

// Shows nothing useful: every answerable question is declined.
const blind = {
  name: 'blind',
  describe: () => ({ name: 'blind' }),
  prepare: async (session) => ({ session }),
  context: async () => ({ text: 'nothing relevant here', evidenceSeqsShown: [], evidenceSeqsPartial: [], estTokens: 6, latencyMs: 1, cpuMs: 1, cost: 0 }),
  release: async () => {}
};

function answerOptions(home, questions, over = {}) {
  return {
    answerClient: answerFake(questions), judgeClient: judgeFake(questions), prompts, catalog,
    cache: ModelCache.forHome(home), concurrency: 1, retry: { wait: async () => {} }, ...over
  };
}

describe('answer stage', () => {
  it('answers and judges every context; records carry verdicts and numbers, never text', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions);
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle'), blind], answer: opts, now: fixedNow, commit: 'abc' });
    assert.strictEqual(out.records.length, 12);
    const oracle = out.summary.oracle.answer;
    assert.strictEqual(oracle.accuracy, 1);
    assert.deepStrictEqual(oracle.abstain, { n: 1, accuracy: 1, falseAnswerRate: 0 });
    const b = out.summary.blind.answer;
    assert.strictEqual(b.accuracy, 0);
    assert.strictEqual(b.declinedRate, 1);
    assert.strictEqual(b.abstain.accuracy, 1);

    assert.strictEqual(out.config.stage, 'B3');
    assert.strictEqual(out.config.metric, 'answer accuracy');
    assert.deepStrictEqual(out.config.answer.prompts.answer, { file: 'answer-v1.md', sha256: prompts.answer.sha256 });
    assert.deepStrictEqual(out.config.answer.prompts.judge, { file: 'judge-v1.md', sha256: prompts.judge.sha256, rulesSha256: JUDGE_RULES_SHA256 });
    assert.strictEqual(out.config.answer.prompts.summarize, null);
    assert.deepStrictEqual(out.config.answer.answerModel, { provider: 'openai', model: 'gpt-6-lite', maxTokens: 400 });
    assert.strictEqual(out.config.answer.tier, 'grid');
    assert.strictEqual(out.config.commit, 'abc');

    const raw = fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf8');
    for (const q of questions) assert.ok(!raw.includes(q.question), 'no question text in records');
    assert.ok(!raw.includes("I don't know") && !raw.includes('fake reason'), 'no reply or reason in records');
    const spend = JSON.parse(fs.readFileSync(path.join(out.dir, 'spend.json'), 'utf8'));
    assert.strictEqual(spend.calls, 24);
    assert.ok(spend.spentUsd > 0);
    assert.match(fs.readFileSync(path.join(out.dir, 'summary.md'), 'utf8'), /## Answer accuracy/);

    assert.deepStrictEqual(out.spotChecks, { file: spotCheckFile(home, out.runId), n: 2 });
    assert.strictEqual(fs.readFileSync(out.spotChecks.file, 'utf8').trim().split('\n').length, 2);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), [], 'the context texts are removed');
  });

  it('resumes after a crash without paying for a finished call twice', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const first = answerOptions(home, questions, { answerClient: answerFake(questions, { crashAt: 7 }) });
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle'), blind], answer: first, now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'AUTH'
    );
    assert.strictEqual(first.judgeClient.prompts.length, 6);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), [], 'a crashed run removes its context texts too');
    // The stopped run's spend is on disk: 6 answers and 6 judgments finished before the 401.
    const [stopped] = fs.readdirSync(home.runs);
    const stoppedSpend = JSON.parse(fs.readFileSync(path.join(home.runs, stopped, 'spend.json'), 'utf8'));
    assert.strictEqual(stoppedSpend.calls, 12);
    assert.strictEqual(stoppedSpend.stoppedBy, 'AUTH');
    assert.ok(stoppedSpend.spentUsd > 0);

    let counts = null;
    const second = answerOptions(home, questions, { onPlan: (p) => { counts = p.counts; } });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle'), blind], answer: second, now: fixedNow, commit: 'x' });
    assert.deepStrictEqual(counts, { answers: 6, answersCached: 6, judgments: 6, judgmentsCached: 6, summaries: 0, summariesCached: 0 });
    assert.strictEqual(second.answerClient.prompts.length, 6);
    assert.strictEqual(second.judgeClient.prompts.length, 6);
    assert.strictEqual(out.records.filter((r) => r.answerCached === true).length, 6);
    assert.strictEqual(out.spend.calls, 12);
  });

  it('refuses a private session without --send-private before any call, and writes no run', async () => {
    const home = setup();
    makePrivate(home.root, 'synth-small');
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions);
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' }),
      (err) => err.code === 'PRIVATE_SESSION' && /synth-small is private/.test(err.message) && /--send-private/.test(err.message)
    );
    assert.strictEqual(opts.answerClient.prompts.length + opts.judgeClient.prompts.length, 0);
    assert.deepStrictEqual(fs.readdirSync(home.runs), []);

    const dry = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, dryRun: true }, now: fixedNow, commit: 'x' });
    assert.strictEqual(dry.dryRun, true);

    const told = [];
    const sent = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, sendPrivate: true, onSendPrivate: (x) => told.push(x) }, now: fixedNow, commit: 'x' });
    assert.strictEqual(sent.records.length, 6);
    assert.deepStrictEqual(told, [{ sessions: ['synth-small'], to: ['anthropic/claude-haiku-4-5', 'openai/gpt-6-lite'] }]);
  });

  it('refuses a plan over the cap before any call; --dry-run prices it and calls nothing', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions, { maxUsd: 0.000001 });
    await assert.rejects(runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' }), (err) => err.code === 'OVER_BUDGET');
    let plan = null;
    const dry = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, dryRun: true, onPlan: (p) => { plan = p; } }, now: fixedNow, commit: 'x' });
    assert.strictEqual(dry.dryRun, true);
    assert.deepStrictEqual(dry.estimate.lines.map((l) => [l.role, l.adapter, l.calls]), [['answer', 'oracle', 6], ['judge', 'oracle', 6]]);
    assert.strictEqual(plan.counts.answers, 6);
    assert.strictEqual(opts.answerClient.prompts.length + opts.judgeClient.prompts.length, 0);
    assert.deepStrictEqual(fs.readdirSync(home.runs), []);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), []);
  });

  it('refuses a model the catalog cannot price unless told to run anyway', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const unpriced = { ...answerFake(questions), model: 'no-such-model' };
    const opts = answerOptions(home, questions, { answerClient: unpriced });
    await assert.rejects(runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' }), (err) => err.code === 'UNPRICED');
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: { ...opts, allowUnpriced: true }, now: fixedNow, commit: 'x' });
    assert.strictEqual(out.config.answer.estimateUsd, null);
  });

  it('does not estimate below what the run spends on the fixtures, the judge included', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    let estimate = null;
    // Every reply fills answerMaxTokens, the most a judge can be asked to read.
    const opts = answerOptions(home, questions, { answerMaxTokens: 100, answerClient: answerFake(questions, { replyChars: 400 }), onPlan: (p) => { estimate = p.estimate; } });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle'), createAdapter('sliding-window')], answer: opts, now: fixedNow, commit: 'x' });
    const judgeEstimate = estimate.lines.filter((l) => l.role === 'judge').reduce((n, l) => n + l.usd, 0);
    const judgeSpent = out.records.reduce((n, r) => n + r.judgeCostUsd, 0);
    assert.ok(judgeSpent <= judgeEstimate, `judge spent ${judgeSpent} > estimated ${judgeEstimate}`);
    assert.ok(out.spend.spentUsd <= estimate.totalUsd, `spent ${out.spend.spentUsd} > estimated ${estimate.totalUsd}`);
  });

  it('records judge-unparsed, leaves it out of accuracy and counts it', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const opts = answerOptions(home, questions, { judgeClient: judgeFake(questions, { raw: (q) => (q.kind === 'user-said' ? 'The reply looks right to me.' : null) }) });
    const out = await runBenchmark({ home, adapters: [createAdapter('oracle')], answer: opts, now: fixedNow, commit: 'x' });
    assert.strictEqual(out.records.find((r) => r.kind === 'user-said').answerError, 'judge-unparsed');
    assert.strictEqual(out.summary.oracle.answer.errors, 1);
    assert.strictEqual(out.summary.oracle.answer.n, 4);
    assert.strictEqual(out.summary.oracle.answer.accuracy, 1);
  });

  it('refuses full-history in the grid tier; the frontier tier samples and gives long-context adapters the first N', async () => {
    const home = setup(SYNTH_FIXTURES);
    const questions = await allQuestions(home);
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('full-history')], answer: answerOptions(home, questions), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && /frontier tier/.test(err.message)
    );
    const out = await runBenchmark({
      home, adapters: [createAdapter('oracle'), createAdapter('full-history')], now: fixedNow, commit: 'x',
      answer: answerOptions(home, questions, { tier: 'frontier', sampleSize: 10, longContextSample: 4 })
    });
    assert.strictEqual(out.records.filter((r) => r.adapter === 'oracle').length, 10);
    assert.strictEqual(out.records.filter((r) => r.adapter === 'full-history').length, 4);
    assert.strictEqual(out.config.answer.sample.questions, 10);
    assert.strictEqual(out.config.answer.sample.longContextQuestions, 4);
    const oracleIds = new Set(out.records.filter((r) => r.adapter === 'oracle').map((r) => r.questionId));
    assert.ok(out.records.filter((r) => r.adapter === 'full-history').every((r) => oracleIds.has(r.questionId)));
    // The fixture catalog gives openai/gpt-6-lite a 64,000-token window
    // (tests/fixtures/models/models-dev.json): (64000 - 400 reply - 1000
    // prompt) x 3/4 = 46,950 estimated tokens, below full-history's 128K.
    assert.strictEqual(out.config.answer.contextCapTokens, 46950);
    assert.strictEqual(out.config.adapters.find((d) => d.name === 'full-history').windowTokens, 46950);
    assert.ok(out.records.filter((r) => r.adapter === 'full-history' && !r.error).every((r) => r.estTokens <= 46950));
  });

  it('refuses a judge that is the answer model', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const same = answerFake(questions);
    await assert.rejects(
      runBenchmark({ home, adapters: [createAdapter('oracle')], answer: answerOptions(home, questions, { judgeClient: same }), now: fixedNow, commit: 'x' }),
      /judge is never the answer model/
    );
  });

  it('runs summarize-compact after the estimate, counting its summaries as setup cost', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const summarizer = { provider: 'fake', model: 'fake-summarizer', local: true, prompts: [], async complete(p) { this.prompts.push(p); return { text: 'a summary', llmMetrics: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }; } };
    const cache = ModelCache.forHome(home);
    const make = () => createAdapter('summarize-compact', { compactEveryTokens: 2000, summarizer: { client: summarizer, cache, prompt: prompts.summarize } });
    await runBenchmark({ home, adapters: [make()], answer: answerOptions(home, questions, { cache, dryRun: true }), now: fixedNow, commit: 'x' });
    assert.strictEqual(summarizer.prompts.length, 0, 'a dry run makes no summary');
    const out = await runBenchmark({ home, adapters: [make()], answer: answerOptions(home, questions, { cache }), now: fixedNow, commit: 'x' });
    assert.strictEqual(out.records.length, 6);
    assert.ok(out.records.every((r) => typeof r.verdict === 'string'));
    assert.strictEqual(out.spend.setupCosts.length, 1);
    assert.strictEqual(out.spend.setupCosts[0].calls, summarizer.prompts.length);
    assert.ok(out.config.answer.prompts.summarize.sha256 === prompts.summarize.sha256);
  });

  it('stops on a summarizer whose key is refused, and records a summarizer that fails after its retries', async () => {
    const home = setup();
    const questions = await allQuestions(home);
    const failing = (status) => ({
      provider: 'openai', model: 'gpt-6-lite', prompts: [],
      async complete(p) { this.prompts.push(p); throw Object.assign(new Error(`status ${status}`), { status }); }
    });
    const cache = ModelCache.forHome(home);
    const make = (client) => createAdapter('summarize-compact', {
      compactEveryTokens: 2000, summarizer: { client, cache, prompt: prompts.summarize, retry: { wait: async () => {} } }
    });

    const refused = failing(401);
    await assert.rejects(
      runBenchmark({ home, adapters: [make(refused)], answer: answerOptions(home, questions, { cache }), now: fixedNow, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'AUTH' && /summarizer/.test(err.message)
    );
    assert.strictEqual(refused.prompts.length, 1, 'a refused key is not retried');
    const [stopped] = fs.readdirSync(home.runs);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home.runs, stopped, 'spend.json'), 'utf8')).stoppedBy, 'AUTH');

    const down = failing(503);
    const out = await runBenchmark({ home, adapters: [make(down), createAdapter('oracle')], answer: answerOptions(home, questions, { cache }), now: fixedNow, commit: 'x' });
    assert.strictEqual(down.prompts.length, 4, 'one call and three retries (spec §15)');
    const sc = out.records.filter((r) => r.adapter === 'summarize-compact');
    assert.strictEqual(sc.length, 6);
    assert.ok(sc.every((r) => r.error === 'summary-failed:503' && r.verdict === undefined));
    assert.ok(out.records.filter((r) => r.adapter === 'oracle').every((r) => typeof r.verdict === 'string'));
    assert.strictEqual(out.spend.stoppedBy, null);
  });

  it('refuses summarize-compact in a run without the answer stage', async () => {
    const home = setup();
    await assert.rejects(runBenchmark({ home, adapterNames: ['summarize-compact'], now: fixedNow, commit: 'x' }), /runs only in the answer stage/);
  });
});

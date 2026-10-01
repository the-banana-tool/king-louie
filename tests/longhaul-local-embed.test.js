// tests/longhaul-local-embed.test.js
// LongHaul on the app's local embedder and reranker (recall stage H3): model
// ids with a slash, `embed --provider local` without --send-private,
// kl-recall-vec with --embed-provider local, the runner-backed scorer, the
// empty-tail count, and adapters closed after every run (B3's run.js). The
// fake backend in a real worker; never a model.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmbedRunner } = require('../src/history/embed-runner');
const embedCommand = require('../src/longhaul/commands/embed');
const { main } = require('../src/longhaul/cli');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { SYNTH_FIXTURES, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { createAdapter } = require('../src/longhaul/adapters');
const { EmbeddingCache, cacheDir, validateModelName } = require('../src/longhaul/embeddings');
const { createRunnerScorer } = require('../src/longhaul/rerank');
const { runBenchmark } = require('../src/longhaul/run');
const { createFakeModels } = require('../src/longhaul/fake-models');
const { loadPrompt } = require('../src/longhaul/prompts');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, sink, makePrivate } = require('./helpers/longhaul-helpers');

const BACKEND = require.resolve('./helpers/fake-embed-backend');
const MODELS = path.join(os.tmpdir(), 'kl-embed-models-unused');
const SESSION = 'synth-small';
const MODEL = 'Xenova/bge-small-en-v1.5';
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'longhaul');
const runners = [];
after(async () => { while (runners.length) await runners.pop().stop(); });
const runner = () => { const r = new EmbedRunner({ testBackend: BACKEND }); runners.push(r); return r; };

function setupHome() {
  const { env } = tmpHome();
  const home = ensureDirs(resolveHome(env));
  writeSyntheticRoot(home.root, [SYNTH_FIXTURES[0]]);
  return { env, home };
}
const ctxFor = (home, env) => ({ home, env, stdout: sink(), stderr: sink(), now: () => new Date(), cwd: process.cwd() });

describe('LongHaul with the local embedder', () => {
  it('model ids may be org/name; the cache folder maps the slash', () => {
    assert.strictEqual(validateModelName(MODEL), MODEL);
    assert.strictEqual(validateModelName('text-embedding-3-small'), 'text-embedding-3-small');
    for (const bad of ['../x', 'a/../b', 'a/b/c', 'a b']) assert.throws(() => validateModelName(bad), bad);
    assert.ok(cacheDir(path.join(os.tmpdir(), 'p'), 's', MODEL).endsWith(path.join('s', 'Xenova__bge-small-en-v1.5')));
  });

  it('embed --provider local fills the cache here, a private session included, with no --send-private', async () => {
    const { env, home } = setupHome();
    makePrivate(home.root, SESSION);
    const ctx = ctxFor(home, env);
    const code = await embedCommand.run(ctx, { session: SESSION, provider: 'local', model: MODEL }, [], { runner: runner() });
    assert.strictEqual(code, 0, ctx.stderr.text);
    const cache = EmbeddingCache.open(cacheDir(home.private, SESSION, MODEL));
    assert.strictEqual(cache.dim, 28);
    assert.strictEqual(cache.rows.length, cache.meta.chunksTotal);
    assert.strictEqual(cache.meta.provider, 'local');
    assert.match(ctx.stdout.text, /local, no cost/);
    const questions = await readQuestions(questionsFile(home.root, SESSION));
    assert.ok(questions.length > 0 && questions.every((q) => cache.question(q.id, q.question)));
  });

  it('kl-recall-vec --embed-provider local: runs from the cache and closes its runner', async () => {
    const { env, home } = setupHome();
    const r = runner();
    await embedCommand.run(ctxFor(home, env), { session: SESSION, provider: 'local', model: MODEL }, [], { runner: r });
    const session = await loadSession(sessionDir(home.root, SESSION));
    const questions = await readQuestions(questionsFile(home.root, SESSION));
    const adapter = createAdapter('kl-recall-vec', { tmpRoot: home.tmp, privateRoot: home.private, provider: 'local', model: MODEL, runner: r });
    assert.strictEqual(adapter.describe().embedder, `local/${MODEL}`);
    const handle = await adapter.prepare(session);
    try {
      const q = questions[0];
      const out = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
      assert.strictEqual(typeof out.text, 'string');
      assert.ok(out.evidenceSeqsShown.every((s) => s < q.askAtSeq));
    } finally {
      await adapter.release(handle);
    }
    await adapter.close();
  });

  it('createRunnerScorer loads the cross-encoder once and scores through the runner', async () => {
    const scorer = createRunnerScorer({ runner: runner(), model: 'fake/rr', modelsDir: MODELS });
    const s = await scorer.score('linen bandage', ['the tomb', 'a linen bandage']);
    assert.ok(s[1] > s[0]);
    assert.strictEqual((await scorer.score('x', ['y'])).length, 1);
  });

  it('run reports how many questions had an empty tail', async () => {
    const stdout = sink();
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'kl-recall,oracle'], { stdout, stderr: sink(), env: tmpHome().env });
    assert.strictEqual(code, 0);
    const summaryMd = stdout.text.match(/summary: (.+)$/m)[1].trim();
    const summary = JSON.parse(fs.readFileSync(path.join(path.dirname(summaryMd), 'summary.json'), 'utf8'));
    assert.strictEqual(typeof summary['kl-recall'].emptyTail, 'number');
    assert.strictEqual(summary.oracle.emptyTail, 0, 'no tail reported counts as not empty');
    assert.match(fs.readFileSync(summaryMd, 'utf8'), /Empty tail/);
  });

  it('runBenchmark closes every adapter: evidence only, the answer stage, and a run that throws', async () => {
    const { home } = setupHome();
    let closed = 0;
    const closing = () => ({
      name: 'closing',
      describe: () => ({ name: 'closing' }),
      prepare: async (session) => ({ session }),
      context: async () => ({ text: 'nothing here', evidenceSeqsShown: [], evidenceSeqsPartial: [], estTokens: 3, latencyMs: 1, cpuMs: 1, cost: 0 }),
      release: async () => {},
      close: async () => { closed += 1; }
    });
    const now = () => new Date('2026-09-30T10:00:00.000Z');
    await runBenchmark({ home, adapters: [closing()], now, commit: 'x' });
    assert.strictEqual(closed, 1, 'evidence only');
    const fake = createFakeModels();
    const answer = { answerClient: fake.answer, judgeClient: fake.judge, prompts: { answer: loadPrompt('answer'), judge: loadPrompt('judge') }, catalog: fixtureCatalog(), dryRun: true };
    await runBenchmark({ home, adapters: [closing()], answer, now, commit: 'x' });
    assert.strictEqual(closed, 2, 'the answer stage, a dry run');
    await assert.rejects(runBenchmark({ home, adapters: [closing()], sessionIds: ['no-such-session'], now, commit: 'x' }), /No session/);
    assert.strictEqual(closed, 3, 'a run that throws');
  });
});

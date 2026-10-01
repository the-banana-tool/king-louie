// tests/longhaul-answer-cli.test.js
// The answer stage from the CLI (benchmark spec §8.1, §10, §14): the
// --fake-models smoke run, the private-session refusal against the local
// fake server (no request reaches it), usage errors, --dry-run, and the
// unpriced-model refusal. No network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { main, COMMANDS } = require('../src/longhaul/cli');
const { writeSyntheticRoot, SYNTH_FIXTURES } = require('../src/longhaul/synthetic');
const { ensureDirs, resolveHome } = require('../src/longhaul/home');
const { createFakeModels } = require('../src/longhaul/fake-models');
const { startFakeLlmServer } = require('./helpers/fake-llm-server');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { tmpHome, sink, makePrivate, FIXTURE_ROOT } = require('./helpers/longhaul-helpers');

const io = (env) => ({ stdout: sink(), stderr: sink(), env });

describe('fake models', () => {
  it('decline, judge a decline as abstained, summarize, and cost nothing', async () => {
    const m = createFakeModels();
    assert.ok([m.answer, m.judge, m.summarizer].every((c) => c.local === true && c.provider === 'fake'));
    assert.strictEqual((await m.answer.complete('anything')).text, "I don't know");
    assert.strictEqual((await m.answer.complete('anything')).llmMetrics.costUsd, 0);
    assert.strictEqual(JSON.parse((await m.judge.complete("x\n<reply>\nI don't know\n</reply>\ny")).text).verdict, 'abstained');
    assert.strictEqual(JSON.parse((await m.judge.complete('<reply>\nPort 18001.\n</reply>')).text).verdict, 'incorrect');
    assert.match((await m.summarizer.complete('p')).text, /Summary/);
  });
});

describe('longhaul run: the answer stage', () => {
  let server;
  before(async () => { server = await startFakeLlmServer(); });
  after(async () => { await server.close(); });

  it('runs the whole answer stage on the fixtures with --fake-models, for $0 and no network', async () => {
    const { env, root } = tmpHome();
    const out = io(env);
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle,sliding-window,real-compaction,summarize-compact', '--fake-models'], out);
    assert.strictEqual(code, 0, out.stderr.text);
    assert.match(out.stdout.text, /estimate: \$0\.0000/);
    assert.match(out.stdout.text, /answer accuracy 0\.000 \(n=\d+\)/);
    // The name column fits summarize-compact (17 chars): every row's metrics start in one column.
    const rows = out.stdout.text.split('\n').filter((l) => / evidence recall | answer accuracy /.test(l));
    assert.ok(rows.some((l) => l.startsWith('summarize-compact ')));
    assert.deepStrictEqual([...new Set(rows.map((l) => l.search(/ (evidence recall|answer accuracy) /)))], ['summarize-compact'.length]);
    const [runId] = fs.readdirSync(path.join(root, 'runs'));
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.oracle.answer.abstain.accuracy, 1);
    assert.strictEqual(summary.oracle.answer.declinedRate, 1);
    assert.strictEqual(summary['real-compaction'].questions, 6);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'config.json'), 'utf8'));
    assert.deepStrictEqual(config.answer.answerModel, { provider: 'fake', model: 'fake-answer', maxTokens: 400 });
    assert.deepStrictEqual(config.skippedAdapters.map((s) => s.sessionId).sort(), ['synth-medium', 'synth-small']);
  });

  it('states what one question is worth from n, not a fixed 0.01 (review deferred T14)', async () => {
    const { env, root } = tmpHome();
    const out = io(env);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'kl-recall,kl-recall-whole', '--fake-models'], out), 0, out.stderr.text);
    const m = out.stdout.text.match(/whole-messages: .* over (\d+) questions .*; one question is (\d\.\d{3}), a difference under (\d\.\d{3}) is noise\n/);
    assert.ok(m, out.stdout.text);
    const n = Number(m[1]);
    assert.deepStrictEqual([m[2], m[3]], [(1 / n).toFixed(3), (2 / n).toFixed(3)]);
    const [runId] = fs.readdirSync(path.join(root, 'runs'));
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'runs', runId, 'summary.json'), 'utf8'));
    const answerable = summary['kl-recall'].answer.n;
    assert.ok(fs.readFileSync(path.join(root, 'runs', runId, 'summary.md'), 'utf8')
      .includes(`One question is ${(1 / answerable).toFixed(3)} of a rate at n=${answerable} (1/n); a difference under two questions (${(2 / answerable).toFixed(3)}) is noise`));
    assert.ok(!out.stdout.text.includes('under 0.02'));
  });

  it('refuses a private session without --send-private: exit 2, and no request reaches the provider', async () => {
    const { env, root } = tmpHome();
    writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
    makePrivate(root, 'synth-small');
    const before = server.requests.length;
    const out = io({ ...env, OPENAI_API_KEY: 'test-key-123456' });
    const code = await main(['run', '--adapters', 'oracle',
      '--answer-provider', 'openai', '--answer-model', 'test-model', '--answer-base-url', `${server.url}/openai/v1`,
      '--judge-provider', 'openai', '--judge-model', 'test-judge', '--judge-base-url', `${server.url}/openai/v1`], out);
    assert.strictEqual(code, 2);
    assert.match(out.stderr.text, /synth-small is private/);
    assert.match(out.stderr.text, /--send-private/);
    assert.strictEqual(server.requests.length, before, 'nothing reached the provider');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'runs')), []);
  });

  it('refuses answer-stage options without the answer stage, half a model pair, and a judge that is the answer model', async () => {
    const { env } = tmpHome();
    const e = { ...env, OPENAI_API_KEY: 'test-key-123456' };
    const base = ['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle'];
    assert.strictEqual(await main([...base, '--dry-run'], io(e)), 2);
    assert.strictEqual(await main([...base, '--tier', 'frontier'], io(e)), 2);
    assert.strictEqual(await main([...base, '--answer-model', 'm'], io(e)), 2);
    assert.strictEqual(await main([...base, '--answer-provider', 'openai', '--answer-model', 'm'], io(e)), 2, 'no judge');
    const same = io(e);
    assert.strictEqual(await main([...base, '--answer-provider', 'openai', '--answer-model', 'm', '--judge-provider', 'openai', '--judge-model', 'm'], same), 2);
    assert.match(same.stderr.text, /judge is never the answer model/);
    assert.strictEqual(await main([...base, '--fake-models', '--answer-provider', 'openai', '--answer-model', 'm'], io(e)), 2);
    assert.strictEqual(await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'full-history', '--fake-models'], io(e)), 2, 'full-history is frontier only');
    assert.strictEqual(await main([...base, '--fake-models', '--tier', 'nope'], io(e)), 2);
    assert.strictEqual(await main([...base, '--fake-models', '--max-usd', '0'], io(e)), 2);
    const usage = io(e);
    assert.strictEqual(await main(['run'], usage), 2);
    assert.match(usage.stderr.text, /--embed-provider openai\|local/);
    assert.deepStrictEqual(COMMANDS.run.options['embed-provider'], { type: 'string' });
  });

  it('--dry-run prints the plan and the estimate, calls nothing and writes no run', async () => {
    const { env, root } = tmpHome();
    const out = io(env);
    const code = await main(['run', '--sessions', FIXTURE_ROOT, '--adapters', 'oracle,full-history', '--tier', 'frontier',
      '--sample', '5', '--long-context-sample', '2', '--fake-models', '--dry-run'], out);
    assert.strictEqual(code, 0, out.stderr.text);
    assert.match(out.stdout.text, /plan: 7 answers \(0 cached\), 7 judgments \(0 cached\), 0 summaries \(0 cached\)/);
    assert.match(out.stdout.text, /dry run: no model was called and no run was written/);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'runs')), []);
  });

  it('builds the clients through createModelClient; an unpriced model is refused unless --allow-unpriced', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    const provider = (reply) => ({
      async streamMessage(messages, options, onChunk) {
        onChunk(reply);
        return { content: '', llmMetrics: { inputTokens: 10, outputTokens: 2, costUsd: null, unpriced: true } };
      }
    });
    const values = {
      sessions: FIXTURE_ROOT, adapters: 'oracle',
      'answer-provider': 'openai', 'answer-model': 'no-such-model', 'judge-provider': 'anthropic', 'judge-model': 'claude-haiku-4-5'
    };
    const ctx = { home, env, stdout: sink(), stderr: sink(), now: () => new Date('2026-09-30T10:00:00Z'), cwd: process.cwd() };
    const deps = {
      providerInstances: { answer: provider("I don't know"), judge: provider('{"verdict":"abstained","reason":"declined"}') },
      catalog: fixtureCatalog(), retry: { wait: async () => {} }
    };
    await assert.rejects(COMMANDS.run.run(ctx, values, [], deps), (err) => err.code === 'UNPRICED');
    assert.strictEqual(await COMMANDS.run.run(ctx, { ...values, 'allow-unpriced': true }, [], deps), 0, ctx.stderr.text);
    // The fake server reports no usage, so the priced judge settles at its estimate.
    assert.match(ctx.stdout.text, /\(21 unpriced, 21 at their estimate: no usage reported\)/);
  });
});

// tests/longhaul-jev-adapters.test.js
// kl-recall-jev-rerank and kl-recall-vec-jev-rerank: Jev reranks, scores are
// cached under private/rerank/<session>/<model>-<mode>/, a private session
// and an estimate over the token cap are refused before any request, a
// refused key or a spent account stops the run, the answer stage is
// cache-only, and longhaul run prints and writes the counts. Synthetic
// fixtures, loopback fake server; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { SYNTH_FIXTURES, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { runBenchmark, RUN_STOP_CODES } = require('../src/longhaul/run');
const { JEV_STOP_CODES } = require('../src/longhaul/jev');
const { UsageError } = require('../src/longhaul/errors');
const runCommand = require('../src/longhaul/commands/run');
const { main } = require('../src/longhaul/cli');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const KEY = 'test-key-not-real-0001';
const REF = { completeMessageTokens: 800, pairToolMessages: true };
const noWait = async () => {};
const now = () => new Date('2026-10-04T10:00:00.000Z');

function setupHome() {
  const { env, root } = tmpHome();
  writeSyntheticRoot(root, [SYNTH_FIXTURES[0]]);
  return { env, root, home: ensureDirs(resolveHome(env)) };
}

async function runAll(adapter, session, questions) {
  const handle = await adapter.prepare(session, { questionCount: questions.length });
  const shown = [];
  try {
    for (const q of questions) {
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
      for (const s of [...r.evidenceSeqsShown, ...r.evidenceSeqsPartial]) assert.ok(s < q.askAtSeq);
      shown.push(r.evidenceSeqsShown);
    }
  } finally {
    await adapter.release(handle);
  }
  return shown;
}

describe('kl-recall-jev-rerank', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  const make = (home, extra = {}) => createAdapter('kl-recall-jev-rerank', {
    tmpRoot: home.tmp, privateRoot: home.private, recall: { ...REF, rerank: { topM: 5 } },
    env: { TYPESAFE_AI_KEY: KEY }, jevBaseUrl: server.url, jevOptions: { wait: noWait }, ...extra
  });

  it('is registered next to the cross-encoder probes; its stop codes stop a run', () => {
    for (const name of ['kl-recall-jev-rerank', 'kl-recall-vec-jev-rerank']) assert.ok(adapterNames().includes(name), name);
    for (const code of [...JEV_STOP_CODES, 'AUTH', 'QUOTA']) assert.ok(RUN_STOP_CODES.has(code), code);
    assert.ok(!RUN_STOP_CODES.has('PRIVATE_SESSION'), 'a per-question refusal is still recorded on its question');
  });

  it('reranks with Jev (batched); a second adapter is served from the cache and needs no key', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const questions = await readQuestions(questionsFile(home.root, 'synth-small'));
    const first = make(home);
    assert.strictEqual(first.name, 'kl-recall-jev-rerank');
    const d = first.describe();
    assert.strictEqual(d.jevMode, 'batched');
    assert.strictEqual(d.reranker, 'typesafe.ai jev-1.13.0-batched');
    assert.strictEqual(d.recall.rerank.kind, 'jev');
    const n0 = server.requests.length;
    const a = await runAll(first, session, questions);
    assert.ok(server.requests.length > n0);
    const st = first.runStats();
    assert.ok(st.rerank.misses > 0 && st.jev.inputTokens > 0);
    assert.strictEqual(st.jev.usd, null, 'unpriced');
    assert.ok(fs.existsSync(path.join(home.private, 'rerank', 'synth-small', 'jev-1.13.0-batched', 'scores.jsonl')));
    const n1 = server.requests.length;
    const second = make(home, { env: {} });
    const b = await runAll(second, session, questions);
    assert.strictEqual(server.requests.length, n1, 'a cache hit sends no request and needs no key');
    assert.deepStrictEqual(b, a);
    assert.strictEqual(second.runStats().rerank.misses, 0);
  });

  it('pointwise has its own cache; the fused variant builds; a bad mode is refused', () => {
    const { home } = setupHome();
    assert.strictEqual(make(home, { jevMode: 'pointwise' }).describe().reranker, 'typesafe.ai jev-1.13.0-pointwise');
    const v = createAdapter('kl-recall-vec-jev-rerank', { tmpRoot: home.tmp, privateRoot: home.private, env: {} });
    assert.strictEqual(v.name, 'kl-recall-vec-jev-rerank');
    assert.strictEqual(v.describe().candidates, 'fused');
    assert.throws(() => make(home, { jevMode: 'listwise' }), /batched or pointwise/);
  });

  it('refuses a private session without --send-private, and an estimate over the token cap, before any request', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const n0 = server.requests.length;
    await assert.rejects(make(home, { maxTokens: 1 }).prepare(session, { questionCount: 10 }), (err) => err.code === 'JEV_OVER_TOKENS');
    session.manifest.private = true;
    await assert.rejects(make(home).prepare(session, { questionCount: 3 }), (err) => err.code === 'PRIVATE_SESSION' && /--send-private/.test(err.message));
    assert.strictEqual(server.requests.length, n0);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), []);
    const ok = make(home, { sendPrivate: true });
    await ok.release(await ok.prepare(session, { questionCount: 3 }));
  });

  it('a refused key (401) stops the run with AUTH; a spent account (402) with QUOTA; neither is retried', async () => {
    for (const [status, code, re] of [[401, 'AUTH', /typesafe\.ai refused the API key \(401\) for the Jev reranker/], [402, 'QUOTA', /typesafe\.ai refused the call: the account is out of credit or quota \(402\) for the Jev reranker/]]) {
      const { home } = setupHome();
      const refusing = await startFakeJevServer({ failFirst: 1000, failStatus: status });
      try {
        const adapter = make(home, { jevBaseUrl: refusing.url });
        await assert.rejects(runBenchmark({ home, adapters: [adapter], now, commit: 'x' }),
          (err) => err instanceof UsageError && err.code === code && re.test(err.message));
        assert.strictEqual(refusing.requests.length, 1, `${status}: one request, then the run stops`);
      } finally {
        await refusing.close();
      }
    }
  });

  it('no TYPESAFE_AI_KEY: the first uncached question stops the run (exit 2, JEV_NO_KEY), not an error per question', async () => {
    assert.ok(JEV_STOP_CODES.includes('JEV_NO_KEY'));
    assert.ok(RUN_STOP_CODES.has('JEV_NO_KEY'));
    const { env, home } = setupHome();
    await assert.rejects(runBenchmark({ home, adapters: [make(home, { env: {} })], now, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'JEV_NO_KEY' && /TYPESAFE_AI_KEY/.test(err.message));
    const stdout = sink();
    const stderr = sink();
    const code = await main(['run', '--adapters', 'kl-recall-jev-rerank', '--jev-base-url', server.url], { env, stdout, stderr, now });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /TYPESAFE_AI_KEY/);
  });

  it('cache-only (the answer stage): a miss stops the run with JEV_SCORES_MISSING and sends nothing; a warm cache serves it', async () => {
    const { home } = setupHome();
    const n0 = server.requests.length;
    await assert.rejects(runBenchmark({ home, adapters: [make(home, { cachedOnly: true })], now, commit: 'x' }),
      (err) => err instanceof UsageError && err.code === 'JEV_SCORES_MISSING' && /evidence-only run/.test(err.message));
    assert.strictEqual(server.requests.length, n0);
    await runBenchmark({ home, adapters: [make(home)], now, commit: 'x' });
    const n1 = server.requests.length;
    assert.ok(n1 > n0);
    const out = await runBenchmark({ home, adapters: [make(home, { cachedOnly: true, env: {} })], now, commit: 'x' });
    assert.strictEqual(server.requests.length, n1);
    assert.ok(out.records.every((r) => r.error === null));
  });

  it('longhaul run prints the Jev line (tokens, price unknown) and writes adapter-stats.json', async () => {
    const { env, home } = setupHome();
    const stdout = sink();
    const ctx = { home, env: { ...env, TYPESAFE_AI_KEY: KEY }, stdout, stderr: sink(), now, cwd: process.cwd() };
    const code = await runCommand.run(ctx, {
      adapters: 'kl-recall-jev-rerank', recall: ['rerank={"topM":5}'], 'jev-mode': 'batched', 'jev-base-url': server.url, 'send-private': false
    });
    assert.strictEqual(code, 0);
    assert.match(stdout.text, /kl-recall-jev-rerank\s+batched topM 5 .*input tokens \d+ \(price unknown\)/);
    const runDir = path.join(home.runs, fs.readdirSync(home.runs)[0]);
    const stats = JSON.parse(fs.readFileSync(path.join(runDir, 'adapter-stats.json'), 'utf8'))['kl-recall-jev-rerank'];
    assert.strictEqual(stats.mode, 'batched');
    assert.ok(stats.jev.requests > 0);
    assert.strictEqual(stats.jev.usd, null);
    assert.strictEqual(stats.scoreErrors, 0);
  });
});

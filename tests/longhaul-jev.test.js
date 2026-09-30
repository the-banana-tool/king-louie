// tests/longhaul-jev.test.js
// The Jev client and scorers (src/longhaul/jev.js) and the
// kl-recall(-vec)-jev-rerank adapters, against a loopback fake Jev server.
// Synthetic fixtures only; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { SYNTH_FIXTURES, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { createAdapter } = require('../src/longhaul/adapters');
const runCommand = require('../src/longhaul/commands/run');
const {
  createJevClient, createPointwiseScorer, createBatchedScorer, planBatches, estTokens, priceUsd, JevError
} = require('../src/longhaul/jev');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { tmpHome, sink } = require('./helpers/longhaul-helpers');

const KEY = 'test-key-not-real';
const REF = { queryUserTurns: 0, bm25TopK: 200, completeMessageTokens: 800, pairToolMessages: true };
const noWait = async () => {};

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

describe('Jev client', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  it('pointwise: one call per pair, the cookbook request shape, scores in order', async () => {
    const client = createJevClient({ apiKey: KEY, baseUrl: server.url, wait: noWait });
    const scorer = createPointwiseScorer({ client });
    const n0 = server.requests.length;
    const scores = await scorer.score('side gate code', ['the side gate code is 4417', 'grocery list', 'gate']);
    assert.strictEqual(server.requests.length - n0, 3);
    assert.deepStrictEqual(scores.map((s) => Math.round(s * 3)), [3, 0, 1]);
    const r = server.requests[n0];
    assert.strictEqual(r.auth, `Bearer ${KEY}`);
    assert.match(r.contentType, /application\/json/);
    assert.strictEqual(r.body.model, 'jev-latest');
    assert.deepStrictEqual(Object.keys(r.body.state).sort(), ['candidate_passage', 'query_excerpt']);
    const q = r.body.questions.establishes;
    assert.strictEqual(q.type, 'noul');
    assert.ok(q.instructions && q.criteria.true && q.criteria.false);
    assert.strictEqual(client.usage.ok, 3);
    assert.ok(client.usage.inputTokens > 0);
  });

  it('batched: groups stay under the token cap and the per-call limit; one noul per candidate', async () => {
    const texts = Array.from({ length: 30 }, (_, i) => `${i % 2 ? 'gate code' : 'weather'} ${'x'.repeat(3000)}`);
    const groups = planBatches('gate code', texts, { maxStateTokens: 5000, maxPerCall: 60 });
    assert.ok(groups.length > 1);
    for (const g of groups) {
      const tokens = estTokens('gate code') + 200 + g.reduce((n, i) => n + estTokens(texts[i]) + 80, 0);
      assert.ok(tokens <= 5000 || g.length === 1, `group of ${g.length} is ${tokens} tokens`);
    }
    assert.deepStrictEqual(groups.flat(), texts.map((_, i) => i), 'every text once, in order');
    assert.ok(planBatches('q', new Array(100).fill('short'), { maxPerCall: 40 }).every((g) => g.length <= 40));
    const client = createJevClient({ apiKey: KEY, baseUrl: server.url, wait: noWait });
    const scorer = createBatchedScorer({ client, maxStateTokens: 5000 });
    const n0 = server.requests.length;
    const scores = await scorer.score('gate code', texts);
    assert.strictEqual(server.requests.length - n0, groups.length);
    texts.forEach((t, i) => assert.strictEqual(scores[i] > 0, i % 2 === 1));
    const r = server.requests[n0];
    assert.strictEqual(r.body.state.query, 'gate code');
    assert.deepStrictEqual(Object.keys(r.body.questions), r.body.state.candidates.map((c) => c.id));
  });

  it('retries 429 with backoff, then succeeds', async () => {
    const flaky = await startFakeJevServer({ failFirst: 2 });
    try {
      const waits = [];
      const client = createJevClient({ apiKey: KEY, baseUrl: flaky.url, wait: async (ms) => { waits.push(ms); }, random: () => 0.5 });
      const r = await client.ask({ state: { query_excerpt: 'a', candidate_passage: 'a' }, questions: { establishes: { type: 'noul', instructions: 'x' } } });
      assert.strictEqual(r.answers.establishes.noul, 1);
      assert.strictEqual(client.usage.retries, 2);
      assert.deepStrictEqual(client.usage.status, { 429: 2, 200: 1 });
      assert.ok(waits[1] > waits[0], 'the backoff grows');
    } finally { await flaky.close(); }
  });

  it('fails a 422 at once, with the status only (never the body)', async () => {
    const bad = await startFakeJevServer({ failFirst: 5, failStatus: 422 });
    try {
      const client = createJevClient({ apiKey: KEY, baseUrl: bad.url, wait: noWait });
      await assert.rejects(client.ask({ state: 's', questions: {} }), (err) => err instanceof JevError && err.status === 422 && !/rate limited/.test(err.message));
      assert.strictEqual(bad.requests.length, 1);
      assert.strictEqual(client.usage.failed, 1);
    } finally { await bad.close(); }
  });

  it('times out a request that never answers, and refuses once spend reaches maxUsd', async () => {
    const hang = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const client = createJevClient({ apiKey: KEY, fetchImpl: hang, timeoutMs: 20, maxRetries: 1, wait: noWait });
    await assert.rejects(client.ask({ state: 's', questions: {} }), (err) => err.code === 'JEV_TIMEOUT');
    assert.strictEqual(client.usage.timeouts, 2);
    const capped = createJevClient({ apiKey: KEY, baseUrl: server.url, maxUsd: 1e-9, wait: noWait });
    await capped.ask({ state: { query_excerpt: 'a', candidate_passage: 'a' }, questions: { establishes: { type: 'noul', instructions: 'x' } } });
    await assert.rejects(capped.ask({ state: 's', questions: {} }), (err) => err.code === 'JEV_SPEND_CAP');
    assert.throws(() => createJevClient({ apiKey: '' }), /TYPESAFE_AI_KEY/);
    assert.strictEqual(priceUsd(1e6), 0.042);
  });
});

describe('kl-recall-jev-rerank', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  const make = (home, extra = {}) => createAdapter('kl-recall-jev-rerank', {
    tmpRoot: home.tmp, privateRoot: home.private, recall: { ...REF, rerank: { topM: 5 } },
    env: { TYPESAFE_AI_KEY: KEY }, jevBaseUrl: server.url, ...extra
  });

  it('reranks with Jev; a second adapter is served from the cache and sends nothing', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const questions = await readQuestions(questionsFile(home.root, 'synth-small'));
    const first = make(home);
    assert.strictEqual(first.name, 'kl-recall-jev-rerank');
    assert.strictEqual(first.describe().jevMode, 'pointwise');
    const n0 = server.requests.length;
    const a = await runAll(first, session, questions);
    assert.ok(server.requests.length > n0);
    const st = first.runStats();
    assert.ok(st.rerank.misses > 0 && st.jev.inputTokens > 0 && st.calibration.scores === st.rerank.misses);
    assert.ok(fs.existsSync(path.join(home.private, 'rerank', 'synth-small', 'jev-1.13.0-pointwise', 'scores.jsonl')));
    const n1 = server.requests.length;
    const second = make(home, { env: {} });
    const b = await runAll(second, session, questions);
    assert.strictEqual(server.requests.length, n1, 'a cache hit sends no request (and needs no key)');
    assert.deepStrictEqual(b, a);
    assert.strictEqual(second.runStats().rerank.misses, 0);
  });

  it('batched mode has its own cache; fused candidates build as kl-recall-vec-jev-rerank', () => {
    const { home } = setupHome();
    const b = make(home, { jevMode: 'batched' });
    assert.strictEqual(b.describe().reranker, 'typesafe.ai jev-1.13.0-batched');
    const v = createAdapter('kl-recall-vec-jev-rerank', { tmpRoot: home.tmp, privateRoot: home.private, env: {} });
    assert.strictEqual(v.name, 'kl-recall-vec-jev-rerank');
    assert.strictEqual(v.describe().candidates, 'fused');
    assert.throws(() => make(home, { jevMode: 'listwise' }), /pointwise or batched/);
  });

  it('refuses a private session without --send-private, before any request', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    session.manifest.private = true;
    const n0 = server.requests.length;
    await assert.rejects(make(home).prepare(session, { questionCount: 3 }), (err) => err.code === 'PRIVATE_SESSION' && /--send-private/.test(err.message));
    assert.strictEqual(server.requests.length, n0);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), []);
    const ok = make(home, { sendPrivate: true });
    await ok.release(await ok.prepare(session, { questionCount: 3 }));
  });

  it('refuses a run whose estimate is over the cap, before any request', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    await assert.rejects(make(home, { maxUsd: 1e-9 }).prepare(session, { questionCount: 10 }), (err) => err.code === 'JEV_OVER_BUDGET');
    assert.deepStrictEqual(fs.readdirSync(home.tmp), []);
  });

  it('longhaul run writes adapter-stats.json with numbers and prints the Jev line', async () => {
    const { env, home } = setupHome();
    const stdout = sink();
    const ctx = { home, env: { ...env, TYPESAFE_AI_KEY: KEY }, stdout, stderr: sink(), now: () => new Date(), cwd: process.cwd() };
    const code = await runCommand.run(ctx, {
      adapters: 'kl-recall-jev-rerank', recall: ['rerank={"topM":5}'], 'jev-mode': 'batched', 'jev-base-url': server.url, 'send-private': false
    });
    assert.strictEqual(code, 0);
    assert.match(stdout.text, /kl-recall-jev-rerank batched topM 5 .*requests \d+/);
    const runDir = path.join(home.runs, fs.readdirSync(home.runs)[0]);
    const stats = JSON.parse(fs.readFileSync(path.join(runDir, 'adapter-stats.json'), 'utf8'))['kl-recall-jev-rerank'];
    assert.strictEqual(stats.mode, 'batched');
    assert.ok(stats.jev.requests > 0);
    assert.strictEqual(stats.scoreErrors, 0);
  });
});

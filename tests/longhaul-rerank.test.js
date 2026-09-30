// tests/longhaul-rerank.test.js
// The rerank score cache, the cached reranker, and the kl-recall-rerank
// adapters (BM25 and fused candidates) with a fake scorer. Synthetic
// fixtures only; no model and no network.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const embedCommand = require('../src/longhaul/commands/embed');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { SYNTH_FIXTURES, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { createAdapter } = require('../src/longhaul/adapters');
const { createKlRecallRerankAdapter } = require('../src/longhaul/adapters/kl-recall-rerank');
const { UsageError } = require('../src/longhaul/errors');
const {
  DEFAULT_RERANK_MODEL, rerankCacheDir, pairHash, RerankCache, loadCrossEncoder, createCachedReranker, newRerankStats
} = require('../src/longhaul/rerank');
const { fakeEmbedder } = require('./helpers/fake-embedding-server');
const { tmpDir, tmpHome, sink } = require('./helpers/longhaul-helpers');

const REF = { queryUserTurns: 0, bm25TopK: 200, completeMessageTokens: 800, pairToolMessages: true };

function setupHome(fixtures = [SYNTH_FIXTURES[0]]) {
  const { env, root } = tmpHome();
  writeSyntheticRoot(root, fixtures);
  return { env, root, home: ensureDirs(resolveHome(env)) };
}

// Scores a text by how many of the query's words it holds; counts calls.
function fakeScorer() {
  const calls = [];
  return {
    calls,
    async score(query, texts) {
      calls.push(texts.length);
      const words = new Set(String(query).toLowerCase().match(/[a-z0-9]+/g) || []);
      return texts.map((t) => (String(t).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => words.has(w)).length);
    }
  };
}
const failingScorer = () => ({ async score() { throw new Error('the scorer must not be called'); } });

describe('rerank cache', () => {
  it('round-trips scores keyed by question, chunk and text hash; skips a torn line', () => {
    const dir = path.join(tmpDir(), 'rerank');
    const cache = RerankCache.open(dir);
    const chunk = { messageId: 'm-1', idx: 0, text: 'The side gate code is 4417.' };
    const h = pairHash('gate code?', chunk.text);
    cache.add([{ q: 'q1', m: chunk.messageId, i: chunk.idx, h, s: 3.5 }]);
    fs.appendFileSync(path.join(dir, 'scores.jsonl'), '{"q":"q1","m":"m-2"');
    const again = RerankCache.open(dir);
    assert.strictEqual(again.size, 1);
    assert.strictEqual(again.get('q1', chunk, h), 3.5);
    assert.strictEqual(again.get('q1', chunk, pairHash('another query', chunk.text)), undefined, 'a changed query is a miss');
    assert.strictEqual(again.get('q2', chunk, h), undefined);
  });

  it('puts a model under private/rerank/<session>/ and refuses a path-like model id', () => {
    assert.strictEqual(rerankCacheDir('/p', 'synth-small', DEFAULT_RERANK_MODEL), path.join('/p', 'rerank', 'synth-small', 'Xenova__ms-marco-MiniLM-L-6-v2'));
    assert.throws(() => rerankCacheDir('/p', 's', '../x'), UsageError);
  });

  it('the cached reranker scores only misses, once', async () => {
    const cache = RerankCache.open(path.join(tmpDir(), 'rerank'));
    const scorer = fakeScorer();
    const stats = newRerankStats();
    const chunks = [
      { messageId: 'm-1', idx: 0, text: 'gate code 4417' },
      { messageId: 'm-2', idx: 0, text: 'grocery list' }
    ];
    const rr = createCachedReranker({ cache, questionId: 'q1', scorer, stats });
    assert.deepStrictEqual(await rr('gate code', chunks), [2, 0]);
    assert.deepStrictEqual(await rr('gate code', chunks), [2, 0]);
    assert.deepStrictEqual(scorer.calls, [2]);
    assert.strictEqual(stats.pairs, 4);
    assert.strictEqual(stats.hits, 2);
    assert.strictEqual(stats.misses, 2);
    await rr('gate code', [...chunks, { messageId: 'm-3', idx: 1, text: 'gate' }]);
    assert.deepStrictEqual(scorer.calls, [2, 1], 'a new chunk alone is scored');
  });

  it('names the no-save install when transformers.js is missing', async () => {
    const load = () => { const e = new Error('Cannot find module'); e.code = 'MODULE_NOT_FOUND'; throw e; };
    await assert.rejects(loadCrossEncoder({ load }), (err) => err instanceof UsageError && /npm i --no-save @huggingface\/transformers onnxruntime-node/.test(err.message));
  });
});

describe('kl-recall-rerank', () => {
  async function runAll(adapter, session, questions) {
    const handle = await adapter.prepare(session);
    const shown = [];
    try {
      for (const q of questions) {
        const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
        for (const s of [...r.evidenceSeqsShown, ...r.evidenceSeqsPartial]) assert.ok(s < q.askAtSeq, `${q.id}: seq ${s} >= ${q.askAtSeq}`);
        assert.ok(Number.isFinite(r.latencyMs));
        shown.push(r.evidenceSeqsShown);
      }
    } finally {
      await adapter.release(handle);
    }
    return shown;
  }

  it('BM25 candidates: reranks, never shows seq >= askAtSeq, and a second run is served from the cache', async () => {
    const { home } = setupHome();
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const questions = await readQuestions(questionsFile(home.root, 'synth-small'));
    const scorer = fakeScorer();
    const first = createKlRecallRerankAdapter({ tmpRoot: home.tmp, privateRoot: home.private, recall: { ...REF, rerank: { topM: 5 } }, scorer });
    assert.strictEqual(first.describe().recall.rerank.enabled, true);
    assert.strictEqual(first.describe().recall.rerank.topM, 5);
    const a = await runAll(first, session, questions);
    assert.ok(scorer.calls.length > 0 && scorer.calls.every((n) => n <= 5), 'at most topM pairs per question');
    assert.ok(first.stats.misses > 0);
    assert.ok(fs.readdirSync(path.join(home.private, 'rerank', 'synth-small')).length > 0);
    const second = createKlRecallRerankAdapter({ tmpRoot: home.tmp, privateRoot: home.private, recall: { ...REF, rerank: { topM: 5 } }, scorer: failingScorer() });
    const b = await runAll(second, session, questions);
    assert.deepStrictEqual(b, a);
    assert.strictEqual(second.stats.misses, 0);
    assert.deepStrictEqual(fs.readdirSync(home.tmp), [], 'temp stores are removed');
  });

  it('fused candidates: BM25 with cached cosine, then the rerank; no embedding call', async () => {
    const { env, home } = setupHome();
    const embedder = fakeEmbedder();
    const ctx = { home, env, stdout: sink(), stderr: sink(), now: () => new Date(), cwd: process.cwd() };
    assert.strictEqual(await embedCommand.run(ctx, { session: 'synth-small', provider: 'openai', model: 'fake-embed-1' }, [], { providerInstance: embedder }), 0);
    const calls = embedder.calls.length;
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const questions = await readQuestions(questionsFile(home.root, 'synth-small'));
    const scorer = fakeScorer();
    const adapter = createAdapter('kl-recall-vec-rerank', {
      tmpRoot: home.tmp, privateRoot: home.private, model: 'fake-embed-1', providerInstance: embedder, scorer, recall: REF
    });
    assert.strictEqual(adapter.name, 'kl-recall-vec-rerank');
    assert.strictEqual(adapter.describe().candidates, 'fused');
    await runAll(adapter, session, questions);
    assert.ok(scorer.calls.length > 0 && scorer.calls.every((n) => n <= 20), 'topM defaults to 20');
    assert.strictEqual(embedder.calls.length, calls);
  });

  it('is created by name and refuses unknown candidates', () => {
    const { home } = setupHome();
    const a = createAdapter('kl-recall-rerank', { tmpRoot: home.tmp, privateRoot: home.private });
    assert.strictEqual(a.name, 'kl-recall-rerank');
    assert.strictEqual(a.describe().candidates, 'bm25');
    assert.throws(() => createKlRecallRerankAdapter({ tmpRoot: home.tmp, privateRoot: home.private, candidates: 'cosine' }), /bm25 or fused/);
    assert.throws(() => createKlRecallRerankAdapter({ tmpRoot: home.tmp }), /privateRoot/);
  });
});

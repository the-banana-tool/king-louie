// tests/longhaul-local-rerank.test.js
// kl-recall-llm-rerank (local inference spec 2026-10-13 §11.3; R-LI-14):
// recall spec §6.3 step 6 with a local model scoring the same top candidates
// the cross-encoder gets, pointwise (a 0 to 10 score per chunk) or listwise
// (one ranking per batch of 20). Scores are cached by RerankCache under
// private/rerank/<session>/<model>-llm-<mode>…/, cache-only in the answer
// stage. A fake local client stands in for the model; synthetic fixtures.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { RUN_STOP_CODES } = require('../src/longhaul/run');
const { parsePointwise, parseListwise } = require('../src/longhaul/adapters/kl-recall-llm-rerank');
const { FIXTURE_ROOT, tmpHome } = require('./helpers/longhaul-helpers');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const REF = { rerank: { topM: 8 } };

function fakeLocal(replyFor) {
  const calls = [];
  return {
    provider: 'fake', model: 'm', local: true, calls,
    async complete(prompt, { maxTokens } = {}) {
      calls.push({ prompt, maxTokens });
      return { text: replyFor(prompt), llmMetrics: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    }
  };
}

// Pointwise: 9 for a passage holding the keyword, else 1.
const passageOf = (prompt) => (/<passage>\n([\s\S]*?)\n<\/passage>/.exec(prompt) || [])[1] || '';
const byKeyword = (word) => (prompt) => (passageOf(prompt).toLowerCase().includes(word) ? '9' : '1');

const newHome = () => ensureDirs(resolveHome(tmpHome().env));

async function fixture(id = 'synth-small') {
  const session = await loadSession(sessionDir(FIXTURE_ROOT, id));
  const questions = await readQuestions(questionsFile(FIXTURE_ROOT, id));
  return { session, questions };
}

async function contexts(adapter, session, questions) {
  const handle = await adapter.prepare(session, { questionCount: questions.length });
  const out = [];
  try {
    for (const q of questions) out.push(await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq }));
  } finally {
    await adapter.release(handle);
  }
  return out;
}

// A scorer that records what it was asked, for the cross-encoder adapter.
function recordingScorer(score = () => 0.5) {
  const asked = [];
  return { asked, async score(query, texts) { asked.push({ query, texts }); return texts.map(score); } };
}

const make = (home, local, extra = {}) => createAdapter('kl-recall-llm-rerank', { tmpRoot: home.tmp, privateRoot: home.private, recall: REF, local, ...extra });

describe('kl-recall-llm-rerank', () => {
  it('is registered, beside the fused variant', () => {
    for (const name of ['kl-recall-llm-rerank', 'kl-recall-vec-llm-rerank']) assert.ok(adapterNames().includes(name), name);
  });

  it('pointwise: the reranked order is the keyword order, not the fused one', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const q = questions[0];
    const plainScorer = recordingScorer();
    const fused = await contexts(createAdapter('kl-recall-rerank', { tmpRoot: home.tmp, privateRoot: home.private, recall: REF, scorer: plainScorer }), session, [q]);
    const candidates = plainScorer.asked[0].texts;
    // The keyword: a word of the last candidate the fused order holds, and of no other.
    const words = (t) => new Set(t.toLowerCase().match(/[a-z]{5,}/g) || []);
    const others = new Set(candidates.slice(0, -1).flatMap((t) => [...words(t)]));
    const word = [...words(candidates[candidates.length - 1])].find((w) => !others.has(w));
    assert.ok(word, 'the fixture gives the last candidate a word of its own');
    const client = fakeLocal(byKeyword(word));
    const adapter = make(home, { client, cache: null });
    const [r] = await contexts(adapter, session, [q]);
    assert.ok(fused[0].text && r.text);
    assert.strictEqual(client.calls.length, candidates.length, 'one call per candidate');
    assert.ok(client.calls.every((c) => c.maxTokens === 4));
    const st = adapter.runStats();
    assert.deepStrictEqual([st.mode, st.calls, st.unparsed], ['pointwise', candidates.length, 0]);
    // The scores the retriever sorts by: the keyword's candidate first.
    const scores = await adapter.scorer.score(q.question, candidates);
    const order = candidates.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
    assert.strictEqual(order[0], candidates.length - 1);
    assert.notDeepStrictEqual(order, candidates.map((_, i) => i));
  });

  it('is given the same candidates as the cross-encoder adapter', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const plainScorer = recordingScorer();
    await contexts(createAdapter('kl-recall-rerank', { tmpRoot: home.tmp, privateRoot: home.private, recall: REF, scorer: plainScorer }), session, questions);
    const client = fakeLocal(() => '5');
    await contexts(make(home, { client, cache: null }), session, questions);
    const passages = client.calls.map((c) => passageOf(c.prompt));
    assert.ok(passages.length > questions.length, 'several candidates per question');
    assert.deepStrictEqual(passages, plainScorer.asked.flatMap((a) => a.texts));
  });

  it('pointwise: a reply that is not 0 to 10 scores 0 and is counted', async () => {
    assert.deepStrictEqual(['7', ' 10 ', '0', '11', 'seven', '7.5', '-1', ''].map(parsePointwise), [7, 10, 0, null, null, null, null, null]);
    const home = newHome();
    const { session, questions } = await fixture();
    const adapter = make(home, { client: fakeLocal(() => 'very relevant'), cache: null });
    await contexts(adapter, session, [questions[0]]);
    assert.ok(adapter.runStats().unparsed > 0);
    assert.strictEqual(adapter.runStats().unparsed, adapter.runStats().calls);
  });

  it('listwise: one call per batch; what the reply leaves out keeps its fused order after what it named', async () => {
    assert.deepStrictEqual(parseListwise('3, 1, 3, 9, 0', 4), [3, 1]);
    assert.deepStrictEqual(parseListwise('none of them', 4), []);
    const home = newHome();
    const { session, questions } = await fixture();
    const q = questions[0];
    const plainScorer = recordingScorer();
    await contexts(createAdapter('kl-recall-rerank', { tmpRoot: home.tmp, privateRoot: home.private, recall: REF, scorer: plainScorer }), session, [q]);
    const candidates = plainScorer.asked[0].texts;
    // Names passage 3 alone.
    const client = fakeLocal(() => '3');
    const adapter = make(home, { client, cache: null }, { llmRerankMode: 'listwise' });
    const scores = await adapter.scorer.score(q.question, candidates);
    assert.strictEqual(client.calls.length, Math.ceil(candidates.length / 20));
    assert.ok(client.calls.every((c) => c.maxTokens === 128));
    const order = candidates.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    assert.deepStrictEqual(order, [2, ...candidates.map((_, i) => i).filter((i) => i !== 2)]);
  });

  it('listwise: batches of 20, and a later batch never outranks an earlier one', async () => {
    const adapter = make(newHome(), { client: fakeLocal(() => '2, 1'), cache: null }, { llmRerankMode: 'listwise' });
    const texts = Array.from({ length: 45 }, (_, i) => `passage ${i}`);
    const scores = await adapter.scorer.score('q', texts);
    const order = texts.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    assert.deepStrictEqual(order.slice(0, 4), [1, 0, 2, 3]);
    assert.deepStrictEqual(order.slice(20, 22), [21, 20]);
    assert.deepStrictEqual(order.slice(40, 42), [41, 40]);
  });

  it('a second run reads the cache and makes no call; the cache is under private/rerank', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const first = fakeLocal(() => '5');
    await contexts(make(home, { client: first, cache: null }), session, questions);
    assert.ok(first.calls.length > 0);
    const dir = path.join(home.private, 'rerank', 'synth-small');
    const [cacheDir] = fs.readdirSync(dir).filter((d) => d.includes('-llm-pointwise'));
    assert.ok(cacheDir && cacheDir.startsWith('m-'), cacheDir);
    const second = fakeLocal(() => '5');
    const adapter = make(home, { client: second, cache: null });
    await contexts(adapter, session, questions);
    assert.strictEqual(second.calls.length, 0);
    assert.strictEqual(adapter.runStats().rerank.hits, adapter.runStats().rerank.pairs);
  });

  it('another digest, mode or server is another cache', () => {
    const home = newHome();
    const base = { ...fakeLocal(() => '5'), baseUrl: 'http://127.0.0.1:11434', digest: `sha256:${'a'.repeat(64)}` };
    const name = (client, extra) => make(home, { client, cache: null }, extra).describe().rerankCache;
    const a = name(base);
    assert.notStrictEqual(a, name({ ...base, digest: `sha256:${'b'.repeat(64)}` }));
    assert.notStrictEqual(a, name({ ...base, baseUrl: 'http://127.0.0.1:8080' }));
    assert.notStrictEqual(a, name(base, { llmRerankMode: 'listwise' }));
    assert.strictEqual(a, name({ ...base }));
    assert.match(a, /-llm-pointwise$/);
  });

  it('cachedOnly: a miss stops the question with LOCAL_CALLS_MISSING, and nothing is called', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const client = fakeLocal(() => '5');
    const adapter = make(home, { client, cache: null, cachedOnly: true });
    const handle = await adapter.prepare(session, {});
    try {
      await assert.rejects(adapter.context(handle, { question: questions[0], askAtSeq: questions[0].askAtSeq }),
        (err) => err instanceof UsageError && err.code === 'LOCAL_CALLS_MISSING');
    } finally {
      await adapter.release(handle);
    }
    assert.strictEqual(client.calls.length, 0);
    assert.ok(RUN_STOP_CODES.has('LOCAL_CALLS_MISSING'));
  });

  it('a changed query (the rewrite in front of it) is a cache miss', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const first = fakeLocal(() => '5');
    await contexts(make(home, { client: first, cache: null }), session, [questions[0]]);
    const second = fakeLocal(() => '5');
    await contexts(make(home, { client: second, cache: null }, { queryFor: async () => 'amber-tapir retry limit' }), session, [questions[0]]);
    assert.ok(second.calls.length > 0, 'the rewritten query is scored afresh');
  });

  it('describe() carries the mode, the local model, its digest and the prompt', () => {
    const home = newHome();
    const client = { ...fakeLocal(() => '5'), digest: 'sha256:00' };
    const a = make(home, { client, cache: null }).describe();
    const b = make(home, { client, cache: null }, { llmRerankMode: 'listwise' }).describe();
    assert.strictEqual(a.name, 'kl-recall-llm-rerank');
    assert.strictEqual(a.llmRerankMode, 'pointwise');
    assert.strictEqual(a.localModel, 'fake/m');
    assert.strictEqual(a.localDigest, 'sha256:00');
    assert.match(a.rerankPromptSha256, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(a.rerankPromptSha256, b.rerankPromptSha256);
    assert.throws(() => make(home, { client, cache: null }, { llmRerankMode: 'both' }), UsageError);
  });
});

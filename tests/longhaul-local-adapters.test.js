// tests/longhaul-local-adapters.test.js
// kl-recall-rewrite and kl-recall-abstain-check (local inference spec
// 2026-10-13 §11.2, §11.3; R-LI-14): a local model rewrites the question
// into the search query, or says whether the built context holds the
// answer. Their calls are cached (stages rewrite, abstain-check), cache-only
// in the answer stage, and change no history.recall default. A fake local
// client stands in for the model; synthetic fixtures; no network.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// The recall defaults on main (CLAUDE.md, History): taken before any adapter
// is loaded, and compared after the adapters have run.
const { HISTORY_DEFAULTS } = require('../src/history/settings');
const DEFAULTS_BEFORE = JSON.stringify(HISTORY_DEFAULTS);
const MAIN_RECALL_DEFAULTS = Object.freeze({ tailUserTurns: 4, bm25TopK: 200, queryUserTurns: 0, rerankEnabled: false, dedupeCosine: 0.92 });

const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { runBenchmark, RUN_STOP_CODES } = require('../src/longhaul/run');
const { ModelCache, STAGES } = require('../src/longhaul/model-cache');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { FIXTURE_ROOT, tmpDir, tmpHome } = require('./helpers/longhaul-helpers');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const NOTE = '[check] The context below likely does not contain the answer.';

function fakeLocal(replyFor) {
  const calls = [];
  return {
    provider: 'fake', model: 'm', local: true, calls,
    async complete(prompt, { maxTokens } = {}) {
      calls.push({ prompt, maxTokens });
      const text = typeof replyFor === 'function' ? replyFor(prompt) : replyFor;
      return { text, llmMetrics: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    }
  };
}

const newHome = () => ensureDirs(resolveHome(tmpHome().env));
const newCache = () => new ModelCache(path.join(tmpDir(), 'model-cache'));

async function fixture(id = 'synth-small') {
  const session = await loadSession(sessionDir(FIXTURE_ROOT, id));
  const questions = await readQuestions(questionsFile(FIXTURE_ROOT, id));
  return { session, questions };
}

// Every question's context; the store's BM25 queries recorded per question.
async function contexts(adapter, session, questions) {
  const handle = await adapter.prepare(session, { questionCount: questions.length });
  const searched = [];
  const original = handle.store.searchText.bind(handle.store);
  let current = null;
  handle.store.searchText = (query, options) => {
    if (current && !options?.messageIds) current.push(query);
    return original(query, options);
  };
  const out = [];
  try {
    for (const q of questions) {
      current = [];
      const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
      for (const s of [...r.evidenceSeqsShown, ...r.evidenceSeqsPartial]) assert.ok(s < q.askAtSeq, `seq ${s} leaked into ${q.id}`);
      searched.push(current);
      out.push(r);
    }
  } finally {
    await adapter.release(handle);
  }
  return { out, searched };
}

const make = (name, home, local, extra = {}) => createAdapter(name, { tmpRoot: home.tmp, local, ...extra });

describe('the local adapters', () => {
  it('are registered, and their stages and stop code exist', () => {
    for (const name of ['kl-recall-rewrite', 'kl-recall-abstain-check']) assert.ok(adapterNames().includes(name), name);
    for (const stage of ['rewrite', 'abstain-check']) assert.ok(STAGES.includes(stage), stage);
    assert.ok(RUN_STOP_CODES.has('LOCAL_CALLS_MISSING'));
  });

  it('refuse without a local client, or with one that is not local', () => {
    const home = newHome();
    assert.throws(() => make('kl-recall-rewrite', home, null), (err) => err instanceof UsageError && err.code === 'LOCAL_REQUIRED');
    const hosted = { ...fakeLocal('x'), local: false };
    assert.throws(() => make('kl-recall-abstain-check', home, { client: hosted, cache: newCache() }), (err) => err.code === 'LOCAL_REQUIRED');
  });
});

describe('kl-recall-rewrite', () => {
  it('R-LI-14: rewrite passes the rewritten query to the builder', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const client = fakeLocal('amber-tapir retry limit');
    const adapter = make('kl-recall-rewrite', home, { client, cache: newCache() });
    const { searched } = await contexts(adapter, session, questions);
    for (const queries of searched) assert.deepStrictEqual(queries, ['amber-tapir retry limit']);
    assert.strictEqual(client.calls.length, questions.length);
    assert.ok(client.calls.every((c) => c.maxTokens === 64));
    assert.ok(client.calls[0].prompt.includes(questions[0].question));
    const st = adapter.runStats();
    assert.deepStrictEqual([st.calls, st.cacheHits, st.fallbacks, st.mode], [questions.length, 0, 0, 'replace']);
  });

  it('append mode searches with the question and the rewrite', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const adapter = make('kl-recall-rewrite', home, { client: fakeLocal('"amber-tapir retry"\nmore words'), cache: newCache() }, { rewriteMode: 'append' });
    const { searched } = await contexts(adapter, session, questions);
    questions.forEach((q, i) => assert.deepStrictEqual(searched[i], [`${q.question}\namber-tapir retry`]));
  });

  it('a second run with the same settings makes no call', async () => {
    const home = newHome();
    const cache = newCache();
    const { session, questions } = await fixture();
    const first = fakeLocal('amber-tapir');
    await contexts(make('kl-recall-rewrite', home, { client: first, cache }), session, questions);
    const second = fakeLocal('amber-tapir');
    const adapter = make('kl-recall-rewrite', home, { client: second, cache });
    const { searched } = await contexts(adapter, session, questions);
    assert.strictEqual(second.calls.length, 0);
    assert.deepStrictEqual(searched[0], ['amber-tapir']);
    assert.strictEqual(adapter.runStats().cacheHits, questions.length);
  });

  it('cachedOnly with an empty cache stops with LOCAL_CALLS_MISSING, and nothing is called', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const client = fakeLocal('x');
    const adapter = make('kl-recall-rewrite', home, { client, cache: newCache(), cachedOnly: true });
    const handle = await adapter.prepare(session, {});
    try {
      await assert.rejects(adapter.context(handle, { question: questions[0], askAtSeq: questions[0].askAtSeq }),
        (err) => err instanceof UsageError && err.code === 'LOCAL_CALLS_MISSING' && /evidence-only run/.test(err.message));
    } finally {
      await adapter.release(handle);
    }
    assert.strictEqual(client.calls.length, 0);
  });

  it('an empty reply falls back to the question and is counted', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const adapter = make('kl-recall-rewrite', home, { client: fakeLocal('  \n '), cache: newCache() });
    const { searched } = await contexts(adapter, session, questions);
    questions.forEach((q, i) => assert.deepStrictEqual(searched[i], [q.question]));
    assert.strictEqual(adapter.runStats().fallbacks, questions.length);
  });

  it('describe() names the local model, the mode and the prompt, so each is in cfg:', () => {
    const home = newHome();
    const local = { client: { ...fakeLocal('x'), digest: 'sha256:00' }, cache: newCache() };
    const a = make('kl-recall-rewrite', home, local).describe();
    const b = make('kl-recall-rewrite', home, local, { rewriteMode: 'append' }).describe();
    assert.strictEqual(a.name, 'kl-recall-rewrite');
    assert.strictEqual(a.localModel, 'fake/m');
    assert.strictEqual(a.localDigest, 'sha256:00');
    assert.match(a.rewritePromptSha256, /^[0-9a-f]{64}$/);
    assert.notDeepStrictEqual(a, b);
    assert.throws(() => make('kl-recall-rewrite', home, local, { rewriteMode: 'both' }), UsageError);
  });
});

describe('kl-recall-abstain-check', () => {
  it('R-LI-14: the abstain check in note mode adds the line and leaves evidence accounting alone', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const plain = await contexts(createAdapter('kl-recall', { tmpRoot: home.tmp }), session, questions);
    const client = fakeLocal('No.');
    const adapter = make('kl-recall-abstain-check', home, { client, cache: newCache() });
    const { out } = await contexts(adapter, session, questions);
    out.forEach((r, i) => {
      assert.ok(r.text.startsWith(`${NOTE}\n\n`), 'the note is above the context');
      assert.strictEqual(r.text.slice(NOTE.length + 2), plain.out[i].text);
      assert.deepStrictEqual(r.evidenceSeqsShown, plain.out[i].evidenceSeqsShown);
      assert.deepStrictEqual(r.evidenceSeqsPartial, plain.out[i].evidenceSeqsPartial);
      assert.deepStrictEqual(r.chunks, plain.out[i].chunks);
    });
    assert.ok(client.calls[0].prompt.includes(plain.out[0].text), 'the check reads the built context');
    const st = adapter.runStats();
    assert.deepStrictEqual([st.calls, st.no, st.yes, st.unparsed, st.mode], [questions.length, questions.length, 0, 0, 'note']);
  });

  it('a yes leaves the context as kl-recall built it', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const plain = await contexts(createAdapter('kl-recall', { tmpRoot: home.tmp }), session, questions);
    const { out } = await contexts(make('kl-recall-abstain-check', home, { client: fakeLocal('yes'), cache: newCache() }), session, questions);
    out.forEach((r, i) => assert.strictEqual(r.text, plain.out[i].text));
  });

  it('an unparsed reply counts as yes', async () => {
    const home = newHome();
    const { session, questions } = await fixture();
    const adapter = make('kl-recall-abstain-check', home, { client: fakeLocal('Probably not, the context is about something else.'), cache: newCache() }, { abstainMode: 'withhold' });
    const { out } = await contexts(adapter, session, questions);
    assert.ok(out.every((r) => r.text && !r.text.startsWith(NOTE)));
    assert.strictEqual(adapter.runStats().unparsed, questions.length);
  });

  it('withhold shows nothing and scores evidence recall 0 for that question', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    const adapter = make('kl-recall-abstain-check', home, { client: fakeLocal('no'), cache: newCache() }, { abstainMode: 'withhold' });
    const result = await runBenchmark({ home, dataRoot: FIXTURE_ROOT, sessionIds: ['synth-small'], adapters: [adapter], commit: 'test' });
    assert.ok(result.records.length > 0);
    for (const r of result.records) {
      assert.strictEqual(r.error, null);
      assert.deepStrictEqual(r.evidenceSeqsShown, []);
      assert.deepStrictEqual(r.evidenceSeqsPartial, []);
      // An abstain question has no evidence, so no evidence recall at all.
      assert.strictEqual(r.evidenceRecall, r.evidenceSeqs.length ? 0 : null);
      assert.strictEqual(r.estTokens, 0);
    }
    assert.ok(result.records.some((r) => r.evidenceSeqs.length > 0));
    assert.strictEqual(result.adapterStats['kl-recall-abstain-check'].withheld, result.records.length);
  });

  it('describe() differs between modes', () => {
    const home = newHome();
    const local = { client: fakeLocal('x'), cache: newCache() };
    const a = make('kl-recall-abstain-check', home, local).describe();
    const b = make('kl-recall-abstain-check', home, local, { abstainMode: 'withhold' }).describe();
    assert.strictEqual(a.abstainMode, 'note');
    assert.match(a.abstainPromptSha256, /^[0-9a-f]{64}$/);
    assert.notDeepStrictEqual(a, b);
  });
});

describe('no leak, and no default changed', () => {
  it('the fixtures\' askAtSeq rule holds for both adapters over every session', async () => {
    const { env } = tmpHome();
    const home = ensureDirs(resolveHome(env));
    const adapters = [
      make('kl-recall-rewrite', home, { client: fakeLocal('port worker retry'), cache: newCache() }),
      make('kl-recall-abstain-check', home, { client: fakeLocal('no'), cache: newCache() })
    ];
    const result = await runBenchmark({ home, dataRoot: FIXTURE_ROOT, adapters, commit: 'test' });
    assert.strictEqual(result.leaks, 0);
    assert.ok(result.records.every((r) => r.error === null));
  });

  it('R-LI-14: no history.recall default changed', () => {
    const r = HISTORY_DEFAULTS.recall;
    assert.deepStrictEqual(
      { tailUserTurns: r.tailUserTurns, bm25TopK: r.bm25TopK, queryUserTurns: r.queryUserTurns, rerankEnabled: r.rerank.enabled, dedupeCosine: r.dedupeCosine },
      MAIN_RECALL_DEFAULTS
    );
    assert.strictEqual(JSON.stringify(HISTORY_DEFAULTS), DEFAULTS_BEFORE, 'loading and running the adapters changed nothing');
  });
});

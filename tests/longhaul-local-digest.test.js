// tests/longhaul-local-digest.test.js
// kl-recall-digest (local inference spec 2026-10-13 §11.3; R-LI-14): every
// digestEveryTokens a local model writes a digest of that span, kept in the
// temporary store as extra recall material (a summary chunk in a chat of
// its own). A digest is never shown for a question asked at or before the
// end of its span, is never evidence (D-LI-4), and is never a message of the
// session. A fake local client stands in for the model; synthetic fixtures.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createAdapter, adapterNames } = require('../src/longhaul/adapters');
const { runBenchmark } = require('../src/longhaul/run');
const runCommand = require('../src/longhaul/commands/run');
const { ModelCache, STAGES } = require('../src/longhaul/model-cache');
const { evidenceRecall } = require('../src/longhaul/scoring');
const { loadSession, sessionDir } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { UsageError } = require('../src/longhaul/errors');
const { FIXTURE_ROOT, tmpDir, tmpHome, sink } = require('./helpers/longhaul-helpers');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const MARK = 'zebracorn';

function fakeLocal(text = `${MARK} digest of this stretch`) {
  const calls = [];
  return {
    provider: 'fake', model: 'm', local: true, calls,
    async complete(prompt, { maxTokens } = {}) {
      calls.push({ prompt, maxTokens });
      return { text, llmMetrics: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    }
  };
}

const newHome = () => ensureDirs(resolveHome(tmpHome().env));
const newCache = () => new ModelCache(path.join(tmpDir(), 'model-cache'));
const make = (home, local, extra = {}) => createAdapter('kl-recall-digest', { tmpRoot: home.tmp, local, digestEveryTokens: 2000, ...extra });

async function fixture(id = 'synth-small') {
  const session = await loadSession(sessionDir(FIXTURE_ROOT, id));
  const questions = await readQuestions(questionsFile(FIXTURE_ROOT, id));
  return { session, questions };
}

describe('kl-recall-digest', () => {
  it('is registered; its stage exists', () => {
    assert.ok(adapterNames().includes('kl-recall-digest'));
    assert.ok(STAGES.includes('digest'));
  });

  it('makes a digest every digestEveryTokens, over messages before upToSeq only, and caches them', async () => {
    const home = newHome();
    const cache = newCache();
    const { session } = await fixture();
    const client = fakeLocal();
    const adapter = make(home, { client, cache });
    const upToSeq = session.index.maxSeq - 10;
    const handle = await adapter.prepare(session, { upToSeq });
    try {
      assert.ok(handle.digests.length >= 2, `${handle.digests.length} digests`);
      let from = 1;
      for (const d of handle.digests) {
        assert.strictEqual(d.fromSeq, from);
        assert.ok(d.toSeq < upToSeq, 'a digest never covers a message at or after upToSeq');
        from = d.toSeq + 1;
      }
      assert.strictEqual(client.calls.length, handle.digests.length);
      assert.ok(client.calls.every((c) => c.maxTokens === 400));
      // The session's chat holds the session's messages and nothing else.
      assert.strictEqual(handle.store.lastSeq(handle.chatId), upToSeq - 1);
    } finally {
      await adapter.release(handle);
    }
    const again = fakeLocal();
    const second = make(home, { client: again, cache });
    await second.release(await second.prepare(session, { upToSeq }));
    assert.strictEqual(again.calls.length, 0, 'the second run reads every digest from the cache');
    assert.strictEqual(second.runStats().cacheHits, client.calls.length);
  });

  it('a digest appears in the context for a late question and not for one asked inside its span', async () => {
    const home = newHome();
    const { session } = await fixture();
    const adapter = make(home, { client: fakeLocal(), cache: newCache() });
    const handle = await adapter.prepare(session, { upToSeq: session.index.maxSeq + 1 });
    try {
      const [first] = handle.digests;
      const inside = await adapter.context(handle, { question: { id: 'q-in', question: MARK }, askAtSeq: first.toSeq });
      assert.ok(!inside.text.includes(MARK), 'the first digest ends at the question: not shown');
      assert.deepStrictEqual(inside.coveredSeqs, []);
      const lateAt = handle.digests[handle.digests.length - 1].toSeq + 1;
      const late = await adapter.context(handle, { question: { id: 'q-late', question: MARK }, askAtSeq: lateAt });
      assert.ok(late.text.includes(MARK), 'a digest is recalled for a later question');
      assert.ok(late.coveredSeqs.length > 0);
      assert.ok(late.coveredSeqs.every((s) => s < lateAt));
      assert.ok(late.digestsShown >= 1);
    } finally {
      await adapter.release(handle);
    }
  });

  it('R-LI-14: a digest is not evidence', async () => {
    const home = newHome();
    const { session } = await fixture();
    const adapter = make(home, { client: fakeLocal(), cache: newCache() });
    const handle = await adapter.prepare(session, { upToSeq: session.index.maxSeq + 1 });
    try {
      const lateAt = handle.digests[handle.digests.length - 1].toSeq + 1;
      const r = await adapter.context(handle, { question: { id: 'q-late', question: MARK }, askAtSeq: lateAt });
      const shown = new Set([...r.evidenceSeqsShown, ...r.evidenceSeqsPartial]);
      const onlyDigested = r.coveredSeqs.find((s) => !shown.has(s));
      assert.ok(onlyDigested, 'some message is covered by a shown digest and not shown itself');
      // A question whose evidence is that message scores 0, and 0 partial.
      assert.strictEqual(evidenceRecall([onlyDigested], r.evidenceSeqsShown), 0);
      assert.ok(!r.evidenceSeqsPartial.includes(onlyDigested));
    } finally {
      await adapter.release(handle);
    }
  });

  it('the leak check passes on the fixtures, and fails (exit 1) when the filter is removed', async () => {
    // A digest that repeats its window's words is found by the questions.
    const echo = () => {
      const calls = [];
      return {
        provider: 'fake', model: 'echo', local: true, calls,
        async complete(prompt) {
          calls.push(prompt);
          const words = prompt.slice(prompt.indexOf('Messages #')).match(/[A-Za-z0-9-]{3,}/g) || [];
          return { text: words.slice(0, 300).join(' '), llmMetrics: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
        }
      };
    };
    const home = newHome();
    const good = make(home, { client: echo(), cache: newCache() });
    const ok = await runBenchmark({ home, dataRoot: FIXTURE_ROOT, adapters: [good], commit: 'test' });
    assert.strictEqual(ok.leaks, 0);
    assert.ok(ok.records.every((r) => r.error === null));
    assert.strictEqual(runCommand.exitCodeFor(ok, sink()), 0);

    const broken = make(newHome(), { client: echo(), cache: newCache() }, { digestAllowed: () => true });
    const home2 = newHome();
    const bad = await runBenchmark({ home: home2, dataRoot: FIXTURE_ROOT, adapters: [broken], commit: 'test' });
    assert.ok(bad.leaks > 0, 'a digest of a span reaching the question is caught by the leak check');
    assert.strictEqual(runCommand.exitCodeFor(bad, sink()), 1);
  });

  it('the answer stage is cache-only: a digest not cached stops with LOCAL_CALLS_MISSING', async () => {
    const home = newHome();
    const { session } = await fixture();
    const client = fakeLocal();
    const adapter = make(home, { client, cache: newCache(), cachedOnly: true });
    await assert.rejects(adapter.prepare(session, {}), (err) => err instanceof UsageError && err.code === 'LOCAL_CALLS_MISSING');
    assert.strictEqual(client.calls.length, 0);
  });

  it('an empty digest is skipped and counted, and describe() carries the interval, the model and the prompt', async () => {
    const home = newHome();
    const { session } = await fixture();
    const adapter = make(home, { client: { ...fakeLocal('  '), digest: 'sha256:00' }, cache: newCache() });
    const handle = await adapter.prepare(session, {});
    try {
      assert.strictEqual(handle.digests.length, 0);
    } finally {
      await adapter.release(handle);
    }
    assert.ok(adapter.runStats().empty > 0);
    const d = adapter.describe();
    assert.deepStrictEqual([d.name, d.digestEveryTokens, d.digestMaxTokens, d.localModel, d.localDigest], ['kl-recall-digest', 2000, 400, 'fake/m', 'sha256:00']);
    assert.match(d.digestPromptSha256, /^[0-9a-f]{64}$/);
    assert.throws(() => make(home, { client: fakeLocal(), cache: newCache() }, { digestEveryTokens: 0 }), UsageError);
  });
});

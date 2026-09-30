// tests/longhaul-embed.test.js
// The H3 probe: `longhaul embed`'s cache, the command's refusals and resume,
// and the kl-recall-vec adapter (fused and vector-only). Synthetic fixtures
// and a fake embedder only; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { main } = require('../src/longhaul/cli');
const embedCommand = require('../src/longhaul/commands/embed');
const { resolveHome, ensureDirs } = require('../src/longhaul/home');
const { SYNTH_FIXTURES, writeSyntheticRoot } = require('../src/longhaul/synthetic');
const { loadSession, sessionDir, messageText } = require('../src/longhaul/session-format');
const { readQuestions, questionsFile } = require('../src/longhaul/questions');
const { createAdapter } = require('../src/longhaul/adapters');
const { createKlRecallVecAdapter } = require('../src/longhaul/adapters/kl-recall-vec');
const { UsageError } = require('../src/longhaul/errors');
const {
  EmbeddingCache, cacheDir, toBytes, fromBytes, batches, topByCosine, createEmbedClient, MAX_EMBED_CHARS, embedText
} = require('../src/longhaul/embeddings');
const { fakeEmbedder, fakeVector, startFakeEmbeddingServer, DIM } = require('./helpers/fake-embedding-server');
const { tmpDir, tmpHome, sink } = require('./helpers/longhaul-helpers');

const KEY = 'test-key-123456';

function makePrivate(root, sessionId) {
  const file = path.join(root, 'sessions', sessionId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, private: true, license: 'private' }, null, 2)}\n`);
}

function setupHome(fixtures = [SYNTH_FIXTURES[0]]) {
  const { env, root } = tmpHome();
  writeSyntheticRoot(root, fixtures);
  const home = ensureDirs(resolveHome(env));
  return { env, root, home };
}

function ctxFor(home, env) {
  return { home, env, stdout: sink(), stderr: sink(), now: () => new Date(), cwd: process.cwd() };
}

describe('embedding cache', () => {
  it('stores little-endian float32', () => {
    assert.deepStrictEqual([...toBytes([1])], [0x00, 0x00, 0x80, 0x3f]);
    assert.deepStrictEqual([...fromBytes(toBytes([0.5, -2]))], [0.5, -2]);
  });

  it('round-trips rows, vectors and questions, and cuts a torn tail on reopen', () => {
    const dir = path.join(tmpDir(), 'cache');
    const cache = EmbeddingCache.open(dir);
    cache.init({ model: 'm', provider: 'openai', dim: null, chunk: { targetChars: 1500, minChars: 40 }, sessionId: 's' });
    const vecs = [[1, 0, 0.25], [0, 1, -0.5]];
    cache.append([{ messageId: 'a', idx: 0, chars: 10, truncated: false }, { messageId: 'b', idx: 1, chars: 20, truncated: true }], vecs, { tokens: 7 });
    cache.addQuestion('q1', 'Which gate code?', [0.5, 0.5, 0]);

    const again = EmbeddingCache.open(dir);
    assert.strictEqual(again.dim, 3);
    assert.strictEqual(again.meta.tokens, 7);
    assert.deepStrictEqual(again.rows.map((r) => [r.messageId, r.idx, r.truncated]), [['a', 0, false], ['b', 1, true]]);
    assert.deepStrictEqual([...again.vector(again.rowOf('b', 1))], [0, 1, -0.5]);
    assert.deepStrictEqual([...again.question('q1', 'Which gate code?')], [0.5, 0.5, 0]);
    assert.strictEqual(again.question('q1', 'A changed question?'), null, 'a changed question text is not a cache hit');

    // A crash after the vectors were written but before their index lines.
    fs.appendFileSync(path.join(dir, 'vectors.f32'), toBytes([9, 9, 9]));
    const torn = EmbeddingCache.open(dir);
    assert.strictEqual(torn.rows.length, 2);
    torn.init({ model: 'm', provider: 'openai', dim: null, chunk: { targetChars: 1500, minChars: 40 }, sessionId: 's' });
    torn.append([{ messageId: 'c', idx: 0, chars: 5, truncated: false }], [[0, 0, 1]]);
    const fixed = EmbeddingCache.open(dir);
    assert.deepStrictEqual([...fixed.vector(fixed.rowOf('c', 0))], [0, 0, 1], 'the next append lines up after the cut');
  });

  it('refuses to extend a cache made with other chunk settings', () => {
    const dir = path.join(tmpDir(), 'cache');
    EmbeddingCache.open(dir).init({ model: 'm', provider: 'openai', dim: null, chunk: { targetChars: 1500, minChars: 40 }, sessionId: 's' });
    assert.throws(() => EmbeddingCache.open(dir).init({ model: 'm', provider: 'openai', dim: null, chunk: { targetChars: 900, minChars: 40 }, sessionId: 's' }), UsageError);
  });

  it('batches by count and by characters; truncates long inputs', () => {
    const items = [{ text: 'a'.repeat(10) }, { text: 'b'.repeat(10) }, { text: 'c'.repeat(10) }];
    assert.deepStrictEqual(batches(items, 2).map((b) => b.length), [2, 1]);
    assert.deepStrictEqual(batches(items, 100, 15).map((b) => b.length), [1, 1, 1]);
    const long = embedText('x'.repeat(MAX_EMBED_CHARS + 5));
    assert.strictEqual(long.text.length, MAX_EMBED_CHARS);
    assert.strictEqual(long.truncated, true);
  });

  it('top-k cosine keeps only chunks before upToSeq', () => {
    const index = {
      dim: 2, size: 3,
      matrix: Float32Array.from([1, 0, 0.6, 0.8, 1, 0]),
      chunkIds: Int32Array.from([10, 11, 12]),
      seqs: Int32Array.from([1, 2, 5])
    };
    const hits = topByCosine(index, [1, 0], { upToSeq: 5, k: 5 });
    assert.deepStrictEqual(hits.map((h) => [h.chunkId, h.vectorRank]), [[10, 1], [11, 2]]);
  });

  it('retries 429 and 5xx, not a 400', async () => {
    let n = 0;
    const flaky = { async embed() { n += 1; if (n < 3) throw Object.assign(new Error('busy'), { status: n === 1 ? 429 : 503 }); return { vectors: [[1]], usage: { input: 1 } }; } };
    const client = createEmbedClient({ embedder: flaky, model: 'm', wait: async () => {} });
    assert.deepStrictEqual((await client.embed(['x'])).vectors, [[1]]);
    assert.strictEqual(n, 3);
    const bad = { async embed() { n += 1; throw Object.assign(new Error('bad'), { status: 400 }); } };
    n = 0;
    await assert.rejects(createEmbedClient({ embedder: bad, model: 'm', wait: async () => {} }).embed(['x']), /bad/);
    assert.strictEqual(n, 1);
  });
});

describe('longhaul embed', () => {
  let server;
  before(async () => { server = await startFakeEmbeddingServer(); });
  after(async () => { await server.close(); });

  it('refuses a private session without --send-private: exit 2, no request, no cache', async () => {
    const { env, root } = setupHome();
    makePrivate(root, 'synth-small');
    const stderr = sink();
    const calls = server.requests.length;
    const code = await main(['embed', '--session', 'synth-small', '--provider', 'openai', '--model', 'text-embedding-3-small',
      '--base-url', `${server.url}/v1`], { stdout: sink(), stderr, env: { ...env, OPENAI_API_KEY: KEY } });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /synth-small is private/);
    assert.match(stderr.text, /--send-private/);
    assert.strictEqual(server.requests.length, calls);
    assert.ok(!fs.existsSync(path.join(root, 'private', 'embeddings')));
  });

  it('embeds every chunk and question, prints no text, prices from the catalog, and a re-run sends nothing', async () => {
    const { env, root } = setupHome();
    makePrivate(root, 'synth-small');
    const args = ['embed', '--session', 'synth-small', '--provider', 'openai', '--model', 'text-embedding-3-small',
      '--base-url', `${server.url}/v1`, '--batch', '7', '--send-private'];
    const stdout = sink();
    const stderr = sink();
    const calls = server.requests.length;
    assert.strictEqual(await main(args, { stdout, stderr, env: { ...env, OPENAI_API_KEY: KEY } }), 0, stderr.text);
    const sent = server.requests.slice(calls);
    assert.ok(sent.length > 1 && sent.every((r) => r.inputs <= 7 && r.model === 'text-embedding-3-small'));
    assert.match(stderr.text, /private session synth-small are sent to openai/);
    assert.match(stdout.text, /tokens \d+; cost \$\d+\.\d{4}/);

    const session = await loadSession(sessionDir(root, 'synth-small'));
    for (const m of session.messages) {
      const words = messageText(m).trim();
      if (words.length > 20) assert.ok(!stdout.text.includes(words.slice(0, 20)) && !stderr.text.includes(words.slice(0, 20)), 'no message text is printed');
    }
    const cache = EmbeddingCache.open(cacheDir(path.join(root, 'private'), 'synth-small', 'text-embedding-3-small'));
    assert.strictEqual(cache.rows.length, cache.meta.chunksTotal);
    assert.strictEqual(cache.dim, DIM);
    const questions = await readQuestions(questionsFile(root, 'synth-small'));
    for (const q of questions) assert.ok(cache.question(q.id, q.question), q.id);

    const again = sink();
    const before2 = server.requests.length;
    assert.strictEqual(await main(args, { stdout: again, stderr: sink(), env: { ...env, OPENAI_API_KEY: KEY } }), 0);
    assert.strictEqual(server.requests.length, before2, 'everything was cached');
    assert.match(again.text, /0 to embed\), \d+ questions \(0 to embed\)/);
  });

  it('says the price is unknown for a model the catalog does not price', async () => {
    const { env } = setupHome();
    const stdout = sink();
    const code = await main(['embed', '--session', 'synth-small', '--provider', 'openai', '--model', 'fake-embed-1',
      '--base-url', `${server.url}/v1`], { stdout, stderr: sink(), env: { ...env, OPENAI_API_KEY: KEY } });
    assert.strictEqual(code, 0);
    assert.match(stdout.text, /price unknown/);
    assert.match(stdout.text, /cost unknown/);
  });

  it('refuses before any request when the estimate is over --max-usd', async () => {
    const { env } = setupHome();
    const calls = server.requests.length;
    const stderr = sink();
    const code = await main(['embed', '--session', 'synth-small', '--provider', 'openai', '--model', 'text-embedding-3-small',
      '--base-url', `${server.url}/v1`, '--max-usd', '0.0000000001'], { stdout: sink(), stderr, env: { ...env, OPENAI_API_KEY: KEY } });
    assert.strictEqual(code, 2);
    assert.match(stderr.text, /over --max-usd/);
    assert.strictEqual(server.requests.length, calls);
  });

  it('retries a 429 through the provider and finishes', async () => {
    const flaky = await startFakeEmbeddingServer({ failFirst: 2 });
    try {
      const { env, home } = setupHome();
      const ctx = ctxFor(home, { ...env, OPENAI_API_KEY: KEY });
      const code = await embedCommand.run(ctx, {
        session: 'synth-small', provider: 'openai', model: 'fake-embed-1', 'base-url': `${flaky.url}/v1`
      }, [], { wait: async () => {} });
      assert.strictEqual(code, 0, ctx.stderr.text);
      const cache = EmbeddingCache.open(cacheDir(home.private, 'synth-small', 'fake-embed-1'));
      assert.strictEqual(cache.rows.length, cache.meta.chunksTotal);
    } finally {
      await flaky.close();
    }
  });
});

describe('kl-recall-vec', () => {
  async function embeddedHome(fixture = SYNTH_FIXTURES[0]) {
    const { env, root, home } = setupHome([fixture]);
    const embedder = fakeEmbedder();
    const ctx = ctxFor(home, env);
    const code = await embedCommand.run(ctx, { session: fixture.sessionId, provider: 'openai', model: 'fake-embed-1' }, [], { providerInstance: embedder });
    assert.strictEqual(code, 0, ctx.stderr.text);
    return { env, root, home, embedder, sessionId: fixture.sessionId };
  }

  it('refuses to prepare without a cache, naming longhaul embed', async () => {
    const { home } = setupHome([SYNTH_FIXTURES[0]]);
    const session = await loadSession(sessionDir(home.root, 'synth-small'));
    const adapter = createKlRecallVecAdapter({ tmpRoot: home.tmp, privateRoot: home.private, model: 'fake-embed-1' });
    await assert.rejects(adapter.prepare(session), (err) => err instanceof UsageError && /longhaul embed/.test(err.message));
    assert.deepStrictEqual(fs.readdirSync(home.tmp), [], 'the temp store is removed');
  });

  it('refuses an incomplete cache', async () => {
    const { home, sessionId } = await embeddedHome();
    const dir = cacheDir(home.private, sessionId, 'fake-embed-1');
    const lines = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n');
    fs.writeFileSync(path.join(dir, 'index.jsonl'), `${lines.slice(0, -3).join('\n')}\n`);
    const session = await loadSession(sessionDir(home.root, sessionId));
    const adapter = createKlRecallVecAdapter({ tmpRoot: home.tmp, privateRoot: home.private, model: 'fake-embed-1' });
    await assert.rejects(adapter.prepare(session), (err) => err instanceof UsageError && /incomplete: 3 of \d+ chunks/.test(err.message));
  });

  for (const vectorOnly of [false, true]) {
    it(`${vectorOnly ? 'vector-only' : 'fused'}: recalls from cached vectors, never shows seq >= askAtSeq, makes no call`, async () => {
      const { home, sessionId, embedder } = await embeddedHome();
      const calls = embedder.calls.length;
      const session = await loadSession(sessionDir(home.root, sessionId));
      const questions = await readQuestions(questionsFile(home.root, sessionId));
      const adapter = createKlRecallVecAdapter({
        tmpRoot: home.tmp, privateRoot: home.private, model: 'fake-embed-1', vectorOnly, providerInstance: embedder,
        recall: { queryUserTurns: 0, bm25TopK: 200, completeMessageTokens: 800, pairToolMessages: true }
      });
      const handle = await adapter.prepare(session);
      try {
        let recalled = 0;
        for (const q of questions) {
          const r = await adapter.context(handle, { question: q, askAtSeq: q.askAtSeq });
          for (const s of [...r.evidenceSeqsShown, ...r.evidenceSeqsPartial]) assert.ok(s < q.askAtSeq, `${q.id}: seq ${s} >= ${q.askAtSeq}`);
          if (Object.keys(r.chunks.shownBySeq).length) recalled += 1;
          assert.ok(Number.isFinite(r.latencyMs));
        }
        assert.ok(recalled > 0, 'the vector list brought chunks back');
      } finally {
        await adapter.release(handle);
      }
      assert.strictEqual(embedder.calls.length, calls, 'every question vector came from the cache');
    });
  }

  it('embeds an uncached question of a private session only with sendPrivate', async () => {
    const { root, home, sessionId, embedder } = await embeddedHome();
    makePrivate(root, sessionId);
    const session = await loadSession(sessionDir(home.root, sessionId));
    const [q] = await readQuestions(questionsFile(home.root, sessionId));
    const fresh = { ...q, id: `${q.id}-new`, question: 'An uncached question about the gate?' };
    const refuse = createKlRecallVecAdapter({ tmpRoot: home.tmp, privateRoot: home.private, model: 'fake-embed-1', providerInstance: embedder });
    const h1 = await refuse.prepare(session);
    try {
      await assert.rejects(refuse.context(h1, { question: fresh, askAtSeq: q.askAtSeq }), /--send-private/);
    } finally { await refuse.release(h1); }
    const allow = createKlRecallVecAdapter({ tmpRoot: home.tmp, privateRoot: home.private, model: 'fake-embed-1', providerInstance: embedder, sendPrivate: true });
    const h2 = await allow.prepare(session);
    const calls = embedder.calls.length;
    try {
      await allow.context(h2, { question: fresh, askAtSeq: q.askAtSeq });
      await allow.context(h2, { question: fresh, askAtSeq: q.askAtSeq });
    } finally { await allow.release(h2); }
    assert.strictEqual(embedder.calls.length, calls + 1, 'embedded once, then cached');
    const cache = EmbeddingCache.open(cacheDir(home.private, sessionId, 'fake-embed-1'));
    assert.deepStrictEqual([...cache.question(fresh.id, fresh.question)].map((x) => Math.round(x * 1e6)), fakeVector(fresh.question).map((x) => Math.round(x * 1e6)));
  });

  it('is created by name, fused and vector-only', () => {
    const { home } = setupHome();
    assert.strictEqual(createAdapter('kl-recall-vec', { tmpRoot: home.tmp, privateRoot: home.private }).name, 'kl-recall-vec');
    const only = createAdapter('kl-recall-vec-only', { tmpRoot: home.tmp, privateRoot: home.private });
    assert.strictEqual(only.name, 'kl-recall-vec-only');
    assert.strictEqual(only.describe().vectorOnly, true);
  });
});

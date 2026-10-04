// tests/history-jev-rerank.test.js
// The shared Jev scorer (recall spec §6.3 step 6): batched groups held under
// the 32K-token state cap, the pointwise shape, scores in their places,
// usage counted, an abort or a failed group stops the rest. Against the
// loopback fake server through TypesafeProvider; no network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const {
  jevScores, planBatches, groupStateTokens, clip, estTokens, limiter, noulOf, MAX_STATE_TOKENS, STATE_TOKEN_LIMIT
} = require('../src/history/jev-rerank');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const { startFakeJevServer } = require('./helpers/fake-jev-server');

const KEY = 'test-key-not-real-0001';

describe('Jev scoring', () => {
  let server;
  let provider;
  const ask = (body, o) => provider.ask(body, o);
  before(async () => {
    server = await startFakeJevServer();
    provider = new TypesafeProvider(KEY, { baseUrl: server.url });
  });
  after(() => server.close());

  it('batched: one request per group, one noul per candidate, scores in order, usage counted', async () => {
    const n0 = server.requests.length;
    const out = await jevScores({ ask, model: 'jev-latest', query: 'side gate code', texts: ['the side gate code is 4417', 'grocery list', 'the gate'] });
    assert.deepStrictEqual(out.scores.map((s) => Math.round(s * 3)), [3, 0, 1]);
    assert.strictEqual(out.requests, 1);
    assert.strictEqual(server.requests.length - n0, 1);
    assert.ok(out.inputTokens > 0);
    assert.strictEqual(out.model, 'jev-1.13.0');
    const r = server.requests.at(-1);
    assert.strictEqual(r.body.state.query, 'side gate code');
    assert.deepStrictEqual(r.body.state.candidates.map((c) => c.id), ['c1', 'c2', 'c3']);
    assert.deepStrictEqual(Object.keys(r.body.questions), ['c1', 'c2', 'c3']);
    const q = r.body.questions.c2;
    assert.strictEqual(q.type, 'noul');
    assert.match(q.instructions, /candidate with id "c2"/);
    assert.match(q.criteria.true, /states or establishes/);
    assert.match(q.criteria.false, /merely on a similar topic/);
  });

  it('pointwise: one request per candidate in the probe shape', async () => {
    const n0 = server.requests.length;
    const out = await jevScores({ ask, model: 'jev-latest', query: 'gate code', texts: ['the gate code is 4417', 'weather'], mode: 'pointwise' });
    assert.deepStrictEqual(out.scores, [1, 0]);
    assert.strictEqual(server.requests.length - n0, 2);
    assert.deepStrictEqual(Object.keys(server.requests.at(-1).body.state).sort(), ['candidate_passage', 'query_excerpt']);
    assert.deepStrictEqual(Object.keys(server.requests.at(-1).body.questions), ['establishes']);
    await assert.rejects(jevScores({ ask, model: 'm', query: 'q', texts: ['a'], mode: 'listwise' }), /batched or pointwise/);
    assert.deepStrictEqual((await jevScores({ ask, model: 'm', query: 'q', texts: [] })).scores, []);
  });

  it('a candidate set over the 32K state cap is split and cut so every request is answered (Review Focus 1)', async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `${i % 2 ? 'gate code' : 'weather'} ${'x'.repeat(1490)}`);
    texts[7] = `gate code ${'y'.repeat(200000)}`;
    const query = `gate code ${'z'.repeat(50000)}`;
    // The fake enforces the cap: the uncut 200K-character candidate is refused.
    await assert.rejects(provider.ask({ state: { query: 'q', candidates: [{ id: 'c1', text: texts[7] }] }, questions: { c1: { type: 'noul', instructions: 'x' } } }),
      (err) => err.status === 422);
    const plan = planBatches(query, texts);
    assert.ok(plan.groups.length > 1);
    assert.ok(estTokens(plan.query) <= 2000, 'the query is cut');
    assert.ok(plan.texts[7].length < texts[7].length, 'the oversized candidate is cut');
    for (const g of plan.groups) {
      assert.ok(groupStateTokens(plan, g) <= MAX_STATE_TOKENS, `group of ${g.length}`);
      assert.ok(g.length <= 60);
    }
    assert.deepStrictEqual(plan.groups.flat(), texts.map((_, i) => i), 'every candidate once, in order');
    const n0 = server.requests.length;
    const out = await jevScores({ ask, model: 'jev-latest', query, texts });
    assert.strictEqual(server.requests.length - n0, plan.groups.length, 'every planned request was answered');
    texts.forEach((_, i) => assert.ok(Number.isFinite(out.scores[i]), `score ${i}`));
    assert.ok(out.scores[1] > out.scores[0], 'scores stay in their places');
    assert.ok(MAX_STATE_TOKENS < STATE_TOKEN_LIMIT);
  });

  it('planBatches holds maxPerCall; clip cuts to the estimate', () => {
    assert.ok(planBatches('q', new Array(100).fill('short'), { maxPerCall: 40 }).groups.every((g) => g.length <= 40));
    assert.strictEqual(clip('abc', 10), 'abc');
    const cut = clip('w'.repeat(10000), 100);
    assert.ok(estTokens(cut) <= 100 && cut.length > 0);
    assert.ok(estTokens('"\n'.repeat(1000)) > estTokens('a'.repeat(2000)) / 2, 'escaping counts');
  });

  it('non-ASCII text counts one token a character, so a group of CJK chunks stays under the 32K state cap', () => {
    assert.strictEqual(estTokens('门禁密码'), Math.ceil(2 / 3) + 4, 'the quotes at 3 a token, each CJK character one');
    assert.strictEqual(estTokens('abcdef'), Math.ceil(8 / 3), 'ASCII stays at 3 characters a token');
    // Invented text: about 600 CJK characters a chunk, 100 chunks (topM 100).
    const chunk = (i) => `第${i}段：侧门的密码是四四一七，码头边的门下雨时会卡住。`.repeat(24);
    const texts = Array.from({ length: 100 }, (_, i) => chunk(i));
    const plan = planBatches('侧门的密码是多少？', texts);
    // At least one token per non-ASCII character: a floor on what Jev counts.
    const floor = (s) => [...String(s)].filter((c) => c.charCodeAt(0) > 127).length;
    for (const g of plan.groups) {
      const tokens = floor(plan.query) + g.reduce((n, i) => n + floor(plan.texts[i]), 0);
      assert.ok(tokens < STATE_TOKEN_LIMIT, `group of ${g.length}: ${tokens} CJK characters`);
      assert.ok(groupStateTokens(plan, g) <= MAX_STATE_TOKENS);
    }
    const cut = clip('门'.repeat(5000), 100);
    assert.ok(estTokens(cut) <= 100 && cut.length > 0);
  });

  it('a failed group stops the groups not yet started, and the error carries the usage so far', async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `gate ${i} ${'x'.repeat(3000)}`);
    const plan = planBatches('gate', texts, { maxStateTokens: 2500 });
    assert.ok(plan.groups.length >= 3);
    server.setFailure({ count: 1, status: 500 });
    const n0 = server.requests.length;
    await assert.rejects(jevScores({ ask, model: 'm', query: 'gate', texts, maxStateTokens: 2500, concurrency: 1 }),
      (err) => err.status === 500 && err.jevUsage.requests === 1);
    assert.strictEqual(server.requests.length - n0, 1);
  });

  it('an abort stops the call in flight and starts nothing more', async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `gate ${i} ${'x'.repeat(3000)}`);
    server.setDelay(300);
    try {
      const c = new AbortController();
      setTimeout(() => c.abort(), 50);
      const n0 = server.requests.length;
      await assert.rejects(jevScores({ ask, model: 'm', query: 'gate', texts, maxStateTokens: 2500, concurrency: 1, abortSignal: c.signal }),
        (err) => err.name === 'AbortError');
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(server.requests.length - n0, 1);
    } finally {
      server.setDelay(0);
    }
  });

  it('noulOf refuses a missing or non-numeric score; limiter bounds concurrency', async () => {
    assert.strictEqual(noulOf({ a: { noul: 0.25 } }, 'a'), 0.25);
    for (const answers of [{}, { a: {} }, { a: { noul: null } }, { a: { noul: '0.5' } }]) {
      assert.throws(() => noulOf(answers, 'a'), (err) => err.code === 'JEV_NO_ANSWER');
    }
    const limit = limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    })));
    assert.strictEqual(peak, 2);
  });
});

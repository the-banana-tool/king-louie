// tests/longhaul-jev.test.js
// LongHaul's Jev client (src/longhaul/jev.js) on the app's TypesafeProvider
// and jevScores: batched by default, the pinned model, retries, refusals
// that are never retried, the timeout, the token cap and the served-model
// check; the cost is unpriced. Loopback fake server; never the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const {
  createJevClient, createJevScorer, estimateJevTokens, usageSummary, newCalibration, calibrationSummary,
  JEV_DEFAULT_MODEL, DEFAULT_MODE, OVERHEAD_TOKENS
} = require('../src/longhaul/jev');
const { UsageError } = require('../src/longhaul/errors');
const { startFakeJevServer } = require('./helpers/fake-jev-server');

const KEY = 'test-key-not-real-0001';
const noWait = async () => {};
const Q = { state: { query_excerpt: 'a', candidate_passage: 'a' }, questions: { establishes: { type: 'noul', instructions: 'x' } } };

describe('LongHaul Jev client', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  it('batched by default; asks for the pinned model; counts usage; unpriced', async () => {
    assert.strictEqual(DEFAULT_MODE, 'batched');
    assert.strictEqual(JEV_DEFAULT_MODEL, 'jev-1.13.0');
    const client = createJevClient({ apiKey: KEY, baseUrl: server.url, wait: noWait });
    const cal = newCalibration();
    const scorer = createJevScorer({ client, calibration: cal });
    assert.strictEqual(scorer.model, 'jev-1.13.0-batched');
    const n0 = server.requests.length;
    const scores = await scorer.score('side gate code', ['the side gate code is 4417', 'grocery list', 'the gate']);
    assert.deepStrictEqual(scores.map((s) => Math.round(s * 3)), [3, 0, 1]);
    assert.strictEqual(server.requests.length - n0, 1);
    assert.strictEqual(server.requests.at(-1).body.model, 'jev-1.13.0');
    assert.strictEqual(server.requests.at(-1).auth, `Bearer ${KEY}`);
    assert.strictEqual(client.usage.ok, 1);
    assert.ok(client.usage.inputTokens > 0);
    assert.deepStrictEqual(client.usage.models, { 'jev-1.13.0': 1 });
    assert.strictEqual(calibrationSummary(cal).scores, 3);
    const s = usageSummary(client.usage);
    assert.strictEqual(s.usd, null, 'Jev is unpriced: never $0');
    assert.strictEqual(s.price, 'unknown');
    assert.strictEqual(s.inputTokens, client.usage.inputTokens);
  });

  it('pointwise: one request per pair; a bad mode is refused', async () => {
    const client = createJevClient({ apiKey: KEY, baseUrl: server.url, wait: noWait });
    const scorer = createJevScorer({ client, mode: 'pointwise' });
    assert.strictEqual(scorer.model, 'jev-1.13.0-pointwise');
    const n0 = server.requests.length;
    assert.deepStrictEqual(await scorer.score('gate code', ['the gate code is 4417', 'weather', 'gate']), [1, 0, 0.5]);
    assert.strictEqual(server.requests.length - n0, 3);
    assert.throws(() => createJevScorer({ client, mode: 'listwise' }), (err) => err instanceof UsageError && /batched or pointwise/.test(err.message));
  });

  it('retries a 429 and a 529 with a growing backoff, then succeeds', async () => {
    const flaky = await startFakeJevServer({ failFirst: 2 });
    try {
      const waits = [];
      const client = createJevClient({ apiKey: KEY, baseUrl: flaky.url, wait: async (ms) => { waits.push(ms); } });
      const r = await client.ask(Q);
      assert.strictEqual(r.answers.establishes.noul, 1);
      assert.strictEqual(client.usage.retries, 2);
      assert.deepStrictEqual(client.usage.status, { 429: 2, 200: 1 });
      assert.ok(waits[1] > waits[0], 'the backoff grows');
      flaky.setFailure({ count: 1, status: 529 });
      await client.ask(Q);
      assert.strictEqual(client.usage.retries, 3);
    } finally {
      await flaky.close();
    }
  });

  it('fails a 422, a 401 and a 402 at once, with the status only (never the body)', async () => {
    for (const status of [422, 401, 402]) {
      const bad = await startFakeJevServer({ failFirst: 5, failStatus: status, failBody: { detail: 'state echo: the side gate code is 4417' } });
      try {
        const client = createJevClient({ apiKey: KEY, baseUrl: bad.url, wait: noWait });
        await assert.rejects(client.ask(Q), (err) => err.status === status && !err.message.includes('4417'));
        assert.strictEqual(bad.requests.length, 1, `${status} is not retried`);
        assert.strictEqual(client.usage.failed, 1);
      } finally {
        await bad.close();
      }
    }
  });

  it('times out a request that never answers and retries it; refuses past the token cap; needs a key', async () => {
    const hung = await startFakeJevServer({ delayMs: 2000 });
    try {
      const client = createJevClient({ apiKey: KEY, baseUrl: hung.url, timeoutMs: 30, retries: 1, wait: noWait });
      await assert.rejects(client.ask(Q), (err) => err.code === 'JEV_TIMEOUT');
      assert.strictEqual(client.usage.timeouts, 2);
    } finally {
      await hung.close();
    }
    const capped = createJevClient({ apiKey: KEY, baseUrl: server.url, maxTokens: 1, wait: noWait });
    await capped.ask(Q);
    const n = server.requests.length;
    await assert.rejects(capped.ask(Q), (err) => err instanceof UsageError && err.code === 'JEV_OVER_TOKENS');
    assert.strictEqual(server.requests.length, n, 'nothing sent past the cap');
    assert.throws(() => createJevClient({ apiKey: '' }), /TYPESAFE_AI_KEY/);
  });

  it('a pinned model must be the one served; jev-latest takes whatever answers', async () => {
    const other = await startFakeJevServer({ model: 'jev-1.14.0' });
    try {
      const pinned = createJevClient({ apiKey: KEY, baseUrl: other.url, wait: noWait });
      await assert.rejects(pinned.ask(Q), (err) => err instanceof UsageError && err.code === 'JEV_MODEL_MISMATCH' && /--jev-model jev-1\.14\.0/.test(err.message));
      const latest = createJevClient({ apiKey: KEY, baseUrl: other.url, model: 'jev-latest', wait: noWait });
      assert.strictEqual((await latest.ask(Q)).model, 'jev-1.14.0');
      assert.strictEqual(other.requests.at(-1).body.model, 'jev-latest');
    } finally {
      await other.close();
    }
  });

  it('estimates input tokens per mode, cache ignored', () => {
    assert.strictEqual(estimateJevTokens({ questions: 10, topM: 100, chunkCount: 50, meanChunkTokens: 100, mode: 'batched' }), 10 * 50 * (100 + OVERHEAD_TOKENS.batched));
    assert.strictEqual(estimateJevTokens({ questions: 2, topM: 5, chunkCount: 500, meanChunkTokens: 10, mode: 'pointwise' }), 2 * 5 * (10 + OVERHEAD_TOKENS.pointwise));
  });
});

// tests/providers-typesafe.test.js
// TypesafeProvider (typesafe.ai's Jev): a decide-only provider. Its request
// goes through BaseProvider.request with the abort signal, its errors carry
// the status and never the body's text, its calls are unpriced, and it is
// never a chat model. Against the loopback fake server; no network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const ProviderFactory = require('../src/providers/provider-factory');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { fixtureCatalog } = require('./helpers/models-fixture');

const KEY = 'test-key-not-real-0001';
const ONE = {
  state: { query: 'gate code', candidates: [{ id: 'c1', text: 'the side gate code is 4417' }] },
  questions: { c1: { type: 'noul', instructions: 'x', criteria: { yes: 'it answers the query', no: 'it does not' } } }
};

describe('TypesafeProvider', () => {
  let server;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());

  it('asks /v1/systemone with the Bearer key; returns answers, usage and the served model, unpriced', async () => {
    const p = new TypesafeProvider(KEY, { baseUrl: server.url, catalog: fixtureCatalog() });
    const out = await p.ask(ONE);
    assert.strictEqual(out.answers.c1.noul, 1);
    assert.strictEqual(out.model, 'jev-1.13.0');
    assert.ok(out.usage.inputTokens > 0);
    assert.strictEqual(out.usage.outputTokens, 0);
    assert.strictEqual(out.llmMetrics.costUsd, null, 'not in the catalog: unpriced, never $0');
    assert.strictEqual(out.llmMetrics.unpriced, true);
    const r = server.requests.at(-1);
    assert.strictEqual(r.path, '/v1/systemone');
    assert.strictEqual(r.auth, `Bearer ${KEY}`);
    assert.match(r.contentType, /application\/json/);
    assert.strictEqual(r.body.model, 'jev-latest');
    assert.deepStrictEqual(r.body.state, ONE.state);
    assert.deepStrictEqual(r.body.questions, ONE.questions);
  });

  it('an error carries the status and never the body text (a 422 can echo the state)', async () => {
    const bad = await startFakeJevServer({ failFirst: 1, failStatus: 422, failBody: { detail: [{ msg: 'state echo: the side gate code is 4417' }] } });
    try {
      const p = new TypesafeProvider(KEY, { baseUrl: bad.url });
      await assert.rejects(p.ask(ONE), (err) => err.name === 'ProviderError' && err.status === 422
        && err.message === 'typesafe.ai answered HTTP 422' && !JSON.stringify({ ...err.toJSON(), m: err.message }).includes('4417'));
    } finally {
      await bad.close();
    }
  });

  it('keeps a 429 retry-after and a short error type for the quota check, not the message', async () => {
    const slow = await startFakeJevServer({ failFirst: 1, failStatus: 429, retryAfter: 2, failBody: { error: { type: 'insufficient_quota', message: 'the side gate code is 4417' } } });
    try {
      const p = new TypesafeProvider(KEY, { baseUrl: slow.url });
      await assert.rejects(p.ask(ONE), (err) => err.status === 429 && err.retryAfterMs === 2000
        && err.type === 'insufficient_quota' && !err.message.includes('4417'));
    } finally {
      await slow.close();
    }
  });

  it('passes the abort signal: an abort cancels the request at the provider', async () => {
    const hung = await startFakeJevServer({ delayMs: 5000 });
    try {
      const p = new TypesafeProvider(KEY, { baseUrl: hung.url });
      const c = new AbortController();
      setTimeout(() => c.abort(), 20);
      const t0 = Date.now();
      await assert.rejects(p.ask(ONE, { abortSignal: c.signal }), (err) => err.name === 'AbortError');
      assert.ok(Date.now() - t0 < 2000);
    } finally {
      await hung.close();
    }
  });

  it('refuses a short key, is not a registered provider, and offers no chat model', async () => {
    assert.throws(() => new TypesafeProvider('short'), /Invalid API key/);
    assert.ok(!ProviderFactory.listRegistered().includes('typesafe'));
    const p = new TypesafeProvider(KEY);
    assert.strictEqual(p.baseUrl, 'https://api.typesafe.ai');
    assert.strictEqual(p.getProviderName(), 'typesafe');
    assert.deepStrictEqual(p.getModels(), []);
    assert.deepStrictEqual(await p.listModels(), []);
    await assert.rejects(p.sendMessage([]), /not a chat model/);
    await assert.rejects(p.ask({ state: 's', questions: {} }), /at least one question/);
    assert.strictEqual(TypesafeProvider.JEV_LATEST, 'jev-latest');
  });
});

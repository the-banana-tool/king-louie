// tests/history-jev-reranker.test.js
// The hosted reranker (recall spec §6.3 step 6, §15): nothing sent with kind
// local, under KL_TEST_MODE, before start or with no key; one warning per
// failure episode; a refused key pauses it until reset; a 429 holds it off;
// a call slower than maxMs is aborted at the provider; a failure that lands
// after a switch changes nothing; Vault text is never sent. Loopback fake
// server only.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { JevReranker } = require('../src/history/jev-reranker');
const { createRecallReranker } = require('../src/history/reranker');
const { EmbedderHost } = require('../src/history/embedder-host');
const { Retriever } = require('../src/history/retriever');
const { TokenEstimator } = require('../src/history/token-estimator');
const { searchHistoryExcerpts } = require('../src/history/search');
const { mergeHistorySettings } = require('../src/history/settings');
const TypesafeProvider = require('../src/providers/typesafe-provider');
const { setLogLevel } = require('../src/logging');
const { startFakeJevServer } = require('./helpers/fake-jev-server');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { openTempStore, seedChat, BASE_TIME } = require('./helpers/history-fixture');

setLogLevel('fatal');

const KEY = 'test-key-not-real-0001';
const TEXTS = ['the side gate code is 4417', 'grocery list'];
const jevSettings = (kind = 'jev', over = {}) => ({ history: mergeHistorySettings({ version: 3, recall: { tailUserTurns: 1, rerank: { kind, enabled: true, ...over } } }) });
const waitFor = async (check, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('JevReranker', () => {
  let server;
  let key;
  let settings;
  let t = null;
  before(async () => { server = await startFakeJevServer(); });
  after(() => server.close());
  beforeEach(() => {
    key = KEY;
    settings = jevSettings();
    server.setFailure({ count: 0 });
    server.setDelay(0);
  });
  afterEach(() => {
    if (t) t.cleanup();
    t = null;
  });

  const make = ({ now, env = {} } = {}) => {
    const notes = [];
    const jev = new JevReranker({
      getSettings: () => settings, getKey: () => key,
      createProvider: (k) => new TypesafeProvider(k, { baseUrl: server.url }),
      notify: (toast) => notes.push(toast), env, ...(now ? { now } : {})
    });
    return { jev, notes };
  };

  it('scores with Jev batched, names the served model and counts the tokens', async () => {
    const { jev, notes } = make();
    jev.start();
    const info = {};
    const n0 = server.requests.length;
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS, { maxMs: 2000, info }), [1, 0]);
    assert.strictEqual(info.name, 'jev:jev-1.13.0');
    assert.strictEqual(server.requests.length - n0, 1);
    assert.strictEqual(server.requests.at(-1).body.model, 'jev-latest');
    assert.strictEqual(server.requests.at(-1).auth, `Bearer ${KEY}`);
    const st = jev.status();
    assert.strictEqual(st.state, 'ready');
    assert.strictEqual(st.model, 'jev-1.13.0');
    assert.strictEqual(st.hasKey, true);
    assert.ok(st.tokens > 0);
    assert.strictEqual(st.requests, 1);
    assert.strictEqual(notes.length, 0);
  });

  it('sends nothing under KL_TEST_MODE, before start, or with no key (one warning for the missing key)', async () => {
    const n0 = server.requests.length;
    const test = make({ env: { KL_TEST_MODE: '1' } });
    test.jev.start();
    await assert.rejects(test.jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /KL_TEST_MODE/.test(err.message));
    const idle = make();
    await assert.rejects(idle.jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /not started/.test(err.message));
    assert.strictEqual(idle.jev.status().state, 'not-started');
    key = null;
    const { jev, notes } = make();
    jev.start();
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /^no typesafe\.ai key is saved/.test(err.message));
    }
    assert.strictEqual(jev.status().state, 'no-key');
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(test.notes.length + idle.notes.length, 0);
    assert.strictEqual(server.requests.length, n0, 'nothing reached typesafe.ai');
  });

  it('a key revoked mid-session (401) pauses Jev with one warning until reset (Review Focus 3)', async () => {
    const { jev, notes } = make();
    jev.start();
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    server.setFailure({ count: 1, status: 401 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_REFUSED' && /refused the key \(401\)/.test(err.message));
    assert.strictEqual(jev.status().state, 'refused');
    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].body, /^Recall reranking with typesafe\.ai is skipped: typesafe\.ai refused the key \(401\)/);
    const n = server.requests.length;
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /refused the key/.test(err.message));
    assert.strictEqual(server.requests.length, n, 'nothing sent while paused');
    assert.strictEqual(notes.length, 1);
    jev.reset();
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    assert.strictEqual(jev.status().state, 'ready');
  });

  it('a 429 holds Jev off for retry-after, then it resumes; a 402 pauses it (new episode, new warning)', async () => {
    let clock = 1000;
    const { jev, notes } = make({ now: () => clock });
    jev.start();
    server.setFailure({ count: 1, status: 429, retryAfter: 3 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => /asked to slow down \(429\)/.test(err.message));
    assert.strictEqual(jev.status().state, 'failing');
    const n = server.requests.length;
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_UNAVAILABLE' && /resumes shortly/.test(err.message));
    assert.strictEqual(server.requests.length, n, 'nothing sent while held off');
    clock += 3001;
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    assert.strictEqual(notes.length, 1);
    server.setFailure({ count: 1, status: 402 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_REFUSED' && /out of credit \(402\)/.test(err.message));
    assert.strictEqual(jev.status().state, 'refused');
    assert.strictEqual(notes.length, 2);
  });

  it('a call slower than maxMs is aborted at the provider; one warning; a success ends the episode (Review Focus 2)', async () => {
    const { jev, notes } = make();
    jev.start();
    server.setDelay(3000);
    const aborted0 = server.aborted();
    const t0 = Date.now();
    await assert.rejects(jev.rerank('gate code', TEXTS, { maxMs: 50 }), (err) => err.code === 'RERANK_TIMEOUT' && /longer than 50 ms/.test(err.message));
    assert.ok(Date.now() - t0 < 1500);
    await waitFor(() => server.aborted() > aborted0);
    assert.strictEqual(notes.length, 1);
    server.setDelay(0);
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS, { maxMs: 2000 }), [1, 0]);
    assert.strictEqual(jev.status().error, null);
    server.setFailure({ count: 1, status: 500 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_FAILED' && /typesafe\.ai failed \(HTTP 500\)/.test(err.message));
    assert.strictEqual(notes.length, 2, 'a new episode after the success');
  });

  it('a failure that lands after a switch to local, or after a new key, changes nothing (Review Focus 4)', async () => {
    const { jev, notes } = make();
    jev.start();
    server.setDelay(150);
    server.setFailure({ count: 1, status: 401 });
    const p = jev.rerank('gate code', TEXTS);
    await new Promise((r) => setTimeout(r, 30));
    settings = jevSettings('local');
    await assert.rejects(p);
    assert.strictEqual(jev.status().state, 'off');
    settings = jevSettings('jev');
    assert.strictEqual(jev.status().state, 'ready', 'no refusal held from the old call');
    server.setFailure({ count: 1, status: 401 });
    const q = jev.rerank('gate code', TEXTS);
    await new Promise((r) => setTimeout(r, 30));
    key = 'test-key-not-real-0002';
    jev.reset();
    await assert.rejects(q);
    assert.strictEqual(jev.status().state, 'ready');
    assert.strictEqual(notes.length, 0);
    server.setDelay(0);
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
    assert.strictEqual(server.requests.at(-1).auth, 'Bearer test-key-not-real-0002', 'the new key is used');
  });

  it('a refusal does not survive jev -> local -> jev, nor a change of Jev model; the next failure warns again', async () => {
    const { jev, notes } = make();
    jev.start();
    server.setFailure({ count: 1, status: 401 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_REFUSED');
    assert.strictEqual(jev.status().state, 'refused');
    assert.strictEqual(notes.length, 1);
    settings = jevSettings('local');
    assert.strictEqual(jev.status().state, 'off');
    settings = jevSettings('jev');
    assert.strictEqual(jev.status().state, 'ready', 'switching back starts clean');
    server.setFailure({ count: 1, status: 401 });
    await assert.rejects(jev.rerank('gate code', TEXTS), (err) => err.code === 'RERANK_REFUSED');
    assert.strictEqual(notes.length, 2, 'a new episode, a new warning');
    settings = jevSettings('jev', { jev: { model: 'jev-1.14.0' } });
    assert.strictEqual(jev.status().state, 'ready', 'a new model starts clean');
    assert.deepStrictEqual(await jev.rerank('gate code', TEXTS), [1, 0]);
  });

  it('stop() aborts a call in flight without a warning', async () => {
    const { jev, notes } = make();
    jev.start();
    server.setDelay(3000);
    const p = jev.rerank('gate code', TEXTS);
    await new Promise((r) => setTimeout(r, 30));
    await jev.stop();
    await assert.rejects(p);
    assert.strictEqual(notes.length, 0);
    assert.strictEqual(jev.status().state, 'not-started');
  });

  it('dispatch: kind local uses the cross-encoder and sends nothing, even with a key saved (Review Focus 5)', async () => {
    const calls = [];
    const host = {
      rerank: async (q, texts) => { calls.push(texts.length); return texts.map(() => 0.5); },
      rerankModelName: () => 'Xenova/ms-marco-MiniLM-L-6-v2'
    };
    const { jev } = make();
    jev.start();
    const reranker = createRecallReranker({ host, jev, getSettings: () => settings });
    settings = jevSettings('local');
    const n = server.requests.length;
    const info = {};
    assert.deepStrictEqual(await reranker('gate code', [{ text: 'a' }, { text: 'b' }], { maxMs: 2000, info }), [0.5, 0.5]);
    assert.strictEqual(info.name, 'local:Xenova/ms-marco-MiniLM-L-6-v2');
    assert.strictEqual(server.requests.length, n);
    settings = jevSettings('jev');
    const info2 = {};
    assert.deepStrictEqual(await reranker('gate code', TEXTS.map((text) => ({ text })), { maxMs: 2000, info: info2 }), [1, 0]);
    assert.strictEqual(info2.name, 'jev:jev-1.13.0');
    assert.deepStrictEqual(calls, [2]);
  });

  it('per turn: a Jev call slower than rerank.maxMs leaves the fused order and says why', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: [
      { sender: 'user', text: 'The side gate code is 4417.' },
      { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
      { sender: 'user', text: 'Lunch is at noon.' }
    ] });
    settings = jevSettings('jev', { maxMs: 50 });
    const { jev } = make();
    jev.start();
    const reranker = createRecallReranker({ host: { rerank: async () => [] }, jev, getSettings: () => settings });
    const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator(), reranker });
    server.setDelay(3000);
    const stats = {};
    const t0 = Date.now();
    const hits = await retriever.retrieve({ query: 'gate', chatIds: ['chat-1'], settings: settings.history.recall, now: BASE_TIME, stats });
    assert.ok(Date.now() - t0 < 1500, 'the turn does not wait for typesafe.ai');
    assert.ok(hits.length >= 2);
    assert.strictEqual(stats.reranker, null);
    assert.match(stats.rerankSkipped, /longer than rerank\.maxMs \(50 ms\)/);
  });

  it('a Jev 401 keeps the fused order and never falls back to the local cross-encoder', async () => {
    t = openTempStore();
    seedChat(t.store, { messages: [
      { sender: 'user', text: 'The side gate code is 4417.' },
      { sender: 'user', text: 'The gate by the dock sticks in the rain.' },
      { sender: 'user', text: 'Lunch is at noon.' }
    ] });
    settings = jevSettings('jev');
    const { jev } = make();
    jev.start();
    let localCalls = 0;
    const host = { rerank: async (q, texts) => { localCalls += 1; return texts.map(() => 0.5); }, rerankModelName: () => 'local-model' };
    const reranker = createRecallReranker({ host, jev, getSettings: () => settings });
    const query = { query: 'gate', chatIds: ['chat-1'], settings: settings.history.recall, now: BASE_TIME };
    const fused = await new Retriever({ store: t.store, estimator: new TokenEstimator() })
      .retrieve({ ...query, settings: { ...settings.history.recall, rerank: { ...settings.history.recall.rerank, enabled: false } } });
    server.setFailure({ count: 1, status: 401 });
    const stats = {};
    const hits = await new Retriever({ store: t.store, estimator: new TokenEstimator(), reranker }).retrieve({ ...query, stats });
    const ids = (list) => list.map((h) => h.chunk.id);
    assert.ok(fused.length >= 2 && ids(fused).every(Number.isInteger));
    assert.deepStrictEqual(ids(hits), ids(fused));
    assert.strictEqual(stats.reranker, null);
    assert.match(stats.rerankSkipped, /refused the key \(401\)/);
    assert.strictEqual(localCalls, 0, 'host.rerank is never called');
  });

  it('Vault results make no chunks, so their text never reaches typesafe.ai', async () => {
    const SECRET = 'zq7-invented-secret-5550142';
    t = openTempStore();
    seedChat(t.store, { messages: [
      { sender: 'user', text: 'Store the invented test password and then read it back for the form.' },
      { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'store', key: 'signup_password', value: SECRET } },
      { sender: 'toolResult', toolName: 'Vault', result: { ok: true, message: 'Secret "signup_password" stored securely.' } },
      { sender: 'toolUse', toolName: 'Vault', parameters: { action: 'retrieve', key: 'signup_password' } },
      { sender: 'toolResult', toolName: 'Vault', result: { ok: true, key: 'signup_password', value: SECRET }, text: `value ${SECRET}` },
      { sender: 'assistant', text: 'Stored and read back; the password form field is filled.' }
    ] });
    const { jev } = make();
    jev.start();
    const reranker = createRecallReranker({ host: { rerank: async () => { throw new Error('not used'); } }, jev, getSettings: () => settings });
    const retriever = new Retriever({ store: t.store, estimator: new TokenEstimator(), reranker });
    const n = server.requests.length;
    const out = await searchHistoryExcerpts({
      store: t.store, retriever, chatId: 'chat-1', query: 'password form', limit: 10, settings: settings.history.recall, reranker, asOf: BASE_TIME
    });
    assert.ok(out.length >= 1);
    const sent = server.requests.slice(n);
    assert.ok(sent.length >= 1, 'the other chunks were reranked by Jev');
    for (const r of sent) assert.ok(!r.raw.includes(SECRET), 'no Vault text in any request');
  });

  it('with kind jev the cross-encoder is not preloaded', async () => {
    const runner = new FakeEmbedRunner();
    const host = new EmbedderHost({
      getSettings: () => ({ history: { recall: { rerank: { kind: 'jev', search: true } } } }),
      modelsDir: os.tmpdir(), createRunner: () => runner, createProvider: () => { throw new Error('not used'); }
    });
    host.start();
    await waitFor(() => host.status().state === 'ready');
    host.preloadReranker();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(runner.calls.filter((c) => c.op === 'load' && c.role === 'reranker').length, 0);
    await host.stop();
  });
});

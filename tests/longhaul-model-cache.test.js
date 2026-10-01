// tests/longhaul-model-cache.test.js
// Cached model calls (benchmark spec §11): a rerun costs nothing, and a run
// cut off mid-way resumes without paying for a finished call twice.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ModelCache, cacheKey, stableStringify, cachedCall, usageFromMetrics } = require('../src/longhaul/model-cache');
const { tmpDir } = require('./helpers/longhaul-helpers');

function fakeClient({ failAt = null, error = null } = {}) {
  const prompts = [];
  return {
    provider: 'fake', model: 'fake-1', prompts,
    async complete(prompt) {
      prompts.push(prompt);
      if (failAt !== null && prompts.length === failAt) throw error;
      return { text: `reply to ${prompt}`, llmMetrics: { inputTokens: prompt.length, outputTokens: 3, costUsd: 0.01 } };
    }
  };
}
const noWait = { wait: async () => {} };
const newCache = () => new ModelCache(path.join(tmpDir(), 'model-cache'));
const call = (cache, client, prompt, extra = {}) => cachedCall({
  cache, stage: 'answer', key: cacheKey({ prompt }), client, prompt, maxTokens: 50, retry: noWait, ...extra
});

describe('cacheKey', () => {
  it('is the same for the same parts in any key order, and differs when any part does', () => {
    assert.strictEqual(cacheKey({ a: 1, b: { c: 2, d: [1, 2] } }), cacheKey({ b: { d: [1, 2], c: 2 }, a: 1 }));
    assert.notStrictEqual(cacheKey({ a: 1 }), cacheKey({ a: 2 }));
    assert.match(cacheKey({ a: 1 }), /^[0-9a-f]{64}$/);
    assert.strictEqual(stableStringify({ b: 1, a: [2, { d: 1, c: 0 }], u: undefined }), '{"a":[2,{"c":0,"d":1}],"b":1}');
  });
});

describe('cachedCall', () => {
  it('calls on a miss, stores the reply under the cache root, and answers a repeat from the cache for nothing', async () => {
    const cache = newCache();
    const client = fakeClient();
    const first = await call(cache, client, 'p1');
    assert.deepStrictEqual({ ...first, latencyMs: 0 }, { text: 'reply to p1', inputTokens: 2, outputTokens: 3, costUsd: 0.01, latencyMs: 0, cached: false });
    const again = await call(cache, client, 'p1');
    assert.strictEqual(again.cached, true);
    assert.strictEqual(again.text, 'reply to p1');
    assert.strictEqual(again.costUsd, 0.01, 'a hit reports what the reply cost when it was made');
    assert.strictEqual(client.prompts.length, 1);
    const key = cacheKey({ prompt: 'p1' });
    assert.ok(fs.existsSync(path.join(cache.root, 'answer', key.slice(0, 2), `${key}.json`)));
  });

  it('resumes a run cut off mid-way: finished calls are hits, only the rest are made', async () => {
    const cache = newCache();
    const crash = Object.assign(new Error('unauthorized'), { status: 401 });
    const first = fakeClient({ failAt: 3, error: crash });
    for (const p of ['p1', 'p2']) await call(cache, first, p);
    await assert.rejects(call(cache, first, 'p3'), /unauthorized/);
    const second = fakeClient();
    for (const p of ['p1', 'p2', 'p3', 'p4']) await call(cache, second, p);
    assert.deepStrictEqual(second.prompts, ['p3', 'p4']);
  });

  it('asks the spend hooks only on a miss, and settles or cancels what it reserved', async () => {
    const cache = newCache();
    const log = [];
    const hooks = {
      beforeCall: ({ promptChars, maxTokens }) => { log.push(['before', promptChars, maxTokens]); return 7; },
      afterCall: (ticket, usage) => log.push(['after', ticket, usage.costUsd]),
      cancel: (ticket) => log.push(['cancel', ticket])
    };
    await call(cache, fakeClient(), 'p1', { hooks });
    await call(cache, fakeClient(), 'p1', { hooks });
    const bad = fakeClient({ failAt: 1, error: Object.assign(new Error('bad request'), { status: 400 }) });
    await assert.rejects(call(cache, bad, 'p2', { hooks }), /bad request/);
    assert.deepStrictEqual(log, [['before', 2, 50], ['after', 7, 0.01], ['before', 2, 50], ['cancel', 7]]);
  });

  it('settles the spend before storing, so a failing cache write never leaves a paid call reserved', async () => {
    const cache = newCache();
    cache.put = () => { throw new Error('disk full'); };
    const log = [];
    const hooks = {
      beforeCall: () => 7,
      afterCall: (ticket, usage) => log.push(['after', ticket, usage.costUsd, usage.inputTokens]),
      cancel: (ticket) => log.push(['cancel', ticket])
    };
    await assert.rejects(call(cache, fakeClient(), 'p1', { hooks }), /disk full/);
    assert.deepStrictEqual(log, [['after', 7, 0.01, 2]]);
  });

  it('retries a 429 inside one call and stores one entry', async () => {
    const cache = newCache();
    const client = fakeClient({ failAt: 1, error: Object.assign(new Error('slow down'), { status: 429 }) });
    assert.strictEqual((await call(cache, client, 'p1')).cached, false);
    assert.strictEqual(client.prompts.length, 2);
    assert.strictEqual((await call(cache, client, 'p1')).cached, true);
  });

  it('treats an unreadable entry as a miss and calls again', async () => {
    const cache = newCache();
    const key = cacheKey({ prompt: 'p1' });
    fs.mkdirSync(path.dirname(cache.file('answer', key)), { recursive: true });
    fs.writeFileSync(cache.file('answer', key), '{"torn":');
    const client = fakeClient();
    assert.strictEqual((await call(cache, client, 'p1')).cached, false);
    assert.strictEqual(client.prompts.length, 1);
  });

  it('refuses an unknown stage or a key that is not a SHA-256', () => {
    const cache = newCache();
    assert.throws(() => cache.file('other', cacheKey({})), /stage/);
    assert.throws(() => cache.file('answer', '../x'), /SHA-256/);
  });

  it('lives under LONGHAUL_HOME/private', () => {
    const cache = ModelCache.forHome({ private: path.join('H', 'private') });
    assert.strictEqual(cache.root, path.join('H', 'private', 'model-cache'));
  });
});

describe('usageFromMetrics', () => {
  it('keeps the provider usage and the catalog cost, and never turns an unknown cost into 0', () => {
    assert.deepStrictEqual(usageFromMetrics({ inputTokens: 10, outputTokens: 2, costUsd: 0.5 }), { inputTokens: 10, outputTokens: 2, costUsd: 0.5 });
    assert.deepStrictEqual(usageFromMetrics({ inputTokens: 10, outputTokens: 2, costUsd: null, unpriced: true }), { inputTokens: 10, outputTokens: 2, costUsd: null });
    assert.deepStrictEqual(usageFromMetrics(null), { inputTokens: null, outputTokens: null, costUsd: null });
  });

  it('records a reply with zero or absent usage as cost unknown, never $0, unless the client is local (review round 2)', () => {
    assert.deepStrictEqual(usageFromMetrics({ inputTokens: 0, outputTokens: 0, costUsd: 0 }), { inputTokens: 0, outputTokens: 0, costUsd: null });
    assert.deepStrictEqual(usageFromMetrics({ costUsd: 0 }), { inputTokens: null, outputTokens: null, costUsd: null });
    assert.deepStrictEqual(usageFromMetrics({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, { local: true }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('stores cost unknown for a non-local reply that reports no usage, through cachedCall', async () => {
    const cache = newCache();
    const client = { provider: 'fake', model: 'fake-1', async complete() { return { text: 'x', llmMetrics: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }; } };
    const out = await call(cache, client, 'p');
    assert.strictEqual(out.costUsd, null);
    const local = { ...client, local: true };
    assert.strictEqual((await call(newCache(), local, 'p')).costUsd, 0);
  });
});

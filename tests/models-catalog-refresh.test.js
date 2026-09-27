// tests/models-catalog-refresh.test.js
// Live catalog refresh (spec 2026-09-27 §4.1, §15): daily fetch with ETag,
// cache under <dataDir>/catalog/, fetch switch, malformed documents discarded,
// fallback to cache then snapshot. The fetch is injected; no network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { CATALOG_DEFAULTS } = require('../src/models/catalog');
const { setLogLevel } = require('../src/logging');

// Several cases here deliberately trigger the catalog's warnings (malformed
// JSON, an unusable document, an HTTP error, an offline fetch, an
// unwritable cache dir); silence them so TAP output stays clean.
setLogLevel('fatal');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-catalog-refresh-')); dirs.push(d); return d; };

const MODELS_URL = CATALOG_DEFAULTS.modelsDevUrl;
const SCORES_URL = CATALOG_DEFAULTS.scoresUrl;

const LIVE_MODELS = {
  openai: {
    id: 'openai',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5 live', tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] }, cost: { input: 5, output: 30, cache_read: 0.5 } }
    }
  },
  'not-ours': { id: 'not-ours', models: { a: { id: 'a' } } }
};
const LIVE_SCORES = {
  data: [{ id: 'openai/gpt-5.5', benchmarks: { artificial_analysis: { intelligence_index: 61, coding_index: 56, agentic_index: 51 } } }]
};

const json = (body, { status = 200, etag = null } = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) }
});

// routes: url → (init, callIndex) => Response. Records every call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: { ...(init.headers || {}) } });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(init, calls.filter((c) => c.url === url).length);
  };
  fn.calls = calls;
  return fn;
}

const clock = (iso) => {
  const state = { now: new Date(iso) };
  return { now: () => state.now, set: (next) => { state.now = new Date(next); } };
};

const liveRoutes = () => ({
  [MODELS_URL]: (init, n) => (n > 1 && init.headers?.['If-None-Match'] === '"md-1"' ? new Response(null, { status: 304 }) : json(LIVE_MODELS, { etag: '"md-1"' })),
  [SCORES_URL]: (init, n) => (n > 1 && init.headers?.['If-None-Match'] === '"sc-1"' ? new Response(null, { status: 304 }) : json(LIVE_SCORES, { etag: '"sc-1"' }))
});

describe('Catalog.refresh', () => {
  it('fetches models.dev and scores, caches them trimmed, and serves them', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch(liveRoutes());
    const t = clock('2026-09-28T08:00:00Z');
    const c = fixtureCatalog({ cacheDir, fetch, now: t.now });
    const events = [];
    c.on('updated', (s) => events.push(s));
    const r = await c.refresh();
    assert.deepStrictEqual(r, { source: 'live', fetchedAt: '2026-09-28T08:00:00.000Z' });
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
    assert.strictEqual(c.get('openai', 'gpt-5.5').scores.intelligence, 61);
    assert.ok(c.get('anthropic', 'claude-sonnet-4-5'), 'snapshot entries stay');
    const file = JSON.parse(fs.readFileSync(path.join(cacheDir, 'models-dev.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(file.data), ['openai'], 'trimmed to King Louie providers');
    assert.strictEqual(file.etag, '"md-1"');
    const scores = JSON.parse(fs.readFileSync(path.join(cacheDir, 'scores.json'), 'utf8'));
    assert.deepStrictEqual(scores.scores['openai/gpt-5.5'], { intelligence: 61, coding: 56, agentic: 51 });
    assert.strictEqual(events.length, 1);
  });

  it('does not fetch again within refreshHours; a forced refresh sends the ETag and keeps the copy on 304', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch(liveRoutes());
    const t = clock('2026-09-28T08:00:00Z');
    const c = fixtureCatalog({ cacheDir, fetch, now: t.now });
    await c.refresh();
    assert.strictEqual(fetch.calls.length, 2);
    t.set('2026-09-28T09:00:00Z');
    await c.refresh();
    assert.strictEqual(fetch.calls.length, 2, 'fresh copy: no fetch');
    await c.refresh({ force: true });
    assert.strictEqual(fetch.calls.length, 4);
    assert.strictEqual(fetch.calls[2].headers['If-None-Match'], '"md-1"');
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
    assert.strictEqual(c.status().fetchedAt, '2026-09-28T09:00:00.000Z', '304 renews the copy');
  });

  it('fetches again once the cached copy is older than refreshHours', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch(liveRoutes());
    const t = clock('2026-09-28T08:00:00Z');
    const c = fixtureCatalog({ cacheDir, fetch, now: t.now });
    await c.refresh();
    t.set('2026-09-29T09:00:00Z');
    await c.refresh();
    assert.strictEqual(fetch.calls.length, 4);
  });

  it('models.catalog.fetch false turns both fetches off', async () => {
    const fetch = fakeFetch(liveRoutes());
    const c = fixtureCatalog({ cacheDir: tmp(), fetch, getSettings: () => ({ models: { catalog: { fetch: false } } }) });
    const r = await c.refresh({ force: true });
    assert.strictEqual(fetch.calls.length, 0);
    assert.strictEqual(r.source, 'snapshot');
  });

  it('keeps the previous copy when the response is not JSON', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch({ [MODELS_URL]: () => new Response('not json', { status: 200 }), [SCORES_URL]: () => new Response('<html>', { status: 200 }) });
    const c = fixtureCatalog({ cacheDir, fetch });
    const events = [];
    c.on('updated', (s) => events.push(s));
    await c.refresh();
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5');
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'models-dev.json')), false);
    assert.strictEqual(c.status().source, 'snapshot');
    assert.strictEqual(events.length, 0);
  });

  it('discards a document that is not a models.dev catalog or an OpenRouter list', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch({ [MODELS_URL]: () => json({ openai: 5 }), [SCORES_URL]: () => json({ nope: true }) });
    const c = fixtureCatalog({ cacheDir, fetch });
    await c.refresh();
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'models-dev.json')), false);
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'scores.json')), false);
    assert.strictEqual(c.get('openai', 'gpt-5.5').scores.intelligence, 60.1);
  });

  it('keeps the previous copy on an HTTP error', async () => {
    const fetch = fakeFetch({ [MODELS_URL]: () => json({ error: 'down' }, { status: 503 }), [SCORES_URL]: () => json({ error: 'down' }, { status: 503 }) });
    const c = fixtureCatalog({ cacheDir: tmp(), fetch });
    await c.refresh();
    assert.strictEqual(c.status().source, 'snapshot');
  });

  it('falls back to the cached copy, then the snapshot, when the fetch fails', async () => {
    const cacheDir = tmp();
    await fixtureCatalog({ cacheDir, fetch: fakeFetch(liveRoutes()) }).refresh();
    const offline = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const c = fixtureCatalog({ cacheDir, fetch: offline });
    await c.refresh({ force: true });
    assert.strictEqual(c.status().source, 'cache');
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
    const bare = fixtureCatalog({ cacheDir: tmp(), fetch: offline });
    await bare.refresh();
    assert.strictEqual(bare.status().source, 'snapshot');
  });

  it('serves the fetched copy for the session even when the cache dir cannot be written', async () => {
    const blocker = path.join(tmp(), 'not-a-dir');
    fs.writeFileSync(blocker, 'a file where the catalog folder should be');
    const c = fixtureCatalog({ cacheDir: blocker, fetch: fakeFetch(liveRoutes()) });
    const r = await c.refresh();
    assert.strictEqual(r.source, 'live');
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
  });

  it('does nothing without a cache dir', async () => {
    const fetch = fakeFetch(liveRoutes());
    const c = fixtureCatalog({ fetch });
    await c.refresh({ force: true });
    assert.strictEqual(fetch.calls.length, 0);
  });

  it('shares one run between overlapping refresh() calls (the startup refresh and a forced "Refresh now")', async () => {
    const cacheDir = tmp();
    const fetch = fakeFetch(liveRoutes());
    const c = fixtureCatalog({ cacheDir, fetch });
    const [a, b] = await Promise.all([c.refresh(), c.refresh({ force: true })]);
    assert.strictEqual(fetch.calls.length, 2, 'one fetch each for models.dev and scores, not one per call');
    assert.deepStrictEqual(a, b, 'both callers see the same result');
    assert.strictEqual(c.get('openai', 'gpt-5.5').name, 'GPT-5.5 live');
  });
});

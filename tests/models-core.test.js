// tests/models-core.test.js
// The core builds one catalog and one Availability (spec 2026-09-27 §3):
// providers price with it, the one connection test stores the account's
// models, 401s mark a provider unusable, and the background checks start
// only when the host asks and never in test mode.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { getActiveCatalog, setActiveCatalog, CATALOG_DEFAULTS } = require('../src/models');
const { setLogLevel } = require('../src/logging');
const { profileSettings } = require('./helpers/profile-settings');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');

// One case here deliberately fails a connection test (a bad key); silence
// the resulting warning so TAP output stays clean.
setLogLevel('fatal');

const tempDirs = [];
const cores = [];
const originalFetch = globalThis.fetch;
const originalTestMode = process.env.KL_TEST_MODE;
// Every core this file builds is shut down here: 'background checks refresh
// the catalog' runs with KL_TEST_MODE off, so startBackgroundChecks reaches
// startHistoryEmbedding and starts the embedder host. Left running, its embed
// worker keeps the process alive and the whole file times out.
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalTestMode === undefined) delete process.env.KL_TEST_MODE;
  else process.env.KL_TEST_MODE = originalTestMode;
  while (cores.length) await cores.pop().shutdown();
  setActiveCatalog(null);
  closeOpenHistoryStores();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeCore(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-models-core-'));
  tempDirs.push(dataDir);
  const sent = [];
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  const core = createCore({
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: (ch, p) => sent.push({ ch, p }) },
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
    // No test here loads a model: the embedder host gets the in-process fake
    // runner, never a child process that would download one.
    history: { createEmbedRunner: () => new FakeEmbedRunner() },
    ...extra
  });
  cores.push(core);
  return { core, store, sent, dataDir };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubProviderFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    const key = String(url);
    // Anthropic's and Gemini's listModels now carry pagination query params
    // (limit/after_id, pageSize/pageToken — final review I1); match a route
    // keyed by the bare path too, so existing routes don't have to spell
    // out every query string.
    const route = routes[key] || routes[key.split('?')[0]];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  };
  return seen;
}

describe('models in the core', () => {
  it('builds the catalog from the bundled snapshot and makes it the one providers price with', () => {
    const { core } = makeCore();
    assert.strictEqual(core.models.catalog.status().source, 'snapshot');
    assert.strictEqual(core.context.getCatalog(), core.models.catalog);
    assert.strictEqual(getActiveCatalog(), core.models.catalog);
    assert.strictEqual(core.context.getProviderOptions('openai').catalog, core.models.catalog);
    assert.strictEqual(core.context.getAvailability(), core.models.availability);
  });

  it('tests a provider with listModels and stores the account\'s models under apiStatus', async () => {
    const { core, store, sent } = makeCore();
    core.saveProviderToken('openai', 'sk-test-123456');
    const seen = stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-4o' }] }) });
    const r = await core.context.testProviderConnection('openai');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.status.models, ['gpt-4o', 'gpt-5.5']);
    assert.deepStrictEqual(store.get('apiStatus').openai.models, ['gpt-4o', 'gpt-5.5']);
    assert.strictEqual(seen[0].headers.Authorization, 'Bearer sk-test-123456');
    assert.ok(sent.some((e) => e.ch === 'models:statusChanged' && e.p.provider === 'openai'));
  });

  it('reports a failed test as an error with its status', async () => {
    const { core } = makeCore();
    core.saveProviderToken('openai', 'sk-test-123456');
    stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ error: { message: 'Incorrect API key provided' } }, 401) });
    const r = await core.context.testProviderConnection('openai');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Incorrect API key provided');
    assert.strictEqual(r.status.httpStatus, 401);
  });

  it('gives Ollama the address from settings', () => {
    const { core } = makeCore();
    const settings = core.getSettings();
    core.context.setSettings({ ...settings, models: { ...settings.models, ollama: { baseUrl: 'http://192.0.2.7:11434' } } });
    assert.strictEqual(core.context.getProviderOptions('ollama').serverUrl, 'http://192.0.2.7:11434');
    assert.strictEqual(core.context.getProviderOptions('openai').serverUrl, undefined);
  });

  it('marks a provider unusable on a 401 during use, but not on a rate limit', () => {
    const { core } = makeCore();
    core.context.reportProviderError('openai', Object.assign(new Error('Incorrect API key provided'), { status: 401 }));
    assert.strictEqual(core.models.availability.status('openai').authFailed, true);
    core.context.reportProviderError('groq', Object.assign(new Error('Rate limit reached'), { status: 429 }));
    assert.strictEqual(core.models.availability.status('groq'), null);
    const wrapped = new Error('Provider call failed (iteration 1, model "m"): bad key');
    wrapped.cause = Object.assign(new Error('bad key'), { status: 403 });
    core.context.reportProviderError('anthropic', wrapped);
    assert.strictEqual(core.models.availability.status('anthropic').authFailed, true);
  });

  it('retests a saved key and forgets the status of a cleared one', async () => {
    const { core, store } = makeCore();
    core.saveProviderToken('openai', 'sk-test-123456');
    stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ data: [{ id: 'gpt-5.5' }] }) });
    assert.strictEqual((await core.context.onProviderKeyChanged('openai')).ok, true);
    store.set('apiTokens', {});
    assert.strictEqual(await core.context.onProviderKeyChanged('openai'), null);
    assert.strictEqual(store.get('apiStatus').openai, undefined);
  });

  // Fix round 1, finding 3 (strengthened in fix round 2, finding A):
  // Availability's createProvider decided OAuth mode by checking token ===
  // '__anthropic_oauth__', but getDecryptedProviderToken only returns that
  // placeholder before the access token is cached — once cached it returns
  // the real token, so the connection test ran in API-key mode (x-api-key
  // header) and Anthropic rejected it with a 401, permanently marking an
  // OAuth-only account unusable. OAuth mode is now decided by
  // anthropicOAuth.isConnected() alone.
  it('tests an OAuth-only Anthropic account in OAuth mode, not API-key mode, even once the token is cached', async () => {
    const { core, store } = makeCore();
    // Seed a connected OAuth session directly, the way a prior sign-in
    // would have left it: encrypted with the same cipher the core uses.
    store.set('anthropicOAuth', {
      accessToken: core.context.encryptToken('oauth-access-token'),
      refreshToken: core.context.encryptToken('refresh-xyz'),
      expiresAt: Date.now() + 3600_000,
      connectedAt: Date.now()
    });
    // No apiTokens.anthropic saved.
    const seen = stubProviderFetch({ 'https://api.anthropic.com/v1/models': () => json({ data: [{ id: 'claude-sonnet-5' }] }) });
    const r1 = await core.context.testProviderConnection('anthropic');
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    // A single call does not prove the fix: on a fresh core the OAuth
    // access-token cache is still empty, so getDecryptedProviderToken
    // returns the '__anthropic_oauth__' placeholder regardless of which
    // code is running, and the old placeholder-string check happened to
    // take the OAuth branch too. The bug only showed on a SECOND call,
    // once the token was cached — the old check's `token ===
    // '__anthropic_oauth__'` then went false (the cache returns the real
    // token instead) and silently fell through to API-key mode. Calling it
    // again is what actually exercises that path.
    const r2 = await core.context.testProviderConnection('anthropic');
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1].headers.Authorization, 'Bearer oauth-access-token');
    assert.strictEqual('x-api-key' in seen[1].headers, false, 'must not send the cached OAuth token as an x-api-key header');
  });

  // Fix round 2, finding B: getDecryptedProviderToken prefers OAuth over a
  // stored API key whenever OAuth is connected, but Availability's
  // createProvider required *no* stored key to take the OAuth branch — an
  // owner who is OAuth-connected and also has an old API key saved got
  // API-key mode (and the same 401) despite an active OAuth session.
  // createProvider's OAuth decision now mirrors getDecryptedProviderToken's
  // own preference: connected wins, independent of a stored key.
  it('prefers OAuth over a stored API key when both are present', async () => {
    const { core, store } = makeCore();
    store.set('anthropicOAuth', {
      accessToken: core.context.encryptToken('oauth-access-token'),
      refreshToken: core.context.encryptToken('refresh-xyz'),
      expiresAt: Date.now() + 3600_000,
      connectedAt: Date.now()
    });
    core.saveProviderToken('anthropic', 'sk-ant-stored-key');
    const seen = stubProviderFetch({ 'https://api.anthropic.com/v1/models': () => json({ data: [{ id: 'claude-sonnet-5' }] }) });
    const r = await core.context.testProviderConnection('anthropic');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(seen[0].headers.Authorization, 'Bearer oauth-access-token');
    assert.strictEqual('x-api-key' in seen[0].headers, false, 'a stored API key must not override an active OAuth session');
  });

  // Final review I3: createProviderInstance (used by resolveInference /
  // InferenceRouter — the real chat send path, not Availability's own
  // createProvider, which Task 9 already fixed the same way) decided OAuth
  // mode by the same '__anthropic_oauth__' placeholder check. Once the
  // access token was cached, a chat send picked API-key mode, sent the
  // token as x-api-key, and Anthropic's 401 got reported to
  // markAuthFailure — a sticky "Key rejected" that a manual "Test all"
  // couldn't fix (that goes through Availability's own, already-correct
  // createProvider), so the owner loops.
  it('a chat send to Anthropic stays in OAuth mode once the token is cached', async () => {
    const { core, store } = makeCore();
    core.context.setSettings(profileSettings(core.getSettings(), { main: [{ provider: 'anthropic', model: 'claude-sonnet-5', effort: null }] }));
    store.set('apiStatus', { anthropic: { ok: true, checkedAt: new Date().toISOString(), models: ['claude-sonnet-5'] } });
    store.set('anthropicOAuth', {
      accessToken: core.context.encryptToken('oauth-access-token'),
      refreshToken: core.context.encryptToken('refresh-xyz'),
      expiresAt: Date.now() + 3600_000,
      connectedAt: Date.now()
    });
    // No apiTokens.anthropic saved.
    const seen = stubProviderFetch({ 'https://api.anthropic.com/v1/models': () => json({ data: [{ id: 'claude-sonnet-5' }] }) });
    const first = await core.context.resolveRole('main');
    assert.strictEqual(first.providerType, 'anthropic');
    assert.strictEqual(first.provider.authMode, 'oauth');
    // A single resolution does not prove the fix: on a fresh core the OAuth
    // access-token cache is still empty, so getDecryptedProviderToken
    // returns the '__anthropic_oauth__' placeholder regardless of which
    // code is running. The bug only showed on a SECOND resolution, once the
    // token was cached and the placeholder check went false.
    const second = await core.context.resolveRole('main');
    assert.strictEqual(second.providerType, 'anthropic');
    assert.strictEqual(second.provider.authMode, 'oauth', 'must stay in OAuth mode once the token is cached');
    await second.provider.listModels();
    assert.strictEqual(seen[seen.length - 1].headers.Authorization, 'Bearer oauth-access-token');
    assert.strictEqual('x-api-key' in seen[seen.length - 1].headers, false, 'must not send the cached OAuth token as an x-api-key header');
  });

  // Final review I4: right after a normal restart, an Ollama status from a
  // previous session is already on disk, but no Availability.test('ollama')
  // has run yet in this process — Catalog.setLocalModels only ever ran in
  // the process that did the discovery. Before this, the catalog knew
  // nothing about that account's local models until the next retest (24h)
  // or a manual Test, so a local id could price at Ollama Cloud rates (or
  // stay unpriced) in the meantime.
  it('seeds local Ollama entries from the stored status at core start, before any test runs this session', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-models-core-'));
    tempDirs.push(dataDir);
    const store = new JsonFileStore({
      dir: dataDir,
      name: 'chat-data',
      defaults: {
        chats: [], activeChatId: null, apiTokens: {}, toolApprovals: { alwaysApproveTools: {} },
        // A discovery from a previous session, already on disk before this
        // core is even constructed.
        apiStatus: { ollama: { ok: true, error: null, message: 'Connected: 1 model.', checkedAt: new Date().toISOString(), models: ['gpt-oss:20b'] } }
      }
    });
    const core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); }
    });
    const entry = core.models.catalog.get('ollama', 'gpt-oss:20b');
    assert.ok(entry, 'the stored model is already in the catalog at start');
    assert.strictEqual(entry.local, true);
    assert.strictEqual(entry.cost.input, 0);
  });

  it('starts no background checks in test mode', async () => {
    process.env.KL_TEST_MODE = '1';
    const calls = [];
    const { core } = makeCore({ fetch: async (url) => { calls.push(url); throw new Error('no'); } });
    assert.deepStrictEqual(await core.models.startBackgroundChecks(), { skipped: true });
    assert.deepStrictEqual(calls, []);
  });

  it('background checks refresh the catalog and retest stale providers', async () => {
    delete process.env.KL_TEST_MODE;
    const catalogCalls = [];
    const { core } = makeCore({
      fetch: async (url) => {
        catalogCalls.push(url);
        if (url === CATALOG_DEFAULTS.modelsDevUrl) return json({ openai: { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5', cost: { input: 5, output: 30 } } } } });
        if (url === CATALOG_DEFAULTS.scoresUrl) return json({ data: [] });
        throw new Error(`unexpected ${url}`);
      }
    });
    core.saveProviderToken('openai', 'sk-test-123456');
    stubProviderFetch({ 'https://api.openai.com/v1/models': () => json({ data: [{ id: 'gpt-5.5' }] }) });
    assert.deepStrictEqual(await core.models.startBackgroundChecks(), { skipped: false });
    assert.deepStrictEqual(catalogCalls.sort(), [CATALOG_DEFAULTS.modelsDevUrl, CATALOG_DEFAULTS.scoresUrl].sort());
    assert.strictEqual(core.models.catalog.status().source, 'live');
    assert.strictEqual(core.models.availability.status('openai').ok, true);
    assert.strictEqual(core.models.availability.status('ollama'), null, 'an Ollama never set up is not probed');
  });
});

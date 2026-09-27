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

// One case here deliberately fails a connection test (a bad key); silence
// the resulting warning so TAP output stays clean.
setLogLevel('fatal');

const tempDirs = [];
const originalFetch = globalThis.fetch;
const originalTestMode = process.env.KL_TEST_MODE;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTestMode === undefined) delete process.env.KL_TEST_MODE;
  else process.env.KL_TEST_MODE = originalTestMode;
  setActiveCatalog(null);
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
    ...extra
  });
  return { core, store, sent, dataDir };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubProviderFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    const route = routes[String(url)];
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

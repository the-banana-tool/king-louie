// tests/models-core-profiles.test.js
// Profiles in the core (spec 2026-09-27 §6, §13): the tier migration at
// construction, the snapshot precedence, usability for registered
// providers, role resolution and /llm profile.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore, PROVIDER_LABELS } = require('../src/core/create-core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const ProviderFactory = require('../src/providers/provider-factory');
const git = require('../src/cases/git');
const { profileSettings } = require('./helpers/profile-settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model, effort = null) => ({ provider, model, effort });
const tempDirs = [];
const realFetch = globalThis.fetch;
const savedCasesRoot = process.env.KL_CASES_ROOT;
afterEach(() => {
  globalThis.fetch = realFetch;
  setActiveCatalog(null);
  if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeCore({ settings, chats = [], apiStatus = {}, patchStore = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-core-profiles-'));
  tempDirs.push(dataDir);
  delete process.env.KL_CASES_ROOT;
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  if (settings) store.set('settings', settings);
  store.set('chats', chats);
  store.set('apiStatus', apiStatus);
  if (patchStore) patchStore(store);
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
  return { core, store };
}

const legacySettings = () => ({
  activeProvider: 'openai',
  inference: {
    activeTier: 'standard',
    tierMap: { fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' }, standard: { provider: 'openai', model: 'gpt-5.5' }, smart: { provider: 'openai', model: 'gpt-5.5' } }
  }
});

const threeProfiles = () => ({
  models: {
    profiles: [
      { id: 'p-a', name: 'A', roles: { main: [t('openai', 'gpt-5.5')] } },
      { id: 'p-b', name: 'B', roles: { main: [t('anthropic', 'claude-sonnet-5')] } },
      { id: 'p-c', name: 'C', roles: { main: [t('gemini', 'gemini-2.5-pro')] } }
    ],
    defaultProfileId: 'p-a'
  }
});

describe('the tier migration at core construction', () => {
  it('moves stored tier settings into one migrated default profile', () => {
    const { core, store } = makeCore({ settings: legacySettings() });
    const migration = core.context.getModelMigration();
    assert.strictEqual(migration.migrated, true);
    const profile = core.context.getProfiles().getDefault();
    assert.strictEqual(profile.kind, 'migrated');
    assert.deepStrictEqual(profile.roles.main, [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(profile.roles.utility, [t('groq', 'llama-3.3-70b-versatile')]);
    assert.strictEqual(store.get('settings').models.profiles.length, 1);
    assert.strictEqual(core.models.profiles, core.context.getProfiles());
  });

  it('gives a fresh store a Default profile whose main lists each provider\'s default model', () => {
    const { core } = makeCore();
    assert.strictEqual(core.context.getModelMigration().fresh, true);
    const profile = core.context.getProfiles().getDefault();
    const expected = Object.keys(PROVIDER_LABELS)
      .map((provider) => ({ provider, model: ProviderFactory.create(provider, 'test-key-123456').getDefaultModel() || '', effort: null }))
      .filter((x) => x.model);
    assert.deepStrictEqual(profile.roles, { main: expected, worker: [], utility: [] });
    assert.ok(!profile.roles.main.some((x) => x.provider === 'ollama'), 'Ollama ships no default');
  });

  for (const [provider, key] of [['openai', 'sk-test-openai-123456'], ['anthropic', 'sk-ant-test-123456']]) {
    it(`a fresh install with only a ${provider} key resolves main to ${provider}'s default model`, async () => {
      const { core } = makeCore();
      core.saveProviderToken(provider, key);
      const model = ProviderFactory.create(provider, key).getDefaultModel();
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      const r = await core.context.resolveRole('main');
      assert.deepStrictEqual([r.providerType, r.model], [provider, model]);
      assert.strictEqual((await core.context.resolveRole('utility')).borrowedFrom, 'main');
    });
  }

  it('leaves the old settings untouched when the write fails, and still starts', () => {
    const before = legacySettings();
    const { core, store } = makeCore({
      settings: before,
      patchStore: (s) => {
        const set = s.set.bind(s);
        let failed = false;
        s.set = (key, value) => {
          if (key === 'settings' && !failed) { failed = true; throw new Error('disk full'); }
          return set(key, value);
        };
      }
    });
    assert.deepStrictEqual(core.context.getModelMigration(), { migrated: false, error: 'disk full' });
    assert.deepStrictEqual(store.get('settings'), before);
    assert.deepStrictEqual(core.context.getProfiles().list(), []);
  });

  it('removes the old tier keys from the stored settings once the profile is written', () => {
    const { store } = makeCore({ settings: { ...legacySettings(), advisor: { enabled: true, model: 'gpt-4o' } } });
    const raw = store.get('settings');
    for (const key of ['activeProvider', 'providerModels', 'inference']) assert.strictEqual(key in raw, false, key);
    assert.deepStrictEqual(raw.advisor, { enabled: true });
    assert.strictEqual(raw.models.profiles.length, 1);
  });
});

describe('snapshotModels', () => {
  it('uses the chat\'s profile and main override, else the default', () => {
    const { core } = makeCore({
      settings: threeProfiles(),
      chats: [{ id: 'c1', title: 'x', messages: [], profileId: 'p-b', mainOverride: t('openai', 'gpt-5.4') }, { id: 'c2', title: 'y', messages: [] }]
    });
    const one = core.context.snapshotModels({ chatId: 'c1' });
    assert.deepStrictEqual([one.profileId, one.mainOverride], ['p-b', t('openai', 'gpt-5.4')]);
    const two = core.context.snapshotModels({ chatId: 'c2' });
    assert.deepStrictEqual([two.profileId, two.mainOverride], ['p-a', null]);
    assert.strictEqual(core.context.snapshotModels({ chatId: 'c1', profileId: 'p-c' }).profileId, 'p-c');
    assert.strictEqual(core.context.snapshotModels().profileId, 'p-a');
  });

  it('snapshotModels falls back to the default for a stale chat profileId', () => {
    const { core } = makeCore({ settings: threeProfiles(), chats: [{ id: 'c1', title: 'x', messages: [], profileId: 'p-gone' }] });
    assert.strictEqual(core.context.snapshotModels({ chatId: 'c1' }).profileId, 'p-a');
  });

  it('in a case chat, case.yaml\'s profile and main override win over the chat\'s', async (ctx) => {
    if (!(await git.isGitAvailable())) return ctx.skip('git is not on PATH');
    const { core } = makeCore({ settings: threeProfiles() });
    const rt = core.context.getCaseRuntime();
    const info = await rt.createCase({ title: 'Lakeside lot' });
    core.context.setChats([{ id: 'c1', title: 'x', messages: [], caseId: info.id, profileId: 'p-b', mainOverride: t('openai', 'gpt-5.4') }]);
    const plain = core.context.snapshotModels({ chatId: 'c1' });
    assert.deepStrictEqual([plain.profileId, plain.mainOverride], ['p-b', null], 'the chat\'s own override does not apply in a case chat');
    rt.store.updateMeta(info.id, { profile: 'p-c', mainOverride: t('anthropic', 'claude-sonnet-5') });
    const chosen = core.context.snapshotModels({ chatId: 'c1' });
    assert.deepStrictEqual([chosen.profileId, chosen.mainOverride], ['p-c', t('anthropic', 'claude-sonnet-5')]);
    assert.strictEqual(core.context.snapshotModels({ caseId: info.id }).profileId, 'p-c', 'an unattended case turn follows case.yaml');
  });
});

describe('explainTarget', () => {
  it('lets a registered provider outside the fourteen answer when it has a key', () => {
    ProviderFactory.registerProvider('fake-core', class { getDefaultModel() { return 'fake'; } });
    try {
      const { core } = makeCore();
      assert.deepStrictEqual(core.context.explainTarget('fake-core', 'fake').reasons, ['No token saved for fake-core.']);
      core.saveProviderToken('fake-core', 'fake-token-123456');
      assert.strictEqual(core.context.explainTarget('fake-core', 'fake').usable, true);
      assert.match(core.context.explainTarget('openai', 'gpt-5.5').reasons[0], /No token saved for OpenAI/);
    } finally {
      ProviderFactory._registry.delete('fake-core');
    }
  });
});

describe('resolveRole', () => {
  it('tests an untested provider first, then returns the instance, a routed provider and the role timeout', async () => {
    const { core } = makeCore({ settings: profileSettings({}, { main: [t('openai', 'gpt-5.5')] }) });
    core.saveProviderToken('openai', 'sk-test-openai-123456');
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const r = await core.context.resolveRole('main', { needs: { toolCall: true } });
    assert.ok(seen.some((u) => u.endsWith('/v1/models')), seen.join('\n'));
    assert.deepStrictEqual([r.providerType, r.model, r.targets], ['openai', 'gpt-5.5', [t('openai', 'gpt-5.5')]]);
    assert.strictEqual(r.provider.getProviderName(), 'openai');
    assert.strictEqual(r.routed.routed, true);
    assert.deepStrictEqual(r.routed.current(), t('openai', 'gpt-5.5'));
    assert.strictEqual(r.timeoutMs, 90000);
    const utility = await core.context.resolveRole('utility');
    assert.strictEqual(utility.borrowedFrom, 'main');
    assert.strictEqual(utility.timeoutMs, 15000);
  });

  it('fails with every skipped target and its reason when nothing is usable', async () => {
    const { core } = makeCore({ settings: profileSettings({}, { main: [t('groq', 'llama-3.3-70b-versatile')] }) });
    await assert.rejects(core.context.resolveRole('main'), (err) => err.code === 'NO_USABLE_MODEL' && /groq\/llama-3\.3-70b-versatile \(No token saved for Groq\.\)/.test(err.message));
  });

  it('checks an explicit target alone', async () => {
    ProviderFactory.registerProvider('fake-core', class { getDefaultModel() { return 'fake'; } getProviderName() { return 'fake-core'; } });
    try {
      const { core } = makeCore({ settings: profileSettings({}, { main: [t('groq', 'x')] }) });
      core.saveProviderToken('fake-core', 'fake-token-123456');
      const r = await core.context.resolveRole('main', { explicit: { provider: 'fake-core', model: 'fake' } });
      assert.deepStrictEqual(r.targets, [t('fake-core', 'fake')]);
    } finally {
      ProviderFactory._registry.delete('fake-core');
    }
  });
});

describe('/llm profile', () => {
  it('lists profiles and sets the default by name or id', async () => {
    const { core } = makeCore({ settings: threeProfiles() });
    const list = await core.context.runLlmCommand('/llm profile');
    assert.strictEqual(list.ok, true);
    assert.match(list.output, /\*\*A\*\* \(default\)/);
    const byName = await core.context.runLlmCommand('/llm profile b');
    assert.deepStrictEqual(byName, { ok: true, output: 'Default profile set to B.' });
    assert.strictEqual(core.context.getProfiles().defaultId(), 'p-b');
    assert.strictEqual((await core.context.runLlmCommand('/llm profile p-c')).ok, true);
    assert.strictEqual(core.context.getProfiles().defaultId(), 'p-c');
    const missing = await core.context.runLlmCommand('/llm profile Nope');
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /No profile named "Nope"/);
  });
});

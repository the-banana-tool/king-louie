// tests/models-profiles-local-only.test.js
// A profile's local-only roles (local inference spec 2026-10-13 §7.1, §13.1,
// §13.2): `localOnly` survives a save, a save may add a role to it, and a
// role leaves it only through models:local.unsetLocalOnly from the app's own
// window. A generic settings save cannot take one off either (the core's
// seal). A turn's snapshot holds a local-only role to local targets and
// refuses it LOCAL_ONLY_ROLE_NO_MODEL when it has none; other roles are
// untouched.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Profiles, normalizeProfile, sealLocalOnly } = require('../src/models/profiles');
const { markLocalDesktopEvent } = require('../src/core/origin');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');
const IPC = require('../src/ipc/constants');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');
const { FakeEmbedRunner } = require('./helpers/fake-embed-runner');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const AT = '2026-10-13T09:00:00.000Z';
const t = (provider, model) => ({ provider, model, effort: null });
const HOSTED = t('openai', 'gpt-5.5');
const LOCAL = t('local', 'workstation/qwen3:8b');

function memoryProfiles(initial) {
  let settings = { models: { profiles: initial, defaultProfileId: initial[0].id } };
  const writes = { sealed: 0, unsealed: 0 };
  const profiles = new Profiles({
    getSettings: () => settings,
    setSettings: (next) => { writes.sealed += 1; settings = sealLocalOnly(next, settings); },
    writeUnsealed: (next) => { writes.unsealed += 1; settings = next; }
  });
  return { profiles, writes, settings: () => settings };
}
const mixed = () => ({ id: 'p-mixed', name: 'Mixed', kind: 'user', roles: { main: [HOSTED], worker: [HOSTED], utility: [LOCAL, HOSTED] }, localOnly: ['utility'] });

describe('a profile\'s localOnly', () => {
  it('survives normalizing and a save; only role ids of the profile or core roles are kept', () => {
    const p = normalizeProfile({ ...mixed(), localOnly: ['utility', 'main', 'nonsense-role', 7, 'utility'] });
    assert.deepStrictEqual(p.localOnly, ['utility', 'main']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(normalizeProfile({ ...mixed(), localOnly: [] }), 'localOnly'), false, 'an empty list is not written');
    const { profiles } = memoryProfiles([mixed()]);
    const saved = profiles.update('p-mixed', { name: 'Mixed models' });
    assert.deepStrictEqual(saved.localOnly, ['utility']);
    assert.deepStrictEqual(profiles.get('p-mixed').localOnly, ['utility']);
  });

  it('a stored localOnly that is not a list makes every role of the profile local-only (fail closed)', () => {
    const p = normalizeProfile({ ...mixed(), localOnly: 'utility' });
    assert.deepStrictEqual([...p.localOnly].sort(), ['main', 'utility', 'worker']);
  });

  it('update adds a role; removing one is LOCAL_ONLY_ONE_WAY_HERE without the option', () => {
    const { profiles } = memoryProfiles([mixed()]);
    assert.deepStrictEqual(profiles.update('p-mixed', { localOnly: ['utility', 'worker'] }).localOnly, ['utility', 'worker']);
    assert.throws(() => profiles.update('p-mixed', { localOnly: ['worker'] }), (err) => err.code === 'LOCAL_ONLY_ONE_WAY_HERE');
    assert.throws(() => profiles.update('p-mixed', { localOnly: [] }), (err) => err.code === 'LOCAL_ONLY_ONE_WAY_HERE');
    assert.deepStrictEqual(profiles.get('p-mixed').localOnly, ['utility', 'worker']);
  });

  it('allowUnsetLocalOnly removes a role, through the unsealed writer only', () => {
    const { profiles, writes } = memoryProfiles([mixed()]);
    const out = profiles.update('p-mixed', { localOnly: [] }, { allowUnsetLocalOnly: true });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(out, 'localOnly'), false);
    assert.strictEqual(profiles.get('p-mixed').localOnly, undefined);
    assert.strictEqual(writes.unsealed, 1);
  });

  it('the seal keeps a stored local-only role through any settings save, and lets one be added', () => {
    const stored = { models: { profiles: [mixed()], defaultProfileId: 'p-mixed' } };
    const dropped = { models: { profiles: [{ ...mixed(), localOnly: [] }], defaultProfileId: 'p-mixed' } };
    assert.deepStrictEqual(sealLocalOnly(dropped, stored).models.profiles[0].localOnly, ['utility']);
    const missing = { models: { profiles: [{ id: 'p-mixed', name: 'Mixed', kind: 'user', roles: mixed().roles }] } };
    assert.deepStrictEqual(sealLocalOnly(missing, stored).models.profiles[0].localOnly, ['utility']);
    const added = { models: { profiles: [{ ...mixed(), localOnly: ['main'] }] } };
    assert.deepStrictEqual(sealLocalOnly(added, stored).models.profiles[0].localOnly.sort(), ['main', 'utility']);
    // A profile the save leaves out entirely is a deleted profile, not a cleared role.
    assert.deepStrictEqual(sealLocalOnly({ models: { profiles: [] } }, stored).models.profiles, []);
  });

  it('snapshot holds a local-only role to local targets and refuses it with none; main is untouched', () => {
    const explain = () => ({ usable: true, reasons: [], notes: [] });
    const isGuaranteeTarget = (target) => target.provider === 'local';
    const { profiles } = memoryProfiles([mixed()]);
    const turn = profiles.snapshot({ profileId: 'p-mixed', explain, isGuaranteeTarget });
    assert.deepStrictEqual(turn.resolve('utility').targets.map((x) => x.provider), ['local']);
    assert.deepStrictEqual(turn.resolve('main').targets.map((x) => x.provider), ['openai']);
    profiles.update('p-mixed', { localOnly: ['utility', 'worker'] });
    const after = profiles.snapshot({ profileId: 'p-mixed', explain, isGuaranteeTarget });
    assert.throws(() => after.mustResolve('worker'), (err) => err.code === 'LOCAL_ONLY_ROLE_NO_MODEL');
    assert.strictEqual(after.mustResolve('main').targets[0].provider, 'openai');
  });
});

describe('models:local.unsetLocalOnly', () => {
  const handlersFor = (profiles) => {
    const handlers = new Map();
    registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getProfiles: () => profiles });
    return handlers;
  };

  it('works only for the local window', async () => {
    const { profiles } = memoryProfiles([mixed()]);
    const h = handlersFor(profiles).get(IPC.MODELS_LOCAL_UNSET_LOCAL_ONLY);
    for (const event of [{}, null, markLocalDesktopEvent({}, { deviceId: 'kld-test-device' })]) {
      const r = await h(event, { profileId: 'p-mixed', role: 'utility' });
      assert.deepStrictEqual([r.ok, r.code], [false, 'NOT_LOCAL_WINDOW']);
    }
    assert.deepStrictEqual(profiles.get('p-mixed').localOnly, ['utility']);
    const r = await h(markLocalDesktopEvent({}), { profileId: 'p-mixed', role: 'utility' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(profiles.get('p-mixed').localOnly, undefined);
  });

  it('models:saveProfile carries localOnly and can add a role', async () => {
    const { profiles } = memoryProfiles([mixed()]);
    const handlers = new Map();
    const { createModelChoices } = require('../src/core/model-choices');
    const none = () => null;
    const choices = createModelChoices({
      profiles, explainTarget: () => ({ usable: true, reasons: [], notes: [] }),
      snapshotModels: none, listChats: () => [], getChat: none, updateChat: none, appendMessageToChat: none
    });
    registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }, { getProfiles: () => profiles, getModelChoices: () => choices });
    const r = await handlers.get(IPC.MODELS_SAVE_PROFILE)({}, { id: 'p-mixed', name: 'Mixed', roles: mixed().roles, localOnly: ['utility', 'main'] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.profile.localOnly, ['utility', 'main']);
    const refused = await handlers.get(IPC.MODELS_SAVE_PROFILE)({}, { id: 'p-mixed', name: 'Mixed', roles: mixed().roles, localOnly: [] });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.code, 'LOCAL_ONLY_ONE_WAY_HERE');
  });
});

describe('the core\'s seal on localOnly', () => {
  let core;
  let dataDir;
  after(async () => {
    if (core) await core.shutdown();
    setActiveCatalog(null);
    closeOpenHistoryStores();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('a generic settings save cannot remove a local-only role; the snapshot passes it to the resolver', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-local-only-'));
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {} } });
    store.set('settings', { models: { profiles: [mixed()], defaultProfileId: 'p-mixed' } });
    core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: () => {} },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      history: { createEmbedRunner: () => new FakeEmbedRunner() }
    });
    const ctx = core.context;
    const settings = ctx.getSettings();
    ctx.setSettings({ ...settings, models: { ...settings.models, profiles: settings.models.profiles.map((p) => ({ ...p, localOnly: [] })) } });
    assert.deepStrictEqual(ctx.getProfiles().get('p-mixed').localOnly, ['utility']);
    const turn = ctx.snapshotModels({});
    assert.strictEqual(turn.egressFor('utility').reason, 'local-only-role');
    assert.strictEqual(turn.egressFor('main'), null);
    void AT;
  });
});

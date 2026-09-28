// tests/models-profiles-ipc.test.js
// The profile channels (spec 2026-09-27 §11): thin handlers over
// src/core/model-choices.js, errors returned as { ok: false, error }.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const IPC = require('../src/ipc/constants');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');
const { ProfileError } = require('../src/models/profiles');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

function setup() {
  const calls = [];
  let settings = { models: { catalog: { fetch: true, refreshHours: 24 }, overrides: {} } };
  const choices = {
    profilesView: () => ({ profiles: [{ id: 'p-a' }], defaultProfileId: 'p-a', customRoles: [] }),
    saveProfile: (p) => { calls.push(['save', p]); if (!p.name) throw new ProfileError('BAD_NAME', 'A profile needs a name.'); return { id: p.id || 'p-new', name: p.name }; },
    duplicateProfile: (id) => { calls.push(['duplicate', id]); return { id: 'p-copy' }; },
    removeProfile: async (id) => { calls.push(['remove', id]); return { removed: id, defaultProfileId: 'p-a', moved: { chats: [], cases: [] } }; },
    setDefaultProfile: (id) => { calls.push(['default', id]); return id; },
    pickerView: ({ needs }) => { calls.push(['picker', needs]); return { usable: [], unusable: [] }; },
    chatView: (chatId) => { calls.push(['view', chatId]); return { chatId }; },
    setChatProfile: async (chatId, profileId) => { calls.push(['chatProfile', chatId, profileId]); return { id: chatId }; },
    setMainOverride: async (chatId, target) => { calls.push(['override', chatId, target]); return { id: chatId }; }
  };
  const context = {
    getModelChoices: () => choices,
    getCatalog: () => ({ status: () => ({ source: 'snapshot' }) }),
    getAvailability: () => ({}),
    getSettings: () => settings,
    setSettings: (next) => { settings = next; }
  };
  const handlers = new Map();
  registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, context);
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { call, calls, settings: () => settings };
}

describe('profile channels', () => {
  it('pass through to the model choices', async () => {
    const { call, calls } = setup();
    assert.deepStrictEqual(await call(IPC.MODELS_PROFILES), { ok: true, profiles: [{ id: 'p-a' }], defaultProfileId: 'p-a', customRoles: [] });
    assert.deepStrictEqual(await call(IPC.MODELS_SAVE_PROFILE, { name: 'Local', roles: { main: [] } }), { ok: true, profile: { id: 'p-new', name: 'Local' } });
    assert.deepStrictEqual(await call(IPC.MODELS_DUPLICATE_PROFILE, { id: 'p-a' }), { ok: true, profile: { id: 'p-copy' } });
    assert.strictEqual((await call(IPC.MODELS_REMOVE_PROFILE, { id: 'p-b' })).removed, 'p-b');
    assert.deepStrictEqual(await call(IPC.MODELS_SET_DEFAULT_PROFILE, { id: 'p-b' }), { ok: true, defaultProfileId: 'p-b' });
    await call(IPC.MODELS_PICKER, { needs: { toolCall: true, junk: 1 } });
    assert.deepStrictEqual(await call(IPC.MODELS_CHAT_VIEW, { chatId: 'c1' }), { ok: true, view: { chatId: 'c1' } });
    await call(IPC.MODELS_SET_CHAT_PROFILE, { chatId: 'c1', profileId: '' });
    await call(IPC.MODELS_SET_MAIN_OVERRIDE, { chatId: 'c1', target: { provider: 'openai', model: 'gpt-5.5', extra: 1 } });
    await call(IPC.MODELS_SET_MAIN_OVERRIDE, { chatId: 'c1', target: null });
    assert.deepStrictEqual(calls.slice(-5), [
      ['picker', { toolCall: true }],
      ['view', 'c1'],
      ['chatProfile', 'c1', null],
      ['override', 'c1', { provider: 'openai', model: 'gpt-5.5', effort: null }],
      ['override', 'c1', null]
    ]);
  });

  it('return a profile error as { ok: false, error }', async () => {
    const { call } = setup();
    assert.deepStrictEqual(await call(IPC.MODELS_SAVE_PROFILE, { name: '' }), { ok: false, error: 'A profile needs a name.' });
  });

  it('save the catalog settings, refusing bad values', async () => {
    const { call, settings } = setup();
    const ok = await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { fetch: false, refreshHours: 12, overrides: { 'openai:gpt-5.5': { cost: { input: 4 } } } });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual([settings().models.catalog.fetch, settings().models.catalog.refreshHours], [false, 12]);
    assert.deepStrictEqual(settings().models.overrides, { 'openai:gpt-5.5': { cost: { input: 4 } } });
    assert.strictEqual((await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { refreshHours: 0 })).ok, false);
    assert.strictEqual((await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { overrides: ['x'] })).ok, false);
    assert.strictEqual((await call(IPC.MODELS_SAVE_CATALOG_SETTINGS, { overrides: { nocolon: {} } })).ok, false);
  });

  it('are exposed on window.electron.models in the preload bridge', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    for (const ch of ['profiles', 'saveProfile', 'duplicateProfile', 'removeProfile', 'setDefaultProfile', 'picker', 'chatView', 'setChatProfile', 'setMainOverride', 'saveCatalogSettings']) {
      assert.ok(preload.includes(`ipcRenderer.invoke('models:${ch}'`), ch);
    }
  });
});

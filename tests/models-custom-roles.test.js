// tests/models-custom-roles.test.js
// Custom roles (spec 2026-09-27 §6.2, §11 "Advanced: custom roles"): saved
// with a fallback core role, refused when invalid, and never removed while a
// profile or a case role still names them.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const IPC = require('../src/ipc/constants');
const { Profiles } = require('../src/models/profiles');
const { createModelChoices } = require('../src/core/model-choices');
const { registerModelsHandlers } = require('../src/ipc/models-handlers');
const { mergeSettings } = require('../src/core/settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const t = (provider, model) => ({ provider, model, effort: null });
const usable = () => ({ usable: true, reasons: [], notes: [] });
const LEGAL = { id: 'legal-drafting', description: '', fallback: 'main', needs: {} };

function setup({ models = {}, caseRoles = {}, cases = [] } = {}) {
  let settings = mergeSettings({
    models: { profiles: [{ id: 'p-a', name: 'Work', kind: 'user', roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [] } }], defaultProfileId: 'p-a', ...models },
    cases: { roles: caseRoles }
  });
  const getSettings = () => settings;
  const setSettings = (next) => { settings = mergeSettings(next); };
  let n = 0;
  const profiles = new Profiles({ getSettings, setSettings, createId: () => `id${++n}` });
  const choices = createModelChoices({
    profiles,
    getSettings,
    explainTarget: usable,
    snapshotModels: () => null,
    listChats: () => [],
    getChat: () => null,
    updateChat: () => null,
    appendMessageToChat: () => null,
    getCaseRuntime: () => ({ listCases: () => cases })
  });
  return { profiles, choices, settings: () => settings, getSettings, setSettings };
}

describe('custom roles', () => {
  it('saves a custom role, refusing a bad id, a built-in name, a missing fallback or a bad context', () => {
    const { choices, settings } = setup();
    const saved = choices.saveCustomRole({ id: 'legal-drafting', description: 'Contracts and letters', fallback: 'main', needs: { toolCall: true, minContext: 64000 } });
    assert.deepStrictEqual(saved, { id: 'legal-drafting', description: 'Contracts and letters', needs: { toolCall: true, minContext: 64000 }, fallback: 'main' });
    assert.deepStrictEqual(settings().models.customRoles, [saved]);
    assert.throws(() => choices.saveCustomRole({ id: 'Legal Drafting', fallback: 'main' }), (e) => e.code === 'BAD_CUSTOM_ROLE' && /lowercase letters/.test(e.message));
    assert.throws(() => choices.saveCustomRole({ id: 'vision', fallback: 'main' }), /"vision" is a built-in role/);
    assert.throws(() => choices.saveCustomRole({ id: 'summaries', fallback: 'vision' }), /needs a fallback: main, worker or utility/);
    assert.throws(() => choices.saveCustomRole({ id: 'summaries', fallback: 'worker', needs: { minContext: -5 } }), /whole number of tokens/);
    // Saving the same id again edits it.
    choices.saveCustomRole({ id: 'legal-drafting', description: 'Contracts', fallback: 'worker' });
    assert.deepStrictEqual(settings().models.customRoles.map((r) => [r.id, r.fallback, r.description]), [['legal-drafting', 'worker', 'Contracts']]);
  });

  it('keeps a stored custom role it cannot read', () => {
    const { choices, settings } = setup({ models: { customRoles: [{ id: 'Bad Id', fallback: 'main' }, LEGAL] } });
    choices.saveCustomRole({ id: 'summaries', fallback: 'utility' });
    assert.deepStrictEqual(settings().models.customRoles.map((r) => r.id), ['Bad Id', 'legal-drafting', 'summaries']);
  });

  it('removing a custom role that is still used is refused, naming each use', () => {
    const { choices, profiles, settings } = setup({
      models: { customRoles: [LEGAL] },
      caseRoles: { draft: { role: 'legal-drafting' } },
      cases: [{ id: 'c-1', title: 'Lakeside lot', roles: { judge: { role: 'legal-drafting' } } }]
    });
    profiles.update('p-a', { roles: { ...profiles.get('p-a').roles, 'legal-drafting': [t('openai', 'gpt-5.5')] } });
    assert.throws(() => choices.removeCustomRole('legal-drafting'), (err) => err.code === 'ROLE_IN_USE'
      && err.message.includes('profile "Work"')
      && err.message.includes('case role draft in the case settings')
      && err.message.includes('case role judge in case "Lakeside lot"')
      && err.references.length === 3);
    assert.strictEqual(settings().models.customRoles.length, 1);
  });

  it('refuses removal (fail closed) when listing cases to check for a use breaks', () => {
    let settings = mergeSettings({
      models: { profiles: [{ id: 'p-a', name: 'Work', kind: 'user', roles: { main: [t('openai', 'gpt-5.5')], worker: [], utility: [] } }], customRoles: [LEGAL], defaultProfileId: 'p-a' }
    });
    const getSettings = () => settings;
    const setSettings = (next) => { settings = mergeSettings(next); };
    const choices = createModelChoices({
      profiles: new Profiles({ getSettings, setSettings, createId: () => 'id1' }),
      getSettings,
      explainTarget: usable,
      snapshotModels: () => null,
      listChats: () => [],
      getChat: () => null,
      updateChat: () => null,
      appendMessageToChat: () => null,
      getCaseRuntime: () => ({ listCases: () => { throw new Error('the case store is locked'); } })
    });
    assert.throws(() => choices.removeCustomRole('legal-drafting'), (err) => err.code === 'ROLE_CHECK_FAILED'
      && /Could not check whether the custom role "legal-drafting" is still used by any case/.test(err.message)
      && err.message.includes('the case store is locked'));
    // Nothing was removed: the role is still there, unused or not.
    assert.deepStrictEqual(settings.models.customRoles, [LEGAL]);
  });

  it('removes an unused custom role; an empty list in a profile is not a use', () => {
    const { choices, profiles, settings } = setup({ models: { customRoles: [LEGAL] } });
    profiles.update('p-a', { roles: { ...profiles.get('p-a').roles, 'legal-drafting': [] } });
    assert.deepStrictEqual(choices.removeCustomRole('legal-drafting'), { removed: 'legal-drafting' });
    assert.deepStrictEqual(settings().models.customRoles, []);
    assert.throws(() => choices.removeCustomRole('legal-drafting'), (e) => e.code === 'NOT_FOUND');
  });

  it('a deleted custom role fails the call naming it', () => {
    const { profiles } = setup({ models: { customRoles: [] } });
    const models = profiles.snapshot({ explain: usable });
    assert.throws(() => models.resolve('legal-drafting'), /Unknown model role "legal-drafting"/);
  });

  it('are saved and removed through their channels, errors as { ok: false, error }', async () => {
    const { choices, getSettings, setSettings } = setup();
    const handlers = new Map();
    registerModelsHandlers({ handle: (ch, fn) => handlers.set(ch, fn) }, { getModelChoices: () => choices, getSettings, setSettings });
    const call = (ch, payload) => handlers.get(ch)({}, payload);
    const saved = await call(IPC.MODELS_SAVE_CUSTOM_ROLE, { id: 'summaries', description: 'Short digests', fallback: 'utility', needs: { imageInput: true, junk: 1 } });
    assert.deepStrictEqual(saved, { ok: true, role: { id: 'summaries', description: 'Short digests', needs: { imageInput: true }, fallback: 'utility' } });
    // wrap-handler passes a thrown ProfileError's code through (Task 10 fix
    // round 1 #5), so this refusal also carries code: 'BAD_CUSTOM_ROLE'.
    assert.deepStrictEqual(await call(IPC.MODELS_SAVE_CUSTOM_ROLE, { id: 'main', fallback: 'main' }), { ok: false, error: '"main" is a built-in role; pick another id.', code: 'BAD_CUSTOM_ROLE' });
    assert.deepStrictEqual(await call(IPC.MODELS_REMOVE_CUSTOM_ROLE, { id: 'summaries' }), { ok: true, removed: 'summaries' });
  });
});

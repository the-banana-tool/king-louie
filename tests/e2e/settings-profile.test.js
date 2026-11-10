const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, fill, openSettingsTab } = require('./helpers');

// About you (settings redesign §8.1): one Name, Role and Project context over the
// template variables and the TELOS profile, saved as they change.
describe('E2E: Settings — About you', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    // TELOS starts empty on a fresh profile; the template has a name of its own.
    await evaluate(ctx, `window.electron.settings.saveTemplateVariables({ templateVariables: { name: 'TestUser' } }).then(() => true)`);
    await openSettingsTab(ctx, 'profile');
  });

  after(async () => { await closeApp(ctx); });

  it('has one field per value and no Save buttons', async () => {
    const shape = await evaluate(ctx, `(() => ({
      fields: ['template-name-input', 'template-role-input', 'template-preferences-input', 'profile-goals-input',
        'template-project-context-input', 'profile-preferences-input'].every((id) => !!document.getElementById(id)),
      doubles: ['profile-name-input', 'profile-role-input', 'profile-project-context-input'].some((id) => !!document.getElementById(id)),
      buttons: ['save-template-variables-btn', 'save-user-profile-btn'].some((id) => !!document.getElementById(id)),
      jsonUnderAdvanced: !!document.querySelector('details.settings-advanced #profile-preferences-input')
    }))()`);
    assert.deepStrictEqual(shape, { fields: true, doubles: false, buttons: false, jsonUnderAdvanced: true });
  });

  it('shows the template name while TELOS has none', async () => {
    await waitFor(ctx, `document.getElementById('template-name-input').value === 'TestUser'`);
  });

  it('a new name is written to both stores', async () => {
    await fill(ctx, '#template-name-input', 'Lakeside Owner');
    // Polled, not slept: the debounced save lands within the bound or the test fails.
    await waitFor(ctx, `window.electron.settings.load().then(({ data: s }) =>
      s.templateVariables.name === 'Lakeside Owner' && s.userProfile.name === 'Lakeside Owner')`, 10000);
    await waitFor(ctx, `document.getElementById('settings-save-state').textContent === 'Saved'`, 10000);
  });

  it('Preferences (JSON) that does not parse is not saved and says so', async () => {
    await fill(ctx, '#profile-preferences-input', '{not json');
    await waitFor(ctx, `(document.querySelector('.settings-tab-content[data-tab="profile"] .settings-field-error')?.textContent || '').length > 0`, 10000);
    // A later field's save must not carry the bad JSON either.
    await fill(ctx, '#template-role-input', 'Owner');
    await waitFor(ctx, `window.electron.settings.load().then(({ data: s }) => s.userProfile.role === 'Owner')`, 10000);
    const out = await evaluate(ctx, `window.electron.settings.load().then(({ data: s }) => ({
      prefs: s.userProfile.preferences,
      error: document.querySelector('.settings-tab-content[data-tab="profile"] .settings-field-error')?.textContent || ''
    }))`);
    assert.deepStrictEqual(out.prefs, {});
    assert.match(out.error, /^Not saved: /);
  });
});

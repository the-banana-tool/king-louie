const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, fill, getValue, isVisible } = require('./helpers');

describe('E2E: Settings — Profile & Template Variables', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `
      (() => {
        const sel = document.getElementById('settings-nav-select');
        for (const opt of sel.options) {
          if (opt.textContent.includes('Profile') || opt.value === 'profile') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has template name input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('template-name-input')`);
    assert.ok(exists);
  });

  it('has template role input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('template-role-input')`);
    assert.ok(exists);
  });

  it('has template preferences textarea', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('template-preferences-input')`);
    assert.ok(exists);
  });

  it('has template project context textarea', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('template-project-context-input')`);
    assert.ok(exists);
  });

  it('has save template variables button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('save-template-variables-btn')`);
    assert.ok(exists);
  });

  it('can fill and save template variables', async () => {
    await fill(ctx, '#template-name-input', 'TestUser');
    await fill(ctx, '#template-role-input', 'Developer');
    await click(ctx, '#save-template-variables-btn');
    await new Promise((r) => setTimeout(r, 500));

    const status = await evaluate(ctx, `
      document.getElementById('template-variables-status')?.textContent || ''
    `);
    // Should show success or at least not show an error
    assert.ok(!status.includes('error') && !status.includes('Error'),
      `save should succeed. Status: "${status}"`);
  });

  it('has user profile fields', async () => {
    const name = await evaluate(ctx, `!!document.getElementById('profile-name-input')`);
    const role = await evaluate(ctx, `!!document.getElementById('profile-role-input')`);
    const goals = await evaluate(ctx, `!!document.getElementById('profile-goals-input')`);
    assert.ok(name, 'profile name should exist');
    assert.ok(role, 'profile role should exist');
    assert.ok(goals, 'profile goals should exist');
  });

  it('has save profile button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('save-user-profile-btn')`);
    assert.ok(exists);
  });
});

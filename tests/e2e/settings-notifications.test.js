const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, fill, getValue } = require('./helpers');

describe('E2E: Settings — Notifications', () => {
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
          if (opt.textContent.includes('Notification') || opt.value === 'notifications') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has notifications enabled checkbox', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('notifications-enabled-input')`);
    assert.ok(exists);
  });

  it('notifications enabled by default', async () => {
    const checked = await evaluate(ctx, `document.getElementById('notifications-enabled-input').checked`);
    assert.strictEqual(checked, true);
  });

  it('has UI toast enabled checkbox', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('notifications-ui-toast-enabled-input')`);
    assert.ok(exists);
  });

  it('has ntfy enabled checkbox', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('notifications-ntfy-enabled-input')`);
    assert.ok(exists);
  });

  it('has toast threshold input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('notifications-toast-threshold-input')`);
    assert.ok(exists);
  });

  it('has external threshold input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('notifications-external-threshold-input')`);
    assert.ok(exists);
  });

  it('has save notifications button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('save-notifications-btn')`);
    assert.ok(exists);
  });

  it('can save notification settings', async () => {
    await click(ctx, '#save-notifications-btn');
    await new Promise((r) => setTimeout(r, 500));
    const status = await evaluate(ctx, `
      document.getElementById('notifications-status')?.textContent || ''
    `);
    assert.ok(!status.includes('Error'), `save should succeed. Status: "${status}"`);
  });
});

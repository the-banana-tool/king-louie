const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, fill, getValue, isVisible, getText } = require('./helpers');

describe('E2E: Settings — General & Defaults', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    // Navigate to General tab
    await evaluate(ctx, `
      (() => {
        const sel = document.getElementById('settings-nav-select');
        for (const opt of sel.options) {
          if (opt.textContent.includes('General') || opt.value === 'general') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has agent mode default checkbox', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('default-agent-mode')`);
    assert.ok(exists);
  });

  it('has sandbox mode default checkbox', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('default-sandbox-mode')`);
    assert.ok(exists);
  });

  it('sandbox mode defaults to checked', async () => {
    const checked = await evaluate(ctx, `document.getElementById('default-sandbox-mode').checked`);
    assert.strictEqual(checked, true, 'sandbox mode should default to enabled');
  });

  it('agent mode defaults to unchecked', async () => {
    const checked = await evaluate(ctx, `document.getElementById('default-agent-mode').checked`);
    assert.strictEqual(checked, false, 'agent mode should default to disabled');
  });
});

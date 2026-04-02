const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Settings — Webhooks', () => {
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
          if (opt.textContent.includes('Webhook') || opt.value === 'webhooks') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has webhook name input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('webhook-name-input')`);
    assert.ok(exists);
  });

  it('has webhook template input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('webhook-template-input')`);
    assert.ok(exists);
  });

  it('has create webhook button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('webhook-create-btn')`);
    assert.ok(exists);
  });

  it('has webhook list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('webhook-list')`);
    assert.ok(exists);
  });
});

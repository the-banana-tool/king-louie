const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Settings — Scheduler', () => {
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
          if (opt.textContent.includes('Scheduler') || opt.value === 'scheduler') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has cron job message input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-message-input')`);
    assert.ok(exists);
  });

  it('has schedule kind select', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-kind-input')`);
    assert.ok(exists);
  });

  it('has schedule value input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-value-input')`);
    assert.ok(exists);
  });

  it('has add job button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-btn')`);
    assert.ok(exists);
  });

  it('has refresh jobs button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-refresh-btn')`);
    assert.ok(exists);
  });

  it('has cron list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-list')`);
    assert.ok(exists);
  });
});

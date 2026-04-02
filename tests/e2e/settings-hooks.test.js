const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Settings — Hooks', () => {
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
          if (opt.textContent.includes('Hook') || opt.value === 'hooks') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has hooks global enabled checkbox', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('hooks-global-enabled-input')`);
    assert.ok(exists);
  });

  it('hooks enabled by default', async () => {
    const checked = await evaluate(ctx, `document.getElementById('hooks-global-enabled-input').checked`);
    assert.strictEqual(checked, true);
  });

  it('has reload hooks button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('reload-hooks-btn')`);
    assert.ok(exists);
  });

  it('has hooks list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('hooks-list')`);
    assert.ok(exists);
  });
});

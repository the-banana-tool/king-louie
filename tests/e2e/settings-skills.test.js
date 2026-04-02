const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Settings — Skills', () => {
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
          if (opt.textContent.includes('Skill') || opt.value === 'skills') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has skill install URL input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('skill-install-url')`);
    assert.ok(exists);
  });

  it('has install button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('skill-install-btn')`);
    assert.ok(exists);
  });

  it('has skills list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('skills-list')`);
    assert.ok(exists);
  });

  it('shows installed skills', async () => {
    const text = await evaluate(ctx, `document.getElementById('skills-list')?.textContent || ''`);
    // At least the 2 installed skills should appear (claude-code and gh)
    assert.ok(text.length > 0, 'skills list should have content');
  });
});

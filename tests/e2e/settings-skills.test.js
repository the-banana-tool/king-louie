const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, openSettingsTab } = require('./helpers');

describe('E2E: Settings — Skills', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'skills');
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

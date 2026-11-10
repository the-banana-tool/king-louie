const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, openSettingsTab } = require('./helpers');

describe('E2E: Settings — Hooks', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'permissions');
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

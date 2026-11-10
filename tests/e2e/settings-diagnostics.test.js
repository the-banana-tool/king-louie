const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, openSettingsTab } = require('./helpers');

describe('E2E: Settings — Diagnostics', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'diagnostics');
  });

  after(async () => { await closeApp(ctx); });

  it('has run diagnostics button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('diagnostics-run-btn')`);
    assert.ok(exists);
  });

  it('has diagnostics results area', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('diagnostics-results')`);
    assert.ok(exists);
  });

  it('can run diagnostics', async () => {
    await click(ctx, '#diagnostics-run-btn');
    await new Promise((r) => setTimeout(r, 2000));

    const status = await evaluate(ctx, `
      document.getElementById('diagnostics-status')?.textContent || ''
    `);
    // Should complete or show a result
    assert.ok(status.length > 0, 'diagnostics should produce a status');
  });
});

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, openSettingsTab } = require('./helpers');

describe('E2E: Settings — Webhooks', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'webhooks');
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

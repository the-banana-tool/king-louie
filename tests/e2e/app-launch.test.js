const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, isVisible } = require('./helpers');

describe('E2E: App Launch', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('shows the chat input', async () => {
    const visible = await isVisible(ctx, '#user-input');
    assert.ok(visible, 'chat input should be visible');
  });

  it('shows the send button', async () => {
    const visible = await isVisible(ctx, '#send-btn');
    assert.ok(visible, 'send button should be visible');
  });

  it('has a settings button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('open-settings-btn')`);
    assert.ok(exists, 'settings button should exist');
  });

  it('chat input is editable', async () => {
    await evaluate(ctx, `document.getElementById('user-input').value = 'test message'`);
    const val = await evaluate(ctx, `document.getElementById('user-input').value`);
    assert.strictEqual(val, 'test message');
  });

  it('has a sidebar with chat list', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('chat-list')`);
    assert.ok(exists, 'chat list should exist');
  });

  it('has a new chat button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('new-chat-btn')`);
    assert.ok(exists, 'new chat button should exist');
  });

  it('no error overlays visible on startup', async () => {
    const errorCount = await evaluate(ctx, `
      document.querySelectorAll('.error-overlay:not([hidden])').length
    `);
    assert.strictEqual(errorCount, 0, 'no error overlays on startup');
  });
});

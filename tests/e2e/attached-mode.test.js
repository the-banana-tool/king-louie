// tests/e2e/attached-mode.test.js
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/attached-mode.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchAttached, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: attached mode', { timeout: 240000 }, () => {
  let ctx;

  before(async () => {
    ctx = await launchAttached();
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('streams a chat from the stub provider through the service', async () => {
    const chatId = await evaluate(ctx, `window.electron.chat.create('Attached chat').then((r) => (r.data || r).id)`);
    const reply = await evaluate(ctx, `window.electron.chat.sendMessage({ chatId: ${JSON.stringify(chatId)}, message: 'hello' }).then((r) => JSON.stringify(r))`);
    assert.match(reply, /Hello from the stub provider\./);
  });

  it('shows the approval dialog for a gated tool and runs it on approve', async () => {
    await click(ctx, '#new-chat-btn');
    await waitFor(ctx, `!!appState.activeChatId`);
    await evaluate(ctx, `window.__probe = window.electron.chat.sendMessage({ chatId: appState.activeChatId, message: 'run the probe', agentMode: true }); true`);
    await waitFor(ctx, `!!document.querySelector('.prompt-message .prompt-actions .btn-primary')`, 30000);
    await click(ctx, '.prompt-message .prompt-actions .btn-primary');
    const reply = await evaluate(ctx, `window.__probe.then((r) => JSON.stringify(r))`);
    assert.match(reply, /The probe ran\./);
  });

  it('marks an unproxied settings tab', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); switchSettingsTab('hooks'); true`);
    const text = await waitFor(ctx, `document.querySelector('.settings-tab-content[data-tab="hooks"] .service-unavailable-notice')?.textContent`);
    assert.strictEqual(text, 'Managed by the local service; not available while attached.');
  });

  it('shows the unreachable banner when the service dies and reconnects after a restart', async () => {
    await ctx.service.kill();
    const banner = await waitFor(ctx, `document.getElementById('attached-service-banner')?.textContent || ''`, 30000);
    assert.match(banner, /not reachable/);
    ctx.service = await ctx.service.restart();
    await evaluate(ctx, `window.electron.desktop.retry(); true`);
    await waitFor(ctx, `window.electron.desktop.status().then((s) => s.view === 'attached-connected')`, 60000);
    await waitFor(ctx, `!document.getElementById('attached-service-banner')`, 10000);
  });
});

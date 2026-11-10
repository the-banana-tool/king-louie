const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

// Memory left Settings (settings redesign spec §5.3): its own panel, opened
// by the brain button beside the gear.
describe('E2E: Memory panel', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await click(ctx, '#open-memory-btn');
    await waitFor(ctx, `!document.getElementById('memory-panel').hidden`);
  });

  after(async () => { await closeApp(ctx); });

  it('has memory search input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('memory-query-input')`);
    assert.ok(exists);
  });

  it('has tier filter select', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('memory-tier-filter-input')`);
    assert.ok(exists);
  });

  it('has capture content input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('memory-capture-content-input')`);
    assert.ok(exists);
  });

  it('has capture type select', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('memory-capture-type-input')`);
    assert.ok(exists);
  });

  it('has refresh, capture, and clear buttons', async () => {
    const refresh = await evaluate(ctx, `!!document.getElementById('memory-refresh-btn')`);
    const capture = await evaluate(ctx, `!!document.getElementById('memory-capture-btn')`);
    const clear = await evaluate(ctx, `!!document.getElementById('memory-clear-btn')`);
    assert.ok(refresh, 'refresh button should exist');
    assert.ok(capture, 'capture button should exist');
    assert.ok(clear, 'clear button should exist');
  });

  it('loads the entries when it opens', async () => {
    await waitFor(ctx, `document.getElementById('memory-status').textContent !== 'Memory not loaded yet.'`);
  });

  it('clear all button uses in-app confirm dialog', async () => {
    await evaluate(ctx, `
      window.__nativeDialogsCalled = [];
      window.confirm = (msg) => { window.__nativeDialogsCalled.push(msg); return false; };
      true
    `);
    await click(ctx, '#memory-clear-btn');
    await new Promise((r) => setTimeout(r, 500));
    const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
    assert.deepStrictEqual(calls, [], 'should not call native confirm');
    // Dismiss the confirm dialog with Escape: it closes itself, not the panel.
    await evaluate(ctx, `
      (() => {
        const m = document.querySelector('.rename-chat-modal');
        if (m) m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()
    `);
    await waitFor(ctx, `!document.querySelector('.rename-chat-modal')`);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('memory-panel').hidden`), false);
  });

  it('has memory list container, in the panel and not in Settings', async () => {
    assert.ok(await evaluate(ctx, `!!document.querySelector('#memory-panel #memory-list')`));
    assert.strictEqual(await evaluate(ctx, `!!document.querySelector('#settings-drawer #memory-list')`), false);
  });

  it('Escape closes the panel, and so does the backdrop', async () => {
    await evaluate(ctx, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await waitFor(ctx, `document.getElementById('memory-panel').hidden`);
    await click(ctx, '#open-memory-btn');
    await waitFor(ctx, `!document.getElementById('memory-panel').hidden`);
    await evaluate(ctx, `document.getElementById('memory-panel').click(); true`);
    await waitFor(ctx, `document.getElementById('memory-panel').hidden`);
  });
});

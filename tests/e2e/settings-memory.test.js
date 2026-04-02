const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, fill } = require('./helpers');

describe('E2E: Settings — Memory', () => {
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
          if (opt.textContent.includes('Memory') || opt.value === 'memory') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
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
    // Dismiss modal
    await evaluate(ctx, `
      (() => { const m = document.querySelector('.rename-chat-modal'); if (m) m.querySelector('button')?.click(); return true; })()
    `);
  });

  it('has memory list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('memory-list')`);
    assert.ok(exists);
  });
});

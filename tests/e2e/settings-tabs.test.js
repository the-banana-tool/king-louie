// tests/e2e/settings-tabs.test.js — the Settings sidebar (settings redesign
// spec §5.1): six groups, one page shown at a time, the last page remembered,
// and search over labels and keywords.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/settings-tabs.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

const GROUPS = ['Models', 'Chats', 'Reaching you', 'Tools', 'Security', 'This computer'];

describe('E2E: Settings — sidebar navigation', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
  });

  after(async () => { await closeApp(ctx); });

  it('lists the six groups', async () => {
    const labels = await evaluate(ctx, `[...document.querySelectorAll('#settings-sidebar .settings-nav-group > h3')].map((h) => h.textContent)`);
    assert.deepStrictEqual(labels, GROUPS);
  });

  it('clicking each item shows exactly that page and marks exactly that item', async () => {
    const tabs = await evaluate(ctx, `[...document.querySelectorAll('#settings-sidebar .settings-nav-item')].map((b) => b.dataset.tab)`);
    assert.ok(tabs.length >= 15, `items: ${tabs.join(', ')}`);
    for (const tab of tabs) {
      await evaluate(ctx, `document.querySelector('#settings-sidebar .settings-nav-item[data-tab=${JSON.stringify(tab)}]').click(); true`);
      const state = await evaluate(ctx, `(() => ({
        panes: [...document.querySelectorAll('#settings-drawer .settings-tab-content.active')].map((p) => p.dataset.tab),
        items: [...document.querySelectorAll('#settings-sidebar .settings-nav-item.is-active')].map((b) => b.dataset.tab)
      }))()`);
      assert.deepStrictEqual(state, { panes: [tab], items: [tab] }, tab);
    }
  });

  it('reopens on the page last shown', async () => {
    await evaluate(ctx, `document.querySelector('#settings-sidebar .settings-nav-item[data-tab="voice"]').click(); true`);
    await click(ctx, '#close-settings-btn');
    await waitFor(ctx, `document.getElementById('settings-drawer').hidden`);
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    const shown = await evaluate(ctx, `(() => ({
      pane: document.querySelector('#settings-drawer .settings-tab-content.active')?.dataset.tab,
      item: document.querySelector('#settings-sidebar .settings-nav-item.is-active')?.dataset.tab
    }))()`);
    assert.deepStrictEqual(shown, { pane: 'voice', item: 'voice' });
  });

  it('search for openrouter keeps Providers & keys', async () => {
    await evaluate(ctx, `(() => {
      const input = document.getElementById('settings-search');
      input.value = 'openrouter';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const visible = await evaluate(ctx, `[...document.querySelectorAll('#settings-sidebar .settings-nav-item')].filter((b) => !b.hidden).map((b) => b.textContent)`);
    assert.ok(visible.includes('Providers & keys'), visible.join(', '));
    assert.ok(!visible.includes('Voice'), 'unmatched pages are filtered out');
  });
});

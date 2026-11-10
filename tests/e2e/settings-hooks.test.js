const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, openSettingsTab } = require('./helpers');

describe('E2E: Settings — Hooks', () => {
  let ctx;
  const pageErrors = [];

  before(async () => {
    ctx = await launchApp();
    const page = await ctx.electronApp.firstWindow();
    page.on('pageerror', (err) => pageErrors.push(err.message));
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

  it('shows the hooks section on the Permissions & hooks page', async () => {
    const shown = await evaluate(ctx, `(() => {
      const el = document.querySelector('[data-section-tab="hooks"]');
      return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    })()`);
    assert.strictEqual(shown, true);
  });

  it('a hook is a compact row whose switch saves, and stays at the new value after a reload', async () => {
    await waitFor(ctx, `!!document.querySelector('#hooks-list .settings-list-row input.switch')`, 15000);
    const { name, next } = await evaluate(ctx, `(() => {
      const input = document.querySelector('#hooks-list .settings-list-row input.switch');
      return { name: input.closest('.settings-list-row').dataset.hookName, next: !input.checked };
    })()`);
    assert.ok(name, 'the row names its hook');
    await evaluate(ctx, `(() => {
      const input = document.querySelector(${JSON.stringify(`#hooks-list .settings-list-row[data-hook-name="${name}"] input.switch`)});
      input.checked = ${next};
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(ctx, `document.getElementById('settings-save-state').dataset.state === 'saved'`, 10000);
    const stored = await evaluate(ctx, `window.electron.hooks.list().then((r) => ((r.data || r).hooks || []).find((h) => h.name === ${JSON.stringify(name)}).enabled !== false)`);
    assert.strictEqual(stored, next, 'the node stored the new value');

    await ctx.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.reload(); });
    await waitFor(ctx, `!!document.getElementById('user-input') && typeof switchSettingsTab === 'function'`, 20000);
    await openSettingsTab(ctx, 'permissions');
    const sel = `#hooks-list .settings-list-row[data-hook-name="${name}"] input.switch`;
    await waitFor(ctx, `!!document.querySelector(${JSON.stringify(sel)})`, 15000);
    const after = await evaluate(ctx, `document.querySelector(${JSON.stringify(sel)}).checked`);
    assert.strictEqual(after, next);
    assert.deepStrictEqual(pageErrors, []);
  });
});

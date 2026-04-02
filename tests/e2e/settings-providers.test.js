const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, getText, isVisible } = require('./helpers');

describe('E2E: Settings — Providers', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    // Navigate to Providers tab
    await evaluate(ctx, `
      (() => {
        const sel = document.getElementById('settings-nav-select');
        for (const opt of sel.options) {
          if (opt.textContent.includes('Provider') || opt.value === 'providers') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('shows provider list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('provider-list')`);
    assert.ok(exists, 'provider-list should exist');
  });

  it('renders provider cards for all 13 providers', async () => {
    const text = await getText(ctx, '#provider-list');
    const expected = ['OpenAI', 'Anthropic', 'Groq', 'Mistral', 'Ollama', 'Gemini', 'OpenRouter',
      'xAI', 'DeepSeek', 'Qwen', 'Together', 'Fireworks', 'Cohere'];
    for (const name of expected) {
      assert.ok(text.includes(name), `provider list should include ${name}`);
    }
  });

  it('each provider has a password input for the API token', async () => {
    const count = await evaluate(ctx, `
      document.querySelectorAll('#provider-list input[type="password"]').length
    `);
    // Ollama doesn't need a token, so at least 12
    assert.ok(count >= 12, `should have at least 12 token inputs, found ${count}`);
  });

  it('each provider has a save button', async () => {
    const count = await evaluate(ctx, `
      document.querySelectorAll('#provider-list .btn-primary').length
    `);
    assert.ok(count >= 12, `should have at least 12 save buttons, found ${count}`);
  });

  it('web search section has Brave and Tavily inputs', async () => {
    const brave = await evaluate(ctx, `!!document.getElementById('websearch-brave-key-input')`);
    const tavily = await evaluate(ctx, `!!document.getElementById('websearch-tavily-key-input')`);
    assert.ok(brave, 'Brave search key input should exist');
    assert.ok(tavily, 'Tavily search key input should exist');
  });

  it('clear provider button uses in-app confirm dialog', async () => {
    // Install dialog trap
    await evaluate(ctx, `
      window.__nativeDialogsCalled = [];
      window.confirm = (msg) => { window.__nativeDialogsCalled.push(msg); return false; };
      true
    `);

    // Find a clear/danger button and click it
    const clicked = await evaluate(ctx, `
      (() => {
        const btns = document.querySelectorAll('#provider-list .btn-danger, #provider-list button[id*="clear"]');
        if (btns.length > 0) { btns[0].click(); return true; }
        return false;
      })()
    `);

    if (clicked) {
      await new Promise((r) => setTimeout(r, 500));
      const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
      assert.deepStrictEqual(calls, [], 'should not call native confirm()');

      // Dismiss any modal that appeared
      await evaluate(ctx, `
        (() => {
          const modal = document.querySelector('.rename-chat-modal');
          if (modal) { const btn = modal.querySelector('button'); if (btn) btn.click(); }
          return true;
        })()
      `);
    }
  });
});

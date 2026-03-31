const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, getText } = require('./helpers');

describe('E2E: Settings Panel', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('opens settings panel when clicking the settings button', async () => {
    await click(ctx, '#open-settings-btn');
    const visible = await waitFor(ctx, `
      (() => {
        const el = document.getElementById('settings-drawer');
        return el && !el.hidden;
      })()
    `);
    assert.ok(visible, 'settings drawer should be visible');
  });

  it('shows all provider sections including new ones', async () => {
    const text = await evaluate(ctx, `document.getElementById('settings-drawer').textContent`);
    assert.ok(text, 'settings drawer should have content');

    const providers = ['OpenAI', 'Anthropic', 'Groq', 'Mistral', 'Gemini', 'OpenRouter'];
    const newProviders = ['xAI', 'DeepSeek', 'Qwen', 'Together', 'Fireworks', 'Cohere'];

    for (const p of [...providers, ...newProviders]) {
      assert.ok(text.includes(p), `settings should include provider "${p}"`);
    }
  });

  it('has token input fields for providers', async () => {
    const tokenInputCount = await evaluate(ctx, `
      document.querySelectorAll('#settings-drawer input[type="password"]').length
    `);
    assert.ok(tokenInputCount >= 7, `should have at least 7 token inputs, found ${tokenInputCount}`);
  });

  it('closes settings panel', async () => {
    await click(ctx, '#close-settings-btn');
    await waitFor(ctx, `document.getElementById('settings-drawer').hidden`);
    const hidden = await evaluate(ctx, `document.getElementById('settings-drawer').hidden`);
    assert.ok(hidden, 'settings should be hidden after close');
  });
});

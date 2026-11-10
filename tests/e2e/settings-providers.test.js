const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, getText, isVisible, openSettingsTab } = require('./helpers');

describe('E2E: Settings — Providers', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'providers');
  });

  after(async () => { await closeApp(ctx); });

  it('shows provider list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('provider-list')`);
    assert.ok(exists, 'provider-list should exist');
  });

  it('renders a row for each of the 13 providers', async () => {
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

  it('each provider has a Save & test button', async () => {
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

  it('a provider without a key shows No key and Add', async () => {
    const row = await evaluate(ctx, `(() => {
      const row = document.querySelector('#provider-list .key-row[data-provider="gemini"]');
      return row && {
        pill: row.querySelector('.status-pill').textContent,
        toggle: row.querySelector('button[data-action="toggle"]').textContent,
        open: !row.querySelector('.key-row-editor').hidden
      };
    })()`);
    assert.deepStrictEqual(row, { pill: 'No key', toggle: 'Add', open: false });
  });

  it('clicking Add opens the row with the key input and Save & test', async () => {
    await click(ctx, '#provider-list .key-row[data-provider="gemini"] button[data-action="toggle"]');
    assert.ok(await isVisible(ctx, '#provider-list .key-row[data-provider="gemini"] .key-row-editor'), 'the row opens in place');
    assert.ok(await isVisible(ctx, '#provider-list .key-row[data-provider="gemini"] input[data-provider="gemini"]'));
    const save = await getText(ctx, '#provider-list .key-row[data-provider="gemini"] button[data-action="save"]');
    assert.strictEqual(save, 'Save & test');
    const remove = await evaluate(ctx, `!!document.querySelector('#provider-list .key-row[data-provider="gemini"] button[data-action="clear"]')`);
    assert.strictEqual(remove, false, 'Remove key only where a key exists');
  });

  it('Brave without a key shows No key, and its row has Add and no Test', async () => {
    const row = await evaluate(ctx, `(() => {
      const row = document.querySelector('#search-image-list .key-row[data-provider="brave"]');
      return row && {
        pill: row.querySelector('.status-pill').textContent,
        toggle: row.querySelector('button[data-action="toggle"]').textContent,
        test: !!row.querySelector('button[data-action="test"]')
      };
    })()`);
    assert.deepStrictEqual(row, { pill: 'No key', toggle: 'Add', test: false });
  });

  it('the image provider select sits with the search and image keys, and no banner shows with no failing key', async () => {
    const inCard = await evaluate(ctx, `!!document.querySelector('#search-images-card #imagegen-default-select')`);
    assert.ok(inCard);
    const bannerHidden = await evaluate(ctx, `document.getElementById('providers-failing-banner').hidden`);
    assert.strictEqual(bannerHidden, true);
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

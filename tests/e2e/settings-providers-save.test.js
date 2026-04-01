const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, fill, getText } = require('./helpers');

/**
 * E2E tests for provider token save/clear/test flows.
 * Verifies that Save Token, Test Connection, Clear Token, and Set Active
 * buttons work correctly for every provider card.
 */

const PROVIDERS = [
  'openai', 'anthropic', 'groq', 'mistral', 'ollama', 'gemini',
  'openrouter', 'xai', 'deepseek', 'qwen', 'together', 'fireworks', 'cohere'
];

// Providers that skip prefix validation (no specific prefix required)
const GENERIC_TOKEN_PROVIDERS = [
  'groq', 'mistral', 'ollama', 'gemini', 'openrouter',
  'xai', 'deepseek', 'qwen', 'together', 'fireworks', 'cohere'
];

function providerSelector(providerKey) {
  return `.provider-card[data-provider="${providerKey}"]`;
}

function msgSelector(providerKey) {
  return `${providerSelector(providerKey)} .provider-message`;
}

function inputSelector(providerKey) {
  return `input[data-provider="${providerKey}"]`;
}

function btnSelector(providerKey, action) {
  return `${providerSelector(providerKey)} button[data-action="${action}"]`;
}

describe('E2E: Settings — Provider Save/Clear/Test', () => {
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

  // --- Structural tests: every provider has all required buttons ---

  for (const provider of PROVIDERS) {
    it(`${provider}: has Save Token button`, async () => {
      const exists = await evaluate(ctx, `!!document.querySelector('${btnSelector(provider, 'save')}')`);
      assert.ok(exists, `${provider} should have a save button`);
    });

    it(`${provider}: has Test Connection button`, async () => {
      const exists = await evaluate(ctx, `!!document.querySelector('${btnSelector(provider, 'test')}')`);
      assert.ok(exists, `${provider} should have a test button`);
    });

    it(`${provider}: has Clear Token button`, async () => {
      const exists = await evaluate(ctx, `!!document.querySelector('${btnSelector(provider, 'clear')}')`);
      assert.ok(exists, `${provider} should have a clear button`);
    });

    it(`${provider}: has Set Active button`, async () => {
      const exists = await evaluate(ctx, `!!document.querySelector('${btnSelector(provider, 'set-active')}')`);
      assert.ok(exists, `${provider} should have a set-active button`);
    });

    it(`${provider}: has password input for token`, async () => {
      const exists = await evaluate(ctx, `!!document.querySelector('${inputSelector(provider)}')`);
      assert.ok(exists, `${provider} should have a token input`);
    });

    it(`${provider}: has message area`, async () => {
      const exists = await evaluate(ctx, `!!document.querySelector('${msgSelector(provider)}')`);
      assert.ok(exists, `${provider} should have a message area`);
    });
  }

  // --- Validation: empty/short token should show error ---

  it('save with empty token shows validation error', async () => {
    // Use gemini since it has no prefix requirement
    await fill(ctx, inputSelector('gemini'), '');
    await click(ctx, btnSelector('gemini', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('gemini'));
    assert.ok(msg.includes('at least 8 characters'), `should show length error, got: ${msg}`);
  });

  it('save with short token shows validation error', async () => {
    await fill(ctx, inputSelector('gemini'), 'abc');
    await click(ctx, btnSelector('gemini', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('gemini'));
    assert.ok(msg.includes('at least 8 characters'), `should show length error, got: ${msg}`);
  });

  // --- Prefix validation for specific providers ---

  it('openai: rejects token without sk- prefix', async () => {
    await fill(ctx, inputSelector('openai'), 'not-a-valid-openai-token');
    await click(ctx, btnSelector('openai', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('openai'));
    assert.ok(msg.includes('sk-'), `should warn about sk- prefix, got: ${msg}`);
  });

  it('anthropic: rejects token without sk-ant- prefix', async () => {
    await fill(ctx, inputSelector('anthropic'), 'not-a-valid-anthropic-token');
    await click(ctx, btnSelector('anthropic', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('anthropic'));
    assert.ok(msg.includes('sk-ant-'), `should warn about sk-ant- prefix, got: ${msg}`);
  });

  // --- Save token flow for every provider ---

  for (const provider of GENERIC_TOKEN_PROVIDERS) {
    it(`${provider}: save button stores token and shows success`, async () => {
      const fakeToken = `test-fake-token-${provider}-1234567890`;
      await fill(ctx, inputSelector(provider), fakeToken);
      await click(ctx, btnSelector(provider, 'save'));
      await new Promise((r) => setTimeout(r, 500));
      const msg = await getText(ctx, msgSelector(provider));
      assert.ok(
        msg.includes('Token saved securely'),
        `${provider} should show "Token saved securely", got: "${msg}"`
      );
    });

    it(`${provider}: input is cleared after successful save`, async () => {
      // Input should have been cleared by the previous save
      const val = await evaluate(ctx, `
        document.querySelector('${inputSelector(provider)}')?.value || ''
      `);
      assert.strictEqual(val, '', `${provider} input should be empty after save`);
    });

    it(`${provider}: label updates to show token is saved`, async () => {
      const labelText = await evaluate(ctx, `
        (() => {
          const card = document.querySelector('${providerSelector(provider)}');
          if (!card) return null;
          const labels = card.querySelectorAll('label');
          return labels[0]?.textContent || null;
        })()
      `);
      assert.ok(
        labelText && labelText.includes('saved'),
        `${provider} label should indicate token is saved, got: "${labelText}"`
      );
    });

    it(`${provider}: placeholder changes after token is saved`, async () => {
      const placeholder = await evaluate(ctx, `
        document.querySelector('${inputSelector(provider)}')?.placeholder || ''
      `);
      // When hasToken is true, placeholder shows masked characters
      assert.ok(
        placeholder !== 'Paste API token',
        `${provider} placeholder should change from default after saving, got: "${placeholder}"`
      );
    });
  }

  // Save with valid prefix for openai and anthropic
  it('openai: save button stores token with valid prefix', async () => {
    await fill(ctx, inputSelector('openai'), 'sk-test-fake-token-openai-1234567890');
    await click(ctx, btnSelector('openai', 'save'));
    await new Promise((r) => setTimeout(r, 500));
    const msg = await getText(ctx, msgSelector('openai'));
    assert.ok(msg.includes('Token saved securely'), `openai should save, got: "${msg}"`);
  });

  it('anthropic: save button stores token with valid prefix', async () => {
    await fill(ctx, inputSelector('anthropic'), 'sk-ant-test-fake-token-anthropic-1234567890');
    await click(ctx, btnSelector('anthropic', 'save'));
    await new Promise((r) => setTimeout(r, 500));
    const msg = await getText(ctx, msgSelector('anthropic'));
    assert.ok(msg.includes('Token saved securely'), `anthropic should save, got: "${msg}"`);
  });

  // --- Test Connection after saving ---

  for (const provider of GENERIC_TOKEN_PROVIDERS) {
    it(`${provider}: test connection runs after token is saved`, async () => {
      await click(ctx, btnSelector(provider, 'test'));
      await new Promise((r) => setTimeout(r, 300));
      // Should show "Testing connection..." initially or a result message
      // We just verify it doesn't say "No token saved"
      const msg = await getText(ctx, msgSelector(provider));
      assert.ok(
        !msg.includes('No token saved'),
        `${provider} should not show "No token saved" after saving, got: "${msg}"`
      );
    });
  }

  // --- Clear token flow ---

  it('clear token shows confirmation dialog (not native confirm)', async () => {
    // Trap native confirm
    await evaluate(ctx, `
      window.__nativeConfirmCalled = false;
      window.confirm = () => { window.__nativeConfirmCalled = true; return false; };
      true
    `);

    await click(ctx, btnSelector('gemini', 'clear'));
    await new Promise((r) => setTimeout(r, 500));

    const nativeCalled = await evaluate(ctx, `window.__nativeConfirmCalled`);
    assert.strictEqual(nativeCalled, false, 'should use in-app confirm, not native confirm()');

    // Dismiss the modal by clicking cancel (first button)
    await evaluate(ctx, `
      (() => {
        const modal = document.querySelector('.rename-chat-modal');
        if (modal) { const btn = modal.querySelector('button'); if (btn) btn.click(); }
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));
  });

  it('clear token removes saved token when confirmed', async () => {
    // First make sure gemini has a token saved
    await fill(ctx, inputSelector('gemini'), 'test-fake-token-gemini-cleartest');
    await click(ctx, btnSelector('gemini', 'save'));
    await new Promise((r) => setTimeout(r, 500));

    // Click clear
    await click(ctx, btnSelector('gemini', 'clear'));
    await new Promise((r) => setTimeout(r, 500));

    // Confirm the modal by clicking the last button (confirm)
    await evaluate(ctx, `
      (() => {
        const modal = document.querySelector('.rename-chat-modal');
        if (modal) {
          const btns = modal.querySelectorAll('button');
          btns[btns.length - 1].click();
        }
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 500));

    const msg = await getText(ctx, msgSelector('gemini'));
    assert.ok(
      msg.includes('Token removed'),
      `should show "Token removed" after clearing, got: "${msg}"`
    );
  });

  it('after clearing, label reverts to default', async () => {
    const labelText = await evaluate(ctx, `
      (() => {
        const card = document.querySelector('${providerSelector('gemini')}');
        if (!card) return null;
        const labels = card.querySelectorAll('label');
        return labels[0]?.textContent || null;
      })()
    `);
    assert.ok(
      labelText === 'API token',
      `label should revert to "API token" after clear, got: "${labelText}"`
    );
  });

  it('after clearing, test connection shows "No token saved"', async () => {
    await click(ctx, btnSelector('gemini', 'test'));
    await new Promise((r) => setTimeout(r, 1000));
    const msg = await getText(ctx, msgSelector('gemini'));
    assert.ok(
      msg.includes('No token saved'),
      `should show "No token saved" after clearing, got: "${msg}"`
    );
  });

  // --- Set Active provider ---

  it('set active button changes active provider', async () => {
    // Click Set Active on groq
    await click(ctx, btnSelector('groq', 'set-active'));
    await new Promise((r) => setTimeout(r, 500));

    // The groq card should now show the active badge
    const hasActiveBadge = await evaluate(ctx, `
      (() => {
        const card = document.querySelector('${providerSelector('groq')}');
        if (!card) return false;
        return !!card.querySelector('.active-provider-badge');
      })()
    `);
    assert.ok(hasActiveBadge, 'groq should have active badge after set active');
  });

  it('set active button is disabled for the active provider', async () => {
    const disabled = await evaluate(ctx, `
      document.querySelector('${btnSelector('groq', 'set-active')}')?.disabled
    `);
    assert.strictEqual(disabled, true, 'set-active button should be disabled for active provider');
  });

  // --- Model select for providers that return objects ---

  it('gemini: model dropdown does not show [object Object]', async () => {
    // Save a token first so models can be listed
    await fill(ctx, inputSelector('gemini'), 'test-fake-token-gemini-modeltest');
    await click(ctx, btnSelector('gemini', 'save'));
    await new Promise((r) => setTimeout(r, 500));

    const hasObjectObject = await evaluate(ctx, `
      (() => {
        const sel = document.querySelector('[data-model-provider="gemini"]');
        if (!sel) return false;
        for (const opt of sel.options) {
          if (opt.textContent.includes('[object Object]')) return true;
        }
        return false;
      })()
    `);
    assert.strictEqual(hasObjectObject, false, 'gemini model dropdown should not contain [object Object]');
  });

  it('groq: model dropdown does not show [object Object]', async () => {
    const hasObjectObject = await evaluate(ctx, `
      (() => {
        const sel = document.querySelector('[data-model-provider="groq"]');
        if (!sel) return false;
        for (const opt of sel.options) {
          if (opt.textContent.includes('[object Object]')) return true;
        }
        return false;
      })()
    `);
    assert.strictEqual(hasObjectObject, false, 'groq model dropdown should not contain [object Object]');
  });

  // --- Edge case: saving replaces previous token ---

  it('saving a new token replaces the previous one', async () => {
    // Save first token
    await fill(ctx, inputSelector('mistral'), 'test-fake-token-mistral-first12345');
    await click(ctx, btnSelector('mistral', 'save'));
    await new Promise((r) => setTimeout(r, 500));
    let msg = await getText(ctx, msgSelector('mistral'));
    assert.ok(msg.includes('Token saved securely'), `first save should succeed, got: "${msg}"`);

    // Save second token (replace)
    await fill(ctx, inputSelector('mistral'), 'test-fake-token-mistral-second12345');
    await click(ctx, btnSelector('mistral', 'save'));
    await new Promise((r) => setTimeout(r, 500));
    msg = await getText(ctx, msgSelector('mistral'));
    assert.ok(msg.includes('Token saved securely'), `second save should succeed, got: "${msg}"`);
  });
});

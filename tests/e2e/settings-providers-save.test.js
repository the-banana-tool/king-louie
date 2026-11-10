const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, fill, getText, openSettingsTab } = require('./helpers');

/**
 * E2E tests for the Providers & keys rows (settings redesign Task 10, spec §5.5):
 * Add/Edit opens a row in place, Save & test saves and then tests, Remove key
 * asks first with the in-app dialog.
 */

const PROVIDERS = [
  'openai', 'anthropic', 'groq', 'mistral', 'ollama', 'gemini',
  'openrouter', 'xai', 'deepseek', 'qwen', 'together', 'fireworks', 'cohere'
];

// A few providers with no prefix rule; saving one runs a real connection test,
// so the save flow is checked on three rather than all of them.
const SAVE_PROVIDERS = ['groq', 'mistral', 'cohere'];

function rowSelector(providerKey) {
  return `#provider-list .key-row[data-provider="${providerKey}"]`;
}

function msgSelector(providerKey) {
  return `${rowSelector(providerKey)} .provider-message`;
}

function inputSelector(providerKey) {
  return `${rowSelector(providerKey)} input[data-provider="${providerKey}"]`;
}

function btnSelector(providerKey, action) {
  return `${rowSelector(providerKey)} button[data-action="${action}"]`;
}

async function openRow(ctx, providerKey) {
  const open = await evaluate(ctx, `!document.querySelector('${rowSelector(providerKey)} .key-row-editor').hidden`);
  if (!open) await click(ctx, btnSelector(providerKey, 'toggle'));
}

// Save & test ends when the row has left "Not tested" for a tested state.
async function waitTested(ctx, providerKey) {
  return waitFor(ctx, `['working', 'failing'].includes(document.querySelector('${rowSelector(providerKey)}')?.dataset.state)`, 30000);
}

describe('E2E: Settings — Providers & keys rows', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'providers');
  });

  after(async () => { await closeApp(ctx); });

  // --- Structure: every provider has a row with its parts ---

  for (const provider of PROVIDERS) {
    it(`${provider}: has a row with a status, Add or Edit, Save & test, a key input and a message area`, async () => {
      const parts = await evaluate(ctx, `(() => {
        const row = document.querySelector('${rowSelector(provider)}');
        if (!row) return null;
        return {
          pill: !!row.querySelector('.status-pill'),
          toggle: row.querySelector('button[data-action="toggle"]')?.textContent || '',
          save: row.querySelector('button[data-action="save"]')?.textContent || '',
          input: !!row.querySelector('input[data-provider="${provider}"]'),
          message: !!row.querySelector('.provider-message')
        };
      })()`);
      assert.ok(parts, `${provider} should have a row`);
      assert.ok(parts.pill, `${provider} should show a status`);
      assert.ok(['Add', 'Edit'].includes(parts.toggle), `${provider} button is Add or Edit, got "${parts.toggle}"`);
      assert.strictEqual(parts.save, 'Save & test');
      assert.ok(parts.input && parts.message);
    });
  }

  // --- Validation: empty/short key shows an error, nothing saved ---

  it('save with an empty key shows a validation error', async () => {
    await openRow(ctx, 'gemini');
    await fill(ctx, inputSelector('gemini'), '');
    await click(ctx, btnSelector('gemini', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('gemini'));
    assert.ok(msg.includes('at least 8 characters'), `should show length error, got: ${msg}`);
  });

  it('save with a short key shows a validation error', async () => {
    await fill(ctx, inputSelector('gemini'), 'abc');
    await click(ctx, btnSelector('gemini', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('gemini'));
    assert.ok(msg.includes('at least 8 characters'), `should show length error, got: ${msg}`);
  });

  it('openai: rejects a key without the sk- prefix', async () => {
    await openRow(ctx, 'openai');
    await fill(ctx, inputSelector('openai'), 'not-a-valid-openai-token');
    await click(ctx, btnSelector('openai', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('openai'));
    assert.ok(msg.includes('sk-'), `should warn about sk- prefix, got: ${msg}`);
  });

  it('anthropic: rejects a key without the sk-ant- prefix', async () => {
    await openRow(ctx, 'anthropic');
    await fill(ctx, inputSelector('anthropic'), 'not-a-valid-anthropic-token');
    await click(ctx, btnSelector('anthropic', 'save'));
    await new Promise((r) => setTimeout(r, 300));
    const msg = await getText(ctx, msgSelector('anthropic'));
    assert.ok(msg.includes('sk-ant-'), `should warn about sk-ant- prefix, got: ${msg}`);
  });

  // --- Save & test ---

  for (const provider of SAVE_PROVIDERS) {
    it(`${provider}: Save & test stores the key, tests it, and the row says Edit`, async () => {
      await openRow(ctx, provider);
      await fill(ctx, inputSelector(provider), `test-fake-token-${provider}-1234567890`);
      await click(ctx, btnSelector(provider, 'save'));
      await waitTested(ctx, provider);
      const row = await evaluate(ctx, `(() => {
        const row = document.querySelector('${rowSelector(provider)}');
        return {
          toggle: row.querySelector('button[data-action="toggle"]').textContent,
          pill: row.querySelector('.status-pill').textContent,
          remove: row.querySelector('button[data-action="clear"]')?.textContent || null,
          input: row.querySelector('input[data-provider="${provider}"]').value
        };
      })()`);
      assert.strictEqual(row.toggle, 'Edit');
      assert.ok(['Working', 'Failing'].includes(row.pill), `tested after saving, got "${row.pill}"`);
      assert.strictEqual(row.remove, 'Remove key');
      assert.strictEqual(row.input, '', 'the key field is cleared after saving');
    });
  }

  it('a failing key adds to the failing banner, counting model providers only', async () => {
    const failing = await evaluate(ctx, `document.querySelectorAll('#provider-list .key-row[data-state="failing"]').length`);
    const banner = await evaluate(ctx, `(() => { const b = document.getElementById('providers-failing-banner'); return { hidden: b.hidden, text: b.textContent }; })()`);
    if (failing === 0) {
      assert.strictEqual(banner.hidden, true);
    } else {
      assert.strictEqual(banner.hidden, false);
      assert.match(banner.text, new RegExp(`^${failing} keys? (is|are) failing\\.`));
    }
  });

  // --- Remove key ---

  it('Remove key uses the in-app confirm dialog (not native confirm)', async () => {
    await evaluate(ctx, `
      window.__nativeConfirmCalled = false;
      window.confirm = () => { window.__nativeConfirmCalled = true; return false; };
      true
    `);
    await openRow(ctx, 'groq');
    await click(ctx, btnSelector('groq', 'clear'));
    await new Promise((r) => setTimeout(r, 500));
    const nativeCalled = await evaluate(ctx, `window.__nativeConfirmCalled`);
    assert.strictEqual(nativeCalled, false, 'should use in-app confirm, not native confirm()');
    await evaluate(ctx, `
      (() => {
        const modal = document.querySelector('.rename-chat-modal');
        if (modal) { const btn = modal.querySelector('button'); if (btn) btn.click(); }
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));
  });

  it('Remove key, confirmed, removes the key: the row says No key and Add', async () => {
    await openRow(ctx, 'groq');
    await click(ctx, btnSelector('groq', 'clear'));
    await new Promise((r) => setTimeout(r, 500));
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
    await waitFor(ctx, `document.querySelector('${rowSelector('groq')}')?.dataset.state === 'no-key'`);
    const row = await evaluate(ctx, `(() => {
      const row = document.querySelector('${rowSelector('groq')}');
      return {
        pill: row.querySelector('.status-pill').textContent,
        toggle: row.querySelector('button[data-action="toggle"]').textContent,
        remove: !!row.querySelector('button[data-action="clear"]'),
        message: row.querySelector('.provider-message').textContent
      };
    })()`);
    assert.deepStrictEqual(row, { pill: 'No key', toggle: 'Add', remove: false, message: 'Key removed.' });
  });
});

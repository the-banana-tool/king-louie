const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, getText, getValue, isVisible } = require('./helpers');

describe('E2E: Mesh Network UI', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);

    // Open settings
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);

    // Navigate to Mesh Network via the settings nav select
    await evaluate(ctx, `
      (() => {
        const sel = document.getElementById('settings-nav-select');
        if (!sel) return false;
        for (const opt of sel.options) {
          if (opt.textContent.includes('Mesh')) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change'));
            return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 500));
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('shows peer ID (not "Mesh not enabled")', async () => {
    // Wait for mesh:ready to propagate
    await new Promise((r) => setTimeout(r, 2000));

    const text = await getText(ctx, '#mesh-peer-id');
    assert.ok(text, 'peer ID element should have text');
    assert.ok(!text.includes('not enabled'),
      `should not say "not enabled". Got: "${text}"`);
    assert.ok(text.startsWith('kl-'),
      `peer ID should start with "kl-". Got: "${text}"`);
  });

  it('has display name input', async () => {
    const visible = await isVisible(ctx, '#mesh-display-name-input');
    assert.ok(visible, 'display name input should be visible');
  });

  it('has capabilities input', async () => {
    const visible = await isVisible(ctx, '#mesh-capabilities-input');
    assert.ok(visible, 'capabilities input should be visible');
  });

  it('generate code button produces a 6-word code', async () => {
    await click(ctx, '#mesh-pair-generate-btn');
    await new Promise((r) => setTimeout(r, 1000));

    const code = await getText(ctx, '#mesh-pairing-code');
    assert.ok(code, 'pairing code should have content');
    assert.ok(!code.includes('Generate'), 'should not still show placeholder text');

    const words = code.trim().split(/\s+/);
    assert.strictEqual(words.length, 6,
      `pairing code should have 6 words. Got ${words.length}: "${code}"`);
  });

  it('has inline pairing form fields (no native prompts)', async () => {
    const codeInput = await isVisible(ctx, '#mesh-pair-code-input');
    const addressInput = await isVisible(ctx, '#mesh-pair-address-input');
    const portInput = await isVisible(ctx, '#mesh-pair-port-input');

    assert.ok(codeInput, 'pairing code input should be visible');
    assert.ok(addressInput, 'pairing address input should be visible');
    assert.ok(portInput, 'pairing port input should be visible');
  });

  it('port input defaults to 18791', async () => {
    const val = await getValue(ctx, '#mesh-pair-port-input');
    assert.strictEqual(val, '18791');
  });

  it('pair button validates empty fields', async () => {
    await evaluate(ctx, `
      document.getElementById('mesh-pair-code-input').value = '';
      document.getElementById('mesh-pair-address-input').value = '';
    `);

    await click(ctx, '#mesh-pair-accept-btn');
    await new Promise((r) => setTimeout(r, 300));

    const status = await getText(ctx, '#mesh-pairing-status');
    assert.ok(status && status.includes('required'),
      `should show validation error. Got: "${status}"`);
  });

  it('has manual peer connect section', async () => {
    const addr = await isVisible(ctx, '#mesh-peer-address-input');
    const port = await isVisible(ctx, '#mesh-peer-port-input');
    const btn = await isVisible(ctx, '#mesh-peer-connect-btn');

    assert.ok(addr, 'peer address input visible');
    assert.ok(port, 'peer port input visible');
    assert.ok(btn, 'connect button visible');
  });

  it('connect validates empty address', async () => {
    await evaluate(ctx, `document.getElementById('mesh-peer-address-input').value = ''`);
    await click(ctx, '#mesh-peer-connect-btn');
    await new Promise((r) => setTimeout(r, 300));

    const status = await getText(ctx, '#mesh-connect-status');
    assert.ok(status, 'should show status message');
  });
});

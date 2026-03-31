const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: No Native Dialogs', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);

    // Install traps for native dialog functions
    await evaluate(ctx, `
      window.__nativeDialogsCalled = [];
      window.alert = (msg) => { window.__nativeDialogsCalled.push('alert: ' + msg); };
      window.confirm = (msg) => { window.__nativeDialogsCalled.push('confirm: ' + msg); return false; };
      window.prompt = (msg) => { window.__nativeDialogsCalled.push('prompt: ' + msg); return null; };
      true
    `);
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('no native dialogs called during app startup', async () => {
    const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
    assert.deepStrictEqual(calls, [], 'no native dialogs on startup');
  });

  it('showNotice function exists (replaces alert)', async () => {
    const exists = await evaluate(ctx, `typeof showNotice === 'function'`);
    assert.ok(exists, 'showNotice should be defined');
  });

  it('showConfirmDialog function exists (replaces confirm)', async () => {
    const exists = await evaluate(ctx, `typeof showConfirmDialog === 'function'`);
    assert.ok(exists, 'showConfirmDialog should be defined');
  });

  it('showNotice creates a dismissible banner', async () => {
    await evaluate(ctx, `showNotice('Test notice message'); true`);
    await new Promise((r) => setTimeout(r, 300));

    const noticeText = await evaluate(ctx, `
      (() => {
        const el = document.querySelector('.kl-notice');
        return el ? el.textContent : null;
      })()
    `);
    assert.strictEqual(noticeText, 'Test notice message');

    // Click to dismiss
    await evaluate(ctx, `
      (() => {
        const el = document.querySelector('.kl-notice');
        if (el) el.click();
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));

    const gone = await evaluate(ctx, `!document.querySelector('.kl-notice')`);
    assert.ok(gone, 'notice should be dismissed after click');
  });

  it('showConfirmDialog shows modal and resolves true on confirm', async () => {
    await evaluate(ctx, `
      window.__confirmResult = 'pending';
      showConfirmDialog('Delete this item?').then(r => { window.__confirmResult = r; });
      true
    `);
    await new Promise((r) => setTimeout(r, 300));

    // Modal should be visible
    const modalVisible = await evaluate(ctx, `!!document.querySelector('.rename-chat-modal')`);
    assert.ok(modalVisible, 'confirm modal should be visible');

    // Should show our message
    const bodyText = await evaluate(ctx, `
      (() => {
        const p = document.querySelector('.rename-chat-modal p');
        return p ? p.textContent : null;
      })()
    `);
    assert.ok(bodyText && bodyText.includes('Delete this item'),
      `modal should show the message. Got: "${bodyText}"`);

    // Click confirm (last button)
    await evaluate(ctx, `
      (() => {
        const btns = document.querySelectorAll('.rename-chat-modal button');
        btns[btns.length - 1].click();
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));

    const result = await evaluate(ctx, `window.__confirmResult`);
    assert.strictEqual(result, true, 'confirm should return true');
  });

  it('showConfirmDialog returns false on cancel', async () => {
    await evaluate(ctx, `
      window.__confirmResult2 = 'pending';
      showConfirmDialog('Really?').then(r => { window.__confirmResult2 = r; });
      true
    `);
    await new Promise((r) => setTimeout(r, 300));

    // Click Cancel (first button)
    await evaluate(ctx, `
      (() => {
        document.querySelector('.rename-chat-modal button').click();
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 200));

    const result = await evaluate(ctx, `window.__confirmResult2`);
    assert.strictEqual(result, false, 'cancel should return false');
  });

  it('mesh pairing uses inline inputs, not prompt()', async () => {
    // Open settings → Mesh Network
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `
      (() => {
        const sel = document.getElementById('settings-nav-select');
        for (const opt of sel.options) {
          if (opt.textContent.includes('Mesh')) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); return; }
        }
      })();
      true
    `);
    await new Promise((r) => setTimeout(r, 300));

    // Click pair button with empty fields
    await click(ctx, '#mesh-pair-accept-btn');
    await new Promise((r) => setTimeout(r, 300));

    // Check no native dialogs were called
    const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
    assert.deepStrictEqual(calls, [], 'no native dialogs called during mesh pairing');
  });
});

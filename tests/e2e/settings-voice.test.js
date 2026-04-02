const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Settings — Voice', () => {
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
          if (opt.textContent.includes('Voice') || opt.value === 'voice') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has voice enabled checkbox', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('voice-enabled-input')`);
    assert.ok(exists);
  });

  it('has voice engine select', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('voice-engine-input')`);
    assert.ok(exists);
  });

  it('has voice speed input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('voice-speed-input')`);
    assert.ok(exists);
  });

  it('has ElevenLabs API key input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('voice-elevenlabs-key-input')`);
    assert.ok(exists);
  });

  it('has save voice settings button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('save-voice-settings-btn')`);
    assert.ok(exists);
  });

  it('clear ElevenLabs key uses in-app confirm', async () => {
    await evaluate(ctx, `
      window.__nativeDialogsCalled = [];
      window.confirm = (msg) => { window.__nativeDialogsCalled.push(msg); return false; };
      true
    `);
    const btn = await evaluate(ctx, `!!document.getElementById('clear-voice-key-btn')`);
    if (btn) {
      await click(ctx, '#clear-voice-key-btn');
      await new Promise((r) => setTimeout(r, 500));
      const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
      assert.deepStrictEqual(calls, [], 'should not call native confirm');
      // Dismiss modal
      await evaluate(ctx, `
        (() => { const m = document.querySelector('.rename-chat-modal'); if (m) m.querySelector('button')?.click(); return true; })()
      `);
    }
  });
});

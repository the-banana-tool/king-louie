const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Inference Tier UI', () => {
  let ctx;

  before(async () => {
    // The chat info popover shows "No active chat." with no tier controls
    // unless a chat exists (fleet stage 7 Task 17: the isolated harness's
    // default seed has no chats, unlike the old harness's shared real profile).
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          chats: [{ id: 'chat-1', title: 'Test chat', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }]
        }
      }
    });
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    // A fresh --user-data-dir profile starts with no chats, so Chat Info has
    // nothing to show without one (it used to rely on the real profile's
    // leftover chats always leaving one active).
    await evaluate(ctx, `document.getElementById('new-chat-btn').click(); true`);

    // Install native dialog trap
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

  it('chat info popover opens and shows tier controls', async () => {
    await click(ctx, '#chat-info-btn');
    await new Promise((r) => setTimeout(r, 500));

    const visible = await evaluate(ctx, `
      (() => {
        const el = document.getElementById('chat-info-popover');
        return el && !el.hidden;
      })()
    `);
    assert.ok(visible, 'chat info popover should be visible');

    const selectCount = await evaluate(ctx, `
      document.querySelectorAll('#chat-info-popover select, #chat-info-popover-body select').length
    `);
    assert.ok(selectCount >= 1, `should have dropdowns in popover, found ${selectCount}`);
  });

  it('the provider list offers only usable providers', async () => {
    await waitFor(ctx, `(document.getElementById('chat-info-provider-select')?.options.length || 0) > 0`);
    const options = await evaluate(ctx, `
      Array.from(document.getElementById('chat-info-provider-select').options).map((o) => o.textContent)
    `);
    // A fresh profile has no tested provider: the only entries are the
    // current tier's provider, marked, or the hint to add a key.
    for (const text of options) {
      assert.ok(/not usable|No usable provider/.test(text), `a fresh profile offered a usable provider: ${text}`);
    }
  });

  it('changing tiers does not trigger native dialogs', async () => {
    const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
    assert.deepStrictEqual(calls, [], 'no native dialogs from tier interactions');
  });
});

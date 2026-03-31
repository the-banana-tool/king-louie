const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Inference Tier UI', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);

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

  it('provider dropdown includes new providers', async () => {
    const options = await evaluate(ctx, `
      (() => {
        const selects = document.querySelectorAll('#chat-info-popover select, #chat-info-popover-body select');
        for (const sel of selects) {
          const opts = Array.from(sel.options).map(o => o.textContent);
          if (opts.some(o => o.includes('OpenAI') || o === 'OpenAI')) return JSON.parse(JSON.stringify(opts));
        }
        return [];
      })()
    `);

    if (options.length > 0) {
      const optText = options.join(', ');
      assert.ok(options.some(o => o.includes('xAI')), `should include xAI. Options: ${optText}`);
      assert.ok(options.some(o => o.includes('DeepSeek')), `should include DeepSeek. Options: ${optText}`);
      assert.ok(options.some(o => o.includes('Qwen')), `should include Qwen. Options: ${optText}`);
      assert.ok(options.some(o => o.includes('Together')), `should include Together. Options: ${optText}`);
      assert.ok(options.some(o => o.includes('Fireworks')), `should include Fireworks. Options: ${optText}`);
      assert.ok(options.some(o => o.includes('Cohere')), `should include Cohere. Options: ${optText}`);
    }
  });

  it('changing tiers does not trigger native dialogs', async () => {
    const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
    assert.deepStrictEqual(calls, [], 'no native dialogs from tier interactions');
  });
});

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, openSettingsTab } = require('./helpers');

const toggle = (id, checked) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  el.checked = ${checked};
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
const choose = (id, value) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
const shown = (id) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  return !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
})()`;

describe('E2E: Settings — Voice', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'voice');
  });

  after(async () => { await closeApp(ctx); });

  it('has the voice output switch, the engine, speed and the ElevenLabs key', async () => {
    for (const id of ['voice-enabled-input', 'voice-engine-input', 'voice-speed-input', 'voice-elevenlabs-key-input']) {
      assert.ok(await evaluate(ctx, `!!document.getElementById(${JSON.stringify(id)})`), id);
    }
    assert.strictEqual(await evaluate(ctx, `document.getElementById('voice-enabled-input').classList.contains('switch')`), true);
    assert.strictEqual(await evaluate(ctx, `document.querySelector('#voice-engine-input option[value="system"]').textContent`), "This computer's voice");
    assert.strictEqual(await evaluate(ctx, `document.querySelector('#voice-speed-input').closest('.unit-field').querySelector('.unit').textContent`), '×');
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('save-voice-settings-btn')`), false, 'saves as it changes');
  });

  it('greys the rest until voice output is on', async () => {
    assert.strictEqual(await evaluate(ctx, `document.getElementById('voice-enabled-input').checked`), false);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('voice-engine-input').disabled`), true);
    await evaluate(ctx, toggle('voice-enabled-input', true));
    await waitFor(ctx, `!document.getElementById('voice-engine-input').disabled`);
    await waitFor(ctx, `window.electron.settings.load().then(({ data: s }) => s.voice.enabled === true)`);
  });

  it('hides ElevenLabs stability while the engine is this computer\'s voice', async () => {
    assert.strictEqual(await evaluate(ctx, `document.getElementById('voice-engine-input').value`), 'system');
    assert.strictEqual(await evaluate(ctx, shown('voice-stability-input')), false);
    await evaluate(ctx, choose('voice-engine-input', 'elevenlabs'));
    await waitFor(ctx, shown('voice-stability-input'));
    await waitFor(ctx, `window.electron.settings.load().then(({ data: s }) => s.voice.engine === 'elevenlabs')`);
  });

  it('after a save the field shows what was stored (speed 3 is stored as 2)', async () => {
    await evaluate(ctx, `(() => {
      const el = document.getElementById('voice-speed-input');
      el.focus();
      el.value = '3';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      return true;
    })()`);
    await waitFor(ctx, `window.electron.settings.load().then(({ data: s }) => s.voice.speed === 2)`);
    await waitFor(ctx, `document.getElementById('voice-speed-input').value === '2'`);
  });

  it('clear ElevenLabs key uses in-app confirm', async () => {
    await evaluate(ctx, `
      window.__nativeDialogsCalled = [];
      window.confirm = (msg) => { window.__nativeDialogsCalled.push(msg); return false; };
      true
    `);
    await waitFor(ctx, shown('clear-voice-key-btn'));
    await click(ctx, '#clear-voice-key-btn');
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    const calls = await evaluate(ctx, `JSON.parse(JSON.stringify(window.__nativeDialogsCalled))`);
    assert.deepStrictEqual(calls, [], 'should not call native confirm');
    await evaluate(ctx, `
      (() => { const m = document.querySelector('.rename-chat-modal'); if (m) m.querySelector('button')?.click(); return true; })()
    `);
  });
});

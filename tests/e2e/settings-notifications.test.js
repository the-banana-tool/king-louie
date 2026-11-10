const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, openSettingsTab } = require('./helpers');

const typeInto = (id, value) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  el.focus();
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
const toggle = (id, checked) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  el.checked = ${checked};
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
const stored = (expr) => `window.electron.settings.load().then(({ data: s }) => ${expr})`;

describe('E2E: Settings — Notifications', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'notifications');
  });

  after(async () => { await closeApp(ctx); });

  it('has the switches, the thresholds in seconds and the ntfy topic, and no Save button', async () => {
    for (const id of [
      'notifications-enabled-input', 'notifications-ui-toast-enabled-input',
      'notifications-ntfy-enabled-input', 'notifications-telegram-long-task-input'
    ]) {
      assert.strictEqual(await evaluate(ctx, `document.getElementById(${JSON.stringify(id)}).classList.contains('switch')`), true, id);
    }
    for (const id of ['notifications-toast-threshold-input', 'notifications-external-threshold-input']) {
      assert.strictEqual(
        await evaluate(ctx, `document.getElementById(${JSON.stringify(id)}).closest('.unit-field').querySelector('.unit').textContent`),
        's', id
      );
    }
    assert.ok(await evaluate(ctx, `!!document.getElementById('notifications-ntfy-topic-input')`));
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('save-notifications-btn')`), false, 'saves as it changes');
  });

  it('notifications enabled by default', async () => {
    const checked = await evaluate(ctx, `document.getElementById('notifications-enabled-input').checked`);
    assert.strictEqual(checked, true);
  });

  it('a toast threshold of 45 s is stored as 45000 ms after the debounce', async () => {
    await evaluate(ctx, typeInto('notifications-toast-threshold-input', '45'));
    await new Promise((r) => setTimeout(r, 1000));
    await waitFor(ctx, stored('s.notifications.thresholdsMs.toast === 45000'), 5000);
    await waitFor(ctx, `document.getElementById('settings-save-state').textContent === 'Saved'`);
  });

  it('an external threshold below the toast one is refused beside the field, and nothing is saved', async () => {
    const before = await evaluate(ctx, stored('s.notifications.thresholdsMs.external'));
    await evaluate(ctx, typeInto('notifications-external-threshold-input', '10'));
    await evaluate(ctx, `document.getElementById('notifications-external-threshold-input').blur(); true`);
    await waitFor(ctx, `(document.querySelector('.settings-field-error[data-for="notifications-external-threshold-input"]')?.textContent || '').includes('at least')`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.strictEqual(await evaluate(ctx, stored('s.notifications.thresholdsMs.external')), before);
    // Put it right again.
    await evaluate(ctx, typeInto('notifications-external-threshold-input', String(before / 1000)));
    await waitFor(ctx, `!document.querySelector('.settings-field-error[data-for="notifications-external-threshold-input"]')`);
  });

  it('greys the rest until notifications are on, and saves the switch', async () => {
    await evaluate(ctx, toggle('notifications-enabled-input', false));
    await waitFor(ctx, `document.getElementById('notifications-toast-threshold-input').disabled`);
    await waitFor(ctx, stored('s.notifications.enabled === false'));
    await evaluate(ctx, toggle('notifications-enabled-input', true));
    await waitFor(ctx, `!document.getElementById('notifications-toast-threshold-input').disabled`);
    await waitFor(ctx, stored('s.notifications.enabled === true'));
  });

  it('greys the ntfy topic until ntfy is on', async () => {
    assert.strictEqual(await evaluate(ctx, `document.getElementById('notifications-ntfy-enabled-input').checked`), false);
    assert.strictEqual(await evaluate(ctx, `document.getElementById('notifications-ntfy-topic-input').disabled`), true);
  });
});

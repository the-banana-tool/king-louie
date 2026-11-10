const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click, openSettingsTab } = require('./helpers');

describe('E2E: Settings — Scheduler', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await openSettingsTab(ctx, 'scheduler');
  });

  after(async () => { await closeApp(ctx); });

  it('has cron job message input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-message-input')`);
    assert.ok(exists);
  });

  it('has schedule kind select', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-kind-input')`);
    assert.ok(exists);
  });

  it('has schedule value input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-value-input')`);
    assert.ok(exists);
  });

  it('has add job button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-add-btn')`);
    assert.ok(exists);
  });

  it('has refresh jobs button', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-refresh-btn')`);
    assert.ok(exists);
  });

  it('has cron list container', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('cron-list')`);
    assert.ok(exists);
  });

  it('the new job\'s interval is a value with a s/min/h unit', async () => {
    const field = await evaluate(ctx, `(() => {
      document.getElementById('cron-add-kind-input').value = 'every';
      document.getElementById('cron-add-kind-input').dispatchEvent(new Event('change', { bubbles: true }));
      const unit = document.getElementById('cron-add-every-unit');
      return { input: document.getElementById('cron-add-every-input')?.type, units: unit ? [...unit.options].map((o) => o.value) : [] };
    })()`);
    assert.deepStrictEqual(field, { input: 'number', units: ['s', 'min', 'h'] });
  });

  it('a job with interval 60000 is a compact row reading "Every 1 min"', async () => {
    await evaluate(ctx, `window.electron.cron.add({ enabled: false, schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'Tick once a minute' } }).then(() => loadCronJobs()).then(() => true)`);
    const row = await waitFor(ctx, `(() => {
      const r = [...document.querySelectorAll('#cron-list .settings-list-row')].find((el) => el.textContent.includes('Tick once a minute'));
      return r ? r.textContent : '';
    })()`, 10000);
    assert.match(row, /Every 1 min/);
    assert.doesNotMatch(row, /60000ms/);
  });
});

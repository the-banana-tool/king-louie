const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_SETTINGS, mergeSettings } = require('../src/core/settings');

describe('core settings', () => {
  it('fills nested defaults without dropping user values', () => {
    const merged = mergeSettings({ checkpoints: { enabled: true } });
    assert.strictEqual(merged.checkpoints.enabled, true);
    assert.strictEqual(merged.checkpoints.maxAgeDays, 14);
    assert.deepStrictEqual(merged.allowedDirectories, []);
  });

  it('treats null as empty', () => {
    assert.deepStrictEqual(mergeSettings(null).models.profiles, []);
  });

  it('has no tier, active-provider or per-provider model defaults (stage M2)', () => {
    for (const key of ['activeProvider', 'providerModels', 'inference']) {
      assert.strictEqual(key in DEFAULT_SETTINGS, false, key);
      assert.strictEqual(key in mergeSettings({}), false, key);
    }
  });

  it('carries the models defaults (spec 2026-09-27 §14, stage M1 keys)', () => {
    const merged = mergeSettings({});
    assert.deepStrictEqual(merged.models.catalog, {
      fetch: true, refreshHours: 24, staleWarnDays: 30,
      modelsDevUrl: 'https://models.dev/api.json',
      scoresUrl: 'https://openrouter.ai/api/v1/models'
    });
    assert.deepStrictEqual(merged.models.overrides, {});
    assert.deepStrictEqual(merged.models.ollama, { baseUrl: 'http://127.0.0.1:11434' });
    assert.deepStrictEqual(merged.models.availability, { retestHours: 24 });
  });

  it('merges models keys one by one and keeps the owner\'s values', () => {
    const merged = mergeSettings({
      models: {
        catalog: { fetch: false },
        overrides: { 'openai:gpt-5.5': { cost: { input: 4 } } },
        ollama: { baseUrl: 'http://192.0.2.10:11434' }
      }
    });
    assert.strictEqual(merged.models.catalog.fetch, false);
    assert.strictEqual(merged.models.catalog.refreshHours, 24);
    assert.deepStrictEqual(merged.models.overrides, { 'openai:gpt-5.5': { cost: { input: 4 } } });
    assert.strictEqual(merged.models.ollama.baseUrl, 'http://192.0.2.10:11434');
    assert.strictEqual(merged.models.availability.retestHours, 24);
    assert.deepStrictEqual(mergeSettings({ models: { overrides: ['not', 'an', 'object'] } }).models.overrides, {});
  });

  it('carries the profile keys (spec §14, stage M2)', () => {
    const merged = mergeSettings({});
    assert.deepStrictEqual(merged.models.profiles, []);
    assert.strictEqual(merged.models.defaultProfileId, null);
    assert.deepStrictEqual(merged.models.customRoles, []);
    assert.deepStrictEqual(merged.models.roleTimeoutsMs, { main: 90000, worker: 30000, utility: 15000 });
    const kept = mergeSettings({ models: { profiles: [{ id: 'p-1' }], defaultProfileId: 'p-1', roleTimeoutsMs: { utility: 5000 } } });
    assert.deepStrictEqual(kept.models.profiles, [{ id: 'p-1' }]);
    assert.strictEqual(kept.models.defaultProfileId, 'p-1');
    assert.deepStrictEqual(kept.models.roleTimeoutsMs, { main: 90000, worker: 30000, utility: 5000 });
    const junk = mergeSettings({ models: { profiles: 'nope', customRoles: {}, defaultProfileId: 7 } });
    assert.deepStrictEqual(junk.models.profiles, []);
    assert.deepStrictEqual(junk.models.customRoles, []);
    assert.strictEqual(junk.models.defaultProfileId, null);
  });
});

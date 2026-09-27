const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_SETTINGS, mergeSettings } = require('../src/core/settings');

describe('core settings', () => {
  it('fills nested defaults without dropping user values', () => {
    const merged = mergeSettings({ activeProvider: 'anthropic', providerModels: { openai: 'custom' }, checkpoints: { enabled: true } });
    assert.strictEqual(merged.activeProvider, 'anthropic');
    assert.strictEqual(merged.providerModels.openai, 'custom');
    assert.strictEqual(merged.providerModels.anthropic, DEFAULT_SETTINGS.providerModels.anthropic);
    assert.strictEqual(merged.checkpoints.enabled, true);
    assert.strictEqual(merged.checkpoints.maxAgeDays, 14);
    assert.deepStrictEqual(merged.allowedDirectories, []);
  });

  it('treats null as empty', () => {
    assert.strictEqual(mergeSettings(null).activeProvider, DEFAULT_SETTINGS.activeProvider);
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
});

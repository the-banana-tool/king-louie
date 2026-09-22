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
});

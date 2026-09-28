const { describe, it } = require('node:test');
const assert = require('node:assert');

const ProviderFactory = require('../src/providers/provider-factory');
const { KL_PROVIDERS } = require('../src/models/provider-ids');

/**
 * The API keys tab is built from PROVIDER_LABELS in src/core/create-core.js,
 * and the models subsystem (catalog, availability, profiles) from KL_PROVIDERS
 * in src/models/provider-ids.js. Every provider offered must be creatable by
 * ProviderFactory — otherwise sending a message blows up with
 * `Unknown provider: "x"` deep in the inference path. This guards that the two
 * lists and the factory agree.
 */
describe('Provider config consistency (core ↔ ProviderFactory)', () => {
  // providerLabels is the module-level PROVIDER_LABELS (also what the service
  // CLI validates `token set <provider>` against).
  const labelKeys = Object.keys(require('../src/core/create-core').PROVIDER_LABELS);
  const registered = new Set(ProviderFactory.listRegistered());

  it('finds a realistic provider list (sanity)', () => {
    assert.ok(labelKeys.length >= 8, `expected >=8 providers, got ${labelKeys.length}`);
  });

  it('providerLabels and KL_PROVIDERS expose the same providers', () => {
    assert.deepStrictEqual([...labelKeys].sort(), [...KL_PROVIDERS].sort());
  });

  it('every provider offered in the UI is registered in ProviderFactory', () => {
    const unregistered = labelKeys.filter((k) => !registered.has(k)).sort();
    assert.deepStrictEqual(
      unregistered,
      [],
      `Providers offered in Settings but NOT creatable (chat will throw "Unknown provider"):\n  ${unregistered.join('\n  ')}`
    );
  });

  it('ollama is registered and needs no API key', () => {
    assert.ok(registered.has('ollama'));
    const provider = ProviderFactory.create('ollama', undefined);
    assert.doesNotThrow(() => provider.validateApiKey());
    assert.strictEqual(provider.getName(), 'ollama');
  });
});

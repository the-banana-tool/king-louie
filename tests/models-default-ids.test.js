// tests/models-default-ids.test.js
// Every model id King Louie ships must resolve in the bundled snapshot
// catalog: each provider's own getDefaultModel(), and the pre-M2 defaults
// the tier migration fills in for a stored setting that left one out. A
// default not in the catalog prices as unpriced and loses its capabilities.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Catalog } = require('../src/models/catalog');
const { KL_PROVIDERS } = require('../src/models');
const { LEGACY_DEFAULTS } = require('../src/models/migrate-tiers');
const ProviderFactory = require('../src/providers/provider-factory');

const catalog = new Catalog().load({});

describe('every shipped default model id resolves in the bundled snapshot', () => {
  it('every provider\'s own getDefaultModel() is in the catalog', () => {
    for (const key of ProviderFactory.listRegistered()) {
      const id = ProviderFactory.create(key, 'test-key-123456').getDefaultModel();
      if (!id) continue; // Ollama's default is empty: no local server to assume.
      assert.ok(catalog.get(key, id), `${key}.getDefaultModel() = "${id}" is not in the bundled snapshot`);
    }
    assert.ok(KL_PROVIDERS.length >= ProviderFactory.listRegistered().length, 'sanity: KL_PROVIDERS covers every registered provider');
  });

  it('the migration\'s pre-M2 defaults are in the catalog', () => {
    for (const [provider, id] of Object.entries(LEGACY_DEFAULTS.providerModels)) {
      if (!id) continue;
      assert.ok(catalog.get(provider, id), `LEGACY_DEFAULTS.providerModels.${provider} = "${id}" is not in the bundled snapshot`);
    }
    for (const [tier, cfg] of Object.entries(LEGACY_DEFAULTS.tierMap)) {
      assert.ok(catalog.get(cfg.provider, cfg.model), `LEGACY_DEFAULTS.tierMap.${tier} = "${cfg.provider}:${cfg.model}" is not in the bundled snapshot`);
    }
  });
});

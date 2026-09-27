// tests/models-default-ids.test.js
// Fix round 1 (Task 8 review): every shipped default model id must resolve
// in the bundled snapshot catalog — settings.providerModels, inference's
// tierMap, the core's providerDefaults, and each provider's own
// getDefaultModel(). A default that is not in the catalog silently prices
// as unpriced and (since capabilitiesOf reads the catalog) loses vision,
// which broke a default Anthropic install's case OCR (NO_VISION_MODEL).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore, DEFAULT_SETTINGS } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { getActiveCatalog, setActiveCatalog, KL_PROVIDERS } = require('../src/models');
const ProviderFactory = require('../src/providers/provider-factory');

const tempDirs = [];
afterEach(() => {
  setActiveCatalog(null);
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeCore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-default-ids-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  return createCore({
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: () => {} },
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); }
  });
}

describe('every shipped default model id resolves in the bundled snapshot', () => {
  it('settings.providerModels: every non-empty default is in the catalog', () => {
    const catalog = getActiveCatalog();
    for (const [provider, id] of Object.entries(DEFAULT_SETTINGS.providerModels)) {
      if (!id) continue; // Ollama ships no default: no local server to assume.
      assert.ok(catalog.get(provider, id), `providerModels.${provider} = "${id}" is not in the bundled snapshot`);
    }
  });

  it('inference.tierMap: every tier\'s default model is in the catalog', () => {
    const catalog = getActiveCatalog();
    for (const [tier, cfg] of Object.entries(DEFAULT_SETTINGS.inference.tierMap)) {
      assert.ok(catalog.get(cfg.provider, cfg.model), `inference.tierMap.${tier} = "${cfg.provider}:${cfg.model}" is not in the bundled snapshot`);
    }
  });

  it('the core\'s providerDefaults: every non-empty default is in the catalog', () => {
    const core = makeCore();
    const catalog = getActiveCatalog();
    assert.strictEqual(catalog, core.models.catalog, 'getActiveCatalog() is the core\'s own catalog');
    for (const [provider, id] of Object.entries(core.context.providerDefaults)) {
      if (!id) continue; // Ollama and Copilot ship no fallback default here.
      assert.ok(catalog.get(provider, id), `providerDefaults.${provider} = "${id}" is not in the bundled snapshot`);
    }
  });

  it('every provider\'s own getDefaultModel() is in the catalog', () => {
    const catalog = getActiveCatalog();
    for (const key of ProviderFactory.listRegistered()) {
      const id = ProviderFactory.create(key, 'test-key-123456').getDefaultModel();
      if (!id) continue; // Ollama's default is empty: no local server to assume.
      assert.ok(catalog.get(key, id), `${key}.getDefaultModel() = "${id}" is not in the bundled snapshot`);
    }
    assert.ok(KL_PROVIDERS.length >= ProviderFactory.listRegistered().length, 'sanity: KL_PROVIDERS covers every registered provider');
  });
});

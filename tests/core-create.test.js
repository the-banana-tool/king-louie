// tests/core-create.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');

function makeDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-core-'));
  const sent = [];
  return {
    sent,
    deps: {
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      ui: { send: (ch, p) => sent.push({ ch, p }) },
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    }
  };
}

describe('createCore', () => {
  it('constructs synchronously and exposes settings and token helpers before start()', () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    assert.strictEqual(typeof core.getSettings().activeProvider, 'string');
    core.saveProviderToken('openai', 'sk-test');
    assert.ok(deps.store.get('apiTokens').openai.startsWith('klc1:'));
    core.vault.set('k', 'v');
    assert.strictEqual(core.vault.get('k'), 'v');
    assert.strictEqual(typeof core.context.getChats, 'function');
    assert.strictEqual(core.context.safeStorage, undefined);
  });

  it('starts headless with every optional feature off, then shuts down cleanly', async () => {
    const { deps } = makeDeps();
    const core = createCore(deps);
    await core.start();
    assert.ok(core.context.toolRegistry.getFunctionDefinitions().length > 10);
    assert.strictEqual(core.getMeshContext(), null);
    await core.shutdown();
  });
});

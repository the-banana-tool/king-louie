const assert = require('assert');

const { registerSettingsHandlers } = require('../src/ipc/settings-handlers');

function run(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✔ ${name}`);
    })
    .catch((error) => {
      console.error(`✖ ${name}`);
      console.error(error.stack || error.message || error);
      process.exitCode = 1;
    });
}

function createIpcMainMock() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };
}

function createDefaultContext(overrides = {}) {
  const settings = { notifications: { enabled: true }, hooks: { enabled: true }, templateVariables: { name: '' }, models: {} };

  return {
    safeStorage: { isEncryptionAvailable: () => true },
    getApiTokens: () => ({ openai: 'encrypted-token' }),
    getApiStatus: () => ({ openai: { ok: true, message: 'ok' } }),
    getSettings: () => settings,
    providerLabels: { openai: 'OpenAI' },
    hasStoredElevenLabsToken: () => false,
    hasStoredTelegramToken: () => false,
    getTelegramBridge: () => null,
    listHookDefinitions: () => [],
    normalizeTemplateVariables: (vars = {}) => vars,
    getUserProfile: () => ({ name: '' }),
    getVoiceSettings: () => ({ enabled: false, engine: 'system' }),
    setTemplateVariables: (vars = {}) => vars,
    updateUserProfile: (profile = {}) => profile,
    setVoiceSettings: (voice = {}) => voice,
    clearElevenLabsToken: () => {},
    saveElevenLabsToken: () => {},
    getTtsEngine: () => ({ testConnection: async () => true }),
    normalizeVoiceSettings: (voice = {}) => voice,
    setSettings: () => {},
    resetRuntimeEnvironmentCache: () => {},
    setApiTokens: () => {},
    encryptToken: (token) => `encrypted:${token}`,
    decryptToken: () => 'token',
    updateStatus: (_provider, status) => status,
    runLlmCommand: async (command) => ({ ok: true, output: command }),
    setNotificationSettings: (notifications) => notifications,
    ...overrides
  };
}

run('registerSettingsHandlers wires expected channels', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext());

  const channels = [
    'settings:load',
    'settings:saveTemplateVariables',
    'settings:saveUserProfile',
    'settings:saveVoice',
    'settings:saveElevenLabsKey',
    'settings:testVoice',
    'settings:saveProvider',
    'settings:testProvider',
    'settings:runLlmCommand',
    'settings:saveNotifications'
  ];

  channels.forEach((channel) => {
    assert.ok(ipcMain.handlers.has(channel), `${channel} should be registered`);
  });

  for (const gone of ['settings:setActiveProvider', 'settings:setProviderModel', 'settings:setInferenceTier', 'settings:setTierProviderModel', 'settings:listModels', 'settings:saveSmartRouting', 'settings:saveSmartRoutingRules', 'settings:saveLlmRouting']) {
    assert.strictEqual(ipcMain.handlers.has(gone), false, `${gone} is gone with the tiers`);
  }
});

run('settings:load returns wrapped payload with provider data', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext());

  const result = await ipcMain.handlers.get('settings:load')({});
  assert.strictEqual(result.ok, true);
  assert.ok(result.data);
  assert.strictEqual('activeProvider' in result.data, false);
  assert.strictEqual('inference' in result.data, false);
  assert.strictEqual('model' in result.data.providers.openai, false);
  assert.ok(result.data.providers.openai);
});

run('settings:saveProvider retests the provider in the background', async () => {
  const changed = [];
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext({
    onProviderKeyChanged: async (provider) => { changed.push(provider); return { ok: true }; }
  }));
  const saved = await ipcMain.handlers.get('settings:saveProvider')({}, { provider: 'openai', token: 'sk-test-123456' });
  assert.deepStrictEqual(saved, { ok: true, hasToken: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(changed, ['openai']);
  await ipcMain.handlers.get('settings:saveProvider')({}, { provider: 'openai', clear: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(changed, ['openai', 'openai']);
});

run('settings:testProvider returns the one connection test\'s result', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext({
    testProviderConnection: async (provider) => ({ ok: true, status: { ok: true, message: `tested ${provider}` } })
  }));
  const result = await ipcMain.handlers.get('settings:testProvider')({}, { provider: 'openai' });
  assert.deepStrictEqual(result, { ok: true, status: { ok: true, message: 'tested openai' } });
});

run('settings:load includes the Ollama address', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext({
    getSettings: () => ({
      models: { ollama: { baseUrl: 'http://127.0.0.1:11434' }, catalog: { fetch: false, refreshHours: 12 }, overrides: {} }
    })
  }));
  const result = await ipcMain.handlers.get('settings:load')({});
  assert.strictEqual(result.data.ollamaBaseUrl, 'http://127.0.0.1:11434');
  assert.deepStrictEqual(result.data.modelsSettings, { catalog: { fetch: false, refreshHours: 12 }, overrides: {} });
});

setTimeout(() => {
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }

  console.log('Settings handler tests completed.');
}, 40);

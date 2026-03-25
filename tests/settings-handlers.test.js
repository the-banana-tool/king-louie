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
  const settings = {
    activeProvider: 'openai',
    inference: { activeTier: 'standard' },
    notifications: { enabled: true },
    hooks: { enabled: true },
    templateVariables: { name: '' },
    providerModels: { openai: 'gpt-4o-mini' }
  };

  return {
    safeStorage: { isEncryptionAvailable: () => true },
    getApiTokens: () => ({ openai: 'encrypted-token' }),
    getApiStatus: () => ({ openai: { ok: true, message: 'ok' } }),
    getSettings: () => settings,
    providerLabels: { openai: 'OpenAI' },
    providerDefaults: { openai: 'gpt-4o-mini' },
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
    setActiveInferenceTier: (tier) => {
      if (!['fast', 'standard', 'smart'].includes(String(tier))) {
        throw new Error('bad tier');
      }
      return { activeTier: tier };
    },
    setNotificationSettings: (notifications) => notifications,
    applyActiveProviderUpdate: ({ provider }) => {
      if (provider !== 'openai') {
        return { ok: false, error: 'Unknown provider.' };
      }
      return { ok: true, activeProvider: provider };
    },
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
    'settings:setActiveProvider',
    'settings:setProviderModel',
    'settings:saveProvider',
    'settings:testProvider',
    'settings:runLlmCommand',
    'settings:setInferenceTier',
    'settings:saveNotifications'
  ];

  channels.forEach((channel) => {
    assert.ok(ipcMain.handlers.has(channel), `${channel} should be registered`);
  });
});

run('settings:load returns wrapped payload with provider data', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext());

  const result = await ipcMain.handlers.get('settings:load')({});
  assert.strictEqual(result.ok, true);
  assert.ok(result.data);
  assert.strictEqual(result.data.activeProvider, 'openai');
  assert.ok(result.data.providers.openai);
});

run('settings:setActiveProvider forwards known provider errors', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext());

  const result = await ipcMain.handlers.get('settings:setActiveProvider')({}, { provider: 'bad' });
  assert.deepStrictEqual(result, { ok: false, error: 'Unknown provider.' });
});

run('settings:setInferenceTier wraps thrown errors', async () => {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, createDefaultContext({
    setActiveInferenceTier: () => {
      throw new Error('tier exploded');
    }
  }));

  const result = await ipcMain.handlers.get('settings:setInferenceTier')({}, { tier: 'broken' });
  assert.deepStrictEqual(result, { ok: false, error: 'tier exploded' });
});

setTimeout(() => {
  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }

  console.log('Settings handler tests completed.');
}, 40);

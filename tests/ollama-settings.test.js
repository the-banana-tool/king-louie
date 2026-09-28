const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { registerSettingsHandlers } = require('../src/ipc/settings-handlers');

function createIpcMainMock() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler) };
}

// Minimal context where NO provider has a saved token — the exact situation a
// fresh Ollama user is in, and the case the tokenless fix targets.
function tokenlessContext(overrides = {}) {
  return {
    safeStorage: { isEncryptionAvailable: () => true },
    getApiTokens: () => ({}),
    getApiStatus: () => ({}),
    getSettings: () => ({ models: {} }),
    setSettings: () => {},
    providerLabels: { openai: 'OpenAI', ollama: 'Ollama (Local)' },
    decryptToken: () => { throw new Error('decryptToken should not be called for tokenless provider'); },
    encryptToken: (t) => `enc:${t}`,
    updateStatus: (_p, status) => status,
    anthropicOAuth: { isConnected: () => false },
    ...overrides
  };
}

function getHandler(channel, ctx) {
  const ipcMain = createIpcMainMock();
  registerSettingsHandlers(ipcMain, ctx || tokenlessContext());
  return ipcMain.handlers.get(channel);
}

describe('Ollama tokenless settings behavior', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  describe('settings:testProvider', () => {
    it('delegates to the one connection test, with no token needed for Ollama', async () => {
      const tested = [];
      const handler = getHandler('settings:testProvider', tokenlessContext({
        testProviderConnection: async (p) => {
          tested.push(p);
          return { ok: true, status: { ok: true, message: 'Connected: 2 models.', models: ['llama3.1', 'qwen2.5'] } };
        }
      }));
      const result = await handler({}, { provider: 'ollama' });
      assert.strictEqual(result.ok, true, `expected success, got: ${JSON.stringify(result)}`);
      assert.deepStrictEqual(tested, ['ollama']);
    });

    it('reports a missing token as the test\'s error', async () => {
      const handler = getHandler('settings:testProvider', tokenlessContext({
        testProviderConnection: async () => ({ ok: false, error: 'No token saved for this provider.', status: { ok: false } })
      }));
      const result = await handler({}, { provider: 'openai' });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /No token saved/i);
    });

    it('refuses an unknown provider without testing', async () => {
      const handler = getHandler('settings:testProvider', tokenlessContext({
        testProviderConnection: async () => { throw new Error('must not be called'); }
      }));
      assert.deepStrictEqual(await handler({}, { provider: 'nope' }), { ok: false, error: 'Unknown provider.' });
    });
  });
});

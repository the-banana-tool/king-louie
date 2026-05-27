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
    getSettings: () => ({ activeProvider: 'ollama', inference: {}, providerModels: {} }),
    setSettings: () => {},
    providerLabels: { openai: 'OpenAI', ollama: 'Ollama (Local)' },
    providerDefaults: { openai: 'gpt-4o-mini', ollama: '' },
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
    it('does NOT reject Ollama for a missing API token', async () => {
      let calledUrl = null;
      global.fetch = async (url) => {
        calledUrl = url;
        return { ok: true, text: async () => '' };
      };

      const handler = getHandler('settings:testProvider');
      const result = await handler({}, { provider: 'ollama' });

      assert.strictEqual(result.ok, true, `expected success, got: ${JSON.stringify(result)}`);
      assert.match(String(calledUrl), /11434\/api\/tags/, 'should probe the local Ollama daemon');
    });

    it('still rejects a token-required provider with no saved token', async () => {
      global.fetch = async () => ({ ok: true, text: async () => '' });
      const handler = getHandler('settings:testProvider');
      const result = await handler({}, { provider: 'openai' });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /No token saved/i);
    });

    it('reports an error (not a crash) when the Ollama daemon is down', async () => {
      global.fetch = async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'connection refused'
      });
      const handler = getHandler('settings:testProvider');
      const result = await handler({}, { provider: 'ollama' });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /503/);
    });
  });

  describe('settings:listModels', () => {
    it('lists Ollama models over the API without a saved token', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ data: [{ id: 'llama3.1' }, { id: 'qwen2.5' }] })
      });
      const handler = getHandler('settings:listModels');
      const result = await handler({}, { provider: 'ollama' });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.source, 'api');
      assert.deepStrictEqual(result.models, ['llama3.1', 'qwen2.5']);
    });

    it('falls back to the static list when the Ollama API is unreachable', async () => {
      global.fetch = async () => { throw new Error('fetch failed'); };
      const handler = getHandler('settings:listModels');
      const result = await handler({}, { provider: 'ollama' });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.source, 'static');
      assert.ok(Array.isArray(result.models));
    });
  });
});

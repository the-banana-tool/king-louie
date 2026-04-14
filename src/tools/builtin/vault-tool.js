const { Tool } = require('../tool-schema');

/**
 * Vault Tool — Secure credential storage and retrieval using Electron safeStorage.
 *
 * Stores secrets encrypted at rest (Windows DPAPI / macOS Keychain / Linux Secret Service).
 * Secrets are stored in the Electron Store under a dedicated namespace to avoid collisions.
 * The tool never returns raw secret values in list operations — only key names.
 *
 * IMPORTANT: The agent MUST use this tool to retrieve sensitive values at the moment they
 * are needed (e.g., right before typing into a form field). This keeps secrets out of the
 * conversation context until the last possible moment.
 */

const VAULT_STORE_PREFIX = '__vault_';

function getStore() {
  // Lazy-require to avoid issues in test environments where electron-store isn't available.
  // electron-store v10+ is ESM-only; CommonJS require returns a namespace with a default export.
  const mod = require('electron-store');
  const Store = mod.default || mod;
  return new Store();
}

const vaultTool = new Tool({
  name: 'Vault',
  description:
    'Securely store, retrieve, and manage sensitive credentials (API keys, passwords, credit card numbers, etc.) using OS-level encryption. ' +
    'Use "store" to save a secret, "retrieve" to get it back, "list" to see stored key names, and "delete" to remove one. ' +
    'Secrets are encrypted at rest via Electron safeStorage. Never log or display retrieved secrets — pass them directly to the action that needs them (e.g., Browser type).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['store', 'retrieve', 'list', 'delete'],
        description: 'Action to perform on the vault.'
      },
      key: {
        type: 'string',
        description: 'The key name for the secret (required for store, retrieve, delete). Use descriptive names like "test_cc_number", "test_cc_expiry", "signup_password".'
      },
      value: {
        type: 'string',
        description: 'The secret value to store (required for store action). Will be encrypted before saving.'
      }
    },
    required: ['action']
  },
  requiresApproval: true,
  execute: async (params, context) => {
    const { action, key, value } = params;

    // encryptToken and decryptToken are injected via extraToolOptions in main.js
    const { encryptToken, decryptToken } = context || {};

    if (action !== 'list' && !key) {
      return { ok: false, error: `"key" parameter is required for ${action} action.` };
    }

    const store = getStore();
    const storeKey = key ? `${VAULT_STORE_PREFIX}${key}` : null;

    try {
      switch (action) {
        case 'store': {
          if (!value) {
            return { ok: false, error: '"value" parameter is required for store action.' };
          }
          if (!encryptToken) {
            return { ok: false, error: 'Encryption is not available. Ensure the app is running in Electron with safeStorage.' };
          }
          const encrypted = encryptToken(value);
          store.set(storeKey, encrypted);
          return { ok: true, message: `Secret "${key}" stored securely.` };
        }

        case 'retrieve': {
          if (!decryptToken) {
            return { ok: false, error: 'Decryption is not available. Ensure the app is running in Electron with safeStorage.' };
          }
          const encrypted = store.get(storeKey);
          if (!encrypted) {
            return { ok: false, error: `No secret found for key "${key}".` };
          }
          const decrypted = decryptToken(encrypted);
          return { ok: true, key, value: decrypted };
        }

        case 'list': {
          const allKeys = Object.keys(store.store || {});
          const vaultKeys = allKeys
            .filter((k) => k.startsWith(VAULT_STORE_PREFIX))
            .map((k) => k.slice(VAULT_STORE_PREFIX.length));
          return { ok: true, keys: vaultKeys, count: vaultKeys.length };
        }

        case 'delete': {
          if (!store.has(storeKey)) {
            return { ok: false, error: `No secret found for key "${key}".` };
          }
          store.delete(storeKey);
          return { ok: true, message: `Secret "${key}" deleted.` };
        }

        default:
          return { ok: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
});

module.exports = vaultTool;

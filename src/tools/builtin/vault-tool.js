const { Tool } = require('../tool-schema');

// Cases stage 4: relay tokens, webhook secrets and mailbox passwords live
// under `contact.`; the model can neither read nor list them, however it
// spells the key (see isContactVaultKey).
const { isContactVaultKey } = require('../../cases/contact-settings');

/**
 * Vault Tool — Secure credential storage and retrieval.
 *
 * Stores secrets encrypted at rest (Windows DPAPI / macOS Keychain / Linux Secret Service
 * via Electron safeStorage, or an AES-GCM master key in headless mode).
 * Secrets are stored under a dedicated namespace to avoid collisions.
 * The tool never returns raw secret values in list operations — only key names.
 *
 * IMPORTANT: The agent MUST use this tool to retrieve sensitive values at the moment they
 * are needed (e.g., right before typing into a form field). This keeps secrets out of the
 * conversation context until the last possible moment.
 */

const vaultTool = new Tool({
  name: 'Vault',
  description:
    'Securely store, retrieve, and manage sensitive credentials (API keys, passwords, credit card numbers, etc.) using OS-level encryption. ' +
    'Use "store" to save a secret, "retrieve" to get it back, "list" to see stored key names, and "delete" to remove one. ' +
    'Secrets are encrypted at rest. Never log or display retrieved secrets — pass them directly to the action that needs them (e.g., Browser type).',
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

    // vault is injected via extraToolOptions in main.js
    const { vault } = context || {};

    if (!vault) {
      return { ok: false, error: 'Vault is not available in this environment.' };
    }

    if (action !== 'list' && !key) {
      return { ok: false, error: `"key" parameter is required for ${action} action.` };
    }

    if (action !== 'list' && isContactVaultKey(key)) {
      return { ok: false, error: 'contact credentials are managed in settings, not by the model' };
    }
    // The desktop vault treats a backslash as an escape, so such a key would
    // not name what it appears to name.
    if (action !== 'list' && String(key).includes('\\')) {
      return { ok: false, error: 'vault keys may not contain a backslash' };
    }

    try {
      switch (action) {
        case 'store': {
          if (!value) {
            return { ok: false, error: '"value" parameter is required for store action.' };
          }
          vault.set(key, value);
          return { ok: true, message: `Secret "${key}" stored securely.` };
        }

        case 'retrieve': {
          const v = vault.get(key);
          if (!v) {
            return { ok: false, error: `No secret found for key "${key}".` };
          }
          return { ok: true, key, value: v };
        }

        case 'list': {
          const keys = vault.list().filter((k) => !isContactVaultKey(k));
          return { ok: true, keys, count: keys.length };
        }

        case 'delete': {
          if (!vault.delete(key)) {
            return { ok: false, error: `No secret found for key "${key}".` };
          }
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

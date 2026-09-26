/**
 * Vault resolver for MCP server configs.
 *
 * Expands ${vault:key} references in env values to decrypted vault secrets
 * at connection time. This keeps plaintext tokens out of settings.json —
 * users store tokens once via the Vault UI and reference them by key here.
 *
 * Unresolved references return the original string (with a warning) so that
 * missing keys surface as MCP auth errors rather than silent empty values.
 */

const { createLogger } = require('../logging');
const { isContactVaultKey } = require('../cases/contact-settings');

const log = createLogger('mcp/vault-resolver');
const VAULT_PREFIX = '__vault_';
const VAULT_REF = /\$\{vault:([^}]+)\}/g;

function createVaultEnvResolver({ vaultStore, decryptToken, onMissing, logger = log } = {}) {
  if (!vaultStore || !decryptToken) {
    // No vault wiring — return identity resolver
    return (config) => config;
  }

  const resolveValue = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(VAULT_REF, (match, key) => {
      // Cases stage 4: contact channel credentials never reach an MCP server.
      // A backslash is an escape to the desktop vault, so it is refused too.
      if (isContactVaultKey(key) || key.includes('\\')) {
        logger.warn(`not resolving ${match}: contact credentials and keys with a backslash are not available to MCP servers`);
        return match;
      }
      const encrypted = vaultStore.get(`${VAULT_PREFIX}${key.trim()}`);
      if (!encrypted) {
        if (onMissing) onMissing(key);
        return match; // leave unresolved so auth failure is visible
      }
      try {
        return decryptToken(encrypted);
      } catch (err) {
        if (onMissing) onMissing(key, err);
        return match;
      }
    });
  };

  return (config = {}) => {
    const resolvedEnv = {};
    for (const [k, v] of Object.entries(config.env || {})) {
      resolvedEnv[k] = resolveValue(v);
    }
    return { ...config, env: resolvedEnv };
  };
}

module.exports = { createVaultEnvResolver };

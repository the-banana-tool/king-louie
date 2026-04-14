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

const VAULT_PREFIX = '__vault_';
const VAULT_REF = /\$\{vault:([^}]+)\}/g;

function createVaultEnvResolver({ vaultStore, decryptToken, onMissing } = {}) {
  if (!vaultStore || !decryptToken) {
    // No vault wiring — return identity resolver
    return (config) => config;
  }

  const resolveValue = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(VAULT_REF, (match, key) => {
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

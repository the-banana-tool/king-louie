// src/models/local-vault-keys.js
// Where an administrator keeps a local server's key in service mode (local
// inference spec 2026-10-13 §5.6, §13.3): the vault, under `local.`, named
// by a `${vault:local.<name>}` reference in the admin service.json. The
// Vault tool can neither read, change, delete nor list such a key (as it
// cannot a `contact.` credential), however the key is spelled.
const LOCAL_SERVER_VAULT_PREFIX = 'local';

// The vault's own reading of a key: a backslash is an escape, and the first
// segment ends at a dot or a bracket. Case and surrounding spaces do not count.
function isLocalServerVaultKey(key) {
  if (typeof key !== 'string') return false;
  const first = key.replace(/\\/g, '').split(/[.[]/)[0];
  return first.trim().toLowerCase() === LOCAL_SERVER_VAULT_PREFIX;
}

module.exports = { LOCAL_SERVER_VAULT_PREFIX, isLocalServerVaultKey };

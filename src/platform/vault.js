// Named secrets stored as ciphertext in an ordinary key-value store.
// The prefix matches what the Vault tool has always written, so existing
// Electron vaults keep working.
const VAULT_PREFIX = '__vault_';

function createVault({ store, cipher }) {
  const storeKey = (key) => `${VAULT_PREFIX}${key}`;
  return {
    set(key, value) {
      store.set(storeKey(key), cipher.encryptString(value));
    },
    get(key) {
      const encrypted = store.get(storeKey(key));
      return encrypted ? cipher.decryptString(encrypted) : null;
    },
    has(key) {
      return store.has(storeKey(key));
    },
    delete(key) {
      if (!store.has(storeKey(key))) return false;
      store.delete(storeKey(key));
      return true;
    },
    list() {
      return Object.keys(store.store || {})
        .filter((k) => k.startsWith(VAULT_PREFIX))
        .map((k) => k.slice(VAULT_PREFIX.length));
    }
  };
}

module.exports = { createVault, VAULT_PREFIX };

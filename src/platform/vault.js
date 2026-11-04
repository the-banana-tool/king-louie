// Named secrets stored as ciphertext in an ordinary key-value store.
// The prefix matches what the Vault tool has always written, so existing
// Electron vaults keep working.
const VAULT_PREFIX = '__vault_';

// What a store's data holds under a name, by own properties only, so x.toString over
// a branch is nothing. A store nests a name at each dot; one stored flat reads too.
function vaultNodeAt(data, key) {
  const name = `${VAULT_PREFIX}${key}`;
  if (data && typeof data === 'object' && Object.hasOwn(data, name)) return data[name];
  let node = data;
  for (const part of name.split('.')) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function createVault({ store, cipher }) {
  const storeKey = (key) => `${VAULT_PREFIX}${key}`;
  const read = (key) => vaultNodeAt(store.store, key);
  const holds = (key) => typeof read(key) === 'string';
  return {
    set(key, value) {
      store.set(storeKey(key), cipher.encryptString(value));
    },
    get(key) {
      const encrypted = read(key);
      return typeof encrypted === 'string' && encrypted ? cipher.decryptString(encrypted) : null;
    },
    has(key) {
      return read(key) !== undefined;
    },
    // A store nests a key at each dot, so has() is also true of a name that only
    // has entries under it. holds() is true of a stored secret alone.
    holds,
    // What this key cannot be written beside, or null: a shorter name holding a
    // secret, which the write would replace with a branch, or the key itself when
    // entries sit under it.
    blockedBy(key) {
      const parts = String(key).split('.');
      for (let i = 1; i < parts.length; i += 1) {
        const name = parts.slice(0, i).join('.');
        if (holds(name)) return name;
      }
      return read(key) !== undefined && !holds(key) ? String(key) : null;
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

module.exports = { createVault, vaultNodeAt, VAULT_PREFIX };

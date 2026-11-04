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

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// A store walks a key's parts as object keys, so this is no name for a secret.
const hasPrototypePart = (key) => String(key).split('.').some((part) => PROTOTYPE_KEYS.has(part));
const MAX_DEPTH = 64;

// Every entry of a store's data by its whole key: walks to the string leaves and
// rejoins with dots, by own keys. `unread` names what is there and is no secret.
function readVaultEntries(data) {
  const entries = new Map();
  const unread = [];
  const walk = (key, value, depth) => {
    if (!value) return;
    if (!key || hasPrototypePart(key)) unread.push(key);
    else if (typeof value === 'string') {
      if (entries.has(key)) unread.push(key);
      else entries.set(key, value);
    } else if (typeof value === 'object' && !Array.isArray(value) && depth < MAX_DEPTH) {
      for (const part of Object.keys(value)) walk(`${key}.${part}`, value[part], depth + 1);
    } else unread.push(key);
  };
  for (const k of Object.keys(data || {})) {
    if (k.startsWith(VAULT_PREFIX)) walk(k.slice(VAULT_PREFIX.length), data[k], 0);
  }
  return { entries, unread };
}

// A branch with nothing in it, as a delete on a store that does not prune leaves.
const isEmptyBranch = (node) => Boolean(node) && typeof node === 'object' && !Array.isArray(node)
  && Object.values(node).every(isEmptyBranch);

const vaultBlockedText = (key, blocker) => (blocker === String(key)
  ? `"${key}" has other secrets stored under it, so it cannot be written.`
  : `"${key}" cannot be written: the secret "${blocker}" is in its way.`);

function createVault({ store, cipher }) {
  const storeKey = (key) => `${VAULT_PREFIX}${key}`;
  const read = (key) => vaultNodeAt(store.store, key);
  const holds = (key) => typeof read(key) === 'string';
  // What this key cannot be written beside, or null: a shorter name holding a secret,
  // which the write would replace with a branch, or the key itself when entries sit
  // under it, which it would replace.
  const blockedBy = (key) => {
    const parts = String(key).split('.');
    for (let i = 1; i < parts.length; i += 1) {
      const name = parts.slice(0, i).join('.');
      if (holds(name)) return name;
    }
    const here = read(key);
    return here !== undefined && !holds(key) && !isEmptyBranch(here) ? String(key) : null;
  };
  return {
    set(key, value) {
      const blocker = blockedBy(key);
      if (blocker) throw Object.assign(new Error(vaultBlockedText(key, blocker)), { code: 'VAULT_NAME_BLOCKED' });
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
    blockedBy,
    // One secret, never a branch, and the parents it leaves empty go with it: no
    // store's delete prunes them. False when it is still there afterwards (a name
    // stored flat, which a store's own delete cannot reach).
    delete(key) {
      if (!holds(key)) return false;
      store.delete(storeKey(key));
      if (holds(key)) return false;
      const parts = String(key).split('.');
      for (let i = parts.length - 1; i >= 1; i -= 1) {
        const parent = parts.slice(0, i).join('.');
        if (!isEmptyBranch(read(parent))) break;
        store.delete(storeKey(parent));
      }
      return true;
    },
    list() {
      return [...readVaultEntries(store.store).entries.keys()];
    }
  };
}

module.exports = { createVault, vaultNodeAt, readVaultEntries, hasPrototypePart, VAULT_PREFIX };

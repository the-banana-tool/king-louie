// The desktop's own record of attached mode (fleet stage 7 §4.4): electron-store
// `desktop-bridge` in <userData>. Read before any core exists, because it
// decides whether one is built at all. Never read by the service.
const crypto = require('crypto');
const { MESSAGES } = require('../desktop-bridge/protocol');

const MODES = Object.freeze(['standalone', 'attached']);

function secureStorageUsable(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

function defaultStoreFactory() {
  const { default: Store } = require('electron-store');
  return (options) => new Store(options);
}

function unavailable() {
  const err = new Error(MESSAGES.SECURE_STORAGE_UNAVAILABLE);
  err.code = 'SECURE_STORAGE_UNAVAILABLE';
  return err;
}

// Shared by setPairing and setPendingPair (fix round 1, Task 13 review): a
// record that will be persisted must already carry its private key sealed,
// never the raw key itself.
function assertSealedPairingRecord(record, methodName) {
  if (!record || typeof record !== 'object') throw new Error(`${methodName} needs a pairing record`);
  if (Object.prototype.hasOwnProperty.call(record, 'privateKey')) {
    throw new Error(`${methodName} refuses a record with a raw privateKey field; seal it first`);
  }
  if (typeof record.privateKeySealed !== 'string' || !record.privateKeySealed) {
    throw new Error(`${methodName} needs a sealed privateKeySealed field`);
  }
}

function openDesktopState(userDataDir, safeStorage, { storeFactory = null, platform = process.platform } = {}) {
  const make = storeFactory || defaultStoreFactory();
  const store = make({
    name: 'desktop-bridge',
    cwd: userDataDir,
    defaults: { mode: 'standalone', installId: null, pairing: null, pendingPair: null, lastImport: null }
  });
  if (!store.get('installId')) store.set('installId', crypto.randomUUID());
  const usable = () => secureStorageUsable(safeStorage, platform);
  return {
    get mode() {
      const mode = store.get('mode');
      return MODES.includes(mode) ? mode : 'standalone';
    },
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
      store.set('mode', mode);
    },
    get installId() { return store.get('installId'); },
    get pairing() { return store.get('pairing') || null; },
    setPairing(pairing) {
      assertSealedPairingRecord(pairing, 'setPairing');
      store.set('pairing', pairing);
    },
    clearPairing() { store.set('pairing', null); },
    get pendingPair() { return store.get('pendingPair') || null; },
    setPendingPair(pending) {
      if (pending === null) { store.set('pendingPair', null); return; }
      assertSealedPairingRecord(pending, 'setPendingPair');
      store.set('pendingPair', pending);
    },
    get lastImport() { return store.get('lastImport') || null; },
    setLastImport(entry) { store.set('lastImport', entry); },
    secureStorageUsable: usable,
    seal(text) {
      if (!usable()) throw unavailable();
      if (typeof text !== 'string') throw new Error('seal() needs a string');
      return safeStorage.encryptString(text).toString('base64');
    },
    unseal(sealedText) {
      if (!usable()) throw unavailable();
      return safeStorage.decryptString(Buffer.from(sealedText, 'base64'));
    }
  };
}

module.exports = { openDesktopState, secureStorageUsable, MODES };

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  MeshIdentity,
  saveIdentity,
  loadIdentity,
  IDENTITY_STORE_KEY,
  LEGACY_ENCRYPTED_KEY
} = require('../src/mesh/mesh-identity');
const { createAesGcmCipher } = require('../src/platform/cipher');

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (key, fallback) => (key in data ? data[key] : fallback),
    set: (key, value) => { data[key] = value; },
    has: (key) => key in data,
    delete: (key) => { delete data[key]; }
  };
}

function makeCipher() {
  return createAesGcmCipher(crypto.randomBytes(32));
}

const unavailableCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('Secure storage is not available on this system.'); },
  decryptString: () => { throw new Error('Secure storage is not available on this system.'); }
};

describe('mesh identity at rest', () => {
  it('writes no private key material in the clear', () => {
    const store = makeStore();
    const cipher = makeCipher();
    const identity = new MeshIdentity({ displayName: 'peer-a' });

    saveIdentity(store, identity, cipher);

    const record = JSON.stringify(store.data[IDENTITY_STORE_KEY]);
    assert.ok(!record.includes(identity.privateKey.toString('hex')), 'ed25519 private key is in the clear');
    assert.ok(!/PRIVATE KEY/.test(record), 'TLS private key PEM is in the clear');
    assert.ok(record.includes(identity.publicKey.toString('hex')), 'the public key should still be readable');
  });

  it('reads the encrypted key back into a working identity', () => {
    const store = makeStore();
    const cipher = makeCipher();
    const identity = new MeshIdentity({ displayName: 'peer-a', capabilities: ['chat'] });
    saveIdentity(store, identity, cipher);

    const restored = loadIdentity(store, cipher);

    assert.strictEqual(restored.peerId, identity.peerId);
    assert.strictEqual(restored.tlsKey, identity.tlsKey);
    assert.strictEqual(restored.tlsFingerprint, identity.tlsFingerprint);
    const signature = restored.sign('hello');
    assert.ok(MeshIdentity.verify('hello', signature, identity.publicKey));
  });

  it('upgrades a plaintext identity already on disk, in place, without changing the peer id', () => {
    const cipher = makeCipher();
    const identity = new MeshIdentity({ displayName: 'legacy-peer' });
    // Exactly what the old code wrote: a plaintext record plus an orphan
    // ciphertext under a key nothing ever read.
    const store = makeStore({
      [IDENTITY_STORE_KEY]: identity.serialize(),
      [LEGACY_ENCRYPTED_KEY]: cipher.encryptString(identity.privateKey.toString('hex'))
    });

    const restored = loadIdentity(store, cipher);

    assert.strictEqual(restored.peerId, identity.peerId, 'the mesh identity must survive the upgrade');
    assert.strictEqual(restored.tlsFingerprint, identity.tlsFingerprint);
    const record = JSON.stringify(store.data[IDENTITY_STORE_KEY]);
    assert.ok(!record.includes(identity.privateKey.toString('hex')), 'plaintext key left on disk after upgrade');
    assert.ok(!/PRIVATE KEY/.test(record), 'plaintext TLS key left on disk after upgrade');
    assert.strictEqual(store.data[LEGACY_ENCRYPTED_KEY], undefined, 'the orphan ciphertext should be removed');

    // And the upgraded record still loads.
    assert.strictEqual(loadIdentity(store, cipher).peerId, identity.peerId);
  });

  it('keeps working, with a warning, when no cipher is available', () => {
    const store = makeStore();
    const identity = new MeshIdentity({ displayName: 'no-cipher' });
    saveIdentity(store, identity, unavailableCipher);
    const restored = loadIdentity(store, unavailableCipher);
    assert.strictEqual(restored.peerId, identity.peerId);
  });

  it('refuses to load an identity whose key will not decrypt, rather than dropping the key', () => {
    const store = makeStore();
    saveIdentity(store, new MeshIdentity({ displayName: 'peer-a' }), makeCipher());
    assert.throws(() => loadIdentity(store, makeCipher()), /mesh private key/i);
  });

  it('returns null when there is nothing stored', () => {
    assert.strictEqual(loadIdentity(makeStore(), makeCipher()), null);
  });
});

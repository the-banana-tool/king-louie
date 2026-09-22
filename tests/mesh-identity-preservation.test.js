// An existing mesh identity must survive a host whose cipher is unavailable or
// broken. Minting a fresh keypair over a stored-but-unreadable record destroys
// the peer id and every pinned pairing, and (with no cipher) rewrites the key in
// the clear. `initializeMesh` must fail loudly and leave the record untouched.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { initializeMesh } = require('../src/mesh');
const {
  MeshIdentity,
  saveIdentity,
  IDENTITY_STORE_KEY
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

const unavailableCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('Secure storage is not available on this system.'); },
  decryptString: () => { throw new Error('Secure storage is not available on this system.'); }
};

async function initAndShutdown(config) {
  const mesh = await initializeMesh(config);
  if (mesh) await mesh.shutdown();
  return mesh;
}

describe('initializeMesh identity preservation', () => {
  it('refuses to start, and leaves the record alone, when the cipher is unavailable', async () => {
    process.env.KL_TEST_MODE = '1';
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const store = makeStore();

    const first = await initAndShutdown({ store, cipher, settings: { mesh: {} } });
    const originalPeerId = first.identity.peerId;
    const originalRecord = JSON.stringify(store.data[IDENTITY_STORE_KEY]);

    await assert.rejects(
      () => initAndShutdown({ store, cipher: unavailableCipher, settings: { mesh: {} } }),
      /mesh private key/i,
      'a cipher failure must not be swallowed'
    );

    assert.strictEqual(
      JSON.stringify(store.data[IDENTITY_STORE_KEY]),
      originalRecord,
      'the stored identity must not be overwritten'
    );

    // And the identity is still there once the cipher comes back.
    const third = await initAndShutdown({ store, cipher, settings: { mesh: {} } });
    assert.strictEqual(third.identity.peerId, originalPeerId);
  });

  it('refuses to start when the stored key will not decrypt', async () => {
    process.env.KL_TEST_MODE = '1';
    const store = makeStore();
    saveIdentity(store, new MeshIdentity({ displayName: 'peer-a' }), createAesGcmCipher(crypto.randomBytes(32)));
    const before = JSON.stringify(store.data[IDENTITY_STORE_KEY]);

    await assert.rejects(
      () => initAndShutdown({ store, cipher: createAesGcmCipher(crypto.randomBytes(32)), settings: { mesh: {} } }),
      /mesh private key/i
    );
    assert.strictEqual(JSON.stringify(store.data[IDENTITY_STORE_KEY]), before);
  });

  it('refuses to mint over a half-written record that has lost its private key', async () => {
    process.env.KL_TEST_MODE = '1';
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const identity = new MeshIdentity({ displayName: 'half' });
    const store = makeStore();
    saveIdentity(store, identity, cipher);
    // A record that carries the encrypted shape but lost its marker: before the
    // fix `MeshIdentity.deserialize` silently generated a brand-new keypair.
    const record = { ...store.data[IDENTITY_STORE_KEY] };
    delete record.keyEncryption;
    store.set(IDENTITY_STORE_KEY, record);
    const before = JSON.stringify(store.data[IDENTITY_STORE_KEY]);

    await assert.rejects(
      () => initAndShutdown({ store, cipher, settings: { mesh: {} } }),
      /private key/i
    );
    assert.strictEqual(JSON.stringify(store.data[IDENTITY_STORE_KEY]), before);
  });

  it('still mints a new identity when nothing is stored', async () => {
    process.env.KL_TEST_MODE = '1';
    const store = makeStore();
    const mesh = await initAndShutdown({ store, cipher: unavailableCipher, settings: { mesh: {} } });
    assert.ok(mesh.identity.peerId.startsWith('kl-'));
    assert.ok(store.data[IDENTITY_STORE_KEY]);
  });
});

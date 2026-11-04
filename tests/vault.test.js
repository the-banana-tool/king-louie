const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createVault, VAULT_PREFIX } = require('../src/platform/vault');
const { createAesGcmCipher } = require('../src/platform/cipher');

function memoryStore() {
  const data = {};
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    has: (k) => k in data,
    delete: (k) => { delete data[k]; },
    get store() { return { ...data }; },
    _data: data
  };
}

describe('vault', () => {
  it('stores ciphertext under the legacy prefix and lists bare keys', () => {
    const store = memoryStore();
    store.set('unrelated', 1);
    const vault = createVault({ store, cipher: createAesGcmCipher(crypto.randomBytes(32)) });
    vault.set('api_key', 'hunter2');
    assert.ok(store._data[`${VAULT_PREFIX}api_key`].startsWith('klc1:'));
    assert.strictEqual(vault.get('api_key'), 'hunter2');
    assert.deepStrictEqual(vault.list(), ['api_key']);
    assert.strictEqual(vault.has('api_key'), true);
    assert.strictEqual(vault.delete('api_key'), true);
    assert.strictEqual(vault.delete('api_key'), false);
    assert.strictEqual(vault.get('api_key'), null);
  });
});

describe('a vault name is read by own properties only', () => {
  const { JsonFileStore } = require('../src/platform/json-file-store');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cipher = { encryptString: (s) => `E:${s}`, decryptString: (s) => s.slice(2) };
  const realVault = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-vault-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new JsonFileStore({ dir, name: 'config' });
    return { dir, store, vault: createVault({ store, cipher }) };
  };

  it('x.toString over a branch reaches nothing', () => {
    const { vault } = realVault();
    vault.set('x.example.com', 'one');
    for (const name of ['x.toString', 'x.constructor', 'x.__proto__', 'x.example.hasOwnProperty']) {
      assert.strictEqual(vault.holds(name), false, name);
      assert.strictEqual(vault.has(name), false, name);
      assert.strictEqual(vault.get(name), null, name);
    }
    assert.strictEqual(vault.get('x.example.com'), 'one');
    assert.strictEqual(vault.has('x.example'), true, 'a name with entries under it is still there');
    assert.strictEqual(vault.holds('x.example'), false);
    assert.strictEqual(vault.get('x.example'), null);
  });

  it('settings:vaultHeld answers the same', async () => {
    const { store, vault } = realVault();
    vault.set('x.example.com', 'one');
    const handlers = new Map();
    require('../src/ipc/settings-handlers').registerSettingsHandlers({ handle: (c, fn) => handlers.set(c, fn) }, { vaultStore: store, encryptToken: cipher.encryptString, decryptToken: cipher.decryptString });
    const answer = await handlers.get('settings:vaultHeld')({}, { keys: ['x.toString', 'x.example.com'] });
    assert.deepStrictEqual((answer.data || answer).held, ['x.example.com']);
  });
});

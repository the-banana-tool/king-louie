const { describe, it } = require('node:test');
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

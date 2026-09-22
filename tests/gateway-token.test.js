const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ensureGatewayToken } = require('../src/gateway/gateway-token');
const { createAesGcmCipher } = require('../src/platform/cipher');

function makeStore(initial = {}) {
  const data = { ...initial };
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

describe('ensureGatewayToken', () => {
  it('creates once, stores ciphertext, writes a private token file', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const store = makeStore();
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const t1 = ensureGatewayToken({ store, cipher, dataDir });
    const t2 = ensureGatewayToken({ store, cipher, dataDir });
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.strictEqual(t1, t2);
    assert.ok(store.data['gateway.authToken'].startsWith('klc1:'));
    const file = path.join(dataDir, 'gateway-token');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), t1);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o077, 0);
  });

  it('falls back to a session-only token when secure storage is unavailable', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const store = makeStore();
    const cipher = {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('Secure storage is not available on this system.'); },
      decryptString: () => { throw new Error('Secure storage is not available on this system.'); }
    };

    const token = ensureGatewayToken({ store, cipher, dataDir });

    assert.match(token, /^[0-9a-f]{64}$/);
    assert.strictEqual(store.data['gateway.authToken'], undefined);
    const file = path.join(dataDir, 'gateway-token');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), token);
  });

  it('generates a new token when the stored ciphertext fails to decrypt', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const store = makeStore({ 'gateway.authToken': 'not-valid-ciphertext' });
    const cipher = createAesGcmCipher(crypto.randomBytes(32));

    const token = ensureGatewayToken({ store, cipher, dataDir });

    assert.match(token, /^[0-9a-f]{64}$/);
    assert.ok(store.data['gateway.authToken'].startsWith('klc1:'));
    assert.notStrictEqual(store.data['gateway.authToken'], 'not-valid-ciphertext');
  });

  it('replaces a pre-existing world-readable token file with mode 0600', { skip: process.platform === 'win32' }, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const file = path.join(dataDir, 'gateway-token');
    fs.writeFileSync(file, 'stale-token', { mode: 0o644 });
    assert.notStrictEqual(fs.statSync(file).mode & 0o777, 0o600);

    const store = makeStore();
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const token = ensureGatewayToken({ store, cipher, dataDir });

    assert.strictEqual(fs.readFileSync(file, 'utf8'), token);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });
});

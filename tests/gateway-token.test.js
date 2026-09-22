const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ensureGatewayToken, publishGatewayToken, revokeGatewayToken } = require('../src/gateway/gateway-token');
const { createAesGcmCipher } = require('../src/platform/cipher');

function makeStore(initial = {}) {
  const data = { ...initial };
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

describe('ensureGatewayToken', () => {
  it('creates once and stores ciphertext, without touching the disk', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const store = makeStore();
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const t1 = ensureGatewayToken({ store, cipher, dataDir });
    const t2 = ensureGatewayToken({ store, cipher, dataDir });
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.strictEqual(t1, t2);
    assert.ok(store.data['gateway.authToken'].startsWith('klc1:'));
    // The bearer token reaches the disk only once a listener is actually bound.
    assert.deepStrictEqual(fs.readdirSync(dataDir), []);
  });

  it('publishes and revokes the token file on demand', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const file = path.join(dataDir, 'gateway-token');

    publishGatewayToken(dataDir, 'a-token');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'a-token');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o077, 0);

    revokeGatewayToken(dataDir);
    assert.strictEqual(fs.existsSync(file), false);
    // Revoking twice is not an error.
    revokeGatewayToken(dataDir);
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
    publishGatewayToken(dataDir, token);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'gateway-token'), 'utf8'), token);
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
    publishGatewayToken(dataDir, token);

    assert.strictEqual(fs.readFileSync(file, 'utf8'), token);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });
});

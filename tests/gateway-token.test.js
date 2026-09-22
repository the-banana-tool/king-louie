const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ensureGatewayToken } = require('../src/gateway/gateway-token');
const { createAesGcmCipher } = require('../src/platform/cipher');

describe('ensureGatewayToken', () => {
  it('creates once, stores ciphertext, writes a private token file', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gw-'));
    const data = {};
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const t1 = ensureGatewayToken({ store, cipher, dataDir });
    const t2 = ensureGatewayToken({ store, cipher, dataDir });
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.strictEqual(t1, t2);
    assert.ok(data['gateway.authToken'].startsWith('klc1:'));
    const file = path.join(dataDir, 'gateway-token');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), t1);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o077, 0);
  });
});

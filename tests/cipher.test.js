const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createAesGcmCipher, createSafeStorageCipher, createUnavailableCipher } = require('../src/platform/cipher');

describe('AES-GCM cipher', () => {
  const key = crypto.randomBytes(32);

  it('round-trips and never repeats ciphertext', () => {
    const c = createAesGcmCipher(key);
    const a = c.encryptString('sk-secret');
    const b = c.encryptString('sk-secret');
    assert.notStrictEqual(a, b);
    assert.match(a, /^klc1:/);
    assert.strictEqual(c.decryptString(a), 'sk-secret');
    assert.strictEqual(c.isEncryptionAvailable(), true);
  });

  it('rejects tampering and wrong keys', () => {
    const c = createAesGcmCipher(key);
    const token = c.encryptString('x');
    const parts = token.split(':');
    const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 1; parts[3] = ct.toString('base64');
    assert.throws(() => c.decryptString(parts.join(':')));
    assert.throws(() => createAesGcmCipher(crypto.randomBytes(32)).decryptString(token));
  });

  it('rejects malformed input and bad keys', () => {
    assert.throws(() => createAesGcmCipher(Buffer.alloc(16)), /32-byte/);
    assert.throws(() => createAesGcmCipher(key).decryptString('nope'), /Unrecognized ciphertext/);
  });
});

describe('safeStorage cipher', () => {
  it('keeps the existing base64 on-disk format', () => {
    const fake = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc(${s})`),
      decryptString: (b) => b.toString().replace(/^enc\((.*)\)$/, '$1')
    };
    const c = createSafeStorageCipher(fake);
    const token = c.encryptString('abc');
    assert.strictEqual(token, Buffer.from('enc(abc)').toString('base64'));
    assert.strictEqual(c.decryptString(token), 'abc');
  });
});

describe('unavailable cipher', () => {
  it('throws the legacy message', () => {
    const c = createUnavailableCipher();
    assert.strictEqual(c.isEncryptionAvailable(), false);
    assert.throws(() => c.encryptString('x'), /Secure storage is not available on this system\./);
  });
});

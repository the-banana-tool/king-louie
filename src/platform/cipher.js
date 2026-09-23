const crypto = require('crypto');

const UNAVAILABLE = 'Secure storage is not available on this system.';
const AES_PREFIX = 'klc1';

function createAesGcmCipher(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error('masterKey must be a 32-byte Buffer');
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [AES_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
    },
    decryptString(token) {
      const parts = String(token || '').split(':');
      if (parts.length !== 4 || parts[0] !== AES_PREFIX) throw new Error('Unrecognized ciphertext format.');
      const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64')));
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    }
  };
}

function createSafeStorageCipher(safeStorage) {
  return {
    isEncryptionAvailable: () => Boolean(safeStorage && safeStorage.isEncryptionAvailable()),
    encryptString(plain) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(UNAVAILABLE);
      return safeStorage.encryptString(String(plain)).toString('base64');
    },
    decryptString(token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(UNAVAILABLE);
      return safeStorage.decryptString(Buffer.from(token, 'base64'));
    }
  };
}

function createUnavailableCipher() {
  const fail = () => { throw new Error(UNAVAILABLE); };
  return { isEncryptionAvailable: () => false, encryptString: fail, decryptString: fail };
}

module.exports = { createAesGcmCipher, createSafeStorageCipher, createUnavailableCipher };

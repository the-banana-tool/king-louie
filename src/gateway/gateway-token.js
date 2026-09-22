const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('gateway-token');

const STORE_KEY = 'gateway.authToken';

function ensureGatewayToken({ store, cipher, dataDir }) {
  let token = null;

  const stored = store.get(STORE_KEY);
  if (stored) {
    try {
      token = cipher.decryptString(stored);
    } catch {
      log.warn('gateway token could not be decrypted; generated a new one');
      token = null;
    }
  }

  if (!token) {
    token = crypto.randomBytes(32).toString('hex');

    const encryptionAvailable = !cipher.isEncryptionAvailable || cipher.isEncryptionAvailable();
    let persisted = false;
    if (encryptionAvailable) {
      try {
        store.set(STORE_KEY, cipher.encryptString(token));
        persisted = true;
      } catch {
        persisted = false;
      }
    }

    if (!persisted) {
      log.warn('secure storage unavailable; gateway token is session-only and will not persist across restarts');
    }
  }

  writeTokenFile(dataDir, token);

  return token;
}

function writeTokenFile(dataDir, token) {
  const file = path.join(dataDir, 'gateway-token');
  const tmpFile = path.join(dataDir, `.gateway-token.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpFile, token, { mode: 0o600 });
    fs.renameSync(tmpFile, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } catch (err) {
    log.warn(`failed to write gateway token file: ${err.message}`);
    try { fs.unlinkSync(tmpFile); } catch { /* best effort cleanup */ }
  }
}

module.exports = { ensureGatewayToken, STORE_KEY };

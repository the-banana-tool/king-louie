const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('gateway-token');

const STORE_KEY = 'gateway.authToken';
const TOKEN_FILE = 'gateway-token';

// Mints (or recovers) the gateway bearer token and keeps it encrypted in the
// store. It deliberately does NOT write the plaintext token file: that happens
// in publishGatewayToken, once a listener is actually bound, so a failed start
// cannot leave a valid credential on disk for a port nothing is serving.
function ensureGatewayToken({ store, cipher }) {
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

  return token;
}

function publishGatewayToken(dataDir, token) {
  if (!dataDir || !token) return false;
  const file = path.join(dataDir, TOKEN_FILE);
  const tmpFile = path.join(dataDir, `.gateway-token.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpFile, token, { mode: 0o600 });
    fs.renameSync(tmpFile, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    return true;
  } catch (err) {
    log.warn(`failed to write gateway token file: ${err.message}`);
    try { fs.unlinkSync(tmpFile); } catch { /* best effort cleanup */ }
    return false;
  }
}

// The token file is only meaningful while the listener is up.
function revokeGatewayToken(dataDir) {
  if (!dataDir) return;
  try {
    fs.unlinkSync(path.join(dataDir, TOKEN_FILE));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`failed to remove gateway token file: ${err.message}`);
  }
}

module.exports = { ensureGatewayToken, publishGatewayToken, revokeGatewayToken, STORE_KEY, TOKEN_FILE };

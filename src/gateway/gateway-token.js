const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_KEY = 'gateway.authToken';

function ensureGatewayToken({ store, cipher, dataDir }) {
  let token = null;
  const stored = store.get(STORE_KEY);
  if (stored) {
    try { token = cipher.decryptString(stored); } catch { token = null; }
  }
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    store.set(STORE_KEY, cipher.encryptString(token));
  }
  const file = path.join(dataDir, 'gateway-token');
  fs.writeFileSync(file, token, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return token;
}

module.exports = { ensureGatewayToken, STORE_KEY };

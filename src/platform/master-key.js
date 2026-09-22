// The service host encrypts secrets with one AES-256-GCM master key. The key
// itself is protected by the OS: a systemd credential (Linux), DPAPI in the
// service account's scope (Windows), or a 0600 file owned by the service
// account (macOS / Linux without systemd credentials).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MASTER_KEY_CREDENTIAL = 'kl-master-key';
const KEY_BYTES = 32;

function parseHexKey(text, origin) {
  const hex = String(text).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${origin} is not a 64-character hex key`);
  return Buffer.from(hex, 'hex');
}

function fromSystemdCredential(env) {
  if (!env.CREDENTIALS_DIRECTORY) return null;
  const file = path.join(env.CREDENTIALS_DIRECTORY, MASTER_KEY_CREDENTIAL);
  if (!fs.existsSync(file)) return null;
  return parseHexKey(fs.readFileSync(file, 'utf8'), `systemd credential ${MASTER_KEY_CREDENTIAL}`);
}

function fromDpapiFile(dataDir, dpapi) {
  const file = path.join(dataDir, 'master.key.dpapi');
  if (fs.existsSync(file)) return dpapi.unprotect(fs.readFileSync(file));
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, dpapi.protect(key), { flag: 'wx' });
  return key;
}

function fromKeyFile(dataDir) {
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) throw new Error(`${file} has permissions ${mode.toString(8)}; it must be 600`);
    return parseHexKey(fs.readFileSync(file, 'utf8'), file);
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return key;
}

function createPowerShellDpapi() {
  const run = (method, input) => {
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
      `$out = [System.Security.Cryptography.ProtectedData]::${method}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
      '[Console]::Out.Write([Convert]::ToBase64String($out))'
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: input.toString('base64'),
      windowsHide: true
    });
    return Buffer.from(out.toString().trim(), 'base64');
  };
  return { protect: (buf) => run('Protect', buf), unprotect: (buf) => run('Unprotect', buf) };
}

function resolveMasterKey({ platform = process.platform, dataDir, env = process.env, dpapi } = {}) {
  const fromCred = fromSystemdCredential(env);
  if (fromCred) return { key: fromCred, source: 'systemd-credential' };
  if (platform === 'win32') {
    return { key: fromDpapiFile(dataDir, dpapi || createPowerShellDpapi()), source: 'dpapi' };
  }
  return { key: fromKeyFile(dataDir), source: 'key-file' };
}

module.exports = { resolveMasterKey, createPowerShellDpapi, MASTER_KEY_CREDENTIAL };

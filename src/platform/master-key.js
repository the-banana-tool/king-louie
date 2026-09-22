// The service host encrypts secrets with one AES-256-GCM master key. The key
// itself is protected by the OS: a systemd credential (Linux), DPAPI in the
// LocalMachine scope inside the data dir's locked-down ACL (Windows), or a
// 0600 file owned by the service account (macOS / Linux without systemd
// credentials).
//
// Every resolution is checked against <dataDir>/key-check, so a process that
// resolves a different key than the one the data dir was encrypted with (an
// admin CLI running under the wrong identity, a lost credential) fails loudly
// instead of silently writing secrets nobody can read back.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createAesGcmCipher } = require('./cipher');
const { windowsPowerShellExe } = require('./windows-paths');

const MASTER_KEY_CREDENTIAL = 'kl-master-key';
// The root-only file the systemd unit's LoadCredential= reads.
const ROOT_CREDENTIAL_PATH = '/etc/king-louie/credentials/kl-master-key';
const KEY_BYTES = 32;
const KEY_CHECK_FILE = 'key-check';
const KEY_CHECK_PLAINTEXT = 'king-louie-key-check-v1';

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

// Root outside the unit (the admin CLI) reads the same file LoadCredential=
// hands the service, so both resolve the same key.
function fromRootCredentialFile({ platform, env, getuid, credentialPath }) {
  if (platform !== 'linux' || env.CREDENTIALS_DIRECTORY) return null;
  if (typeof getuid !== 'function' || getuid() !== 0) return null;
  if (!fs.existsSync(credentialPath)) return null;
  return parseHexKey(fs.readFileSync(credentialPath, 'utf8'), credentialPath);
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

// LocalMachine scope: any account on this machine could unprotect the blob,
// so what keeps master.key.dpapi private is the data dir's protected DACL
// (LOCAL SERVICE, SYSTEM and Administrators only). That is what lets an
// elevated admin CLI and the LOCAL SERVICE task resolve the same key.
function createPowerShellDpapi({ powershellExe = windowsPowerShellExe() } = {}) {
  const run = (method, input) => {
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
      `$out = [System.Security.Cryptography.ProtectedData]::${method}($in, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)`,
      '[Console]::Out.Write([Convert]::ToBase64String($out))'
    ].join('; ');
    const out = execFileSync(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: input.toString('base64'),
      windowsHide: true
    });
    return Buffer.from(out.toString().trim(), 'base64');
  };
  return { protect: (buf) => run('Protect', buf), unprotect: (buf) => run('Unprotect', buf) };
}

// First resolution in a data dir writes key-check; every later one must be
// able to decrypt it.
function verifyKeyCheck({ dataDir, key, source }) {
  const file = path.join(dataDir, KEY_CHECK_FILE);
  const cipher = createAesGcmCipher(key);
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, cipher.encryptString(KEY_CHECK_PLAINTEXT), { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Lost a race with another process creating it: verify theirs.
    }
  }
  let ok = false;
  try {
    ok = cipher.decryptString(fs.readFileSync(file, 'utf8').trim()) === KEY_CHECK_PLAINTEXT;
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `this data dir (${dataDir}) was encrypted with a different master key than the one resolved here `
      + `(source ${source}); run as the service account, or as root/an elevated Administrator for an `
      + 'installed service — see README "Service mode"'
    );
  }
}

function resolveMasterKeyUnchecked({ platform, dataDir, env, dpapi, getuid, credentialPath }) {
  const fromCred = fromSystemdCredential(env);
  if (fromCred) return { key: fromCred, source: 'systemd-credential' };
  const fromRootCred = fromRootCredentialFile({ platform, env, getuid, credentialPath });
  if (fromRootCred) return { key: fromRootCred, source: 'credential-file' };
  if (platform === 'win32') {
    return { key: fromDpapiFile(dataDir, dpapi || createPowerShellDpapi()), source: 'dpapi' };
  }
  return { key: fromKeyFile(dataDir), source: 'key-file' };
}

function resolveMasterKey({
  platform = process.platform,
  dataDir,
  env = process.env,
  dpapi,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  credentialPath = ROOT_CREDENTIAL_PATH
} = {}) {
  const resolved = resolveMasterKeyUnchecked({ platform, dataDir, env, dpapi, getuid, credentialPath });
  verifyKeyCheck({ dataDir, key: resolved.key, source: resolved.source });
  return resolved;
}

module.exports = {
  resolveMasterKey,
  createPowerShellDpapi,
  MASTER_KEY_CREDENTIAL,
  ROOT_CREDENTIAL_PATH,
  KEY_CHECK_FILE
};

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
const { adminCredentialPath } = require('./paths');
const { createLogger } = require('../logging');

const log = createLogger('master-key');

const MASTER_KEY_CREDENTIAL = 'kl-master-key';
// The root-only file the systemd unit's LoadCredential= reads, for the default
// Linux layout. An instance on a non-default data dir gets its own, beside its
// own admin config dir — see adminCredentialPath.
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

function fromDpapiFile(dataDir, dpapi, onPath) {
  const file = path.join(dataDir, 'master.key.dpapi');
  if (fs.existsSync(file)) return dpapi.unprotect(fs.readFileSync(file));
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, dpapi.protect(key), { flag: 'wx' });
  onPath(file);
  return key;
}

// Creates `file` exclusively with `content` and pins it to 0600.
//
// 'wx' (O_CREAT|O_EXCL) refuses to follow a symlink and refuses an existing
// file, which is what keeps a root-run admin CLI from being steered by a name
// the service account planted in its own data dir. The mode is then pinned on
// that same descriptor: a path-based chmod after the write re-resolves the
// name, and can be raced (unlink + symlink) into chmodding something else.
// Throws EEXIST to the caller, which decides what a lost race means.
function writePrivateFileExclusive(file, content) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

function readPrivateKeyFile(file) {
  if (!fs.existsSync(file)) return null;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} has permissions ${mode.toString(8)}; it must be 600`);
  return parseHexKey(fs.readFileSync(file, 'utf8'), file);
}

// Where a POSIX host without a systemd credential keeps its key.
//
// It used to be <dataDir>/master.key — inside the very directory the key
// encrypts. A Time Machine backup, a snapshot or a `tar` of the data dir then
// carried both halves, which is strictly weaker than the Electron host's
// Keychain on the same machine, and weaker than Linux-with-systemd. The key
// now goes in the admin-owned config dir the installers create: the service
// account can read it, but the directory is root-owned, so the account cannot
// replace the key, and a copy of the data dir alone does not decrypt.
//
// Order matters. A key already in the data dir wins, because minting a second
// one would fail the key check and lock the operator out of their own store;
// it is used and the log says where to move it. Minting only ever goes to the
// admin location when that directory already exists — no installer, no
// directory, and the data dir stays the fallback, loudly.
function fromPosixKeyFile({ dataDir, credentialPath, onPath }) {
  const dataDirKey = path.join(dataDir, 'master.key');

  const legacy = readPrivateKeyFile(dataDirKey);
  if (legacy) {
    log.warn(
      `the master key is inside the directory it protects (${dataDirKey}); a backup or snapshot of the `
      + `data dir carries both halves. Stop the service, move the file to ${credentialPath} (root-owned `
      + 'directory, 0600), and start it again.'
    );
    return { key: legacy, source: 'key-file' };
  }

  const admin = readPrivateKeyFile(credentialPath);
  if (admin) return { key: admin, source: 'credential-file' };

  const key = crypto.randomBytes(KEY_BYTES);
  if (fs.existsSync(path.dirname(credentialPath))) {
    try {
      writePrivateFileExclusive(credentialPath, key.toString('hex'));
      return { key, source: 'credential-file' };
    } catch (err) {
      // Lost a race with another process: use whatever it wrote.
      if (err.code === 'EEXIST') return { key: readPrivateKeyFile(credentialPath), source: 'credential-file' };
      if (!['EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw err;
      log.warn(`cannot write the master key to ${credentialPath} (${err.code}); falling back to the data dir`);
    }
  }

  log.warn(
    `no admin-owned key location at ${path.dirname(credentialPath)}, so the master key is being written to `
    + `${dataDirKey} — inside the directory it protects. A backup or snapshot of the data dir will carry `
    + 'both halves. Install the service so the config dir exists, or create that directory root-owned.'
  );
  writePrivateFileExclusive(dataDirKey, key.toString('hex'));
  onPath(dataDirKey);
  return { key, source: 'key-file' };
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
// able to decrypt it. `create: false` never writes: a missing key-check is
// refused instead (the admin import's writer, Task 9 fix round 2, N1, must
// not seal a data dir the service has never opened).
function verifyKeyCheck({ dataDir, key, source, onPath = () => {}, create = true }) {
  const file = path.join(dataDir, KEY_CHECK_FILE);
  const cipher = createAesGcmCipher(key);
  // One existence check, with the refusal nested under it: two separate
  // checks let a file removed between them reach the create branch even
  // with create: false.
  if (!fs.existsSync(file)) {
    if (!create) {
      throw new Error(`${file} does not exist; start the service once first so it sets up its data dir`);
    }
    try {
      writePrivateFileExclusive(file, cipher.encryptString(KEY_CHECK_PLAINTEXT));
      onPath(file);
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

function resolveMasterKeyUnchecked({ platform, dataDir, env, dpapi, getuid, credentialPath, onPath }) {
  const fromCred = fromSystemdCredential(env);
  if (fromCred) return { key: fromCred, source: 'systemd-credential' };
  const fromRootCred = fromRootCredentialFile({ platform, env, getuid, credentialPath });
  if (fromRootCred) return { key: fromRootCred, source: 'credential-file' };
  if (platform === 'win32') {
    return { key: fromDpapiFile(dataDir, dpapi || createPowerShellDpapi(), onPath), source: 'dpapi' };
  }
  return fromPosixKeyFile({ dataDir, credentialPath, onPath });
}

function resolveMasterKey({
  platform = process.platform,
  dataDir,
  env = process.env,
  dpapi,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  credentialPath = adminCredentialPath({ platform, dataDir }),
  // Told about each file this created in the data dir (the key file, the
  // key-check), so a root admin CLI can hand exactly those back to the data
  // dir's owner — see src/service/ownership.js. Files it only read are not
  // reported: they were not created by this run.
  onPath = () => {}
} = {}) {
  const resolved = resolveMasterKeyUnchecked({ platform, dataDir, env, dpapi, getuid, credentialPath, onPath });
  verifyKeyCheck({ dataDir, key: resolved.key, source: resolved.source, onPath });
  return resolved;
}

// Reads one key file without following a link at its last component and
// without trusting a swapped file: a regular file with one link, owned by
// `expectUid` when given, opened O_NOFOLLOW where the platform has it and
// checked to be the inode that was lstatted. A missing file is null.
function readKeyFileStrict(file, { expectUid = null, checkMode = process.platform !== 'win32' } = {}) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) throw new Error(`${file} is a link; refusing to read a master key through it`);
  if (!st.isFile() || st.nlink > 1) throw new Error(`${file} is not a plain file with a single link`);
  if (expectUid !== null && st.uid !== expectUid) throw new Error(`${file} is owned by uid ${st.uid}, not ${expectUid}`);
  if (checkMode && (st.mode & 0o077)) throw new Error(`${file} has permissions ${(st.mode & 0o777).toString(8)}; it must be 600`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const now = fs.fstatSync(fd);
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev || now.nlink > 1) throw new Error(`${file} changed while it was being read`);
    if (now.size > 4096) throw new Error(`${file} is too large to be a master key`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// The admin import's resolution (Task 9 fix round 2, N1): the same sources in
// the same order as resolveMasterKey, but it never creates a key, never
// writes a file and never touches key-check. Null when no key exists yet.
// Files inside the data dir are read with readKeyFileStrict, because the
// service account controls every name there: a planted link must not make a
// root process read someone else's key and hand it over.
function resolveMasterKeyReadOnly({
  platform = process.platform,
  dataDir,
  env = process.env,
  dpapi,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  credentialPath = adminCredentialPath({ platform, dataDir }),
  dataDirOwnerUid = null,
  checkMode = process.platform !== 'win32'
} = {}) {
  const fromCred = fromSystemdCredential(env);
  if (fromCred) return { key: fromCred, source: 'systemd-credential' };
  const fromRootCred = fromRootCredentialFile({ platform, env, getuid, credentialPath });
  if (fromRootCred) return { key: fromRootCred, source: 'credential-file' };
  if (platform === 'win32') {
    const blob = readKeyFileStrict(path.join(dataDir, 'master.key.dpapi'), { checkMode: false });
    if (!blob) return null;
    return { key: (dpapi || createPowerShellDpapi()).unprotect(blob), source: 'dpapi' };
  }
  const dataDirKey = path.join(dataDir, 'master.key');
  const legacy = readKeyFileStrict(dataDirKey, { expectUid: dataDirOwnerUid, checkMode });
  if (legacy) return { key: parseHexKey(legacy.toString('utf8'), dataDirKey), source: 'key-file' };
  const admin = readKeyFileStrict(credentialPath, { checkMode });
  if (admin) return { key: parseHexKey(admin.toString('utf8'), credentialPath), source: 'credential-file' };
  return null;
}

module.exports = {
  resolveMasterKey,
  resolveMasterKeyReadOnly,
  verifyKeyCheck,
  createPowerShellDpapi,
  MASTER_KEY_CREDENTIAL,
  ROOT_CREDENTIAL_PATH,
  KEY_CHECK_FILE
};

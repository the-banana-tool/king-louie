const fs = require('fs');
const path = require('path');

// On Windows and macOS the data dir is a `data` subdir of the KingLouie dir,
// leaving room beside it for stage 2's root/admin-owned, read-only config
// dir. Linux keeps that config under /etc/king-louie instead.
function defaultServiceDataDir({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'KingLouie', 'data');
  if (platform === 'darwin') return '/Library/Application Support/KingLouie/data';
  return '/var/lib/king-louie';
}

// Creates `dir` 0700 and pins it to 0700 if it already existed.
//
// This runs as root from the admin CLI (`token set` / `vault set`), and
// logs/ and cache/ sit inside a data dir the *service account* owns. A
// recursive mkdir treats a symlink-to-a-directory as "already there" and
// returns without throwing; a path-based chmod then follows that symlink, so
// root would apply 0700 to whatever the service account pointed it at —
// `chmod 0700 /etc` or `/usr` locks every other account out of the machine.
// So the mode is applied to a descriptor opened with O_NOFOLLOW, and a
// symlink is refused outright rather than repaired.
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // O_NOFOLLOW on a symlink is ELOOP everywhere Node runs; ENOTDIR means
    // the name is something other than a directory.
    if (err.code === 'ELOOP' || err.code === 'ENOTDIR') {
      throw new Error(`Refusing to use ${dir}: it is a symlink or not a directory`);
    }
    throw err;
  }
  try {
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

// The root/admin-owned, service-read-only configuration directory that sits
// beside the data dir. Everything security-relevant (which listeners are on,
// which ports they use) is read from here rather than from the data dir,
// which is owned by the service account itself. The installers create it:
// /etc/king-louie for the default Linux layout (root-owned 0755),
// …/KingLouie/config on macOS (root-owned 0755) and
// %ProgramData%\KingLouie\config on Windows (inside a parent whose protected
// DACL grants LOCAL SERVICE read and execute only).
//
// It is derived *per instance*, because a config dir shared between instances
// is a config dir that cannot hold per-instance ports: Linux used to return
// the literal /etc/king-louie whatever --data-dir said, so a second service on
// the box inherited the first one's ports, failed to bind, and — since a
// failed bind of an explicitly enabled listener is fatal — refused to start.
// The security property is unchanged: whatever this resolves to, the installer
// creates it root-owned and `assertAdminOwned` refuses to read a file the
// service account owns or could write.
function adminConfigDir({ platform = process.platform, dataDir } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const dirname = platform === 'win32' ? path.win32.dirname : path.posix.dirname;
  if (platform === 'linux') {
    // Resolve before comparing, so "/var/lib/../lib/king-louie" is recognised
    // as the default layout rather than deriving "/var/lib/config" from it.
    const resolved = dataDir ? path.posix.resolve(dataDir) : null;
    if (!resolved || resolved === defaultServiceDataDir({ platform: 'linux' })) return '/etc/king-louie';
    return join(dirname(resolved), 'config');
  }
  return join(dirname(dataDir), 'config');
}

// The root-only file the systemd unit's LoadCredential= reads, and that a
// root-run admin CLI reads directly so both resolve the same master key.
// Derived from the config dir so two instances do not share one key.
function adminCredentialPath({ platform = process.platform, dataDir } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(adminConfigDir({ platform, dataDir }), 'credentials', 'kl-master-key');
}

// `onPath` is told about every directory this ensured, so a root admin CLI can
// hand exactly those back to the data dir's owner afterwards instead of
// walking the tree looking for root-owned entries (src/service/ownership.js).
function ensureServicePaths(dataDir, { onPath = null } = {}) {
  const paths = {
    dataDir,
    logsDir: path.join(dataDir, 'logs'),
    cacheDir: path.join(dataDir, 'cache')
  };
  for (const dir of Object.values(paths)) {
    ensurePrivateDir(dir);
    if (onPath) onPath(dir);
  }
  return paths;
}

module.exports = {
  defaultServiceDataDir,
  adminConfigDir,
  adminCredentialPath,
  ensureServicePaths,
  ensurePrivateDir
};

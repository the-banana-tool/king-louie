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

module.exports = { defaultServiceDataDir, ensureServicePaths, ensurePrivateDir };

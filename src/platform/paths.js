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

// Every path component of `target`, from the filesystem root down to and
// including `target` itself.
function pathComponents(target) {
  const { root } = path.parse(target);
  const parts = target.slice(root.length).split(/[\\/]+/).filter(Boolean);
  const out = [root];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    out.push(current);
  }
  return out;
}

// A symlink (or Windows reparse point) among the ancestors is only as
// trustworthy as whoever could have planted it. Root and the account running
// this process are the two principals already trusted with this path, so a
// link either of them owns is taken as deliberate — that is what keeps macOS's
// own `/var -> private/var` and `/tmp -> private/tmp` working. A link anyone
// else owns is refused.
//
// Windows has no cheap equivalent here (the owner SID and the DACL would both
// have to be read through a handle opened FILE_FLAG_OPEN_REPARSE_POINT, which
// is what the installer does), so a reparse point in the path is refused
// outright and the operator is told to name the resolved path instead.
function assertLinkIsDeliberate(link, st, euid) {
  if (process.platform === 'win32') {
    throw new Error(
      `Refusing to use ${link}: it is a junction or symlink, so the directory created under it would not be `
      + 'the one named here. Pass the resolved path instead.'
    );
  }
  if (euid >= 0 && st.uid !== 0 && st.uid !== euid) {
    throw new Error(
      `Refusing to use ${link}: it is a symlink owned by uid ${st.uid}, which is neither root nor this `
      + `process (uid ${euid}). Whoever owns it chooses where the data dir really lands.`
    );
  }
}

// Refuses a path whose ancestry anyone else could have aimed elsewhere, and
// returns the components still to be created.
//
// `mkdirSync(..., { recursive: true })` treats a symlink-to-a-directory as
// "already there" and follows it, so only the *final* component was ever
// checked: `--data-dir /tmp/kl/data` with a planted `/tmp/kl -> …` had root
// create the data dir — and the master key, key-check, gateway token and
// stores that go in it — inside a directory of someone else's choosing, and
// chmod 0700 through it. Verified in a container: ensurePrivateDir('/tmp/c5/kl/data')
// with `/tmp/c5/kl` a symlink resolved to /tmp/c5/attacker/data.
//
// This is a check, not a capability: Node has no openat(2), so between the
// lstat here and the mkdir below a component could still be swapped. The
// creation loop is non-recursive so such a swap surfaces as EEXIST on a name
// that is then re-validated, and the final mode is still applied through an
// O_NOFOLLOW descriptor rather than by path.
function assertUnplantedAncestry(target, euid, depth = 0) {
  if (depth > 32) throw new Error(`Refusing to use ${target}: too many symlinked ancestors`);

  const components = pathComponents(target);
  for (let i = 0; i < components.length; i += 1) {
    const entry = components[i];
    let st;
    try {
      // lstat, never existsSync: a dangling symlink reads as missing and would
      // then be "created" straight through.
      st = fs.lstatSync(entry);
    } catch (err) {
      // Missing, so nothing below it exists either: the rest is ours to make.
      if (err.code === 'ENOENT') return;
      throw err;
    }

    if (st.isSymbolicLink()) {
      // The entry itself is handled by the O_NOFOLLOW open in ensurePrivateDir
      // on POSIX; on Windows there is no such open, so refuse it here.
      if (i === components.length - 1) {
        throw new Error(`Refusing to use ${target}: it is a symlink or not a directory`);
      }
      assertLinkIsDeliberate(entry, st, euid);
      const rest = components.slice(i + 1).map((c) => path.basename(c));
      assertUnplantedAncestry(path.join(fs.realpathSync(entry), ...rest), euid, depth + 1);
      return;
    }

    if (!st.isDirectory()) {
      throw new Error(`Refusing to use ${target}: ${entry} exists and is not a directory`);
    }
  }
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
// symlink is refused outright rather than repaired. The ancestors above it get
// the same treatment in assertUnplantedAncestry, which is why the mkdir below
// is per component rather than recursive.
function ensurePrivateDir(dir) {
  const target = path.resolve(dir);
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1;

  assertUnplantedAncestry(target, euid);

  // Skips index 0, the filesystem root: mkdir on `/` or `C:\` is EEXIST at
  // best and EPERM at worst, and it is not ours to create.
  for (const entry of pathComponents(target).slice(1)) {
    try {
      fs.mkdirSync(entry, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Either it was already there (the common case) or it appeared between
      // the walk above and now. Either way it has to hold up to the same check.
      const st = fs.lstatSync(entry);
      if (st.isSymbolicLink()) {
        if (entry === target) throw new Error(`Refusing to use ${target}: it is a symlink or not a directory`);
        assertLinkIsDeliberate(entry, st, euid);
      } else if (!st.isDirectory()) {
        throw new Error(`Refusing to use ${target}: ${entry} exists and is not a directory`);
      }
    }
  }

  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // O_NOFOLLOW on a symlink is ELOOP everywhere Node runs; ENOTDIR means
    // the name is something other than a directory.
    if (err.code === 'ELOOP' || err.code === 'ENOTDIR') {
      throw new Error(`Refusing to use ${target}: it is a symlink or not a directory`);
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

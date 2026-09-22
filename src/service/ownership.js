// When the admin CLI runs as root against a service's data dir (token set,
// vault set), every file or dir it creates there — stores, master.key,
// key-check, logs/, cache/ — would be root-owned and unreadable by the
// service account. This hands them back to the data dir's owner.
const fs = require('fs');
const path = require('path');

const defaultGetuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

// Returns the paths it chowned. A no-op unless running as root (uid 0) on a
// data dir owned by someone else. Never follows symlinks: entries are lstat'd
// and lchown'd, and a symlinked dir is not descended into.
function restoreDataDirOwnership(dataDir, { getuid = defaultGetuid, fsImpl = fs } = {}) {
  if (getuid() !== 0) return [];
  let owner;
  try {
    owner = fsImpl.lstatSync(dataDir);
  } catch {
    return [];
  }
  if (!owner.isDirectory() || owner.uid === 0) return [];
  const { uid, gid } = owner;
  const changed = [];
  const walk = (dir) => {
    for (const name of fsImpl.readdirSync(dir)) {
      const entry = path.join(dir, name);
      const st = fsImpl.lstatSync(entry);
      if (st.uid === 0) {
        fsImpl.lchownSync(entry, uid, gid);
        changed.push(entry);
      }
      if (st.isDirectory()) walk(entry);
    }
  };
  walk(dataDir);
  return changed;
}

module.exports = { restoreDataDirOwnership };

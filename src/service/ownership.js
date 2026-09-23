// When the admin CLI runs as root against a service's data dir (token set,
// vault set), every file or dir it creates there — stores, master.key,
// key-check, logs/, cache/ — would be root-owned and unreadable by the
// service account. This hands them back to the data dir's owner.
//
// It hands back *only the paths this invocation actually created or wrote*,
// which the callers report as they go. It used to walk the whole data dir and
// lchown every root-owned entry, which the service account could turn into a
// privilege escalation: a hard link inside the data dir to a root-owned file
// elsewhere on the same volume got chowned to the service account, and a
// subdirectory swapped between the readdir and the lstat sent the walk
// somewhere it had no business going. There is no walk any more, listed
// paths are opened without following symlinks and checked for identity
// before the chown, and a multiply-linked file is never chowned at all.
//
// POSIX only in practice: it returns immediately unless getuid() is 0, and
// process.getuid does not exist on Windows.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const defaultLog = createLogger('service/ownership');
const defaultGetuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

// True when the fs implementation can do the open-then-fchown dance, which is
// the only way to be sure the thing chowned is the thing that was stat'd.
function canChownByDescriptor(fsImpl) {
  return typeof fsImpl.constants?.O_NOFOLLOW === 'number'
    && typeof fsImpl.openSync === 'function'
    && typeof fsImpl.fstatSync === 'function'
    && typeof fsImpl.fchownSync === 'function'
    && typeof fsImpl.closeSync === 'function';
}

function isForeignHardLink(st) {
  return !st.isDirectory() && Number(st.nlink) > 1;
}

// Chowns one path, or explains why it would not. Returns true if it chowned.
function chownOne(target, uid, gid, fsImpl, log) {
  let st;
  try {
    st = fsImpl.lstatSync(target);
  } catch {
    return false; // Written earlier this run, gone now: nothing to hand over.
  }
  if (st.uid !== 0) return false; // Already the service account's (or someone else's).
  if (isForeignHardLink(st)) {
    log.warn('hard-linked file: not ours to chown', { path: target, nlink: st.nlink });
    return false;
  }

  // O_NOFOLLOW refuses to open a symlink at all, so symlinks take the lchown
  // path below — which never follows one either.
  if (canChownByDescriptor(fsImpl) && !st.isSymbolicLink()) {
    const c = fsImpl.constants;
    let flags = (c.O_RDONLY || 0) | c.O_NOFOLLOW;
    if (st.isDirectory() && typeof c.O_DIRECTORY === 'number') flags |= c.O_DIRECTORY;

    let fd;
    try {
      fd = fsImpl.openSync(target, flags);
    } catch (err) {
      log.warn('could not open without following symlinks; leaving it root-owned', {
        path: target,
        code: err.code
      });
      return false;
    }
    try {
      const opened = fsImpl.fstatSync(fd);
      // Same inode as the one just stat'd, or the entry was replaced in the
      // window and this is somebody else's file.
      if (opened.ino !== st.ino || opened.dev !== st.dev) {
        log.warn('entry was replaced while being handed back; leaving it root-owned', { path: target });
        return false;
      }
      if (opened.uid !== 0) return false;
      if (isForeignHardLink(opened)) {
        log.warn('hard-linked file: not ours to chown', { path: target, nlink: opened.nlink });
        return false;
      }
      fsImpl.fchownSync(fd, uid, gid);
      return true;
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  try {
    fsImpl.lchownSync(target, uid, gid);
  } catch (err) {
    log.warn('could not hand a path back to the data dir owner', { path: target, code: err.code });
    return false;
  }
  // Without a descriptor the check can only happen afterwards. It cannot undo
  // a swap, but it makes one visible instead of silent.
  try {
    const after = fsImpl.lstatSync(target);
    if (after.ino !== st.ino || after.dev !== st.dev) {
      log.warn('entry was replaced while being handed back; it may now have the wrong owner', { path: target });
    }
  } catch {
    // Gone already: nothing left to verify.
  }
  return true;
}

// `createdPaths` is what this invocation created or wrote, reported by the
// code that wrote it. Returns the paths it actually chowned. A no-op unless
// running as root (uid 0) on a data dir owned by someone else.
function restoreDataDirOwnership(dataDir, createdPaths = [], {
  getuid = defaultGetuid,
  fsImpl = fs,
  log = defaultLog
} = {}) {
  if (getuid() !== 0) return [];
  let owner;
  try {
    owner = fsImpl.lstatSync(dataDir);
  } catch {
    return [];
  }
  if (!owner.isDirectory() || owner.uid === 0) return [];

  const { uid, gid } = owner;
  const root = path.resolve(dataDir);
  const changed = [];
  const seen = new Set();

  for (const candidate of createdPaths) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const target = path.resolve(candidate);
    if (seen.has(target)) continue;
    seen.add(target);
    if (target !== root && !target.startsWith(root + path.sep)) {
      log.warn('refusing to chown a path outside the data dir', { path: target, dataDir: root });
      continue;
    }
    if (chownOne(target, uid, gid, fsImpl, log)) changed.push(target);
  }
  return changed;
}

module.exports = { restoreDataDirOwnership };

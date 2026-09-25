// Refuses a write whose path runs through a link (fleet stage 7 Task 9, fix
// round 1, C1). `king-louie-service import --from` runs as an administrator.
// On POSIX its writes happen in a child that has dropped to the data dir's
// owner, so a link planted by the service account gains it nothing. Windows
// has no setuid, so there the importer writes the data dir as an
// Administrator, inside a directory the service account controls: a junction
// planted at <dataDir>/memory would steer an Administrator write anywhere.
//
// A guard is built from `anchors`, the directories the caller trusts because
// the administrator named them (--data-dir, KL_CASES_ROOT). check(target)
// refuses, failing closed:
//   - a target outside every anchor;
//   - an anchor that is itself a link;
//   - any existing component between the anchor and the target that is a
//     symlink or junction (Node's lstat reports both, and volume mount
//     points, as isSymbolicLink()), or a non-directory where a directory
//     belongs;
//   - a deepest existing component whose real path (realpathSync.native,
//     which resolves every name-surrogate reparse point and expands 8.3 short
//     names) is not the anchor's real path plus the same relative path. This
//     second check catches any redirection lstat does not label.
//
// It narrows the window but cannot close it: between check() and the write,
// the service account can still swap a directory for a junction. Node has no
// handle-relative open to prevent that. The residual is documented for the PR.
//
// Only the admin CLI's writer passes a guard. Every store takes `writeGuard`
// as an option and does nothing extra without one, so the running service
// (the bridge import included) writes exactly as it did before.
const fs = require('fs');
const path = require('path');

class WriteGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriteGuardError';
    this.code = 'UNSAFE_WRITE_PATH';
  }
}

function createWriteGuard({ anchors, platform = process.platform, fsImpl = fs }) {
  const fold = platform === 'win32' || platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;
  const roots = [...new Set((anchors || []).filter((a) => typeof a === 'string' && a).map((a) => path.resolve(a)))];
  if (!roots.length) throw new Error('a write guard needs at least one anchor directory');

  const inside = (parent, child) => {
    const rel = path.relative(fold(parent), fold(child));
    return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
  };

  function check(target) {
    const abs = path.resolve(String(target));
    const anchor = roots.find((a) => inside(a, abs));
    if (!anchor) throw new WriteGuardError(`${abs} is outside ${roots.join(' and ')}, where this import writes`);

    let st;
    try {
      st = fsImpl.lstatSync(anchor);
    } catch (err) {
      throw new WriteGuardError(`${anchor} cannot be checked: ${err.message}`);
    }
    if (st.isSymbolicLink()) throw new WriteGuardError(`${anchor} is a link or junction`);
    if (!st.isDirectory()) throw new WriteGuardError(`${anchor} is not a directory`);

    const segs = path.relative(anchor, abs).split(path.sep).filter(Boolean);
    let cur = anchor;
    let deepest = anchor;
    for (let i = 0; i < segs.length; i += 1) {
      cur = path.join(cur, segs[i]);
      try {
        st = fsImpl.lstatSync(cur);
      } catch (err) {
        if (err.code === 'ENOENT') break;
        throw new WriteGuardError(`${cur} cannot be checked: ${err.message}`);
      }
      if (st.isSymbolicLink()) throw new WriteGuardError(`${cur} is a link or junction`);
      if (i < segs.length - 1 && !st.isDirectory()) throw new WriteGuardError(`${cur} is not a directory`);
      deepest = cur;
    }

    let real;
    let expected;
    try {
      expected = path.join(fsImpl.realpathSync.native(anchor), path.relative(anchor, deepest));
      real = fsImpl.realpathSync.native(deepest);
    } catch (err) {
      throw new WriteGuardError(`${deepest} cannot be resolved: ${err.message}`);
    }
    if (fold(path.resolve(real)) !== fold(path.resolve(expected))) {
      throw new WriteGuardError(`${deepest} resolves to ${real}, not to the path it names`);
    }
  }

  return { anchors: roots, check };
}

// Callers hold `writeGuard` as null or a guard; this keeps the call sites short.
const guardCheck = (guard, target) => { if (guard) guard.check(target); };

module.exports = { createWriteGuard, guardCheck, WriteGuardError };

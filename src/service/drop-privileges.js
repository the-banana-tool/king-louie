// Dropping root to the data dir's owner (fleet stage 4, rulings
// T13-dropprivs and T13-enroll). A root-run CLI process must never write,
// chown or unlink inside the courier directories: the service account owns
// approvals/ and can swap outbox/ or inbox/ for a link at any moment, which
// turns every root write there into a file planted wherever root can write.
// Whatever touches those directories runs as the data dir's owner instead:
// supplementary groups cleared, then gid, then uid, then verified. The drop
// is one-way for the calling process (`mcp` calls it on itself; enroll-device
// calls it in its forked courier child, src/service/courier-child.js).
//
// A root-owned data dir has no service account to become and is refused.
// `proc` and `fsImpl` are injectable for tests; on Windows there is no
// getuid and this is a no-op.
const fs = require('fs');

function isRoot(proc = process) {
  return (typeof proc.getuid === 'function' && proc.getuid() === 0)
    || (typeof proc.geteuid === 'function' && proc.geteuid() === 0);
}

// The data dir's owner { uid, gid }, after checking it is a real directory.
function dataDirOwner(dataDir, { fsImpl = fs, who = 'this command' } = {}) {
  const st = fsImpl.lstatSync(dataDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to run ${who} as root: ${dataDir} is not a real directory`);
  }
  return { uid: st.uid, gid: st.gid };
}

// → { uid, gid } when it dropped, null when not root (nothing to do).
function dropToDataDirOwner(dataDir, { proc = process, fsImpl = fs, who = 'this command' } = {}) {
  if (!isRoot(proc)) return null;
  const { uid, gid } = dataDirOwner(dataDir, { fsImpl, who });
  if (uid === 0) {
    throw new Error(`refusing to run ${who} as root: ${dataDir} is owned by root, so there is no service account to run as; run ${who} as the service account`);
  }
  try {
    if (typeof proc.setgroups === 'function') proc.setgroups([]);
    proc.setgid(gid);
    proc.setuid(uid);
  } catch (err) {
    throw new Error(`refusing to run ${who} as root: could not become the data dir's owner (uid ${uid}, gid ${gid}): ${err.message}`);
  }
  if (proc.getuid() !== uid || proc.geteuid() !== uid) {
    throw new Error(`refusing to run ${who} as root: still running as uid ${proc.getuid()}/${proc.geteuid()} after dropping to the data dir's owner (uid ${uid})`);
  }
  return { uid, gid };
}

module.exports = { isRoot, dataDirOwner, dropToDataDirOwner };

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
// A root-owned data dir means the service itself runs as root: there is no
// lower account to drop to, and none that could swap a link under root
// either, so the caller goes ahead as root (ruling T13-rootdir; `mcp` and
// enroll-device behave the same). `proc` and `fsImpl` are injectable for
// tests; on Windows there is no getuid and this is a no-op.
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

// → { dropped: true, uid, gid } when it dropped;
//   { dropped: false, reason: 'not-root' } when not root (nothing to do);
//   { dropped: false, reason: 'root-owned', uid: 0, gid } when the data dir
//   is root's (the service runs as root; nothing lower to drop to).
// Throws (refuses) for a data dir that is not a real directory, or when the
// drop fails or does not take.
function dropToDataDirOwner(dataDir, { proc = process, fsImpl = fs, who = 'this command' } = {}) {
  if (!isRoot(proc)) return { dropped: false, reason: 'not-root' };
  const { uid, gid } = dataDirOwner(dataDir, { fsImpl, who });
  if (uid === 0) return { dropped: false, reason: 'root-owned', uid, gid };
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
  return { dropped: true, uid, gid };
}

module.exports = { isRoot, dataDirOwner, dropToDataDirOwner };

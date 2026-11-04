// Who a node seals to, and whether it must (sealed phones, R-SP-5).
//
// recipients(): every active approver record (`isActive`, the revoke overlay
// included) that holds a box key, plus the node's own box. An untrusted store, or
// a latch not known to be on disk, gives {}.
//
// sealing(): true while that set holds a device, or the latch is set. A relayed
// revoke acts on the overlay at once and an untrusted store is often temporary,
// so "no recipients" must never mean "send in clear". Latched with no device to
// seal to, a node sends no content: canSeal() is false and the builders refuse
// `no_sealed_recipient`.
//
// The latch is <dataDir>/approvals/sealing.json, written atomically the first
// time the set holds a device, before canSeal() can say yes. Only one state is
// not latched: the read says the file is not there (ENOENT) and its directory
// is a real one or absent. Any other failed read, a link, a directory or a file
// that does not parse as a latch counts as latched, so what this process cannot
// read can never send clear. A latch that
// cannot be written leaves sealing() true (held in memory, tried again at each
// read) and canSeal() false.
//
// Everything is read at every call. Nothing here clears the latch, and no relay
// method reaches this file's clearLatch: only `device unseal` at the console.
//
// Residual: the file is the service account's, so anything running as that
// account can delete it. While a device holds a box key the next build writes it
// again. With none, the node then sends in clear.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('./approver-store');

const log = createLogger('approvals/seal-policy');

const NONE = Object.freeze({ state: 'none', latched: false });
const GOOD = Object.freeze({ state: 'good', latched: true });
const BAD = Object.freeze({ state: 'bad', latched: true });

const latchFile = (dataDir) => path.join(dataDir, 'approvals', 'sealing.json');

function isLatchRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.v === 1 && typeof value.latched_at === 'string';
}

// → { state: 'none' | 'good' | 'bad', latched }. Never throws.
function readLatch(dataDir) {
  const file = latchFile(dataDir);
  try {
    if (!fs.lstatSync(file).isFile()) return BAD;
    return isLatchRecord(JSON.parse(fs.readFileSync(file, 'utf8'))) ? GOOD : BAD;
  } catch (err) {
    if (err.code !== 'ENOENT') return BAD;
  }
  // Windows answers ENOENT, not POSIX's ENOTDIR, when a file sits where the
  // approvals dir should be, and a dangling link answers it everywhere: "no
  // file" holds only under a real directory, or with no directory yet.
  try {
    return fs.lstatSync(path.dirname(file)).isDirectory() ? NONE : BAD;
  } catch (err) {
    return err.code === 'ENOENT' ? NONE : BAD;
  }
}

// onPath: told each path created, so a process running as root can hand them to
// the data dir's owner. The directory is synced after the rename: a latch lost to
// a power cut would let a node that has sealed send in clear. Windows cannot sync
// a directory, and NTFS journals the rename.
function writeLatch(dataDir, nowMs = Date.now(), onPath = null) {
  const file = latchFile(dataDir);
  const dir = path.dirname(file);
  const madeDir = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (madeDir && onPath) onPath(dir);
  writeFileAtomic(file, `${JSON.stringify({ v: 1, latched_at: new Date(nowMs).toISOString() })}\n`);
  if (onPath) onPath(file);
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Why this account could not write the latch now, else null. For doctor: it
// proves the access of whoever runs it, not of the service. Writes only a probe
// of a random name, 'wx' so that nothing planted is followed, and removes it.
function latchWriteProblem(dataDir, fsImpl = fs) {
  const approvals = path.dirname(latchFile(dataDir));
  const dir = fsImpl.existsSync(approvals) ? approvals : dataDir;
  const probe = path.join(dir, `.latch-probe-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fsImpl.closeSync(fsImpl.openSync(probe, 'wx', 0o600));
    fsImpl.unlinkSync(probe);
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}

// The approvals dir is writable by the service account, and an administrator's
// CLI deletes from it: why that CLI must not, else null. Links are refused, so
// it cannot be steered into removing a file elsewhere, and so is anything at the
// latch's path that is not a file, which removing would not clear.
function latchPathProblem(dataDir) {
  const file = latchFile(dataDir);
  const dir = path.dirname(file);
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return `Refusing to use ${dir}: it is a link, and this directory is writable by the service account.`;
    if (!st.isDirectory()) return `${dir} is not a directory. Remove it by hand.`;
    if (!fs.lstatSync(file).isFile()) return `${file} is not a file. Remove it by hand.`;
    return null;
  } catch (err) {
    return err.code === 'ENOENT' ? null : `Cannot check ${file}: ${err.code || err.message}.`;
  }
}

// `device unseal` only. Removes the name itself: a link there is not followed.
function clearLatch(dataDir) {
  try {
    fs.unlinkSync(latchFile(dataDir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function createSealPolicy({ approverStore, identity, dataDir, writeLatchFile = writeLatch, now = Date.now, onPathWritten = null } = {}) {
  if (!approverStore || !identity || !dataDir) throw new TypeError('createSealPolicy needs approverStore, identity and dataDir');
  const box = identity.box || null;
  // A device was seen and the latch is not on disk yet.
  let unwritten = false;
  let writeFailureLogged = false;

  const look = () => {
    const devices = approverStore.list().filter((r) => r.box_key && approverStore.isActive(r.device_id));
    const read = readLatch(dataDir);
    let durable = read === GOOD;
    if (durable) {
      unwritten = false;
    } else if (devices.length > 0 || unwritten) {
      try {
        writeLatchFile(dataDir, now(), onPathWritten);
        durable = true;
        unwritten = false;
        writeFailureLogged = false;
      } catch (err) {
        unwritten = true;
        if (!writeFailureLogged) log.error(`cannot write ${latchFile(dataDir)}: ${err.code || err.message}; nothing goes to the phones until it can be written`);
        writeFailureLogged = true;
      }
    }
    return { devices, durable, latched: durable || read === BAD || unwritten };
  };

  return {
    senderId: identity.nodeId,
    nodeBox: box ? box.jwk : null,
    sealing() {
      const { devices, latched } = look();
      return latched || devices.length > 0;
    },
    canSeal() {
      const { devices, durable } = look();
      return Boolean(box) && durable && devices.length > 0;
    },
    recipients() {
      const { devices, durable } = look();
      // No key leaves here before the latch is on disk.
      if (approverStore.untrusted || !durable) return {};
      const out = {};
      for (const r of devices) out[r.device_id] = r.box_key;
      if (box) out[identity.nodeId] = box.jwk;
      return out;
    }
  };
}

module.exports = { createSealPolicy, readLatch, writeLatch, clearLatch, latchPathProblem, latchWriteProblem, latchFile };

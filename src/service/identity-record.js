// src/service/identity-record.js
//
// The administrator's record of this node's identity (owner ruling R-F5-17).
//
// The node's key pair lives in the data dir, which the service account owns,
// and the service account also holds the master key. So anything that runs as
// that account (an agent's shell command, say) can put a key pair of its own
// there, and the service would start with it. This file is what an
// administrator vouched for: the node id and its public key, in
// <configDir>/identity/node.json, written only by `king-louie-service
// identity record` (after it shows the id and asks). The service and
// `session install` read it and compare.
//
// It is read the way the approver set is (src/approvals/approver-store.js):
// POSIX by owner and mode of the file and both directories above it; Windows,
// where files carry no owner Node can see, by the owners a PowerShell child
// reads (Administrators, SYSTEM or the config dir's own owner; never a config
// dir LOCAL SERVICE owns; no links) and, on the service's side, by a probe
// that the service can neither create a file beside the record nor open the
// record itself for writing. Whatever cannot be checked is not trusted. Loads
// no agent code: every profile's start reads it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { deriveNodeId } = require('../mesh/node-identity');

const defaultLog = createLogger('service/identity-record');

const RECORD_DIR = 'identity';
const RECORD_FILE = 'node.json';
const RECORD_KEYS = ['node_id', 'public_key', 'recorded_at', 'v'];
// A record is about 220 bytes.
const RECORD_MAX_BYTES = 4096;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PUBLIC_KEY_RE = /^[0-9a-f]{88}$/;
const SID_RE = /^S-1-(?:\d+-)*\d+$/;
const WINDOWS_ADMINISTRATORS = 'S-1-5-32-544';
const WINDOWS_TRUSTED_OWNERS = new Set([WINDOWS_ADMINISTRATORS, 'S-1-5-18']);
const WINDOWS_SERVICE_ACCOUNTS = new Set(['S-1-5-19']);
const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

const recordDir = (configDir) => path.join(configDir, RECORD_DIR);
const recordPath = (configDir) => path.join(configDir, RECORD_DIR, RECORD_FILE);

// A DER (SPKI) Ed25519 public key as lower-case hex, from the hex or the
// Buffer an identity holds; null when it is neither.
function publicKeyHex(publicKey) {
  const hex = Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : (typeof publicKey === 'string' ? publicKey.toLowerCase() : '');
  if (!PUBLIC_KEY_RE.test(hex)) return null;
  try {
    deriveNodeId(hex);
  } catch {
    return null;
  }
  return hex;
}

// { nodeId, publicKey } when `raw` is a well-formed record whose id is its
// key's; null otherwise.
function parseRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((k, i) => k !== RECORD_KEYS[i])) return null;
  if (raw.v !== 1 || typeof raw.node_id !== 'string' || typeof raw.public_key !== 'string') return null;
  if (typeof raw.recorded_at !== 'string' || !TIMESTAMP_RE.test(raw.recorded_at)) return null;
  const hex = PUBLIC_KEY_RE.test(raw.public_key) ? publicKeyHex(raw.public_key) : null;
  if (hex === null || deriveNodeId(hex) !== raw.node_id) return null;
  return { nodeId: raw.node_id, publicKey: hex, recordedAt: raw.recorded_at };
}

// Windows owners, through the installers' handle-based inspector (one
// no-follow handle per path; no Get-Acl). Synchronous: this runs once when
// the service starts, and in the admin CLI.
function defaultInspectOwners(paths) {
  return require('../desktop-bridge/pairing').inspectWindowsOwners(paths);
}

// null when the owners allow trusting the record, else why not. An owner
// nobody could read is not trusted.
function windowsOwnerProblem({ configDir, dir, file, inspectOwners }) {
  const unread = `could not be checked: the owners of ${file} and the directories above it could not be read`;
  let report;
  try {
    report = inspectOwners([configDir, dir, file]);
  } catch {
    return unread;
  }
  if (!report || !Array.isArray(report.entries) || report.entries.length !== 3) return unread;
  const targets = [configDir, dir, file];
  for (let i = 0; i < 3; i += 1) {
    const entry = report.entries[i];
    if (!entry || typeof entry.owner !== 'string' || !SID_RE.test(entry.owner)) return unread;
    if (entry.link) return `cannot be trusted: ${targets[i]} is a link`;
  }
  const [config, ...below] = report.entries.map((e) => e.owner);
  if (WINDOWS_SERVICE_ACCOUNTS.has(config)) {
    return `cannot be trusted: ${configDir} is owned by the service account (${config})`;
  }
  for (let i = 0; i < below.length; i += 1) {
    if (!WINDOWS_TRUSTED_OWNERS.has(below[i]) && below[i] !== config) {
      return `cannot be trusted: ${targets[i + 1]} is owned by ${below[i]}, which is neither Administrators, SYSTEM nor the owner of ${configDir}`;
    }
  }
  return null;
}

// Windows, the service's side. Two questions, and only "denied" answers
// either: can this process create a file beside the record, and can it open
// the record itself for writing? The second is its own question (fourth
// security review, finding 1): a directory can refuse new files and still
// hand every file in it a write entry through an inherit-only ACE, which the
// record then inherits. Opening for writing changes nothing in the file.
// Not asked, because nothing here can ask it without changing the file: the
// right to delete the record or to rewrite its ACL. The administrator's
// command gives both the directory and the file a protected ACL of their own
// (writeIdentityRecord), so neither has an entry it did not write.
function windowsProbeProblem({ dir, file, fsImpl }) {
  const denied = (err) => Boolean(err) && (err.code === 'EACCES' || err.code === 'EPERM');
  const probe = path.join(dir, `.probe-${crypto.randomBytes(6).toString('hex')}`);
  let fd = null;
  let openErr = null;
  try {
    fd = fsImpl.openSync(probe, 'wx');
  } catch (err) {
    openErr = err;
  }
  if (fd !== null) {
    try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    try { fsImpl.unlinkSync(probe); } catch { /* ignore */ }
    return `cannot be trusted: ${dir} is writable by the account running the service`;
  }
  if (!denied(openErr)) return `could not be verified: whether ${dir} is protected is unknown (${(openErr && openErr.code) || 'error'})`;
  let wfd = null;
  let writeErr = null;
  try {
    wfd = fsImpl.openSync(file, 'r+');
  } catch (err) {
    writeErr = err;
  }
  if (wfd !== null) {
    try { fsImpl.closeSync(wfd); } catch { /* ignore */ }
    return `cannot be trusted: ${file} is writable by the account running the service`;
  }
  if (!denied(writeErr)) return `could not be verified: whether ${file} is protected is unknown (${(writeErr && writeErr.code) || 'error'})`;
  return null;
}

// The service's probe alone, for asking again while it runs (as the approver
// set's probe is run again on every scan): null when the record is still out
// of this process's reach, or off Windows, where owner and mode were read
// when the service started; else why it can no longer be trusted. No
// PowerShell: the owners are not read again here.
function probeIdentityRecord({ configDir, platform = process.platform, fsImpl = fs } = {}) {
  if (platform !== 'win32') return null;
  const file = recordPath(configDir);
  const problem = windowsProbeProblem({ dir: recordDir(configDir), file, fsImpl });
  return problem === null ? null : `${file} ${problem}`;
}

// POSIX: the config dir, the record's directory and the record are the
// administrator's and nobody else can write them. Whoever can write a
// directory can put a file of their own in place of the one inside it.
function posixProblem({ configDir, dir, file, adminUid, fsImpl }) {
  for (const target of [configDir, dir, file]) {
    let st;
    try {
      st = fsImpl.lstatSync(target);
    } catch (err) {
      return `could not be checked (${err.code || 'error'})`;
    }
    if (st.isSymbolicLink()) return `cannot be trusted: ${target} is a link`;
    if (st.mode & 0o022) return `cannot be trusted: ${target} can be written by others (mode ${(st.mode & 0o7777).toString(8)})`;
    if (st.uid !== adminUid) return `cannot be trusted: ${target} is not owned by the administrator (it is owned by uid ${st.uid})`;
  }
  return null;
}

// What an administrator recorded, read without trusting anything that could
// not be checked:
//   { state: 'none', file }                       no record
//   { state: 'recorded', file, nodeId, publicKey, recordedAt }
//   { state: 'invalid', file, reason }            there is one and it cannot
//                                                 be used; `reason` never
//                                                 quotes the file
// serviceProbe: true for the service (which must not be able to write the
// directory), false for the admin CLI and doctor (an administrator can).
function readIdentityRecord({ configDir, platform = process.platform, adminUid = 0, serviceProbe = false, fsImpl = fs,
  inspectOwners = defaultInspectOwners } = {}) {
  const dir = recordDir(configDir);
  const file = recordPath(configDir);
  const invalid = (reason) => ({ state: 'invalid', file, reason });
  let st;
  try {
    st = fsImpl.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      // A link where the directory should be is not "no record".
      try {
        if (fsImpl.lstatSync(dir).isSymbolicLink()) return invalid(`cannot be trusted: ${dir} is a link`);
      } catch { /* no directory either */ }
      return { state: 'none', file };
    }
    return invalid(`could not be checked (${err.code || 'error'})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) return invalid('is not a regular file');
  if (st.size > RECORD_MAX_BYTES) return invalid(`is larger than ${RECORD_MAX_BYTES} bytes`);
  const problem = platform === 'win32'
    ? (windowsOwnerProblem({ configDir, dir, file, inspectOwners }) || (serviceProbe ? windowsProbeProblem({ dir, file, fsImpl }) : null))
    : posixProblem({ configDir, dir, file, adminUid, fsImpl });
  if (problem) return invalid(problem);
  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (err) {
    // Never the parser's own message: it quotes the text it could not parse.
    return invalid(err instanceof SyntaxError ? 'is not valid JSON' : `could not be read (${err.code || 'error'})`);
  }
  const record = parseRecord(raw);
  if (!record) return invalid('is malformed');
  return { state: 'recorded', file, ...record };
}

const ADMIN = 'as root or an Administrator';

// The record against the identity in the data dir:
//   match     the administrator recorded exactly this key
//   none      nobody recorded anything (an install from before R-F5-17, or
//             a new one): nothing is vouched for
//   mismatch  the data dir holds another identity than the one recorded
//   invalid   there is a record that cannot be trusted or read
// `problem` says what an administrator does about each (null on a match).
// The key is what is compared; the id follows from it.
function checkNodeIdentityRecord({ configDir, dataDir = null, identity, ...readOptions } = {}) {
  const seen = readIdentityRecord({ configDir, ...readOptions });
  const where = dataDir ? ` --data-dir ${dataDir}` : '';
  if (seen.state === 'none') {
    return {
      state: 'none', file: seen.file, recorded: null,
      problem: `no administrator record of this node's identity (${seen.file} is missing): ${ADMIN} run "king-louie-service identity record${where}" and compare the id it shows with the one your phones show for this node`
    };
  }
  if (seen.state === 'invalid') {
    return {
      state: 'invalid', file: seen.file, recorded: null,
      problem: `${seen.file} ${seen.reason}, so it does not say which identity an administrator recorded: ${ADMIN} find out who could have changed it, then run "king-louie-service identity record --replace${where}"`
    };
  }
  const recorded = { nodeId: seen.nodeId, publicKey: seen.publicKey };
  const held = identity && typeof identity === 'object' ? publicKeyHex(identity.publicKey) : null;
  if (held !== null && held === seen.publicKey) return { state: 'match', file: seen.file, problem: null, recorded };
  const heldId = held === null ? 'no readable identity' : deriveNodeId(held);
  return {
    state: 'mismatch', file: seen.file, recorded,
    problem: `the identity in ${dataDir || 'the data dir'} (${heldId}) is not the one an administrator recorded in ${seen.file} (${seen.nodeId}). `
      + `If the data dir was replaced or reset on purpose, ${ADMIN} run "king-louie-service identity record --replace${where}" (phones, relays and desktops paired with the old identity must be paired again). `
      + 'If it was not, something else changed the data dir: restore it from a backup before starting the service'
  };
}

// The service's own check, when it starts. A match is silent. No record is
// one warning: the service runs, computer use stays off (src/gui/index.js)
// and `session install` refuses, until an administrator records the
// identity. A mismatch, or a record that cannot be trusted, stops the start:
// the service never presents an identity other than the one recorded, and
// never treats a record it could not check as absent.
function assertRecordedIdentity({ log = defaultLog, ...options } = {}) {
  const result = checkNodeIdentityRecord({ serviceProbe: true, ...options });
  if (result.state === 'match') return result;
  if (result.state === 'none') {
    log.warn(`${result.problem}. Until then nothing vouches for this identity: the service runs, computer use stays off and "session install" refuses.`);
    return result;
  }
  const code = result.state === 'mismatch' ? 'NODE_IDENTITY_MISMATCH' : 'NODE_IDENTITY_RECORD_INVALID';
  throw Object.assign(new Error(`Refusing to start: ${result.problem}.`), { code });
}

function defaultRunIcacls(argv) {
  require('child_process').execFileSync(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
}

// The config dir must exist and be its own real path: nothing above the
// record may be a link.
function assertRealConfigDir(configDir) {
  const resolved = path.resolve(configDir);
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `${resolved} does not exist: install the service first` : `${resolved} cannot be checked (${err.code || 'error'})`);
  }
  const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
  if (foldsCase ? real.toLowerCase() !== resolved.toLowerCase() : real !== resolved) {
    throw new Error(`${resolved} is reached through a link (it resolves to ${real}); refusing to write the identity record there`);
  }
  if (!fs.lstatSync(resolved).isDirectory()) throw new Error(`${resolved} is not a directory`);
  return resolved;
}

// What the record's directory and the record get on Windows: the ACL the
// installers give the config dir (WINDOWS_CONFIG_DIR_SDDL in installers.js),
// set on each of them and protected, so nothing is inherited from above and
// nothing a directory of that name held before carries over. SYSTEM and
// Administrators in full; LOCAL SERVICE, the account the installed service
// runs as, reads. A service run by hand as any other account cannot read a
// record written this way, and refuses to start for it.
const WINDOWS_SYSTEM = 'S-1-5-18';
const WINDOWS_LOCAL_SERVICE = 'S-1-5-19';
function icaclsExe(env) {
  return require('../platform/windows-paths').windowsIcaclsExe(env);
}
function windowsRecordDirAclArgs(dir, env = process.env) {
  return [icaclsExe(env), dir, '/inheritance:r', '/grant:r',
    `*${WINDOWS_SYSTEM}:(OI)(CI)(F)`, `*${WINDOWS_ADMINISTRATORS}:(OI)(CI)(F)`, `*${WINDOWS_LOCAL_SERVICE}:(OI)(CI)(RX)`];
}
function windowsRecordFileAclArgs(file, env = process.env) {
  return [icaclsExe(env), file, '/inheritance:r', '/grant:r', `*${WINDOWS_SYSTEM}:(F)`, `*${WINDOWS_ADMINISTRATORS}:(F)`, `*${WINDOWS_LOCAL_SERVICE}:(R)`];
}
// Administrators, not whichever administrator ran the command: a
// directory's owner can always rewrite its ACL.
function windowsRecordOwnerArgs(target, env = process.env) {
  return [icaclsExe(env), target, '/setowner', `*${WINDOWS_ADMINISTRATORS}`];
}

// Windows (fourth security review, finding 1). A directory that was there
// before is never kept: whoever once controlled it may have left an entry
// that every new file inherits (an inherit-only "modify", say), or may still
// hold a handle that can rewrite its ACL. So the record is built in a new
// directory beside it, which gets its protected ACL and its owner before
// anything is in it; the file is created empty, gets its own, and is written
// only then; and the new directory takes the old one's name (two renames:
// for that instant there is no record, which every reader takes as "none").
// The old directory is removed. If anything fails the old one is put back
// and nothing was recorded.
function writeWindowsRecord({ root, text, runIcacls, env, log }) {
  const dir = recordDir(root);
  const tag = crypto.randomBytes(4).toString('hex');
  const fresh = path.join(root, `.${RECORD_DIR}.new-${tag}`);
  const aside = path.join(root, `.${RECORD_DIR}.old-${tag}`);
  fs.mkdirSync(fresh);
  let movedAside = false;
  let swapped = false;
  try {
    runIcacls(windowsRecordDirAclArgs(fresh, env));
    runIcacls(windowsRecordOwnerArgs(fresh, env));
    const target = path.join(fresh, RECORD_FILE);
    fs.closeSync(fs.openSync(target, 'wx'));
    runIcacls(windowsRecordFileAclArgs(target, env));
    runIcacls(windowsRecordOwnerArgs(target, env));
    const fd = fs.openSync(target, 'r+');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(dir, aside);
      movedAside = true;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`${dir} could not be replaced (${err.code || 'error'}): stop the service and anything else that has it open, then run this again; nothing was recorded`);
      }
    }
    fs.renameSync(fresh, dir);
    swapped = true;
  } catch (err) {
    if (movedAside && !swapped) { try { fs.renameSync(aside, dir); } catch { /* the caller's read-back says what is there now */ } }
    try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* never made, or already renamed */ }
    throw err;
  }
  if (movedAside) {
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch (err) {
      log.warn(`the identity record was written, but the directory it replaced could not be removed (${err.code || 'error'}): remove ${aside} by hand`);
    }
  }
  return recordPath(root);
}

// Written by the administrator's command only. POSIX: the whole file is
// replaced through a rename, so a reader never sees half of one; 0755 for
// the directory and 0644 for the file (the id and the public key are not
// private; the service account must read them and must not write them).
// Windows: the directory is made anew with the file in it (writeWindowsRecord).
function writeIdentityRecord({ configDir, nodeId, publicKey, platform = process.platform, now = Date.now(), runIcacls = defaultRunIcacls, env = process.env, log = defaultLog } = {}) {
  const hex = publicKeyHex(publicKey);
  if (hex === null) throw new Error('not an Ed25519 public key; nothing was recorded');
  if (deriveNodeId(hex) !== nodeId) throw new Error(`node id ${nodeId} does not belong to that public key; nothing was recorded`);
  const root = assertRealConfigDir(configDir);
  const dir = recordDir(root);
  const file = recordPath(root);
  if (platform !== 'win32') {
    try {
      fs.mkdirSync(dir, { mode: 0o755 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  let dst = null;
  try {
    dst = fs.lstatSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (dst && (dst.isSymbolicLink() || !dst.isDirectory())) throw new Error(`${dir} is not a directory (a link is refused); nothing was recorded`);
  if (dst) {
    try {
      const fst = fs.lstatSync(file);
      if (fst.isSymbolicLink() || !fst.isFile()) throw new Error(`${file} is not a regular file (a link or a directory is refused); nothing was recorded`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  const text = `${JSON.stringify({ v: 1, node_id: nodeId, public_key: hex, recorded_at: new Date(now).toISOString() }, null, 2)}\n`;
  if (platform === 'win32') return writeWindowsRecord({ root, text, runIcacls, env, log });
  const tmp = path.join(dir, `.node.json.tmp-${crypto.randomBytes(4).toString('hex')}`);
  let fd = null;
  try {
    fs.chmodSync(dir, 0o755);
    fd = fs.openSync(tmp, 'wx', 0o644);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* never made, or already renamed */ }
    throw err;
  }
  return file;
}

module.exports = {
  RECORD_DIR, RECORD_FILE, RECORD_MAX_BYTES, recordPath, publicKeyHex,
  readIdentityRecord, checkNodeIdentityRecord, assertRecordedIdentity, writeIdentityRecord, probeIdentityRecord,
  windowsRecordDirAclArgs, windowsRecordFileAclArgs, windowsRecordOwnerArgs
};

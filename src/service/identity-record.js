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
// record itself for writing, and by the access lists of the record and its
// directory, which must let nobody but SYSTEM and Administrators change
// either. Whatever cannot be checked is not trusted. Loads no agent code:
// every profile's start reads it.
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
const WINDOWS_SYSTEM = 'S-1-5-18';
const WINDOWS_LOCAL_SERVICE = 'S-1-5-19';
const WINDOWS_TRUSTED_OWNERS = new Set([WINDOWS_ADMINISTRATORS, WINDOWS_SYSTEM]);
const WINDOWS_SERVICE_ACCOUNTS = new Set([WINDOWS_LOCAL_SERVICE]);
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
// Not asked, because no attempt can ask it without changing the file: the
// right to delete the record or to rewrite its ACL. That is read from the
// access lists instead, when the service starts (windowsAclProblem).
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
// PowerShell: neither the owners nor the access lists are read again here.
function probeIdentityRecord({ configDir, platform = process.platform, fsImpl = fs } = {}) {
  if (platform !== 'win32') return null;
  const file = recordPath(configDir);
  const problem = windowsProbeProblem({ dir: recordDir(configDir), file, fsImpl });
  return problem === null ? null : `${file} ${problem}`;
}

// What the service (when it starts) and doctor read on Windows, which the
// service's probe cannot ask and an administrator's own write attempt cannot
// show (fourth security review, finding 5; fifth, finding 3): the access
// lists of the record's directory and of the record,
// through the installers' handle-based inspector (one no-follow handle per
// path, framework types only, no Get-Acl). Reading them needs no privilege
// beyond being allowed to open the two; an account that is not allowed gets
// "unread", which is said as such.
//
// Rights that let their holder change a file, or what a directory holds, or
// who may: write data / add file, append / add subdirectory, write extended
// attributes, delete child, write attributes, delete, WRITE_DAC, WRITE_OWNER,
// GENERIC_ALL, GENERIC_WRITE.
const WINDOWS_WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const WINDOWS_ACE_INHERIT_ONLY = 0x8;

function aclScript() {
  const { WINDOWS_INSPECT_CSHARP } = require('./installers');
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  Add-Type -TypeDefinition @'",
    WINDOWS_INSPECT_CSHARP,
    "'@",
    '  foreach ($p in $env:KL_INSPECT_PATHS.Split([char]10)) {',
    '    $r = [KlFsInspect]::Inspect($p)',
    "    if ($null -eq $r) { [Console]::Out.WriteLine('missing'); continue }",
    '    $sd = [System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$r[1], 0)',
    "    $o = '-'",
    '    if ($null -ne $sd.Owner) { $o = $sd.Owner.Value }',
    "    if ($null -eq $sd.DiscretionaryAcl) { [Console]::Out.WriteLine('path nodacl ' + $o); continue }",
    "    [Console]::Out.WriteLine('path dacl ' + $o)",
    '    foreach ($ace in $sd.DiscretionaryAcl) {',
    '      if ($ace -is [System.Security.AccessControl.CommonAce]) {',
    "        [Console]::Out.WriteLine(('ace {0} {1} {2:x8} {3}' -f [int]$ace.AceType, $ace.SecurityIdentifier.Value, $ace.AccessMask, [int]$ace.AceFlags))",
    "      } else { [Console]::Out.WriteLine('ace other') }",
    '    }',
    '  }',
    '  exit 0',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n');
}

// One entry per path asked about: null (nothing there), or { dacl, aces }
// with `owner` (a SID) when the descriptor names one, each ace
// { type, sid, mask, flags } or { other: true } (a kind this does not
// read). Throws on output it does not know: no evidence is not trust.
function parseAclOutput(out) {
  const entries = [];
  for (const raw of String(out).trim().split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'missing') { entries.push(null); continue; }
    const head = /^path (dacl|nodacl)(?: (-|S-1-[0-9-]+))?$/.exec(line);
    if (head) {
      entries.push({ dacl: head[1] === 'dacl', ...(head[2] && head[2] !== '-' ? { owner: head[2] } : {}), aces: [] });
      continue;
    }
    const current = entries[entries.length - 1];
    if (!current) throw new Error('unexpected access list output');
    if (line === 'ace other') { current.aces.push({ other: true }); continue; }
    const m = /^ace (\d+) (S-1-[0-9-]+) ([0-9a-f]{8}) (\d+)$/.exec(line);
    if (!m) throw new Error('unexpected access list output');
    current.aces.push({ type: Number(m[1]), sid: m[2], mask: parseInt(m[3], 16), flags: Number(m[4]) });
  }
  return entries;
}

function defaultInspectAcl(paths, { execFile = require('child_process').execFileSync, env = process.env } = {}) {
  const { windowsPowerShellExe } = require('../platform/windows-paths');
  return parseAclOutput(execFile(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', aclScript()], {
    env: { ...env, KL_INSPECT_PATHS: paths.join('\n') }, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore']
  }));
}

// Who, besides SYSTEM and Administrators, the access lists of the record and
// of its directory let change them:
//   { state: 'clean' }             nobody
//   { state: 'writable', detail }  somebody: `detail` names the path and the SID
//   { state: 'unread', detail }    they could not be read, or hold an entry of
//                                  a kind this does not read
// An entry that only the directory's files inherit counts: that is how a
// record came to be writable in place while its directory refused new files.
// A deny entry takes rights away and is not looked at. Windows only.
//
// whole: what doctor asks (fifth security review, finding 5). The config dir
// is read as well: whoever may delete or add in it can put a directory of
// their own where identity\ is. An entry there that only what is in it
// inherits is passed over, since it gives nothing on the config dir itself
// and the two below it are read themselves. And the owners are judged, since
// an owner can rewrite an access list whatever it says:
//   { state: 'owner', detail }     no entry lets anybody else change the
//                                  three, but one is not owned by SYSTEM or
//                                  Administrators, or its owner was not read
// `where` on a "writable" answer: 'config' or 'record'. The service's own
// read (windowsAclProblem) asks about the two below the config dir only: its
// owner rule accepts a config dir owned by another account than the
// service's (a hand-made layout), which this would refuse.
function recordAclProblem({ configDir, inspectAcl = defaultInspectAcl, whole = false } = {}) {
  const below = [recordDir(configDir), recordPath(configDir)];
  const targets = whole ? [configDir, ...below] : below;
  const dirAt = targets.length - 2;
  const unread = { state: 'unread', detail: `the access lists of ${below[1]}${whole ? ', its directory and the config dir' : ' and its directory'} could not be read` };
  let report;
  try {
    report = inspectAcl(targets);
  } catch {
    return unread;
  }
  if (!Array.isArray(report) || report.length !== targets.length || report.some((e) => !e || !Array.isArray(e.aces))) return unread;
  for (let i = 0; i < targets.length; i += 1) {
    const entry = report[i];
    const where = whole && i === 0 ? 'config' : 'record';
    if (entry.dacl !== true) return { state: 'writable', where, detail: `${targets[i]} has no access list at all, so anyone can change it` };
    for (const ace of entry.aces) {
      if (!ace || ace.other || !Number.isInteger(ace.type) || !Number.isInteger(ace.mask) || typeof ace.sid !== 'string' || !SID_RE.test(ace.sid)) {
        return { state: 'unread', detail: `the access list of ${targets[i]} holds an entry of a kind that is not read here` };
      }
      if (ace.type === 1) continue;
      if (ace.type !== 0) return { state: 'unread', detail: `the access list of ${targets[i]} holds an entry of a kind that is not read here` };
      if (WINDOWS_TRUSTED_OWNERS.has(ace.sid) || (ace.mask & WINDOWS_WRITE_RIGHTS) === 0) continue;
      const inheritOnly = Boolean(Number(ace.flags) & WINDOWS_ACE_INHERIT_ONLY);
      if (where === 'config' && inheritOnly) continue;
      const inherited = i === dirAt && inheritOnly ? ', through an entry that the files in it inherit' : '';
      return { state: 'writable', where, detail: `the access list of ${targets[i]} lets ${ace.sid} change it${inherited}` };
    }
  }
  if (whole) {
    for (let i = 0; i < targets.length; i += 1) {
      const owner = report[i].owner;
      if (typeof owner !== 'string' || !SID_RE.test(owner)) return { state: 'owner', detail: `the owner of ${targets[i]} was not read` };
      if (!WINDOWS_TRUSTED_OWNERS.has(owner)) {
        return { state: 'owner', detail: `${targets[i]} is owned by ${owner}, which is neither Administrators nor SYSTEM: an owner can rewrite an access list whatever it says` };
      }
    }
  }
  return { state: 'clean' };
}

// Windows, the service's side, when it starts (fifth security review,
// finding 3). The owner read and the probe both pass a record whose access
// list gives the service's account WRITE_DAC and nothing else: it cannot
// write the record now, and can once it has rewritten the list. So the lists
// are read, and only "nobody but SYSTEM and Administrators" is trusted; a
// list that could not be read is not. One more PowerShell child, so this
// runs where the owner read does (the start), never before each lease.
function windowsAclProblem({ configDir, inspectAcl }) {
  const acl = recordAclProblem({ configDir, inspectAcl });
  if (acl.state === 'clean') return null;
  return `${acl.state === 'writable' ? 'cannot be trusted' : 'could not be verified'}: ${acl.detail}`;
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
// directory or the record, now or after rewriting an access list), false for
// the admin CLI and doctor (an administrator can; doctor reads the access
// lists itself and says what it found).
function readIdentityRecord({ configDir, platform = process.platform, adminUid = 0, serviceProbe = false, fsImpl = fs,
  inspectOwners = defaultInspectOwners, inspectAcl = defaultInspectAcl } = {}) {
  const dir = recordDir(configDir);
  const file = recordPath(configDir);
  const invalid = (reason) => ({ state: 'invalid', file, reason });
  // Windows: "access denied" on the record is its own answer (fifth security
  // review, finding 2). The record's access list names three readers, so an
  // account that is none of them is not helped by writing the record again.
  // Still invalid: a record nobody could read vouches for nothing.
  const refused = (err) => platform === 'win32' && Boolean(err) && (err.code === 'EACCES' || err.code === 'EPERM');
  const unreadable = (err) => ({
    ...invalid(`could not be read by the account ${serviceProbe ? 'the service runs as' : 'this ran as'} (${err.code})`),
    unreadable: serviceProbe ? 'service' : 'admin'
  });
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
    if (refused(err)) return unreadable(err);
    return invalid(`could not be checked (${err.code || 'error'})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) return invalid('is not a regular file');
  if (st.size > RECORD_MAX_BYTES) return invalid(`is larger than ${RECORD_MAX_BYTES} bytes`);
  const problem = platform === 'win32'
    ? (windowsOwnerProblem({ configDir, dir, file, inspectOwners })
      || (serviceProbe ? (windowsProbeProblem({ dir, file, fsImpl }) || windowsAclProblem({ configDir, inspectAcl })) : null))
    : posixProblem({ configDir, dir, file, adminUid, fsImpl });
  if (problem) return invalid(problem);
  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (err) {
    // Never the parser's own message: it quotes the text it could not parse.
    if (refused(err)) return unreadable(err);
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
  if (seen.state === 'invalid' && seen.unreadable) {
    // Who "identity record" lets read the record on Windows
    // (windowsRecordDirAclArgs, windowsRecordFileAclArgs). Writing it again
    // gives the same three, so that is not the remedy.
    const readers = `On Windows the record can be read only by SYSTEM (${WINDOWS_SYSTEM}), Administrators (${WINDOWS_ADMINISTRATORS}) and LOCAL SERVICE (${WINDOWS_LOCAL_SERVICE})`;
    const remedy = seen.unreadable === 'service'
      ? `${readers}, the account "king-louie-service install" sets the service up under: run the service as LOCAL SERVICE. `
        + '"king-louie-service identity record --replace" writes the same access list again and changes nothing. '
        + 'If the service does run as LOCAL SERVICE, the access list is no longer the one that command writes: an Administrator should find out who changed it before writing the record anew'
      : `${readers}: run this from an elevated (Administrator) prompt`;
    return {
      state: 'invalid', file: seen.file, recorded: null,
      problem: `${seen.file} ${seen.reason}, so it does not say which identity an administrator recorded. ${remedy}`
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
// The old directory is removed (removeRecordDir: the record and the empty
// directory, nothing else). If anything fails the old one is put back and
// nothing was recorded.

// Removes a record directory this command is done with: the one record file
// it expects, then the directory itself, neither of them recursively (fifth
// security review, finding 6). The account the service runs as may once have
// controlled the directory that is being replaced, and this runs as an
// administrator: a recursive delete would remove whatever that account left
// in it, and whatever a link in it led to on a file system that follows
// them. null when it is gone; otherwise what is left, and nothing was
// removed unless the answer says so. Names found in the directory are
// counted, never repeated: they go to an administrator's terminal.
function removeRecordDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    return err.code === 'ENOENT' ? null : `could not be looked at (${err.code || 'error'})`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'is a link or not a directory, and was not removed';
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return `could not be listed (${err.code || 'error'}), and was not removed`;
  }
  const others = names.filter((name) => name !== RECORD_FILE).length;
  if (others > 0) return `holds ${others} ${others === 1 ? 'entry' : 'entries'} besides ${RECORD_FILE}, and was not removed: nothing in it was touched`;
  const file = path.join(dir, RECORD_FILE);
  if (names.length === 1) {
    let fst;
    try {
      fst = fs.lstatSync(file);
    } catch (err) {
      return `${RECORD_FILE} in it could not be looked at (${err.code || 'error'}), and it was not removed`;
    }
    if (fst.isSymbolicLink() || !fst.isFile()) return `${RECORD_FILE} in it is not a regular file, and it was not removed: nothing in it was touched`;
    try {
      fs.unlinkSync(file);
    } catch (err) {
      return `${RECORD_FILE} in it could not be removed (${err.code || 'error'})`;
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch (err) {
    return `is empty of its record now but could not be removed itself (${err.code || 'error'})`;
  }
  return null;
}

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
    // Never made, already renamed, or this command's own minutes-old
    // directory: at most the record file is in it.
    if (!swapped) {
      const left = removeRecordDir(fresh);
      if (left) log.warn(`nothing was recorded, and the directory this command had made for the new record, ${fresh}, ${left}. Look at what it holds and remove it by hand`);
    }
    throw err;
  }
  if (movedAside) {
    const left = removeRecordDir(aside);
    if (left) {
      log.warn(`the identity record was written. The directory it replaced was moved to ${aside}, which ${left}. `
        + 'This command removes only the old record and the empty directory. Look at what that directory holds, and who put it there, and remove it by hand');
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
  recordAclProblem, parseAclOutput, inspectWindowsAcl: defaultInspectAcl,
  windowsRecordDirAclArgs, windowsRecordFileAclArgs, windowsRecordOwnerArgs
};

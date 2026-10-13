// src/gui/session-secret.js
// The session helper's secret and endpoint (fleet stage 5 spec §3.1, §4.3).
// The canonical copy (service reads) is klc1: ciphertext under the master
// key; each per-user copy (helper reads) is plaintext in the admin-owned
// config dir, readable only by that user. Elevated writes never follow a
// link: the config dir must be its own realpath and every component below it
// is lstat'ed (Deviation 11); a file is replaced by unlink + O_EXCL create.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { GuiError } = require('./errors');
const { windowsIcaclsExe, windowsPowerShellExe } = require('../platform/windows-paths');

const SID_RE = /^S-1-\d+(-\d+){1,14}$/;
const POSIX_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const ENDPOINT_RE = /^[0-9a-f]{32}$/;
const SECRET_HEX_RE = /^[0-9a-f]{64}$/;

const joinFor = (platform) => (platform === 'win32' ? path.win32.join : path.posix.join);

function mintSessionSecret() {
  return { secret: crypto.randomBytes(32), endpointId: crypto.randomBytes(16).toString('hex') };
}

const canonicalPath = (configDir) => path.join(configDir, 'session', 'helper-secret.json');

function sessionIpcDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/KingLouie/session';
  return '/var/lib/king-louie-session';
}

function endpointPath({ platform = process.platform, endpointId, ipcDir = sessionIpcDir(platform) }) {
  if (!ENDPOINT_RE.test(String(endpointId))) throw new GuiError('invalid_params', 'endpoint id must be 32 hex characters');
  if (platform === 'win32') return `\\\\.\\pipe\\king-louie-session-${endpointId}`;
  return path.posix.join(ipcDir, `${endpointId}.sock`);
}

function userCopyPath({ platform = process.platform, configDir, user, sid }) {
  const join = joinFor(platform);
  if (platform === 'win32') {
    if (!SID_RE.test(String(sid))) throw new GuiError('invalid_params', 'a Windows session user is named by its SID');
    return join(configDir, 'session', 'users', `${sid}.json`);
  }
  if (!POSIX_USER_RE.test(String(user))) throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(user)}`);
  return join(configDir, 'session', 'users', `${user}.json`);
}

// The config dir must be its own realpath (no link anywhere above it), and
// nothing from it down to `target` may be a symlink, junction or other
// reparse point (Node reports junctions as symbolic links).
function assertSafeComponents(target, { root }) {
  const resolvedRoot = path.resolve(root);
  let real;
  try {
    real = fs.realpathSync.native(resolvedRoot);
  } catch {
    throw new GuiError('unsafe_path', resolvedRoot);
  }
  // Names compare without case only where the filesystem does (Windows, macOS):
  // on Linux a link that differs from its target by case alone must not pass.
  const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
  const same = foldsCase ? real.toLowerCase() === resolvedRoot.toLowerCase() : real === resolvedRoot;
  if (!same) throw new GuiError('unsafe_path', `${resolvedRoot} resolves to ${real}`);
  const rel = path.relative(resolvedRoot, path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new GuiError('unsafe_path', `${target} is outside ${resolvedRoot}`);
  let current = resolvedRoot;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new GuiError('unsafe_path', current);
  }
}

function ensureAdminDir(dir, { root, platform }) {
  assertSafeComponents(dir, { root });
  try {
    fs.mkdirSync(dir, { mode: 0o755 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new GuiError('unsafe_path', dir);
  if (platform !== 'win32') fs.chmodSync(dir, 0o755);
}

function writeFileAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeCanonical({ configDir, cipher, secret, endpointId, nodeId, sessionUser, sessionSid = null, sessionUid = null, svcGid = null, platform = process.platform, now = Date.now() }) {
  ensureAdminDir(path.join(configDir, 'session'), { root: configDir, platform });
  const file = canonicalPath(configDir);
  assertSafeComponents(file, { root: configDir });
  const record = {
    v: 1,
    node_id: nodeId,
    endpoint_id: endpointId,
    secret: cipher.encryptString(secret.toString('hex')),
    rotated_at: new Date(now).toISOString(),
    session_user: sessionUser,
    // Who that is (R-F5-10): the SID on Windows, the uid elsewhere. The name
    // alone is not an identity.
    session_sid: sessionSid,
    session_uid: sessionUid
  };
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, 0o640);
  if (platform !== 'win32') {
    fs.chmodSync(file, 0o640);
    if (svcGid !== null) fs.chownSync(file, process.getuid(), svcGid);
  }
  return file;
}

function canonicalMtime(configDir) {
  try {
    return fs.statSync(canonicalPath(configDir)).mtimeMs;
  } catch {
    return null;
  }
}

function readCanonical({ configDir, cipher, geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1), adminUid = 0 }) {
  const file = canonicalPath(configDir);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new GuiError('session_not_installed', `${file} is missing (run "king-louie-service session install --user NAME")`);
  }
  // Required lazily: node-config.js requires this module's sibling config.js.
  const { assertAdminOwned } = require('../service/node-config');
  assertAdminOwned(file, geteuid, adminUid, { decides: 'who the session helper is', selfGrant: 'pose as the session helper' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.v !== 1 || !ENDPOINT_RE.test(String(raw.endpoint_id)) || typeof raw.node_id !== 'string' || typeof raw.session_user !== 'string') {
    throw new GuiError('session_not_installed', `${file} is malformed`);
  }
  const hex = cipher.decryptString(raw.secret);
  if (!SECRET_HEX_RE.test(hex)) throw new GuiError('session_not_installed', `${file} holds no valid secret`);
  return {
    secret: Buffer.from(hex, 'hex'),
    endpointId: raw.endpoint_id,
    nodeId: raw.node_id,
    sessionUser: raw.session_user,
    sessionSid: raw.session_sid || null,
    sessionUid: Number.isInteger(raw.session_uid) ? raw.session_uid : null,
    mtimeMs: st.mtimeMs
  };
}

const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

// Who the helper is installed for, decided without trusting the file (owner
// ruling R-F5-10). 'none': there is no file. 'installed': it records an
// identity (the SID on Windows, the uid elsewhere; never the bare name).
// 'invalid': anything else, with a reason that never quotes the file. With a
// cipher the file is also verified as the service reads it: admin-owned, it
// decrypts, and it holds a valid secret. Without one (uninstall, which must
// work with no master key) only the recorded identity is read.
// requireIdentity: false is the service's own reading (R-F5-11): it runs a
// file it can verify whether or not the file records the SID or uid.
function inspectCanonical({ configDir, platform = process.platform, cipher = null, geteuid = defaultGeteuid, adminUid = 0,
  checkOwner = cipher !== null, requireIdentity = true }) {
  const file = canonicalPath(configDir);
  const invalid = (reason) => ({ state: 'invalid', file, reason });
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    return err.code === 'ENOENT' ? { state: 'none', file } : invalid(`cannot be read (${err.code || 'error'})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) return invalid('is not a regular file');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Never the parser's own message: it quotes the text it could not parse.
    return invalid(err instanceof SyntaxError ? 'is not valid JSON' : `cannot be read (${err.code || 'error'})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1 || typeof raw.session_user !== 'string' || !raw.session_user) {
    return invalid('is malformed');
  }
  const sid = typeof raw.session_sid === 'string' && SID_RE.test(raw.session_sid) ? raw.session_sid : null;
  const uid = Number.isInteger(raw.session_uid) && raw.session_uid >= 0 ? raw.session_uid : null;
  if (requireIdentity && (platform === 'win32' ? sid : uid) === null) {
    return invalid(`does not record the ${platform === 'win32' ? 'SID' : 'uid'} it was installed for`);
  }
  if (checkOwner) {
    try {
      require('../service/node-config').assertAdminOwned(file, geteuid, adminUid, { decides: 'who the session helper is', selfGrant: 'pose as the session helper' });
    } catch {
      return invalid('is not owned by the administrator');
    }
  }
  if (cipher) {
    try {
      readCanonical({ configDir, cipher, geteuid, adminUid });
    } catch (err) {
      return invalid(err instanceof GuiError ? 'is malformed or holds no valid secret' : 'does not decrypt under this data dir\'s master key');
    }
  }
  // endpointId: only ever a well-formed one (a rotation reuses it).
  return { state: 'installed', file, user: raw.session_user, sid, uid, endpointId: ENDPOINT_RE.test(String(raw.endpoint_id)) ? raw.endpoint_id : null };
}

// The same person: the same SID on Windows, the same uid elsewhere.
function sameSessionIdentity(installed, account, platform = process.platform) {
  if (platform === 'win32') {
    return typeof installed.sid === 'string' && typeof account.sid === 'string' && installed.sid.toUpperCase() === account.sid.toUpperCase();
  }
  return Number.isInteger(installed.uid) && installed.uid === account.uid;
}

function windowsUserAclArgs(file, sid, env = process.env) {
  return [windowsIcaclsExe(env), file, '/inheritance:r', '/grant:r', `*${sid}:(R)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];
}

// The copy's owner becomes Administrators, not whichever administrator ran
// the install: the owner can always rewrite the ACL (as desktop pair does
// for its bridge file).
function windowsUserOwnerArgs(file, env = process.env) {
  return [windowsIcaclsExe(env), file, '/setowner', '*S-1-5-32-544'];
}

// The users directory inherits the config dir's protected ACL (SYSTEM,
// Administrators, LOCAL SERVICE), so the session user, who is none of them,
// could not read who owns it, and checkUserCopyTrust runs as that user: on a
// real install the helper exited session_file_insecure before it connected
// (second security review, finding 1). The user gets read-control,
// read-attributes and synchronize on the directory itself: the first two are
// what the owner read opens it with, and every CreateFile asks for the third
// as well (without it the open is still refused; the test that runs the real
// check found that). Nothing more: no (OI) or (CI), so no child inherits the
// entry, and none of the three lists, reads or writes anything in it. /grant:r
// replaces an older entry for the same SID. No traverse right is given on
// the parents: every Windows account holds "bypass traverse checking"
// unless an administrator took it away, and then nothing under the config
// dir is reachable by path for that user anyway.
function windowsUsersDirAclArgs(dir, sid, env = process.env) {
  if (!SID_RE.test(String(sid))) throw new GuiError('invalid_params', 'a Windows session user is named by its SID');
  return [windowsIcaclsExe(env), dir, '/grant:r', `*${sid}:(RC,S,RA)`];
}

// Uninstall takes that entry off again (by SID, so an account that is gone
// is removed as well).
function windowsUsersDirRevokeArgs(dir, sid, env = process.env) {
  if (!SID_RE.test(String(sid))) throw new GuiError('invalid_params', 'a Windows session user is named by its SID');
  return [windowsIcaclsExe(env), dir, '/remove:g', `*${sid}`];
}

function defaultRunIcacls(argv) {
  execFileSync(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
}

function writeUserCopy({ platform = process.platform, configDir, user, uid, gid, sid, content, runIcacls = defaultRunIcacls, env = process.env }) {
  const file = userCopyPath({ platform, configDir, user, sid });
  ensureAdminDir(path.join(configDir, 'session'), { root: configDir, platform });
  ensureAdminDir(path.dirname(file), { root: configDir, platform });
  assertSafeComponents(file, { root: configDir });
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw new GuiError('unsafe_path', file);
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
  const text = `${JSON.stringify(content, null, 2)}\n`;
  if (platform === 'win32') {
    // Windows (security review finding 3): a new file starts with the ACL it
    // inherits, so it is created empty, narrowed to this user (read),
    // SYSTEM and Administrators and given to Administrators, and only then
    // written. If any of that fails the file is removed: the secret is never
    // in a file whose ACL nobody set. The directory first (second review,
    // finding 1): the user's right to read its owner, and its owner, which
    // the helper checks. A failure there leaves no copy at all.
    const dir = path.dirname(file);
    runIcacls(windowsUsersDirAclArgs(dir, sid, env));
    runIcacls(windowsUserOwnerArgs(dir, env));
    fs.closeSync(fs.openSync(file, flags, 0o600));
    try {
      runIcacls(windowsUserAclArgs(file, sid, env));
      runIcacls(windowsUserOwnerArgs(file, env));
      const fd = fs.openSync(file, 'r+');
      try {
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      throw err;
    }
    return file;
  }
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fchownSync(fd, uid, gid);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

// What is at `target`, for a removal: nothing above it may be a link (the
// config dir is its own realpath and every directory down to the target's
// own is a real one; unsafe_path otherwise), and the entry itself is told
// apart without following it: 'none', 'file', 'link' (a symlink or a
// junction), 'dir' or 'other'.
function removalKind(target, { root }) {
  assertSafeComponents(path.dirname(target), { root });
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return 'none';
    throw err;
  }
  if (st.isSymbolicLink()) return 'link';
  if (st.isFile()) return 'file';
  return st.isDirectory() ? 'dir' : 'other';
}

// Removes what is at `target` and never follows a link: a link is removed
// itself (what it points to is not touched), a file is unlinked, and a
// directory goes with what is in it only when `recursive` says so.
function removeEntry(target, { root, recursive = false }) {
  const kind = removalKind(target, { root });
  if (kind === 'none') return false;
  if (kind === 'dir') {
    if (!recursive) throw new GuiError('unsafe_path', `${target} is a directory`);
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }
  try {
    fs.unlinkSync(target);
  } catch (err) {
    // A junction (Windows reports it as a link) is a directory entry: removed as one, never entered.
    if (kind === 'link' && (err.code === 'EPERM' || err.code === 'EISDIR')) fs.rmdirSync(target);
    else if (err.code !== 'ENOENT') throw err;
  }
  return true;
}

function removeUserCopy({ platform = process.platform, configDir, user, sid, runIcacls = defaultRunIcacls, env = process.env }) {
  const file = userCopyPath({ platform, configDir, user, sid });
  // Nothing above the copy may be a link; a link at the copy's own path is
  // removed itself, and a directory there is refused.
  const removed = removeEntry(file, { root: configDir });
  // Windows: the entry install gave this SID on the users directory goes
  // too, after the copy (the secret is what matters most) and whether or
  // not a copy was there, so a run that stopped half way is finished by the
  // next one. A directory that is not there has no entry to remove.
  if (platform === 'win32') {
    const dir = path.dirname(file);
    let st = null;
    try { st = fs.lstatSync(dir); } catch { st = null; }
    if (st && st.isDirectory() && !st.isSymbolicLink()) {
      const argv = windowsUsersDirRevokeArgs(dir, sid, env);
      try {
        runIcacls(argv);
      } catch {
        throw Object.assign(new Error(`the copy is removed, but the entry for ${sid} could not be taken off ${dir}; as an administrator run: icacls "${dir}" /remove:g *${sid}`), { aclNotRemoved: true });
      }
    }
  }
  return removed;
}

function readUserCopy({ path: file, platform = process.platform, getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1), rootUid = 0 }) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new GuiError('session_not_installed', `${file} is missing (ask the administrator to run "session install")`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new GuiError('session_file_insecure', `${file} is not a regular file`);
  if (platform !== 'win32') {
    const dir = fs.statSync(path.dirname(file));
    if (st.mode & 0o077) throw new GuiError('session_file_insecure', `${file} is readable by others (mode ${(st.mode & 0o777).toString(8)})`);
    if (st.uid !== getuid()) throw new GuiError('session_file_insecure', `${file} is not owned by this user`);
    if (dir.uid !== rootUid || (dir.mode & 0o022)) throw new GuiError('session_file_insecure', `${path.dirname(file)} is not an administrator-owned directory`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new GuiError('session_not_installed', `${file} is not valid JSON`);
  }
  if (raw.v !== 1 || typeof raw.node_id !== 'string' || typeof raw.endpoint !== 'string' || !SECRET_HEX_RE.test(String(raw.secret))) {
    throw new GuiError('session_not_installed', `${file} is malformed`);
  }
  return { secret: Buffer.from(raw.secret, 'hex'), endpoint: raw.endpoint, nodeId: raw.node_id };
}

// Windows: who owns the helper's file and its directory (security review
// finding 3). readUserCopy cannot see that (Node reports no owner there),
// and a file anyone else could put in place would point the helper at a
// service of their choosing. Both must be owned by SYSTEM or Administrators
// and neither may be a link. The read is the installers' handle-based
// inspector in a PowerShell child, so this is async and awaited, never run
// on a synchronous path. Off Windows readUserCopy checks uid and modes
// itself. alsoTrustCurrentUser: tests only, whose temp dirs they own.
const WINDOWS_ADMIN_OWNERS = Object.freeze(['S-1-5-18', 'S-1-5-32-544']);
async function checkUserCopyTrust({ path: file, platform = process.platform, env = process.env, alsoTrustCurrentUser = false,
  inspectOwners = (paths, options) => require('../desktop-bridge/pairing').inspectWindowsOwnersAsync(paths, options) } = {}) {
  if (platform !== 'win32') return;
  const dir = path.win32.dirname(file);
  const paths = [dir, file];
  let report;
  try {
    report = await inspectOwners(paths, { env });
  } catch {
    // An install older than the directory entry for this user ends here.
    throw new GuiError('session_file_insecure', `the owners of ${file} and its directory could not be read (ask the administrator to run "session install" again: it gives this user the right to read them)`);
  }
  // No evidence is not trust.
  if (!report || !Array.isArray(report.entries) || report.entries.length !== paths.length) {
    throw new GuiError('session_file_insecure', `the owners of ${file} and its directory could not be read`);
  }
  report.entries.forEach((entry, i) => {
    const what = paths[i];
    if (!entry) throw new GuiError('session_not_installed', `${what} is missing (ask the administrator to run "session install")`);
    if (entry.link) throw new GuiError('session_file_insecure', `${what} is a link`);
    const owner = typeof entry.owner === 'string' ? entry.owner : null;
    const ok = owner !== null && (WINDOWS_ADMIN_OWNERS.includes(owner) || (alsoTrustCurrentUser === true && SID_RE.test(owner) && owner === report.me));
    if (!ok) throw new GuiError('session_file_insecure', `${what} is not owned by SYSTEM or Administrators`);
  });
}

// Does the identity a helper file records still belong to an account on
// this machine? Used by "session uninstall" for an account that was deleted
// and made again under the same name: the name resolves, to another SID
// (uid), and the recorded one belongs to nobody. Only a clear "no such
// account" answers false; a check that could not run answers true, so
// nothing is removed on a guess. Read-only.
function sessionIdentityExists({ sid = null, uid = null }, { platform = process.platform,
  execFile = (f, a, o) => execFileSync(f, a, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], ...o }), env = process.env } = {}) {
  if (platform === 'win32') {
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return true;
    const script = [
      'try {',
      '  (New-Object System.Security.Principal.SecurityIdentifier($env:KL_SESSION_SID)).Translate([System.Security.Principal.NTAccount]) | Out-Null',
      "  [Console]::Out.WriteLine('mapped')",
      '} catch [System.Security.Principal.IdentityNotMappedException] {',
      "  [Console]::Out.WriteLine('unmapped')",
      '}'
    ].join('\n');
    try {
      return String(execFile(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...env, KL_SESSION_SID: sid } })).trim() !== 'unmapped';
    } catch {
      return true;
    }
  }
  if (!Number.isInteger(uid) || uid < 0) return true;
  try {
    execFile('/usr/bin/id', ['-un', String(uid)], {});
    return true;
  } catch (err) {
    // id exits 1 for a uid nobody has; anything else (id is not there, it was killed) is not an answer.
    return !(err && err.status === 1);
  }
}

function resolveSessionUser(name, { platform = process.platform, execFile = (f, a, o) => execFileSync(f, a, { encoding: 'utf8', windowsHide: true, ...o }), env = process.env, exists = fs.existsSync } = {}) {
  if (typeof name !== 'string' || !name || name.startsWith('-') || name.length > 104 || /[\u0000-\u001f"]/.test(name)) {
    throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(name)}`);
  }
  const run = (file, argv, options = {}) => {
    try {
      return String(execFile(file, argv, options));
    } catch {
      throw new GuiError('user_not_found', name);
    }
  };
  if (platform === 'win32') {
    const script = '(New-Object System.Security.Principal.NTAccount($env:KL_SESSION_USER)).Translate([System.Security.Principal.SecurityIdentifier]).Value';
    const sid = run(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...env, KL_SESSION_USER: name } }).trim();
    if (!SID_RE.test(sid)) throw new GuiError('user_not_found', name);
    return { user: name, uid: null, gid: null, home: null, sid };
  }
  if (!POSIX_USER_RE.test(name)) throw new GuiError('invalid_params', `not a user name: ${JSON.stringify(name)}`);
  const uid = Number(run('/usr/bin/id', ['-u', name]).trim());
  const gid = Number(run('/usr/bin/id', ['-g', name]).trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new GuiError('user_not_found', name);
  let home;
  if (platform === 'darwin') {
    const m = /NFSHomeDirectory:\s*(\S.*)$/m.exec(run('/usr/bin/dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory']));
    home = m ? m[1].trim() : null;
  } else {
    home = run('/usr/bin/getent', ['passwd', name]).trim().split(':')[5] || null;
  }
  if (!home || !home.startsWith('/') || !exists(home)) throw new GuiError('home_missing', `${name} has no home directory`);
  return { user: name, uid, gid, home, sid: null };
}

module.exports = {
  mintSessionSecret, canonicalPath, writeCanonical, readCanonical, canonicalMtime, inspectCanonical, sameSessionIdentity,
  userCopyPath, writeUserCopy, readUserCopy, removeUserCopy, checkUserCopyTrust, windowsUserOwnerArgs,
  windowsUsersDirAclArgs, windowsUsersDirRevokeArgs, removalKind, removeEntry, sessionIdentityExists,
  endpointPath, sessionIpcDir, assertSafeComponents, windowsUserAclArgs, resolveSessionUser
};

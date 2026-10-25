// src/service/commands/session.js
// `king-louie-service session …` (fleet stage 5 spec §7). CLI output goes to
// io.stdout/io.stderr on purpose; everything else logs via createLogger.
//   session                      run the helper (as the logged-in user)
//   session install --user NAME  (elevated) mint and write the secret, the
//                                per-user copy and the login start; rotates
//   session uninstall --user NAME
//   session status | probe
// install and uninstall say what they are about to do and ask [y/N] first
// (owner ruling R-F5-9), like "desktop pair": off a terminal they need --yes
// (exit 2), and nothing is resolved, minted, created or written before the
// answer. --dry-run asks nothing because it changes nothing.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GuiError, isGuiError } = require('../../gui/errors');

const SESSION_USAGE = `Usage: king-louie-service session [--session-file PATH]
       king-louie-service session install --user NAME [--data-dir DIR] [--dry-run] [--yes]
       king-louie-service session uninstall --user NAME [--data-dir DIR] [--dry-run] [--yes]
       king-louie-service session status [--data-dir DIR]
       king-louie-service session probe [--data-dir DIR]
`;

// More than any real store holds; a file past it is not read.
const STORE_MAX_BYTES = 64 * 1024 * 1024;

// The store's text, or null when there is no store yet. The service account
// controls every name in the data dir and this runs elevated, so the file
// is read only if it is a regular file of a sane size (second security
// review, finding 10): a link is not followed, and a pipe put there is
// neither opened to wait for a writer nor read.
function readStoreText(file, maxBytes, nothing = 'nothing was installed') {
  const refuse = (why) => new Error(`${file} ${why}; ${nothing}`);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw refuse(`cannot be checked (${err.code || 'error'})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw refuse('is not a regular file (a link, a pipe or a directory is refused)');
  if (st.size > maxBytes) throw refuse(`is larger than ${maxBytes} bytes`);
  // Between that look and this open the name can change hands. O_NOFOLLOW
  // refuses a link that appeared; O_NONBLOCK keeps the open of a pipe that
  // appeared from waiting; the open file is then checked again. (Windows has
  // neither flag, and no pipes at a path in a directory.)
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(file, flags);
  } catch (err) {
    throw refuse(`cannot be opened (${err.code || 'error'})`);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw refuse('is not a regular file (a link, a pipe or a directory is refused)');
    if (opened.size > maxBytes) throw refuse(`is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// The node's identity, read where the service's store keeps it (the dot path
// mesh.identity of <dataDir>/chat-data.json) and verified before its id is
// sealed into anything (owner ruling R-F5-12): the stored public key must be
// the public half of the stored private key, and that private key must be
// held under the master key. A record with its key in the clear is refused
// (finding 10): anyone who can write the data dir can store a key pair of
// their own that way, with no master key at all; the service puts an older
// build's plaintext key under the master key the first time it starts.
// Read-only: unlike loadIdentity it never upgrades or writes the record.
// Null when there is no identity yet; throws when there is one that does
// not hold together. This proves the id belongs to a key that whoever holds
// this data dir's master key stored. It cannot prove more: the identity
// lives only in the data dir, and no admin-owned file names it (the
// service account holds the master key). What an administrator vouched for
// is the record in the config dir (owner ruling R-F5-17,
// src/service/identity-record.js), which the caller compares this with.
// `nothing`: how the caller says that it did nothing ("nothing was installed").
function readNodeIdentity(dataDir, cipher, { maxBytes = STORE_MAX_BYTES, nothing = 'nothing was installed' } = {}) {
  const file = path.join(dataDir, 'chat-data.json');
  const text = readStoreText(file, maxBytes, nothing);
  if (text === null) return null;
  let record;
  try {
    const store = JSON.parse(text);
    record = store && store.mesh && store.mesh.identity;
  } catch {
    // Never the parser's own message: it quotes the text it could not parse.
    throw new Error(`${file} is not valid JSON; ${nothing}`);
  }
  if (!record || typeof record !== 'object' || typeof record.publicKey !== 'string' || !record.publicKey) return null;
  const { deriveNodeId } = require('../../mesh/node-identity');
  const { KEY_ENCRYPTION_MARKER } = require('../../mesh/mesh-identity');
  // The reasons never quote the record.
  const refuse = (why) => new Error(`the node identity in ${dataDir} ${why}; ${nothing}`);
  let publicKey;
  let nodeId;
  try {
    publicKey = Buffer.from(record.publicKey, 'hex');
    nodeId = deriveNodeId(publicKey);
  } catch {
    throw refuse('holds no Ed25519 public key');
  }
  if (record.keyEncryption !== KEY_ENCRYPTION_MARKER) {
    throw refuse('holds its private key in the clear, not under the master key: start the service once (it puts the key under the master key), then run this again');
  }
  let privateHex;
  try {
    privateHex = cipher.decryptString(record.encryptedPrivateKey);
  } catch {
    throw refuse('does not decrypt under this data dir\'s master key');
  }
  if (typeof privateHex !== 'string' || !privateHex) throw refuse('has no private key');
  let derived;
  try {
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(privateHex, 'hex'), format: 'der', type: 'pkcs8' });
    derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  } catch {
    throw refuse('holds an unreadable private key');
  }
  if (!derived.equals(publicKey)) throw refuse('names a public key that is not its private key\'s');
  return { nodeId, publicKey: publicKey.toString('hex') };
}

// The node identity of a data dir, for an administrator's command: the data
// dir must be a real directory, the master key is resolved read-only with
// the data dir's owner uid (R-F5-12: a key file its owner does not own is
// refused, as "import --from" reads it; Windows has no uid, its key is
// DPAPI-wrapped), and the identity is verified against it (readNodeIdentity).
// Reads only. → { nodeId, publicKey, cipher }.
function resolveNodeIdentity({ dataDir, platform = process.platform, deps = {}, nothing = 'nothing was installed' }) {
  let dirStat;
  try {
    dirStat = fs.lstatSync(dataDir);
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `${dataDir} does not exist: start the service once first` : `cannot check ${dataDir}: ${err.message}`);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`${dataDir} is not a directory (links are refused)`);
  const ownerUid = deps.dataDirOwnerUid !== undefined ? deps.dataDirOwnerUid : (platform === 'win32' ? null : dirStat.uid);
  const resolveKey = deps.resolveKey || ((uid) => require('../../platform/master-key').resolveMasterKeyReadOnly({ platform, dataDir, dataDirOwnerUid: uid }));
  const resolved = resolveKey(ownerUid);
  if (!resolved) throw new Error(`no master key for ${dataDir}: start the service once first`);
  (deps.verifyKey || ((r) => require('../../platform/master-key').verifyKeyCheck({ dataDir, key: r.key, source: r.source, create: false })))(resolved);
  const cipher = require('../../platform/cipher').createAesGcmCipher(resolved.key);
  const nodeIdentity = readNodeIdentity(dataDir, cipher, { nothing });
  if (!nodeIdentity) throw new Error(`no node identity in ${dataDir}: start the service once first`);
  return { ...nodeIdentity, cipher };
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  return Buffer.concat(chunks).toString('utf8');
}

function common(dataDir, deps, io) {
  const { adminConfigDir } = require('../../platform/paths');
  const platform = deps.platform || process.platform;
  const configDir = deps.configDir || adminConfigDir({ platform, dataDir });
  return {
    platform,
    configDir,
    // R-F5-14: whether node.yaml enables desktop apps (null when it cannot be read).
    guiEnabled: deps.guiEnabled || (() => {
      try {
        const gui = require('../node-config').loadNodeConfig({
          dataDir, adminConfigDir: configDir,
          ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid }),
          ...(deps.geteuid ? { geteuid: deps.geteuid } : {})
        }).gui;
        return Boolean(gui && gui.enabled === true);
      } catch {
        return null;
      }
    }),
    isTTY: deps.isTTY || (() => Boolean(io && io.stdin && io.stdin.isTTY)),
    confirm: deps.confirm || ((question) => require('./desktop').defaultConfirm(io, question)),
    // node.yaml is the admin's; a file that fails its owner check throws.
    nodeName: deps.nodeName || (() => require('../node-config').loadNodeConfig({
      dataDir, adminConfigDir: configDir,
      ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid }),
      ...(deps.geteuid ? { geteuid: deps.geteuid } : {})
    }).name),
    entryPath: deps.entryPath || path.resolve(__dirname, '..', '..', '..', 'bin', 'king-louie-service.js'),
    nodePath: deps.nodePath || process.execPath,
    execute: deps.execute || ((steps, opts) => require('../../session/autostart').executeAutostartSteps(steps, opts)),
    isAdmin: deps.isAdmin || (() => require('./admin-check').isAdmin({ platform })),
    // options.singleUser: false for uninstall, which must still resolve
    // what an older install was made for.
    resolveUser: deps.resolveSessionUser || ((name, options = {}) => require('../../gui/session-secret').resolveSessionUser(name, { platform, ...options }))
  };
}

// R-F5-14: installing the helper enables nothing; node.yaml does.
const NOT_ENABLED = (configDir) => `installed but not enabled in node.yaml: desktop apps stay off until ${path.join(configDir, 'node.yaml')} has\n  ${require('../../gui/config').GUI_ENABLE_LINES.replace(/\n/g, '\n  ')}\nand the service is restarted`;

// The installers' check of the Windows config dir (WINDOWS_CONFIG_DIRS_SCRIPT:
// framework types only, the path in an environment variable). Throws with
// the script's own one-line reason.
function verifyWindowsConfigDir(configDir) {
  const { execFileSync } = require('child_process');
  const { WINDOWS_CONFIG_DIRS_SCRIPT } = require('../installers');
  const { windowsPowerShellExe } = require('../../platform/windows-paths');
  try {
    execFileSync(windowsPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CONFIG_DIRS_SCRIPT], {
      env: { ...process.env, KL_CONFIG_DIR: configDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true
    });
  } catch (err) {
    const first = String(err.stderr || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    throw new Error(first || `the config dir ${configDir} could not be verified (${err.code || 'powershell failed'})`);
  }
}

// Text this command did not write (what the helper reported about itself,
// what a status file or the helper file holds) goes to the terminal only
// through this: one clean line, or marked as altered (second security
// review, finding 13). See commands/io.js.
const shown = (value, max) => require('./io').shown(value, max);
const shownList = (list) => (Array.isArray(list) ? list : []).map((v) => shown(v, 64)).join(', ');

// Windows account names are compared case-insensitively and stored bare.
const bareName = (name, platform) => (platform === 'win32' ? String(name).split('\\').pop() : String(name));

// The account's identity as the consent text shows it: the SID on Windows,
// the uid elsewhere. The name alone does not say who it is.
const identityText = (account, platform) => (platform === 'win32' ? `SID ${account.sid}` : `uid ${account.uid}`);

function loginStartText({ platform, account, sessionUser }) {
  const A = require('../../session/autostart');
  if (platform === 'win32') return `the logon task "${A.windowsTaskName(sessionUser)}"`;
  return `${platform === 'darwin' ? 'the LaunchAgent' : 'the autostart entry'} ${A.autostartPath({ platform, home: account.home })}`;
}

// Windows: the session user runs `king-louie-service mcp`, which posts to the
// service through the file courier under the data dir; install gives that
// user modify on these two directories and uninstall takes it off again.
const COURIER_TEXT = 'the service\'s courier (approvals\\outbox, approvals\\inbox)';
const courierDirs = (dataDir) => [path.join(dataDir, 'approvals', 'outbox'), path.join(dataDir, 'approvals', 'inbox')];

// After consent: the courier directories, created (0700, the service makes
// them so too) when missing. A link or anything but a directory at one is
// refused, so the grant never lands on what a link points to.
function ensureCourierDirs(dataDir) {
  for (const dir of [path.join(dataDir, 'approvals'), ...courierDirs(dataDir)]) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new GuiError('unsafe_path', `${dir} is not a directory (links are refused)`);
  }
  return courierDirs(dataDir);
}

// The courier directories uninstall asks icacls about: only real ones (a
// missing one holds no entry, and a link is never followed).
function existingCourierDirs(dataDir) {
  return courierDirs(dataDir).filter((dir) => {
    try {
      const st = fs.lstatSync(dir);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

// R-F5-9: off a terminal nobody can be asked, so only --yes goes on. Checked
// before anything is resolved or read (as "desktop pair" does).
function refusedUnasked({ flags, io, c, verb }) {
  if (flags.dryRun || flags.yes || c.isTTY()) return false;
  io.stderr.write(`Refusing to ${verb} the session helper without confirmation on a non-interactive terminal; pass --yes.\n`);
  return true;
}

// Only an explicit yes (or --yes) is consent.
async function consented({ flags, c, question }) {
  if (flags.yes) return true;
  return (await c.confirm(question)) === true;
}

async function install({ flags, dataDir, io, deps }) {
  const S = require('../../gui/session-secret');
  const A = require('../../session/autostart');
  const c = common(dataDir, deps, io);
  if (!flags.user) { io.stderr.write(SESSION_USAGE); return 2; }
  if (!c.isAdmin()) { io.stderr.write('session install needs root (or an elevated Administrator prompt on Windows).\n'); return 1; }
  if (refusedUnasked({ flags, io, c, verb: 'install' })) return 2;
  // Everything from here to the question only reads.
  const account = c.resolveUser(flags.user);
  // Third security review, finding 4: one user account, never a group or a
  // built-in identity (the helper's file is made readable by this SID). The
  // resolver refuses by what the lookup says the name is; this is the SID's
  // form again, whoever resolved it. Before the question; nothing is written.
  if (c.platform === 'win32') S.assertSingleUserAccount(account, c.platform);
  const sessionUser = bareName(flags.user, c.platform);
  // R-F5-12: the service account controls every name in the data dir, so a
  // key file there counts only when the data dir's owner owns it, and the
  // identity is verified against that key before its id is sealed.
  const { nodeId, publicKey, cipher } = resolveNodeIdentity({ dataDir, platform: c.platform, deps });
  // R-F5-17: and it must be the identity an administrator recorded
  // ("king-louie-service identity record"). The identity above only proves
  // that whoever holds this data dir's master key stored it, which the
  // service account does. No record, another identity, or a record that
  // cannot be trusted: refused before the question, with nothing written.
  const recorded = require('../identity-record').checkNodeIdentityRecord({
    configDir: c.configDir, dataDir, identity: { nodeId, publicKey }, platform: c.platform, serviceProbe: false,
    ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid }), ...(deps.identityRecord || {})
  });
  if (recorded.state !== 'match') throw new Error(`${recorded.problem}. Nothing was installed.`);
  // R-F5-10: who is installed is the recorded SID (uid off Windows), never
  // the name, and a file that cannot say so refuses the install. Checked with
  // the cipher, so "installed" means what the service itself would accept.
  const installed = S.inspectCanonical({
    configDir: c.configDir, platform: c.platform, cipher,
    ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid }), ...(deps.geteuid ? { geteuid: deps.geteuid } : {})
  });
  if (installed.state === 'invalid') {
    throw new GuiError('session_file_invalid', `${installed.file} ${installed.reason}, so this cannot tell who the helper is installed for; run "session uninstall --user NAME" to clear it, or fix the file, then install again`);
  }
  if (installed.state === 'installed' && !S.sameSessionIdentity(installed, account, c.platform)) {
    throw new GuiError('session_user_mismatch', `installed for "${shown(installed.user)}" (${identityText(installed, c.platform)}), not ${sessionUser} (${identityText(account, c.platform)}); run "session uninstall --user ${shown(installed.user)}" first`);
  }
  const rotates = installed.state === 'installed';

  const ipcDir = deps.ipcDir || S.sessionIpcDir(c.platform);
  const sessionFile = S.userCopyPath({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: account.sid });
  const steps = A.planAutostartInstall({ platform: c.platform, account: { ...account, user: sessionUser }, nodePath: c.nodePath, entryPath: c.entryPath, sessionFile });

  if (flags.dryRun) {
    io.stdout.write(`[dry-run] write ${S.canonicalPath(c.configDir)} (node ${nodeId}, user ${sessionUser})\n`);
    io.stdout.write(`[dry-run] write ${sessionFile}\n`);
    if (c.platform === 'win32') io.stdout.write(`[dry-run] give ${account.sid} read-control, read-attributes and synchronize on ${path.dirname(sessionFile)} (that directory only)\n`);
    if (c.platform === 'win32') {
      for (const dir of courierDirs(dataDir)) io.stdout.write(`[dry-run] give ${account.sid} modify on ${dir} (created if missing)\n`);
    }
    if (c.platform !== 'win32') io.stdout.write(`[dry-run] create ${ipcDir} (0711, owned by the service account)\n`);
    await c.execute(steps, { dryRun: true, io, entryPath: c.entryPath, nodePath: c.nodePath });
    return 0;
  }

  // R-F5-9: what is about to be granted, then the question. Nothing has been
  // minted, created or written yet.
  io.stdout.write(`Session helper for node "${c.nodeName()}" (${nodeId}):\n`);
  io.stdout.write(`  session user: ${sessionUser} (${identityText(account, c.platform)})\n`);
  io.stdout.write(`  grants: a helper that runs as ${sessionUser} in ${sessionUser}'s desktop session. Through it this node's service can launch the apps in gui.apps, capture their windows and, under a lease signed on the owner's phone, click and type in them.\n`);
  io.stdout.write(`  starts at every login of ${sessionUser}: ${loginStartText({ platform: c.platform, account, sessionUser })}\n`);
  io.stdout.write(`  writes: ${S.canonicalPath(c.configDir)} (the service's secret) and ${sessionFile} (${sessionUser}'s copy)${c.platform === 'win32' ? '' : `; creates ${ipcDir}`}\n`);
  // Windows (second review, finding 1): the helper, running as this user,
  // checks who owns its file and the directory it is in before it trusts
  // either, and the directory's ACL would not let it look.
  if (c.platform === 'win32') io.stdout.write(`  lets ${sessionUser} read who owns ${path.dirname(sessionFile)} (its owner and attributes; nothing in it, and no other directory)\n`);
  if (c.platform === 'win32') io.stdout.write(`  lets ${sessionUser} post requests to ${COURIER_TEXT}\n`);
  if (rotates) io.stdout.write(`  replaces the secret installed for ${shown(installed.user)}; the endpoint stays, so a running service and helper pick the new secret up without a restart\n`);
  if (!(await consented({ flags, c, question: `Install the session helper for ${sessionUser}? [y/N] ` }))) {
    io.stderr.write('Not installing without confirmation. Nothing was written.\n');
    return 1;
  }

  // A rotation keeps the endpoint and changes only the secret (security
  // review finding 6): the running service listens on the endpoint it
  // started with, so a new endpoint id would leave the helper with nowhere
  // to reconnect to until the service restarted. Only for the same identity
  // and a file that verified above (R-F5-10); anything else gets a new one.
  // Windows (security review finding 3): the config dir the secret goes
  // into must be the administrators' (owner and ACL, and no link or foreign
  // owner above it): the installers' own create-or-verify check. After
  // consent, because it creates the directory when it is missing.
  if (c.platform === 'win32') {
    try {
      (deps.verifyConfigDir || verifyWindowsConfigDir)(c.configDir);
    } catch (err) {
      throw new Error(`${String(err.message).replace(/[\s.]+$/, '')}. Nothing was written.`);
    }
  }
  const minted = S.mintSessionSecret();
  const secret = minted.secret;
  const endpointId = rotates && installed.endpointId ? installed.endpointId : minted.endpointId;
  const endpoint = S.endpointPath({ platform: c.platform, endpointId, ipcDir });
  let svc = null;
  if (c.platform !== 'win32') {
    const st = fs.statSync(dataDir);
    svc = { uid: st.uid, gid: st.gid };
    try {
      fs.mkdirSync(ipcDir, { recursive: true, mode: 0o711 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const ist = fs.lstatSync(ipcDir);
    if (ist.isSymbolicLink() || !ist.isDirectory()) throw new GuiError('unsafe_path', ipcDir);
    fs.chownSync(ipcDir, svc.uid, svc.gid);
    fs.chmodSync(ipcDir, 0o711);
  }
  S.writeCanonical({ configDir: c.configDir, cipher, secret, endpointId, nodeId, sessionUser, sessionSid: account.sid || null, sessionUid: c.platform === 'win32' ? null : account.uid, svcGid: svc ? svc.gid : null, platform: c.platform });
  S.writeUserCopy({
    platform: c.platform, configDir: c.configDir, user: sessionUser, uid: account.uid, gid: account.gid, sid: account.sid,
    content: { v: 1, node_id: nodeId, endpoint, secret: secret.toString('hex'), rotated_at: new Date().toISOString() },
    ...(deps.runIcacls ? { runIcacls: deps.runIcacls } : {})
  });
  if (c.platform === 'win32') {
    const runIcacls = deps.runIcacls || S.defaultRunIcacls;
    for (const dir of ensureCourierDirs(dataDir)) {
      try {
        runIcacls(S.windowsCourierAclArgs(dir, account.sid));
      } catch (err) {
        throw new Error(`${account.sid} could not be given modify on ${dir} (${err.message}); the helper files are written but the login start is not: run "session install --user ${sessionUser}" again`);
      }
    }
  }
  await c.execute(steps, { dryRun: false, io, entryPath: c.entryPath, nodePath: c.nodePath });
  io.stdout.write(`Session helper installed for ${sessionUser} (node ${nodeId}).\n`);
  io.stdout.write(`  service secret: ${S.canonicalPath(c.configDir)}\n  user copy:      ${sessionFile}\n  endpoint:       ${endpoint}\n`);
  io.stdout.write(rotates
    ? 'The secret was rotated and the endpoint kept. A running service drops the helper\'s connection at its next check (about 10 seconds) and takes only the new secret; the helper reads its new file when it reconnects (its retries are 1 to 30 seconds apart). no restart is needed. A service that was not running, or that started with desktop apps off, needs a start as usual.\n'
    : 'Restart the King Louie service so it starts waiting for the helper.\n');
  if (c.guiEnabled() !== true) io.stdout.write(`${NOT_ENABLED(c.configDir)}\n`);
  if (c.platform === 'darwin') {
    io.stdout.write(`At the next login macOS asks for Screen Recording and Accessibility for ${c.nodePath}. Those permissions cover every script ${sessionUser} runs with that node binary.\n`);
  }
  return 0;
}

async function uninstall({ flags, dataDir, io, deps }) {
  const S = require('../../gui/session-secret');
  const A = require('../../session/autostart');
  const c = common(dataDir, deps, io);
  if (!flags.user) { io.stderr.write(SESSION_USAGE); return 2; }
  if (!c.isAdmin()) { io.stderr.write('session uninstall needs root (or an elevated Administrator prompt on Windows).\n'); return 1; }
  if (refusedUnasked({ flags, io, c, verb: 'remove' })) return 2;
  const sameName = (a, b) => (c.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  // R-F5-10: by identity, and with no master key (uninstall must work
  // without one). Everything from here to the question only reads.
  const installed = S.inspectCanonical({ configDir: c.configDir, platform: c.platform });
  // Windows: --user may be the SID the helper file records, exactly. That
  // names the installed identity itself, with nothing to resolve (third
  // security review, finding 5: the way to remove an install whose account
  // no domain controller can vouch for or against).
  const bySid = c.platform === 'win32' && installed.state === 'installed' && typeof installed.sid === 'string'
    && String(flags.user).trim().toUpperCase() === installed.sid.toUpperCase();
  const sessionUser = bySid ? installed.user : bareName(flags.user, c.platform);
  const recordedForName = installed.state === 'installed' && sameName(installed.user, sessionUser);
  // An account that no longer exists cannot be resolved (security review
  // finding 13e), and must not leave the node unable to install anyone
  // else: when the helper file records that name, its recorded SID (uid) is
  // the identity to remove. Any other name is still user_not_found.
  let account;
  let gone = false;
  if (bySid) account = { user: sessionUser, sid: installed.sid, uid: null, gid: null, home: null };
  else {
    try {
      account = c.resolveUser(flags.user, { singleUser: false });
    } catch (err) {
      if (!isGuiError(err) || !['user_not_found', 'home_missing'].includes(err.code)) throw err;
      if (!recordedForName) throw err;
      account = { user: sessionUser, sid: installed.sid, uid: installed.uid, gid: null, home: null };
      gone = true;
    }
  }
  const mine = installed.state === 'installed' && S.sameSessionIdentity(installed, account, c.platform);
  // A helper file that cannot say who it was installed for is removed too,
  // so a damaged file never leaves the owner unable to install.
  const damaged = installed.state === 'invalid';
  // The account was deleted and made again under the same name (second
  // security review, finding 11): the name resolves, to another SID (uid),
  // and the one the helper file records belongs to nobody. Without this,
  // install said "uninstall alice first" and uninstall said "that is not
  // alice's": no way out but deleting files by hand. Only when the recorded
  // identity is provably gone; an account of the same name that still
  // exists (another domain's, say) keeps its install and is named exactly.
  // Third security review, finding 5: "provably" is a SID of this machine's
  // own accounts that maps to nothing. A domain account's SID that does not
  // resolve may only mean no domain controller is reachable: its install
  // stays until the owner names the recorded identity exactly.
  const identityState = deps.identityState
    || (deps.identityExists ? (identity) => (deps.identityExists(identity) ? 'exists' : 'gone') : (identity) => S.sessionIdentityState(identity, { platform: c.platform }));
  const otherIdentity = !gone && recordedForName && !mine ? identityState({ sid: installed.sid, uid: installed.uid }) : null;
  const stale = otherIdentity === 'gone' ? { user: sessionUser, sid: installed.sid, uid: installed.uid } : null;
  const whyKept = otherIdentity === 'unresolved'
    ? ` (recorded for the same name under an identity that could not be resolved; it may be a domain account with no domain controller in reach. To remove it, name that identity exactly: ${c.platform === 'win32' ? `--user ${installed.sid}, or the name with its domain` : 'the name as its directory knows it, with the directory in reach'})`
    : ' (another account of the same name, which still exists: name it with its domain or machine to remove it)';
  const removesCanonical = mine || damaged || stale !== null;
  // A login start in a home directory is removed by a child running as that
  // user; for a user who is gone there is nobody to run as and no home to
  // look in. The Windows logon task is deleted by name.
  const unreachableLoginStart = gone && c.platform !== 'win32';
  const steps = unreachableLoginStart ? [] : A.planAutostartUninstall({ platform: c.platform, account: { ...account, user: sessionUser } });
  // Every copy this removes: this account's, and the one of the identity
  // the helper file records under the same name (the same file off Windows,
  // where a copy is named by the user; another on Windows, named by SID).
  const copies = [];
  for (const who of [account, ...(stale ? [stale] : [])]) {
    const file = S.userCopyPath({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: who.sid });
    if (!copies.some((x) => x.file === file)) copies.push({ who, file });
  }
  // Checked before anything is removed, and again just before the removal:
  // no link above any path this touches (unsafe_path), and no directory
  // where a copy should be. A refusal removes nothing. A link at a path
  // itself is not a refusal: the link is removed, never what it points to.
  const preflight = () => {
    for (const { file } of copies) {
      if (['dir', 'other'].includes(S.removalKind(file, { root: c.configDir }))) throw new GuiError('unsafe_path', `${file} is not a file`);
    }
    if (removesCanonical) S.removalKind(installed.file, { root: c.configDir });
  };
  try {
    preflight();
  } catch (err) {
    if (!isGuiError(err)) throw err;
    io.stderr.write(`${err.message}\nNothing was removed.\n`);
    return 1;
  }

  if (flags.dryRun) {
    // Everything the real run removes, and what it leaves.
    for (const { who, file } of copies) {
      io.stdout.write(`[dry-run] remove ${file}\n`);
      if (c.platform === 'win32') {
        io.stdout.write(`[dry-run] remove the entry for ${who.sid} from the ACL of ${path.dirname(file)}\n`);
        for (const dir of existingCourierDirs(dataDir)) io.stdout.write(`[dry-run] remove the entry for ${who.sid} from the ACL of ${dir}\n`);
      }
    }
    if (mine) io.stdout.write(`[dry-run] remove ${installed.file} (the service's secret)\n`);
    else if (stale) io.stdout.write(`[dry-run] remove ${installed.file} (the service's secret, recorded for ${shown(installed.user)} under ${identityText(installed, c.platform)}, an identity that no longer exists here)\n`);
    else if (damaged) io.stdout.write(`[dry-run] remove ${installed.file} (it ${installed.reason}, so it cannot say who it was installed for)\n`);
    else if (installed.state === 'installed') io.stdout.write(`[dry-run] keep ${installed.file}: it is installed for "${shown(installed.user)}" (${identityText(installed, c.platform)}), not for this user${recordedForName ? whyKept : ''}\n`);
    if (unreachableLoginStart) io.stdout.write(`[dry-run] leave the login start in ${sessionUser}'s home directory (there is no such user to remove it as)\n`);
    await c.execute(steps, { dryRun: true, io, entryPath: c.entryPath, nodePath: c.nodePath });
    return 0;
  }

  // R-F5-9: what is about to be removed, then the question.
  let nodeName = null;
  try { nodeName = c.nodeName(); } catch { nodeName = null; } // a bad node.yaml must not block a removal
  io.stdout.write(`Removing the session helper of ${sessionUser} (${identityText(account, c.platform)})${nodeName ? ` on node "${nodeName}"` : ''}:\n`);
  if (gone) io.stdout.write(`  ${sessionUser} no longer exists on this machine; this removes what the helper file records for that name\n`);
  if (unreachableLoginStart) io.stdout.write(`  the login start in ${sessionUser}'s home directory could not be removed (there is no such user to remove it as); it does nothing without the files below\n`);
  else io.stdout.write(`  the login start: ${loginStartText({ platform: c.platform, account, sessionUser })}\n`);
  for (const { file } of copies) {
    io.stdout.write(`  ${sessionUser}'s copy of the secret: ${file}\n`);
    if (c.platform === 'win32') io.stdout.write(`  ${sessionUser}'s right to read who owns ${path.dirname(file)}\n`);
  }
  if (c.platform === 'win32') io.stdout.write(`  ${sessionUser}'s right to post requests to ${COURIER_TEXT}\n`);
  if (stale) io.stdout.write(`  the helper file records ${sessionUser} under another identity (${identityText(stale, c.platform)}) that no longer exists on this machine: the account was deleted and made again. What was installed for it is removed with this.\n`);
  if (mine || stale) io.stdout.write(`  the service's secret: ${installed.file} (desktop apps stay off on this node until "session install" runs again)\n`);
  if (damaged) io.stdout.write(`  the service's helper file: ${installed.file} ${installed.reason}, so this cannot tell who it was installed for; it is removed too. If it was installed for another user, run "session uninstall" for that user as well.\n`);
  if (installed.state === 'installed' && !removesCanonical) {
    io.stdout.write(`  ${installed.file} stays: it is installed for "${shown(installed.user)}" (${identityText(installed, c.platform)}), not for this user${recordedForName ? whyKept : ''}\n`);
  }
  if (!(await consented({ flags, c, question: `Remove the session helper for ${sessionUser}? [y/N] ` }))) {
    io.stderr.write('Not removing without confirmation. Nothing was removed.\n');
    return 1;
  }
  // Again, now: the question took time.
  try {
    preflight();
  } catch (err) {
    if (!isGuiError(err)) throw err;
    io.stderr.write(`${err.message}\nNothing was removed.\n`);
    return 1;
  }
  if (steps.length) await c.execute(steps, { dryRun: false, io, entryPath: c.entryPath, nodePath: c.nodePath });
  // Windows: each copy, then the entry install gave its SID on the users
  // directory, then its entries on the courier directories (which stay: they
  // are the service's). If only such entries stay behind, the rest is still
  // removed and the command says what is left and how to remove it.
  const aclLeft = [];
  for (const { who } of copies) {
    try {
      S.removeUserCopy({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: who.sid, ...(deps.runIcacls ? { runIcacls: deps.runIcacls } : {}) });
    } catch (err) {
      if (!err || err.aclNotRemoved !== true) throw err;
      aclLeft.push(err.message);
    }
    if (c.platform !== 'win32') continue;
    const runIcacls = deps.runIcacls || S.defaultRunIcacls;
    for (const dir of existingCourierDirs(dataDir)) {
      try {
        runIcacls(S.windowsCourierRevokeArgs(dir, who.sid));
      } catch {
        aclLeft.push(`the entry for ${who.sid} could not be taken off ${dir}; as an administrator run: icacls "${dir}" /remove:g *${who.sid}`);
      }
    }
  }
  // Never follows a link: a link is removed itself, a directory (a damaged
  // helper "file" can be one) with what is in it.
  if (removesCanonical) S.removeEntry(installed.file, { root: c.configDir, recursive: damaged });
  if (aclLeft.length) {
    io.stderr.write(`Session helper removed for ${sessionUser}, except ${aclLeft.length === 1 ? 'one directory permission' : `${aclLeft.length} directory permissions`}: ${aclLeft.join('; ')}\n`);
    return 1;
  }
  io.stdout.write(`Session helper removed for ${sessionUser}.\n`);
  return 0;
}

function printProbes(io, probes) {
  for (const p of Array.isArray(probes) ? probes : []) {
    if (p === null || typeof p !== 'object') continue;
    io.stdout.write(`  ${shown(p.check, 64)}: ${p.ok === true ? 'ok' : `missing — ${p.hint ? shown(p.hint) : 'no hint'}`}\n`);
  }
}

async function status({ dataDir, io, deps }) {
  const c = common(dataDir, deps, io);
  const record = (deps.readStatus || ((d) => require('../../gui/status').readGuiStatusRecord({ dataDir: d })))(dataDir);
  const installed = require('../../gui/session-secret').inspectCanonical({ configDir: c.configDir, platform: c.platform });
  if (installed.state === 'installed') {
    io.stdout.write(`installed for: ${shown(installed.user)} (${identityText(installed, c.platform)})\n`);
    if (c.guiEnabled() === false) io.stdout.write(`${NOT_ENABLED(c.configDir)}\n`);
  }
  else if (installed.state === 'invalid') io.stdout.write(`installed, but ${installed.file} ${installed.reason}: run "session uninstall --user NAME", then "session install --user NAME"\n`);
  else io.stdout.write('not installed (session install --user NAME)\n');
  if (!record) {
    io.stdout.write('helper: no running service reports a session helper\n');
    return 0;
  }
  if (!record.available && typeof record.reason === 'string' && record.reason) {
    // R-F5-11: the running service turned desktop apps off, and why.
    const { remedyFor } = require('../../gui/status');
    io.stdout.write(`helper: off (${shown(record.reason)})${record.detail ? `: ${shown(record.detail)}` : ''}\n`);
    io.stdout.write(`  to fix it, ${remedyFor(record.reason)}\n`);
    return 0;
  }
  // From here on every value is the helper's word or the file's: shown, never printed raw.
  io.stdout.write(`helper: ${record.available ? `connected (${shown(record.user, 64)}, ${shown(record.platform, 64)})` : 'not connected'}\n`);
  if (record.available) io.stdout.write(`capabilities: ${shownList(record.capabilities) || 'none'}\n`);
  if (Array.isArray(record.limits) && record.limits.length) io.stdout.write(`limits: ${shownList(record.limits)}\n`);
  printProbes(io, record.probes);
  if (record.lease) io.stdout.write(`lease: ${record.lease.active === true ? 'active' : 'not active'} (${shownList(record.lease.app_ids)})\n`);
  return 0;
}

async function probe({ dataDir, io, deps }) {
  const record = (deps.readStatus || ((d) => require('../../gui/status').readGuiStatusRecord({ dataDir: d })))(dataDir);
  if (record && record.available) {
    io.stdout.write(`probe report from the running helper (${shown(record.user, 64)}, ${shown(record.platform, 64)}):\n`);
    io.stdout.write(`capabilities: ${shownList(record.capabilities) || 'none'}\n`);
    printProbes(io, record.probes);
    return 0;
  }
  const localProbe = deps.localProbe || (async () => {
    const { selectBackend, loadBackend, NO_BACKEND_REPORT } = require('../../session/backends');
    const name = selectBackend({});
    if (!name) return NO_BACKEND_REPORT('no desktop session in this shell');
    const backend = loadBackend(name, {});
    try { return await backend.probe(); } finally { await backend.stop(); }
  });
  const r = await localProbe();
  io.stdout.write('local probe from this shell, not the running helper:\n');
  io.stdout.write(`capabilities: ${shownList(r.capabilities) || 'none'}\n`);
  printProbes(io, r.probes);
  return 0;
}

async function runHelperFromCli({ flags, deps }) {
  const runHelper = deps.runHelper || ((opts) => require('../../session/helper').runSessionHelper(opts));
  const ac = new AbortController();
  const stop = () => ac.abort();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, stop);
  try {
    return await runHelper({ sessionFile: flags.sessionFile || null, signal: ac.signal });
  } finally {
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(sig, stop);
  }
}

async function runSessionCommand({ sub, arg, flags = {}, dataDir, io, deps = {} }) {
  try {
    switch (sub) {
      case undefined: return await runHelperFromCli({ flags, deps });
      case 'install': return await install({ flags, dataDir, io, deps });
      case 'uninstall': return await uninstall({ flags, dataDir, io, deps });
      case 'status': return await status({ dataDir, io, deps });
      case 'probe': return await probe({ dataDir, io, deps });
      // Internal: the user-home writer, spawned as the target user by install.
      case '_write-autostart': {
        const content = await readStdin(deps.stdin || io.stdin || process.stdin);
        require('../../session/autostart').writeAutostartFile({ file: arg, content });
        return 0;
      }
      case '_remove-autostart':
        require('../../session/autostart').removeAutostartFile({ file: arg });
        return 0;
      default:
        io.stderr.write(SESSION_USAGE);
        return 2;
    }
  } catch (err) {
    io.stderr.write(`${isGuiError(err) ? err.message : `Error: ${err.message}`}\n`);
    return 1;
  }
}

module.exports = { runSessionCommand, readNodeIdentity, resolveNodeIdentity, verifyWindowsConfigDir, SESSION_USAGE, STORE_MAX_BYTES };

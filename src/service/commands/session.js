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

// The node's identity, read where the service's store keeps it (the dot path
// mesh.identity of <dataDir>/chat-data.json) and verified before its id is
// sealed into anything (owner ruling R-F5-12): the stored public key must be
// the public half of the stored private key, which is held under the master
// key (or in the clear, by an older build). Read-only: unlike loadIdentity it
// never upgrades or writes the record. Null when there is no identity yet;
// throws when there is one that does not hold together. This proves the id
// belongs to the key this data dir signs with. It cannot prove more: the
// identity lives only in the data dir, and no admin-owned file names it.
function readNodeIdentity(dataDir, cipher) {
  let record;
  try {
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8'));
    record = store && store.mesh && store.mesh.identity;
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || typeof record.publicKey !== 'string' || !record.publicKey) return null;
  const { deriveNodeId } = require('../../mesh/node-identity');
  const { KEY_ENCRYPTION_MARKER } = require('../../mesh/mesh-identity');
  // The reasons never quote the record.
  const refuse = (why) => new Error(`the node identity in ${dataDir} ${why}; nothing was installed`);
  let publicKey;
  let nodeId;
  try {
    publicKey = Buffer.from(record.publicKey, 'hex');
    nodeId = deriveNodeId(publicKey);
  } catch {
    throw refuse('holds no Ed25519 public key');
  }
  let privateHex = record.privateKey;
  if (record.keyEncryption === KEY_ENCRYPTION_MARKER) {
    try {
      privateHex = cipher.decryptString(record.encryptedPrivateKey);
    } catch {
      throw refuse('does not decrypt under this data dir\'s master key');
    }
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
  return { nodeId };
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
    resolveUser: deps.resolveSessionUser || ((name) => require('../../gui/session-secret').resolveSessionUser(name, { platform }))
  };
}

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
  const sessionUser = bareName(flags.user, c.platform);
  let dirStat;
  try {
    dirStat = fs.lstatSync(dataDir);
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `${dataDir} does not exist: start the service once first` : `cannot check ${dataDir}: ${err.message}`);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`${dataDir} is not a directory (links are refused)`);
  // R-F5-12: the service account controls every name in the data dir, so a
  // key file there counts only when the data dir's owner owns it (as
  // "import --from" reads it). Windows has no uid; its key is DPAPI-wrapped.
  const ownerUid = deps.dataDirOwnerUid !== undefined ? deps.dataDirOwnerUid : (c.platform === 'win32' ? null : dirStat.uid);
  const resolveKey = deps.resolveKey || ((uid) => require('../../platform/master-key').resolveMasterKeyReadOnly({ platform: c.platform, dataDir, dataDirOwnerUid: uid }));
  const resolved = resolveKey(ownerUid);
  if (!resolved) throw new Error(`no master key for ${dataDir}: start the service once first`);
  (deps.verifyKey || ((r) => require('../../platform/master-key').verifyKeyCheck({ dataDir, key: r.key, source: r.source, create: false })))(resolved);
  const cipher = require('../../platform/cipher').createAesGcmCipher(resolved.key);
  const nodeIdentity = readNodeIdentity(dataDir, cipher);
  if (!nodeIdentity) throw new Error(`no node identity in ${dataDir}: start the service once first`);
  const { nodeId } = nodeIdentity;
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
    throw new GuiError('session_user_mismatch', `installed for "${installed.user}" (${identityText(installed, c.platform)}), not ${sessionUser} (${identityText(account, c.platform)}); run "session uninstall --user ${installed.user}" first`);
  }
  const rotates = installed.state === 'installed';

  const ipcDir = deps.ipcDir || S.sessionIpcDir(c.platform);
  const sessionFile = S.userCopyPath({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: account.sid });
  const steps = A.planAutostartInstall({ platform: c.platform, account: { ...account, user: sessionUser }, nodePath: c.nodePath, entryPath: c.entryPath, sessionFile });

  if (flags.dryRun) {
    io.stdout.write(`[dry-run] write ${S.canonicalPath(c.configDir)} (node ${nodeId}, user ${sessionUser})\n`);
    io.stdout.write(`[dry-run] write ${sessionFile}\n`);
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
  if (rotates) io.stdout.write(`  replaces the secret installed for ${installed.user}; a running helper reconnects with the new one\n`);
  if (!(await consented({ flags, c, question: `Install the session helper for ${sessionUser}? [y/N] ` }))) {
    io.stderr.write('Not installing without confirmation. Nothing was written.\n');
    return 1;
  }

  const { secret, endpointId } = S.mintSessionSecret();
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
  await c.execute(steps, { dryRun: false, io, entryPath: c.entryPath, nodePath: c.nodePath });
  io.stdout.write(`Session helper installed for ${sessionUser} (node ${nodeId}).\n`);
  io.stdout.write(`  service secret: ${S.canonicalPath(c.configDir)}\n  user copy:      ${sessionFile}\n  endpoint:       ${endpoint}\n`);
  io.stdout.write(rotates ? 'The secret was rotated; the running service drops the old connection and the helper reconnects.\n' : 'Restart the King Louie service so it starts waiting for the helper.\n');
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
  const account = c.resolveUser(flags.user);
  const sessionUser = bareName(flags.user, c.platform);
  const steps = A.planAutostartUninstall({ platform: c.platform, account: { ...account, user: sessionUser } });
  const copyFile = S.userCopyPath({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: account.sid });
  if (flags.dryRun) {
    io.stdout.write(`[dry-run] remove ${copyFile}\n`);
    await c.execute(steps, { dryRun: true, io, entryPath: c.entryPath, nodePath: c.nodePath });
    return 0;
  }
  // R-F5-10: by identity, and with no master key (uninstall must work
  // without one). A helper file that cannot say who it was installed for is
  // removed too, so a damaged file never leaves the owner unable to install.
  const installed = S.inspectCanonical({ configDir: c.configDir, platform: c.platform });
  const mine = installed.state === 'installed' && S.sameSessionIdentity(installed, account, c.platform);
  const damaged = installed.state === 'invalid';
  // R-F5-9: what is about to be removed, then the question.
  let nodeName = null;
  try { nodeName = c.nodeName(); } catch { nodeName = null; } // a bad node.yaml must not block a removal
  io.stdout.write(`Removing the session helper of ${sessionUser} (${identityText(account, c.platform)})${nodeName ? ` on node "${nodeName}"` : ''}:\n`);
  io.stdout.write(`  the login start: ${loginStartText({ platform: c.platform, account, sessionUser })}\n`);
  io.stdout.write(`  ${sessionUser}'s copy of the secret: ${copyFile}\n`);
  if (mine) io.stdout.write(`  the service's secret: ${installed.file} (desktop apps stay off on this node until "session install" runs again)\n`);
  if (damaged) io.stdout.write(`  the service's helper file: ${installed.file} ${installed.reason}, so this cannot tell who it was installed for; it is removed too. If it was installed for another user, run "session uninstall" for that user as well.\n`);
  if (installed.state === 'installed' && !mine) io.stdout.write(`  ${installed.file} stays: it is installed for "${installed.user}" (${identityText(installed, c.platform)}), not for this user\n`);
  if (!(await consented({ flags, c, question: `Remove the session helper for ${sessionUser}? [y/N] ` }))) {
    io.stderr.write('Not removing without confirmation. Nothing was removed.\n');
    return 1;
  }
  await c.execute(steps, { dryRun: false, io, entryPath: c.entryPath, nodePath: c.nodePath });
  S.removeUserCopy({ platform: c.platform, configDir: c.configDir, user: sessionUser, sid: account.sid });
  if (mine || damaged) {
    S.assertSafeComponents(installed.file, { root: c.configDir });
    // Never follows a link: a link is removed itself, a directory with what is in it.
    fs.rmSync(installed.file, { recursive: damaged, force: true });
  }
  io.stdout.write(`Session helper removed for ${sessionUser}.\n`);
  return 0;
}

function printProbes(io, probes) {
  for (const p of probes || []) io.stdout.write(`  ${p.check}: ${p.ok ? 'ok' : `missing — ${p.hint || 'no hint'}`}\n`);
}

async function status({ dataDir, io, deps }) {
  const c = common(dataDir, deps, io);
  const record = (deps.readStatus || ((d) => require('../../gui/status').readGuiStatusRecord({ dataDir: d })))(dataDir);
  const installed = require('../../gui/session-secret').inspectCanonical({ configDir: c.configDir, platform: c.platform });
  if (installed.state === 'installed') io.stdout.write(`installed for: ${installed.user} (${identityText(installed, c.platform)})\n`);
  else if (installed.state === 'invalid') io.stdout.write(`installed, but ${installed.file} ${installed.reason}: run "session uninstall --user NAME", then "session install --user NAME"\n`);
  else io.stdout.write('not installed (session install --user NAME)\n');
  if (!record) {
    io.stdout.write('helper: no running service reports a session helper\n');
    return 0;
  }
  if (!record.available && typeof record.reason === 'string' && record.reason) {
    // R-F5-11: the running service turned desktop apps off, and why.
    const { printable } = require('./io');
    const { remedyFor } = require('../../gui/status');
    io.stdout.write(`helper: off (${printable(record.reason)})${record.detail ? `: ${printable(record.detail)}` : ''}\n`);
    io.stdout.write(`  to fix it, ${remedyFor(record.reason)}\n`);
    return 0;
  }
  io.stdout.write(`helper: ${record.available ? `connected (${record.user}, ${record.platform})` : 'not connected'}\n`);
  if (record.available) io.stdout.write(`capabilities: ${(record.capabilities || []).join(', ') || 'none'}\n`);
  if ((record.limits || []).length) io.stdout.write(`limits: ${record.limits.join(', ')}\n`);
  printProbes(io, record.probes);
  if (record.lease) io.stdout.write(`lease: ${record.lease.active ? 'active' : 'not active'} (${(record.lease.app_ids || []).join(', ')})\n`);
  return 0;
}

async function probe({ dataDir, io, deps }) {
  const record = (deps.readStatus || ((d) => require('../../gui/status').readGuiStatusRecord({ dataDir: d })))(dataDir);
  if (record && record.available) {
    io.stdout.write(`probe report from the running helper (${record.user}, ${record.platform}):\n`);
    io.stdout.write(`capabilities: ${(record.capabilities || []).join(', ') || 'none'}\n`);
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
  io.stdout.write(`capabilities: ${(r.capabilities || []).join(', ') || 'none'}\n`);
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

module.exports = { runSessionCommand, readNodeIdentity, SESSION_USAGE };

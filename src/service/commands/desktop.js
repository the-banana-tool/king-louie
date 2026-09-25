// king-louie-service desktop pair|unpair|list (fleet stage 7 §3.2).
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { createLogger } = require('../../logging');
const { adminConfigDir } = require('../../platform/paths');
const { windowsSystemRoot } = require('../../platform/windows-paths');
const {
  decodePairRequest, parseDevices, emptyDevices, upsertDevice, removeDevice,
  bridgeFileRecord, writeFileAtomic, DEVICES_FILE, BRIDGE_FILE,
  ADMIN_OWNER_SIDS, inspectWindowsOwners
} = require('../../desktop-bridge/pairing');
const { fingerprintGroups } = require('../../desktop-bridge/keys');
const { DEFAULT_DESKTOP_BRIDGE_PORT, DEVICE_ID_RE } = require('../../desktop-bridge/protocol');
const { isAdmin: defaultIsAdmin } = require('./admin-check');

const log = createLogger('service-desktop-cli');

const DESKTOP_HELP = `Usage: king-louie-service desktop pair <request> [--data-dir DIR] [--yes]
       king-louie-service desktop unpair <device-id> [--data-dir DIR]
       king-louie-service desktop list [--data-dir DIR]
`;
const PAIR_WARNING = 'Every paired desktop sees every chat, setting and secret name in this service, and directories and rules it adds apply to its own runs only.';
const TRUST_QUESTION = 'Trust this device? [y/N] ';

const icaclsExe = (env) => path.win32.join(windowsSystemRoot(env), 'System32', 'icacls.exe');

// R56: a normal user must be able to read the owner of the bridge file's
// directory. Non-inherited on purpose: it applies to this directory only.
function grantDirectoryReadControl(dir, { execFile = execFileSync, env = process.env } = {}) {
  execFile(icaclsExe(env), [dir, '/grant', '*S-1-5-11:(RC,RA)'], { windowsHide: true, stdio: 'pipe' });
}

// Best-effort only (fix round 1): the bridge-file trust check at connection
// time is what actually enforces this; a failure here just means the owner
// doesn't get the early warning. Goes to both the logger and io.stderr (fix
// round 2, minor): a CLI operator watching the command's own output should
// see it too, not only whoever reads the service log.
function warnIfConfigDirNotAdminOwned(configDir, { execFile, env, io }) {
  let report;
  try {
    report = inspectWindowsOwners([configDir], { execFile, env });
  } catch {
    return;
  }
  const owner = report && Array.isArray(report.entries) && report.entries[0] ? report.entries[0].owner : null;
  if (!owner || !ADMIN_OWNER_SIDS.includes(owner)) {
    const message = `${configDir} is not owned by SYSTEM or Administrators (owner: ${owner || 'unknown'}); the desktop bridge trust check may refuse it.`;
    log.warn(message);
    if (io && io.stderr) io.stderr.write(`${message}\n`);
  }
}

function applyWindowsAcls({ bridgeFile, configDir, io, execFile = execFileSync, env = process.env }) {
  execFile(icaclsExe(env), [bridgeFile, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-5-19:R', '*S-1-5-11:R'], { windowsHide: true, stdio: 'pipe' });
  // Ownership becomes Administrators, not whichever admin happened to run
  // `desktop pair` (fix round 1, minor): ownership decides who can re-ACL
  // the file later, and that should never be one admin's personal account.
  execFile(icaclsExe(env), [bridgeFile, '/setowner', '*S-1-5-32-544'], { windowsHide: true, stdio: 'pipe' });
  grantDirectoryReadControl(configDir, { execFile, env });
  warnIfConfigDirNotAdminOwned(configDir, { execFile, env, io });
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Replace the file but keep its mode and (as root) its owner. writeFileAtomic's
// own mode is applied through fs.openSync, which the process umask can still
// mask down (fix round 1, I2), so the mode is reasserted with an explicit
// chmod after the write.
function writeKeepingOwnership(file, text) {
  let st = null;
  try { st = fs.statSync(file); } catch { st = null; }
  const mode = st ? st.mode & 0o7777 : 0o644;
  writeFileAtomic(file, text, mode);
  fs.chmodSync(file, mode);
  if (st && typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(file, st.uid, st.gid);
}

// POSIX 0640 root:<service group>, the data dir's group being the service
// account's. Refuses (fix round 1, minor) rather than falling back to gid 0
// when the data dir can't be stat'd: a silent gid-0 devices file would be
// unreadable by the service account it's meant for.
function defaultChownDevicesFile(file, dataDir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const gid = fs.statSync(dataDir).gid;
  fs.chownSync(file, 0, gid);
}

function defaultNodeName(dataDir) {
  const { loadNodeConfig } = require('../node-config');
  return loadNodeConfig({ dataDir }).name;
}

function defaultCreateIdentity(core, ports, nodeName) {
  const { getOrGenerateNodeIdentity } = require('../../mesh/node-identity');
  return getOrGenerateNodeIdentity(core.context.getStore(), ports.cipher, nodeName);
}

// Read-only lookup of the node identity from <dataDir>/chat-data.json. Never
// creates one (fix round 2, I1b): resolving/creating the identity is a write
// (it may run withServiceCore, which persists a freshly generated identity),
// and it must never happen before the owner has confirmed pairing.
function readExistingNodePublicKey(dataDir) {
  const file = path.join(dataDir, 'chat-data.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hex = data && data.mesh && data.mesh.identity && data.mesh.identity.publicKey;
    if (hex) return { ok: true, publicKey: hex };
    return { ok: false };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false };
    return { ok: false, error: `Cannot read ${file}: ${err.message}` };
  }
}

// Creates the node identity when none exists yet. Only called after the
// owner has confirmed pairing (fix round 2, I1b): a running service would
// overwrite the store, so this refuses rather than racing it.
async function createNodeIdentity({ dataDir, io, deps }) {
  if (deps.runningServicePid(dataDir)) return { ok: false, error: 'No node identity yet. Stop the service once and rerun this command.' };
  const nodeName = deps.nodeName ? deps.nodeName() : defaultNodeName(dataDir);
  const create = deps.createIdentity ? (() => deps.createIdentity()) : null;
  const identity = await deps.withServiceCore(dataDir, io, (core, ports) => (create ? create() : defaultCreateIdentity(core, ports, nodeName)));
  return { ok: true, publicKey: identity.publicKey.toString('hex') };
}

function defaultIsTTY(io) {
  return Boolean(io && io.stdin && io.stdin.isTTY);
}

// EOF at the prompt (stdin closed before an answer) counts as a decline
// (fix round 2, minor). `rl.close()` fires 'close' synchronously (fix
// round 3, critical fix: resolving AFTER close meant the 'close' handler's
// resolve(false) always settled the promise first, so typing "y" still
// refused) — the answer is resolved before closing, and the `answered`
// flag makes the 'close' handler's resolve(false) a no-op once that's
// already happened. Without it (a real EOF, 'close' with no 'line' first),
// the flag is still false and the decline goes through as intended.
function defaultConfirm(io, question) {
  return new Promise((resolve) => {
    let answered = false;
    const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
    rl.question(question, (answer) => {
      answered = true;
      resolve(/^y(es)?$/i.test(String(answer).trim()));
      rl.close();
    });
    rl.on('close', () => {
      if (!answered) resolve(false);
    });
  });
}

// A pasted pairing request is never trusted before the owner sees the
// fingerprint. `--yes` skips the prompt outright; otherwise a TTY asks,
// defaulting to no. The non-TTY-without-`--yes` refusal is also checked by
// the caller before anything else runs (I1b, fix round 2); it is repeated
// here as a defensive backstop so this function is correct in isolation.
// `deps.isTTY` and `deps.confirm` make both paths testable without a real
// terminal.
async function confirmPairing({ io, deps, yes }) {
  if (yes) return { ok: true };
  const isTTY = deps.isTTY ? deps.isTTY() : defaultIsTTY(io);
  if (!isTTY) {
    return { ok: false, code: 2, message: 'Refusing to pair without confirmation on a non-interactive terminal; pass --yes.\n' };
  }
  const ask = deps.confirm || ((question) => defaultConfirm(io, question));
  const confirmed = await ask(TRUST_QUESTION);
  return confirmed ? { ok: true } : { ok: false, code: 1, message: 'Not pairing without confirmation.\n' };
}

async function runDesktopCommand({ sub, arg, dataDir, io, deps = {}, yes = false }) {
  // No fail-open default (like import.js's I7): a caller that forgets this
  // could re-check a service that is in fact running and overwrite its
  // devices file underneath it.
  if (typeof deps.runningServicePid !== 'function') throw new TypeError('runDesktopCommand needs deps.runningServicePid');
  const platform = deps.platform || process.platform;
  const configDir = deps.configDir || adminConfigDir({ dataDir });
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin({ platform }));
  const chownDevicesFile = deps.chownDevicesFile || defaultChownDevicesFile;
  if (!['pair', 'unpair', 'list'].includes(sub)) {
    io.stderr.write(DESKTOP_HELP);
    return 2;
  }
  if (!(await isAdmin())) {
    io.stderr.write(`desktop ${sub} ${sub === 'list' ? 'reads' : 'writes'} ${configDir}; run it as root/an administrator.\n`);
    return 1;
  }
  const devicesFile = path.join(configDir, DEVICES_FILE);
  const readDevices = () => (fs.existsSync(devicesFile) ? parseDevices(fs.readFileSync(devicesFile, 'utf8')) : emptyDevices());
  const writeDevices = (doc) => {
    writeFileAtomic(devicesFile, `${JSON.stringify(doc, null, 2)}\n`, 0o640);
    if (platform !== 'win32') {
      fs.chmodSync(devicesFile, 0o640);
      chownDevicesFile(devicesFile, dataDir);
    }
  };

  if (sub === 'list') {
    const doc = readDevices();
    if (!doc.devices.length) io.stdout.write('No paired desktops.\n');
    for (const d of doc.devices) io.stdout.write(`${d.deviceId}  ${d.label}  paired ${d.pairedAt}\n`);
    return 0;
  }

  if (!arg) {
    io.stderr.write(DESKTOP_HELP);
    return 2;
  }

  if (sub === 'unpair') {
    // Never echoed back (fix round 1, minor): the message names no input.
    if (!DEVICE_ID_RE.test(arg)) {
      io.stderr.write('Not a device id.\n');
      return 2;
    }
    const { doc, removed } = removeDevice(readDevices(), arg);
    if (!removed) {
      io.stderr.write(`No paired desktop ${arg}.\n`);
      return 1;
    }
    writeDevices(doc);
    io.stdout.write(`Unpaired ${arg}. A live connection from it closes within 5 seconds.\n`);
    return 0;
  }

  // I1b (fix round 2): with no --yes, a non-TTY is refused before anything
  // else runs — before even reading service.json or decoding the request.
  // The prior order let a non-interactive run that was always going to be
  // refused still trigger resolveNodePublicKey's side effect (persisting a
  // freshly generated node identity via withServiceCore) before the refusal.
  if (!yes) {
    const isTTY = deps.isTTY ? deps.isTTY() : defaultIsTTY(io);
    if (!isTTY) {
      io.stderr.write('Refusing to pair without confirmation on a non-interactive terminal; pass --yes.\n');
      return 2;
    }
  }

  const serviceFile = path.join(configDir, 'service.json');
  const serviceCfg = readJsonIfExists(serviceFile);
  if (serviceCfg.profile === 'runbook') {
    io.stderr.write('desktopBridge needs profile: agent\n');
    return 1;
  }
  let request;
  try {
    request = decodePairRequest(arg);
  } catch (err) {
    io.stderr.write(`Not a pairing request: ${err.message}\n`);
    return 2;
  }

  const configured = serviceCfg.ports && Number.isInteger(serviceCfg.ports.desktopBridge) ? serviceCfg.ports.desktopBridge : undefined;
  const port = configured && configured > 0 ? configured : DEFAULT_DESKTOP_BRIDGE_PORT;
  const bridgeFile = path.join(configDir, BRIDGE_FILE);

  // I1b: label/fingerprint + PAIR_WARNING are printed before anything else
  // is read or written, so the owner sees what they're about to trust.
  io.stdout.write(`Desktop: ${request.label} (${fingerprintGroups(request.deviceId)})\n`);
  io.stdout.write(`Port: ${port}\n`);
  io.stdout.write(`${PAIR_WARNING}\n`);

  // A read-only lookup, never a creation (I1b): only shown pre-confirmation
  // when an identity already exists, so a first pair never persists
  // anything before the owner has agreed to it.
  const existing = readExistingNodePublicKey(dataDir);
  if (existing.error) {
    io.stderr.write(`${existing.error}\n`);
    return 1;
  }
  let record = existing.ok ? bridgeFileRecord({ publicKey: existing.publicKey, port }) : null;
  if (record) io.stdout.write(`Service: ${record.nodeId} (${fingerprintGroups(record.nodeId)})\n`);

  const trust = await confirmPairing({ io, deps, yes });
  if (!trust.ok) {
    io.stderr.write(trust.message);
    return trust.code;
  }

  // I1b: only after confirmation does a missing identity get created —
  // this is the one place this command can write to <dataDir>/chat-data.json.
  if (!record) {
    const created = await createNodeIdentity({ dataDir, io, deps });
    if (!created.ok) {
      io.stderr.write(`${created.error}\n`);
      return 1;
    }
    record = bridgeFileRecord({ publicKey: created.publicKey, port });
    io.stdout.write(`Service: ${record.nodeId} (${fingerprintGroups(record.nodeId)}) — compare this on your desktop.\n`);
  }

  // I2: created 0o755 and chmod'd when new, since a restrictive umask
  // (027/077) would otherwise leave the service unable to read its own
  // config dir on next start.
  const configDirExisted = fs.existsSync(configDir);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  if (!configDirExisted) fs.chmodSync(configDir, 0o755);

  const pairedAt = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeDevices(upsertDevice(readDevices(), { deviceId: request.deviceId, publicKey: request.publicKey, label: request.label, pairedAt }));

  writeFileAtomic(bridgeFile, `${JSON.stringify(record, null, 2)}\n`, 0o644);

  const turnedOn = !(serviceCfg.features && serviceCfg.features.desktopBridge === true);
  const merged = {
    ...serviceCfg,
    features: { ...(serviceCfg.features || {}), desktopBridge: true },
    ports: { ...(serviceCfg.ports || {}), ...(configured === undefined ? { desktopBridge: port } : {}) }
  };
  writeKeepingOwnership(serviceFile, `${JSON.stringify(merged, null, 2)}\n`);

  if (platform === 'win32') (deps.applyWindowsAcls || applyWindowsAcls)({ bridgeFile, configDir, io });
  else fs.chmodSync(bridgeFile, 0o644);

  io.stdout.write(`If this fingerprint differs from the one on your desktop, run \`desktop unpair ${request.deviceId}\` now.\n`);
  if (turnedOn) io.stdout.write('Restart the service to open the desktop bridge.\n');
  return 0;
}

module.exports = { runDesktopCommand, grantDirectoryReadControl, applyWindowsAcls, defaultConfirm, DESKTOP_HELP, PAIR_WARNING };

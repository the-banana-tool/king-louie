// king-louie-service desktop pair|unpair|list (fleet stage 7 §3.2).
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { adminConfigDir } = require('../../platform/paths');
const { windowsSystemRoot } = require('../../platform/windows-paths');
const {
  decodePairRequest, parseDevices, emptyDevices, upsertDevice, removeDevice,
  bridgeFileRecord, writeFileAtomic, DEVICES_FILE, BRIDGE_FILE
} = require('../../desktop-bridge/pairing');
const { fingerprintGroups } = require('../../desktop-bridge/keys');
const { DEFAULT_DESKTOP_BRIDGE_PORT } = require('../../desktop-bridge/protocol');
const { isAdmin: defaultIsAdmin } = require('./admin-check');

const DESKTOP_HELP = `Usage: king-louie-service desktop pair <request> [--data-dir DIR]
       king-louie-service desktop unpair <device-id> [--data-dir DIR]
       king-louie-service desktop list [--data-dir DIR]
`;
const PAIR_WARNING = 'Every paired desktop sees every chat, setting and secret name in this service, and directories and rules it adds apply to its own runs only.';

const icaclsExe = (env) => path.win32.join(windowsSystemRoot(env), 'System32', 'icacls.exe');

// R56: a normal user must be able to read the owner of the bridge file's
// directory. Non-inherited on purpose: it applies to this directory only.
function grantDirectoryReadControl(dir, { execFile = execFileSync, env = process.env } = {}) {
  execFile(icaclsExe(env), [dir, '/grant', '*S-1-5-11:(RC,RA)'], { windowsHide: true, stdio: 'pipe' });
}

function applyWindowsAcls({ bridgeFile, configDir, execFile = execFileSync, env = process.env }) {
  execFile(icaclsExe(env), [bridgeFile, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-5-19:R', '*S-1-5-11:R'], { windowsHide: true, stdio: 'pipe' });
  grantDirectoryReadControl(configDir, { execFile, env });
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Replace the file but keep its mode and (as root) its owner.
function writeKeepingOwnership(file, text) {
  let st = null;
  try { st = fs.statSync(file); } catch { st = null; }
  writeFileAtomic(file, text, st ? st.mode & 0o7777 : 0o644);
  if (st && typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(file, st.uid, st.gid);
}

// POSIX 0640 root:<service group>, the data dir's group being the service account's.
function defaultChownDevicesFile(file, dataDir) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  let gid = 0;
  try { gid = fs.statSync(dataDir).gid; } catch { gid = 0; }
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

// The node identity, read-only from <dataDir>/chat-data.json; created only
// when the service is stopped (a running service would overwrite the store).
async function resolveNodePublicKey({ dataDir, io, deps }) {
  const file = path.join(dataDir, 'chat-data.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hex = data && data.mesh && data.mesh.identity && data.mesh.identity.publicKey;
    if (hex) return { ok: true, publicKey: hex };
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, error: `Cannot read ${file}: ${err.message}` };
  }
  if (deps.runningServicePid(dataDir)) return { ok: false, error: 'No node identity yet. Stop the service once and rerun this command.' };
  const nodeName = deps.nodeName ? deps.nodeName() : defaultNodeName(dataDir);
  const create = deps.createIdentity ? (() => deps.createIdentity()) : null;
  const identity = await deps.withServiceCore(dataDir, io, (core, ports) => (create ? create() : defaultCreateIdentity(core, ports, nodeName)));
  return { ok: true, publicKey: identity.publicKey.toString('hex') };
}

async function runDesktopCommand({ sub, arg, dataDir, io, deps = {} }) {
  const platform = deps.platform || process.platform;
  const configDir = deps.configDir || adminConfigDir({ dataDir });
  const isAdmin = deps.isAdmin || (() => defaultIsAdmin({ platform }));
  const chownDevicesFile = deps.chownDevicesFile || defaultChownDevicesFile;
  const allDeps = { runningServicePid: () => null, ...deps };
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
    const { doc, removed } = removeDevice(readDevices(), arg);
    if (!removed) {
      io.stderr.write(`No paired desktop ${arg}.\n`);
      return 1;
    }
    writeDevices(doc);
    io.stdout.write(`Unpaired ${arg}. A live connection from it closes within 5 seconds.\n`);
    return 0;
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
  const node = await resolveNodePublicKey({ dataDir, io, deps: allDeps });
  if (!node.ok) {
    io.stderr.write(`${node.error}\n`);
    return 1;
  }
  fs.mkdirSync(configDir, { recursive: true });
  const pairedAt = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeDevices(upsertDevice(readDevices(), { deviceId: request.deviceId, publicKey: request.publicKey, label: request.label, pairedAt }));

  const configured = serviceCfg.ports && Number.isInteger(serviceCfg.ports.desktopBridge) ? serviceCfg.ports.desktopBridge : undefined;
  const port = configured && configured > 0 ? configured : DEFAULT_DESKTOP_BRIDGE_PORT;
  const bridgeFile = path.join(configDir, BRIDGE_FILE);
  const record = bridgeFileRecord({ publicKey: node.publicKey, port });
  writeFileAtomic(bridgeFile, `${JSON.stringify(record, null, 2)}\n`, 0o644);

  const turnedOn = !(serviceCfg.features && serviceCfg.features.desktopBridge === true);
  const merged = {
    ...serviceCfg,
    features: { ...(serviceCfg.features || {}), desktopBridge: true },
    ports: { ...(serviceCfg.ports || {}), ...(configured === undefined ? { desktopBridge: port } : {}) }
  };
  writeKeepingOwnership(serviceFile, `${JSON.stringify(merged, null, 2)}\n`);

  if (platform === 'win32') (deps.applyWindowsAcls || applyWindowsAcls)({ bridgeFile, configDir });
  else fs.chmodSync(bridgeFile, 0o644);

  io.stdout.write(`Desktop: ${request.label} (${fingerprintGroups(request.deviceId)})\n`);
  io.stdout.write(`Service: ${record.nodeId} (${fingerprintGroups(record.nodeId)})\n`);
  io.stdout.write(`Port: ${port}\n`);
  io.stdout.write(`${PAIR_WARNING}\n`);
  if (turnedOn) io.stdout.write('Restart the service to open the desktop bridge.\n');
  return 0;
}

module.exports = { runDesktopCommand, grantDirectoryReadControl, applyWindowsAcls, DESKTOP_HELP, PAIR_WARNING };

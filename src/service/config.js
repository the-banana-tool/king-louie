const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');

const log = createLogger('service/config');

const PROFILES = new Set(['agent', 'runbook']);
// Chat channels are off by default: in stage 1 the service denies every
// remote approval, and stage 3 brings the phone approver that makes channels
// useful for unsafe work.
const DEFAULT_FEATURES = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false };
// Distinct from the Electron app's 18789/18790 *and* from mesh's documented
// 18791 (src/mesh/mesh-transport.js), which the desktop app binds on 0.0.0.0
// by default — so a service and a desktop app on one machine do not fight
// over a port, and an unprivileged local user squatting the mesh port cannot
// keep the service's gateway off the air.
const DEFAULT_PORTS = { gateway: 18793, webhook: 18794 };
const CONFIG_FILE = 'service.json';
// Keys that decide whether a network listener exists and where it binds.
// These may only come from the admin-owned config dir; see below.
const ADMIN_ONLY_KEYS = ['features', 'ports'];

function validatePorts(ports, file) {
  if (ports === undefined) return {};
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) {
    throw new Error(`Invalid ${file}: "ports" must be an object`);
  }
  const out = {};
  for (const [name, value] of Object.entries(ports)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, name)) {
      throw new Error(`Invalid ${file}: ports.${name} is not a known port (expected ${Object.keys(DEFAULT_PORTS).join(', ')})`);
    }
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`Invalid ${file}: ports.${name} must be an integer from 1 to 65535`);
    }
    out[name] = value;
  }
  return out;
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid ${file}: ${err.message}`);
  }
}

// The admin config decides which listeners exist, so a service account that
// could rewrite it would be back where it started. The installers create the
// directory root-owned, but an operator can still get the mode wrong by hand,
// and that must fail closed rather than quietly grant the account a say.
// Windows has no mode bits worth checking here — the directory's protected
// DACL (LOCAL SERVICE: read and execute, no write) is the equivalent, and it
// is verified by the installer.
function assertAdminOwned(file, geteuid) {
  if (process.platform === 'win32') return;
  const st = fs.statSync(file);
  if (st.mode & 0o022) {
    throw new Error(
      `Refusing to read ${file}: it is group- or world-writable (mode ${(st.mode & 0o7777).toString(8)}). `
      + 'It decides which network listeners this service opens and must be writable only by root/an administrator.'
    );
  }
  const euid = geteuid();
  if (euid >= 0 && euid !== 0 && st.uid === euid) {
    throw new Error(
      `Refusing to read ${file}: it is owned by the account running the service (uid ${euid}), which could then `
      + 'enable its own listeners. It must be owned by root/an administrator.'
    );
  }
}

/**
 * @param dataDir         the service's own data dir (writable by the service account)
 * @param overrides       CLI overrides; they win over every file
 * @param adminConfigDir  the root/admin-owned config dir; defaults to the
 *                        per-platform location beside the data dir
 * @param geteuid         injectable for tests, the way master-key.js takes getuid
 */
function loadServiceConfig(dataDir, overrides = {}, {
  adminConfigDir: adminDir = adminConfigDir({ dataDir }),
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1)
} = {}) {
  const serviceFile = path.join(dataDir, CONFIG_FILE);
  const adminFile = path.join(adminDir, CONFIG_FILE);

  const serviceCfg = readJsonFile(serviceFile) || {};
  // <dataDir>/service.json is writable by the service account itself, so a
  // compromise of the agent — a prompt injection that reaches any write_file
  // tool, no shell needed — could otherwise switch listeners on for the next
  // restart, which the units' own restart policies supply for free.
  for (const key of ADMIN_ONLY_KEYS) {
    if (serviceCfg[key] !== undefined) {
      log.warn(
        `ignoring "${key}" in ${serviceFile}: it is writable by the service account. `
        + `Set it in ${adminFile} instead.`
      );
    }
  }

  let adminCfg = {};
  if (fs.existsSync(adminFile)) {
    assertAdminOwned(adminFile, geteuid);
    adminCfg = readJsonFile(adminFile) || {};
  }

  const profile = overrides.profile || adminCfg.profile || serviceCfg.profile || 'agent';
  if (!PROFILES.has(profile)) throw new Error(`Unknown profile "${profile}". Expected one of: ${[...PROFILES].join(', ')}`);

  const features = { ...DEFAULT_FEATURES, ...(adminCfg.features || {}), ...(overrides.features || {}) };
  // mesh binds a non-loopback listener and stage 1 has no remote approver, so
  // it stays off even when an administrator asks for it.
  if (features.mesh) {
    log.warn('features.mesh is not supported in service mode yet; ignoring it and keeping mesh off');
    features.mesh = false;
  }

  // Loud, per-feature, naming the file responsible: an operator reading the
  // log must be able to see at a glance which listener is open and why.
  for (const [name, on] of Object.entries(features)) {
    if (!on) continue;
    const source = overrides.features && overrides.features[name] !== undefined
      ? 'a command-line override'
      : adminFile;
    log.info(`feature "${name}" is ENABLED by ${source}`);
  }

  return {
    profile,
    features,
    ports: { ...DEFAULT_PORTS, ...validatePorts(adminCfg.ports, adminFile) }
  };
}

module.exports = { loadServiceConfig, PROFILES, DEFAULT_PORTS, DEFAULT_FEATURES, CONFIG_FILE };

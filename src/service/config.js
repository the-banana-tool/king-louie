const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');

const log = createLogger('service/config');

const PROFILES = new Set(['agent', 'runbook']);
// Chat channels are off by default: in stage 1 the service denies every
// remote approval, and stage 3 brings the phone approver that makes channels
// useful for unsafe work.
const DEFAULT_FEATURES = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };
// Distinct from the Electron app's 18789/18790 *and* from mesh's documented
// 18791 (src/mesh/mesh-transport.js), which the desktop app binds on 0.0.0.0
// by default — so a service and a desktop app on one machine do not fight
// over a port, and an unprivileged local user squatting the mesh port cannot
// keep the service's gateway off the air.
// desktopBridge (fleet stage 7): the loopback listener the desktop app attaches to.
const DEFAULT_PORTS = { gateway: 18793, webhook: 18794, desktopBridge: 18795 };
const CONFIG_FILE = 'service.json';
// Keys that decide whether a network listener exists and where it binds, and
// which profile — and so whether the agent stack loads at all. These may only
// come from the admin-owned config dir; see below.
const ADMIN_ONLY_KEYS = ['features', 'ports', 'profile'];

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
    // 0 (ephemeral) only for the desktop bridge, which tests bind anywhere;
    // a real paired desktop can't discover an ephemeral port, so this is not
    // a production setting (see the load-time warning in loadServiceConfig).
    const min = name === 'desktopBridge' ? 0 : 1;
    if (!Number.isInteger(value) || value < min || value > 65535) {
      throw new Error(`Invalid ${file}: ports.${name} must be an integer from ${min} to 65535`);
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

// What service.json decides, for assertAdminOwned's refusals. node.yaml and
// the runbooks go through the same check (src/service/node-config.js) and pass
// their own wording, since they decide node policy rather than listeners.
const SERVICE_CONFIG_CONTROLS = {
  decides: 'which network listeners this service opens',
  selfGrant: 'enable its own listeners'
};

// The admin config decides which listeners exist, so a service account that
// could rewrite it would be back where it started. The installers create the
// directory root-owned, but an operator can still get the mode wrong by hand,
// and that must fail closed rather than quietly grant the account a say.
// Windows has no mode bits worth checking here — the directory's protected
// DACL (LOCAL SERVICE: read and execute, no write) is the equivalent, and it
// is verified by the installer.
// `adminUid` is who counts as the administrator — root on every POSIX layout
// the installers produce. It is a parameter only so the tests, which cannot
// create a root-owned file, can point it at their own uid; nothing reads it
// from configuration, because a config-supplied answer to "who may configure
// this" is no answer at all.
// `controls` only words the refusal; it never changes what is checked.
function assertAdminOwned(file, geteuid, adminUid = 0, controls = SERVICE_CONFIG_CONTROLS) {
  if (process.platform === 'win32') return;
  const euid = geteuid();
  // The containing directory as well as the file: whoever can write the
  // directory can rename a file of their own over this one, so checking the
  // file alone proves nothing about who decides its contents.
  for (const target of [path.dirname(file), file]) {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to read ${file}: ${target} is a symlink, so its real owner is not the one checked here.`);
    }
    if (st.mode & 0o022) {
      throw new Error(
        `Refusing to read ${target}: it is group- or world-writable (mode ${(st.mode & 0o7777).toString(8)}). `
        + `It decides ${controls.decides} and must be writable only by root/an administrator.`
      );
    }
    // Not "owned by somebody other than me": that accepted a file planted by
    // any *third* unprivileged uid. With a hand-picked data dir under a shared
    // parent (say `/tmp/kl/data`, whose admin config is `/tmp/kl/config`),
    // another local user could drop a service.json there and turn on the
    // gateway and webhook listeners, or move them to ports of their choosing.
    if (st.uid !== adminUid) {
      const why = euid >= 0 && st.uid === euid
        ? `it is owned by the account running the service (uid ${euid}), which could then ${controls.selfGrant}`
        : `it is owned by uid ${st.uid}, not by root/an administrator (uid ${adminUid})`;
      throw new Error(
        `Refusing to read ${target}: ${why}. It decides ${controls.decides} `
        + 'and must be owned by root/an administrator.'
      );
    }
  }
}

/**
 * @param dataDir         the service's own data dir (writable by the service account)
 * @param overrides       CLI overrides; they win over every file
 * @param adminConfigDir  the root/admin-owned config dir; defaults to the
 *                        per-platform location beside the data dir
 * @param geteuid         injectable for tests, the way master-key.js takes getuid
 * @param adminUid        which uid counts as the administrator (0; see assertAdminOwned)
 */
function loadServiceConfig(dataDir, overrides = {}, {
  adminConfigDir: adminDir = adminConfigDir({ dataDir }),
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  adminUid = 0
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
    assertAdminOwned(adminFile, geteuid, adminUid);
    adminCfg = readJsonFile(adminFile) || {};
  }

  const profile = overrides.profile || adminCfg.profile || 'agent';
  if (!PROFILES.has(profile)) throw new Error(`Unknown profile "${profile}". Expected one of: ${[...PROFILES].join(', ')}`);

  const features = { ...DEFAULT_FEATURES, ...(adminCfg.features || {}), ...(overrides.features || {}) };
  // mesh binds a non-loopback listener and stage 1 has no remote approver, so
  // it stays off even when an administrator asks for it.
  if (features.mesh) {
    log.warn('features.mesh is not supported in service mode yet; ignoring it and keeping mesh off');
    features.mesh = false;
  }

  // The desktop bridge needs the agent stack it proxies to.
  if (features.desktopBridge && profile === 'runbook') {
    throw new Error('desktopBridge needs profile: agent');
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

  const ports = { ...DEFAULT_PORTS, ...validatePorts(adminCfg.ports, adminFile) };
  if (features.desktopBridge && ports.desktopBridge === 0) {
    log.warn("ports.desktopBridge 0 is for tests; the paired desktop can't reach an ephemeral port");
  }

  return { profile, features, ports };
}

module.exports = { loadServiceConfig, assertAdminOwned, PROFILES, DEFAULT_PORTS, DEFAULT_FEATURES, CONFIG_FILE };

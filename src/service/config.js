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
// Keys that decide whether a network listener exists and where it binds, and
// which profile — and so whether the agent stack loads at all. These may only
// come from the admin-owned config dir; see below.
// `relay` (the relay's listeners, TLS files and push credentials) and `audit`
// (ledger retention) joined in fleet stage 3.
const ADMIN_ONLY_KEYS = ['features', 'ports', 'profile', 'relay', 'audit'];
const RELAY_DEFAULTS = { phoneListen: { host: '0.0.0.0', port: 8443 }, meshPort: 18795, auditRetentionDays: 365 };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(obj, allowed, where, file) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${file}: ${where}.${key} is not a known key (expected ${allowed.join(', ')})`);
  }
}

function listenBlock(raw, where, file, { host = null, port }) {
  const value = raw === undefined ? {} : raw;
  if (!isPlainObject(value)) throw new Error(`Invalid ${file}: ${where} must be an object with host and port`);
  rejectUnknownKeys(value, ['host', 'port'], where, file);
  const out = { host: value.host === undefined ? host : value.host, port: value.port === undefined ? port : value.port };
  if (typeof out.host !== 'string' || !out.host) throw new Error(`Invalid ${file}: ${where}.host is required`);
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error(`Invalid ${file}: ${where}.port must be an integer from 1 to 65535`);
  return out;
}

function requiredString(value, where, file) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${file}: ${where} is required`);
  return value.trim();
}

// The relay host's block (spec §6). Returns the shape startRelay takes, or
// null when there is no relay block.
function parseRelayConfig(raw, file) {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: "relay" must be an object`);
  rejectUnknownKeys(raw, ['phone_listen', 'tls', 'mesh_listen', 'public_url', 'push'], 'relay', file);
  if (!isPlainObject(raw.tls)) throw new Error(`Invalid ${file}: relay.tls with cert_file and key_file is required`);
  rejectUnknownKeys(raw.tls, ['cert_file', 'key_file'], 'relay.tls', file);
  const publicUrl = requiredString(raw.public_url, 'relay.public_url', file);
  if (!/^https:\/\//.test(publicUrl)) throw new Error(`Invalid ${file}: relay.public_url must be an https:// URL`);
  const push = {};
  if (raw.push !== undefined) {
    if (!isPlainObject(raw.push)) throw new Error(`Invalid ${file}: relay.push must be an object`);
    rejectUnknownKeys(raw.push, ['apns', 'fcm'], 'relay.push', file);
    if (raw.push.apns !== undefined) {
      const a = raw.push.apns;
      if (!isPlainObject(a)) throw new Error(`Invalid ${file}: relay.push.apns must be an object`);
      rejectUnknownKeys(a, ['team_id', 'key_id', 'key_file', 'topic', 'environment'], 'relay.push.apns', file);
      const environment = a.environment === undefined ? 'production' : a.environment;
      if (!['production', 'sandbox'].includes(environment)) throw new Error(`Invalid ${file}: relay.push.apns.environment must be production or sandbox`);
      push.apns = {
        teamId: requiredString(a.team_id, 'relay.push.apns.team_id', file),
        keyId: requiredString(a.key_id, 'relay.push.apns.key_id', file),
        keyFile: requiredString(a.key_file, 'relay.push.apns.key_file', file),
        topic: requiredString(a.topic, 'relay.push.apns.topic', file),
        environment
      };
    }
    if (raw.push.fcm !== undefined) {
      if (!isPlainObject(raw.push.fcm)) throw new Error(`Invalid ${file}: relay.push.fcm must be an object`);
      rejectUnknownKeys(raw.push.fcm, ['service_account_file'], 'relay.push.fcm', file);
      push.fcm = { serviceAccountFile: requiredString(raw.push.fcm.service_account_file, 'relay.push.fcm.service_account_file', file) };
    }
  }
  return {
    phoneListen: listenBlock(raw.phone_listen, 'relay.phone_listen', file, RELAY_DEFAULTS.phoneListen),
    tls: { certFile: requiredString(raw.tls.cert_file, 'relay.tls.cert_file', file), keyFile: requiredString(raw.tls.key_file, 'relay.tls.key_file', file) },
    meshListen: listenBlock(raw.mesh_listen, 'relay.mesh_listen', file, { host: null, port: RELAY_DEFAULTS.meshPort }),
    publicUrl,
    push
  };
}

function parseAuditConfig(raw, file) {
  if (raw === undefined) return { retentionDays: RELAY_DEFAULTS.auditRetentionDays };
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: "audit" must be an object`);
  rejectUnknownKeys(raw, ['retention_days'], 'audit', file);
  const days = raw.retention_days === undefined ? RELAY_DEFAULTS.auditRetentionDays : raw.retention_days;
  if (!Number.isInteger(days) || days < 30) throw new Error(`Invalid ${file}: audit.retention_days must be an integer of at least 30`);
  return { retentionDays: days };
}

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
    ports: { ...DEFAULT_PORTS, ...validatePorts(adminCfg.ports, adminFile) },
    relay: parseRelayConfig(adminCfg.relay, adminFile),
    audit: parseAuditConfig(adminCfg.audit, adminFile)
  };
}

module.exports = { loadServiceConfig, assertAdminOwned, parseRelayConfig, parseAuditConfig, PROFILES, DEFAULT_PORTS, DEFAULT_FEATURES, CONFIG_FILE };

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');
const { EXECUTOR_ID_PATTERN } = require('../cases/executors/util');

const log = createLogger('service/config');

// frontdoor (fleet stage 4): the one public machine; it loads no agent code.
const PROFILES = new Set(['agent', 'runbook', 'frontdoor']);
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
// 18795 is taken by the relay mesh listener (fleet stage 3), hence 18796.
const DEFAULT_PORTS = { gateway: 18793, webhook: 18794, desktopBridge: 18796 };
const CONFIG_FILE = 'service.json';
// Keys that decide whether a network listener exists and where it binds, and
// which profile — and so whether the agent stack loads at all. These may only
// come from the admin-owned config dir; see below.
// `relay` (the relay's listeners, TLS files and push credentials) and `audit`
// (ledger retention) joined in fleet stage 3. `executors` (which executor
// packages load, from where) joined in cases stage 3 (R42). `contact` (cases
// stage 4, R55): who the owner is, where to reach them and through which relays.
// `playbooks` (cases stage 6, ruling T14-admin): the playbook source
// allowlist and same-major auto-update. `localInference` (local inference
// stage L1, R-LI-6): which servers count as local, and so which models a
// private chat may run on.
const ADMIN_ONLY_KEYS = ['features', 'ports', 'profile', 'relay', 'audit', 'executors', 'contact', 'playbooks', 'localInference'];
const EXECUTOR_KEYS = ['entries', 'packageRoots'];
const RELAY_DEFAULTS = { phoneListen: { host: '0.0.0.0', port: 8443 }, meshPort: 18795, auditRetentionDays: 365 };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Same message as features/ports and node.yaml (unknownKeyError, below).
function rejectUnknownKeys(obj, allowed, where, file) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw unknownKeyError(file, `${where}.${key}`, allowed);
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

// relay.push, shared by the relay host and the front door (§3.1: "used as is").
function parsePushConfig(raw, file) {
  const push = {};
  if (raw === undefined) return push;
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: relay.push must be an object`);
  rejectUnknownKeys(raw, ['apns', 'fcm'], 'relay.push', file);
  if (raw.apns !== undefined) {
    const a = raw.apns;
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
  if (raw.fcm !== undefined) {
    if (!isPlainObject(raw.fcm)) throw new Error(`Invalid ${file}: relay.push.fcm must be an object`);
    rejectUnknownKeys(raw.fcm, ['service_account_file'], 'relay.push.fcm', file);
    push.fcm = { serviceAccountFile: requiredString(raw.fcm.service_account_file, 'relay.push.fcm.service_account_file', file) };
  }
  return push;
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
  let parsedPublicUrl;
  try {
    parsedPublicUrl = new URL(publicUrl);
  } catch {
    throw new Error(`Invalid ${file}: relay.public_url must be a valid URL`);
  }
  if (parsedPublicUrl.protocol !== 'https:') throw new Error(`Invalid ${file}: relay.public_url must be an https:// URL`);
  if (!parsedPublicUrl.hostname) throw new Error(`Invalid ${file}: relay.public_url must include a host`);
  const push = parsePushConfig(raw.push, file);
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
  if (!Number.isInteger(days) || days < 30 || days > 3650) {
    throw new Error(`Invalid ${file}: audit.retention_days must be an integer of at least 30 (up to 3650)`);
  }
  return { retentionDays: days };
}

// The one formatter for "this config file carries a key we don't know
// about." node-config.js's node.yaml check and this file's own service.json
// check (stage 6 Task 2) both throw through this, so the message can't drift
// between the two files.
function unknownKeyError(file, keyPath, knownList) {
  return new Error(`Invalid ${file}: unknown key "${keyPath}" (known: ${knownList.join(', ')})`);
}

// Cases stage 3 (R42, R55): executors come only from the admin service.json.
function validateExecutors(value, file) {
  if (value === undefined) return { entries: {}, packageRoots: [] };
  if (!isPlainObject(value)) throw new Error(`Invalid ${file}: "executors" must be an object`);
  rejectUnknownKeys(value, EXECUTOR_KEYS, 'executors', file);
  const entries = value.entries === undefined ? {} : value.entries;
  if (!isPlainObject(entries)) throw new Error(`Invalid ${file}: executors.entries must be an object`);
  for (const [id, entry] of Object.entries(entries)) {
    if (!EXECUTOR_ID_PATTERN.test(id)) throw new Error(`Invalid ${file}: executors.entries.${id} is not a lowercase executor id`);
    if (!isPlainObject(entry)) throw new Error(`Invalid ${file}: executors.entries.${id} must be an object`);
  }
  const roots = value.packageRoots === undefined ? [] : value.packageRoots;
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === 'string' && path.isAbsolute(r))) {
    throw new Error(`Invalid ${file}: executors.packageRoots must be a list of absolute paths`);
  }
  return { entries: JSON.parse(JSON.stringify(entries)), packageRoots: [...roots] };
}

// The admin service.json decides which listeners exist and where they bind,
// so a key it does not know is an error, not a silent no-op: a misspelled
// feature used to be merged in and then ignored. The known names are the
// defaults' own keys, so a stage that adds a default makes its key known.
function validateFeatures(features, file) {
  if (features === undefined) return {};
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw new Error(`Invalid ${file}: "features" must be an object`);
  }
  for (const name of Object.keys(features)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_FEATURES, name)) {
      throw unknownKeyError(file, `features.${name}`, Object.keys(DEFAULT_FEATURES));
    }
  }
  return features;
}

// Cases stage 6 (ruling T14-admin): in service mode the playbook source
// allowlist and autoUpdate are policy, so they come only from here. Each
// source is a path:<absolute folder> or an https/ssh URL prefix, checked
// with the same rules the allowlist matches by (src/cases/playbooks/vendor.js).
const PLAYBOOK_SOURCE_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
function parsePlaybooksConfig(raw, file) {
  if (raw === undefined) return { sources: [], autoUpdate: false };
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: "playbooks" must be an object`);
  rejectUnknownKeys(raw, ['sources', 'autoUpdate'], 'playbooks', file);
  const sources = raw.sources === undefined ? [] : raw.sources;
  if (!Array.isArray(sources) || sources.length > 100) throw new Error(`Invalid ${file}: playbooks.sources must be a list of at most 100 entries`);
  const { normalizeUrl } = require('../cases/playbooks/vendor');
  const out = sources.map((entry, i) => {
    const bad = () => new Error(`Invalid ${file}: playbooks.sources[${i}] must be path:<absolute folder> or an https/ssh URL prefix`);
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 2048 || PLAYBOOK_SOURCE_UNSAFE_RE.test(entry)) throw bad();
    const e = entry.trim();
    if (e.startsWith('path:')) {
      const folder = e.slice('path:'.length).trim();
      if (/^[\\/]{2}/.test(folder) || !path.isAbsolute(folder)) throw bad();
      return e;
    }
    if (!normalizeUrl(e)) throw bad();
    return e;
  });
  if (raw.autoUpdate !== undefined && typeof raw.autoUpdate !== 'boolean') throw new Error(`Invalid ${file}: playbooks.autoUpdate must be true or false`);
  return { sources: out, autoUpdate: raw.autoUpdate === true };
}

// Local inference stage L1 (spec 2026-10-13 §5.6, §13.3; R-LI-6, R-LI-29):
// in service mode a local server exists only because the administrator
// listed it here. That listing is the mark: a model on such a server may run
// a private chat, so nothing the service account can write adds one.
//
// An IP address written here (in baseUrl or addresses) is checked now, and a
// public one stops the load. A host name is not resolved here: the service
// resolves and pins it at start, so loading this file needs no resolver.
const LOCAL_SERVER_KEYS = ['id', 'name', 'kind', 'baseUrl', 'addresses', 'tlsFingerprint', 'allowCgnat', 'maxConcurrent', 'timeoutMs', 'key', 'adapters'];
const MAX_LOCAL_SERVERS = 32;
const LOCAL_KEY_REF = /^\$\{vault:[A-Za-z0-9._-]+\}$/;
function parseLocalInferenceConfig(raw, file) {
  if (raw === undefined) return { servers: [] };
  if (!isPlainObject(raw)) throw new Error(`Invalid ${file}: "localInference" must be an object`);
  rejectUnknownKeys(raw, ['servers'], 'localInference', file);
  const list = raw.servers === undefined ? [] : raw.servers;
  if (!Array.isArray(list) || list.length > MAX_LOCAL_SERVERS) {
    throw new Error(`Invalid ${file}: localInference.servers must be a list of at most ${MAX_LOCAL_SERVERS} servers`);
  }
  const { SERVER_ID_RE, SERVER_KINDS, readEntry } = require('../models/local-servers');
  const { parseBaseUrl, classifyAddress, canonicalAddress, isTlsFingerprint } = require('../models/local-address');
  const seen = new Set();
  const servers = list.map((entry, i) => {
    const where = `localInference.servers[${i}]`;
    const bad = (message) => new Error(`Invalid ${file}: ${where}${message}`);
    if (!isPlainObject(entry)) throw bad(' must be an object');
    rejectUnknownKeys(entry, LOCAL_SERVER_KEYS, where, file);
    if (typeof entry.id !== 'string' || !SERVER_ID_RE.test(entry.id)) throw bad('.id must be 2 to 40 lowercase letters, digits and dashes, starting with a letter');
    if (seen.has(entry.id)) throw bad(`.id "${entry.id}" is used twice`);
    seen.add(entry.id);
    if (!SERVER_KINDS.includes(entry.kind)) throw bad(`.kind must be one of ${SERVER_KINDS.join(', ')}`);
    let url;
    try {
      url = parseBaseUrl(entry.baseUrl);
    } catch (err) {
      throw bad(`.baseUrl: ${err.message}`);
    }
    if (entry.allowCgnat !== undefined && typeof entry.allowCgnat !== 'boolean') throw bad('.allowCgnat must be true or false');
    const allowCgnat = entry.allowCgnat === true;
    if (entry.tlsFingerprint !== undefined && entry.tlsFingerprint !== null && !isTlsFingerprint(entry.tlsFingerprint)) {
      throw bad('.tlsFingerprint must be 64 hex characters (SHA-256)');
    }
    if (entry.key !== undefined && entry.key !== null && (typeof entry.key !== 'string' || !LOCAL_KEY_REF.test(entry.key))) {
      throw bad('.key must be a ${vault:<key>} reference; store the key in the vault');
    }
    // Under local. only: the Vault tool refuses and hides that namespace
    // (src/models/local-vault-keys.js), so the model cannot read the key.
    if (entry.key !== undefined && entry.key !== null && !require('../models/local-vault-keys').isLocalServerVaultKey(entry.key.slice('${vault:'.length, -1))) {
      throw bad('.key must name a vault key under local. (${vault:local.<name>}); the model cannot read that namespace');
    }
    // Adapters (spec §12.1): { model, id, job, ref } each, one id per model.
    // The model's digest is not written here: it is read from the server
    // when the adapter is first used after the model was probed.
    if (entry.adapters !== undefined) {
      const { checkAdapterDeclaration, plainModelId, MAX_ADAPTERS } = require('../models/local-probe');
      if (!Array.isArray(entry.adapters) || entry.adapters.length > 64) throw bad('.adapters must be a list of at most 64 adapters');
      const ids = new Set();
      entry.adapters.forEach((a, j) => {
        const at = `.adapters[${j}]`;
        if (!isPlainObject(a)) throw bad(`${at} must be an object { model, id, job, ref }`);
        rejectUnknownKeys(a, ['model', 'id', 'job', 'ref'], `${where}${at}`, file);
        if (plainModelId(a.model) === null) throw bad(`${at}.model must be the server's id for the model`);
        const { model, ...declared } = a;
        const { problem } = checkAdapterDeclaration(declared);
        if (problem) throw bad(`${at}: ${problem}`);
        const key = JSON.stringify([model, a.id]);
        if (ids.has(key)) throw bad(`${at}: adapters declares ${a.id} for ${model} twice`);
        ids.add(key);
      });
      const perModel = new Map();
      for (const a of entry.adapters) perModel.set(a.model, (perModel.get(a.model) || 0) + 1);
      if ([...perModel.values()].some((n) => n > MAX_ADAPTERS)) throw bad(`.adapters may declare at most ${MAX_ADAPTERS} adapters for one model`);
    }
    // Every address written in the file is classified now (§5.2).
    const allowed = (cls) => cls === 'loopback' || cls === 'lan' || (cls === 'cgnat' && allowCgnat);
    const classify = (address, field) => {
      let cls;
      let canonical;
      try {
        cls = classifyAddress(address);
        canonical = canonicalAddress(address);
      } catch {
        throw bad(`${field} must hold IP addresses; "${String(address).slice(0, 80)}" is not one`);
      }
      if (!allowed(cls)) {
        throw bad(`${field}: ${canonical} is ${cls === 'cgnat' ? 'in 100.64.0.0/10, which needs allowCgnat: true' : `a ${cls} address`}; a local server must be on this machine or your own network`);
      }
      return canonical;
    };
    let addresses = null;
    if (entry.addresses !== undefined && entry.addresses !== null) {
      if (!Array.isArray(entry.addresses) || entry.addresses.length === 0 || entry.addresses.length > 8) throw bad('.addresses must be a list of 1 to 8 IP addresses');
      addresses = [...new Set(entry.addresses.map((a) => classify(a, '.addresses')))];
    }
    if (url.isIpLiteral) {
      const written = classify(url.hostname, '.baseUrl');
      if (addresses && (addresses.length !== 1 || addresses[0] !== written)) {
        throw bad('.addresses cannot name another address than the one in baseUrl');
      }
    }
    const out = {
      id: entry.id,
      name: entry.name === undefined || entry.name === null ? entry.id : entry.name,
      kind: entry.kind,
      baseUrl: url.href,
      addresses,
      tlsFingerprint: entry.tlsFingerprint ? entry.tlsFingerprint.toLowerCase() : null,
      allowCgnat,
      maxConcurrent: entry.maxConcurrent === undefined || entry.maxConcurrent === null ? 2 : entry.maxConcurrent,
      timeoutMs: entry.timeoutMs === undefined ? null : entry.timeoutMs,
      key: entry.key || null,
      adapters: entry.adapters === undefined ? [] : JSON.parse(JSON.stringify(entry.adapters))
    };
    // The rest of the shape is the registry's own check, with a stand-in pin
    // (a real one is made at start).
    const standIn = url.isIpLiteral ? canonicalAddress(url.hostname) : (addresses ? addresses[0] : '127.0.0.1');
    const standInClass = classifyAddress(standIn);
    const { problem } = readEntry({
      id: out.id, name: out.name, kind: out.kind, baseUrl: out.baseUrl, tlsFingerprint: out.tlsFingerprint, allowCgnat: out.allowCgnat,
      maxConcurrent: out.maxConcurrent, timeoutMs: out.timeoutMs,
      pinned: { addresses: [standIn], class: standInClass, at: null },
      markedLocalAt: 'admin'
    });
    if (problem) throw bad(`: ${problem}`);
    return out;
  });
  return { servers };
}

// Cases stage 4 (R55): who the owner is and where to reach them comes only
// from the admin service.json, never from the service-writable data dir.
const { validateContactConfig } = require('../cases/contact-settings');

function validatePorts(ports, file) {
  if (ports === undefined) return {};
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) {
    throw new Error(`Invalid ${file}: "ports" must be an object`);
  }
  const out = {};
  for (const [name, value] of Object.entries(ports)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, name)) {
      throw unknownKeyError(file, `ports.${name}`, Object.keys(DEFAULT_PORTS));
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

  const features = { ...DEFAULT_FEATURES, ...validateFeatures(adminCfg.features, adminFile), ...(overrides.features || {}) };
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

  // On the frontdoor profile the relay block follows §3.1 (public_url is
  // derived; tls/phone_listen/mesh_listen are refused; push is used as is).
  // Those refusals are startup check 4, run in order by startFrontDoor, so
  // the raw block is handed over unparsed.
  const frontdoor = profile === 'frontdoor';
  return {
    profile,
    features,
    ports,
    relay: frontdoor ? null : parseRelayConfig(adminCfg.relay, adminFile),
    ...(frontdoor ? { relayRaw: adminCfg.relay === undefined ? null : adminCfg.relay } : {}),
    audit: parseAuditConfig(adminCfg.audit, adminFile),
    executors: validateExecutors(adminCfg.executors, adminFile),
    contact: validateContactConfig(adminCfg.contact, adminFile, { unknownKeyError }),
    playbooks: parsePlaybooksConfig(adminCfg.playbooks, adminFile),
    localInference: parseLocalInferenceConfig(adminCfg.localInference, adminFile)
  };
}

module.exports = { loadServiceConfig, assertAdminOwned, parseRelayConfig, parsePushConfig, parseAuditConfig, validateExecutors, parsePlaybooksConfig, parseLocalInferenceConfig, PROFILES, DEFAULT_PORTS, DEFAULT_FEATURES, CONFIG_FILE, unknownKeyError };

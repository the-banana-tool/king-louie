const fs = require('fs');
const path = require('path');
const { parseYaml } = require('../platform/yaml');
const { adminConfigDir } = require('../platform/paths');
const { assertAdminOwned: assertServiceAdminOwned, unknownKeyError } = require('./config');

const NODE_CONFIG_FILE = 'node.yaml';

const DEFAULT_ALWAYS_CONFIRM = [
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(git push*)',
  'Vault(*)',
  'Bash(*deploy*)'
];
const DEFAULT_DENY = ['Bash(rm -rf /*)'];
const DEFAULT_MAX_CONCURRENT_JOBS = 2;

// Every key node.yaml may carry, per level. A key that is not listed stops
// the node from loading. A misspelled `always_confirm` used to fall back
// silently to the defaults, which can be looser than what the administrator
// wrote. A later stage that parses a new top-level key appends it here in the
// same change (fleet stage 3 `approvers`, stage 4 `frontdoor`, stage 5 `gui`)
// and validates that key's own subtree itself.
const NODE_YAML_KEYS = Object.freeze({
  top: Object.freeze(['name', 'profile', 'front_door', 'capabilities', 'policy', 'runbooks_dir']),
  policy: Object.freeze(['allowed_roots', 'remote_sessions', 'max_concurrent_jobs']),
  remote_sessions: Object.freeze(['always_confirm', 'deny'])
});

// node.yaml and the runbooks beside it decide what this node lets remote
// sessions and runbooks do, so they get the same ownership check as the
// admin service.json — one implementation, so neither copy can drift weaker
// than the other — worded for what these files control.
const NODE_POLICY_CONTROLS = {
  decides: 'what this node may do (its policy and runbooks)',
  selfGrant: 'loosen its own node policy or runbooks'
};

function assertAdminOwned(file, geteuid, adminUid = 0, controls = NODE_POLICY_CONTROLS) {
  assertServiceAdminOwned(file, geteuid, adminUid, controls);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringList(value, { nonEmpty = false } = {}) {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && (!nonEmpty || item.trim() !== ''));
}

function assertKnownKeys(mapping, known, prefix, file) {
  for (const key of Object.keys(mapping)) {
    if (!known.includes(key)) {
      throw unknownKeyError(file, `${prefix}${key}`, known);
    }
  }
}

function defaultNodeConfig(adminDir) {
  return {
    name: 'unnamed-node',
    profile: 'agent',
    capabilities: [],
    policy: {
      allowed_roots: [],
      remote_sessions: {
        always_confirm: [...DEFAULT_ALWAYS_CONFIRM],
        deny: [...DEFAULT_DENY]
      },
      max_concurrent_jobs: DEFAULT_MAX_CONCURRENT_JOBS
    },
    runbooksDir: path.join(adminDir, 'runbooks')
  };
}

/**
 * Loads and validates node.yaml from adminConfigDir.
 *
 * A key that is absent takes its default; a key that is present but malformed
 * throws. Quietly swapping a typo'd policy value for the default would run the
 * node under a policy its administrator never wrote — and for `deny` or
 * `allowed_roots` the default may well be looser than what they meant.
 */
function loadNodeConfig({
  dataDir,
  adminConfigDir: adminDir = adminConfigDir({ dataDir }),
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  adminUid = 0
} = {}) {
  const configFile = path.join(adminDir, NODE_CONFIG_FILE);

  if (!fs.existsSync(configFile)) {
    return defaultNodeConfig(adminDir);
  }

  assertAdminOwned(configFile, geteuid, adminUid);

  let raw;
  try {
    raw = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${configFile}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Invalid ${configFile}: ${err.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid ${configFile}: must contain a YAML object`);
  }
  const invalid = (what) => new Error(`Invalid ${configFile}: ${what}`);

  // Before any per-key validation, so a typo is reported as the typo and not
  // as whatever default it would have left in place.
  assertKnownKeys(parsed, NODE_YAML_KEYS.top, '', configFile);
  if (isPlainObject(parsed.policy)) {
    assertKnownKeys(parsed.policy, NODE_YAML_KEYS.policy, 'policy.', configFile);
    if (isPlainObject(parsed.policy.remote_sessions)) {
      assertKnownKeys(parsed.policy.remote_sessions, NODE_YAML_KEYS.remote_sessions, 'policy.remote_sessions.', configFile);
    }
  }

  let name = 'unnamed-node';
  if (parsed.name !== undefined) {
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw invalid('name must be a non-empty string');
    name = parsed.name.trim();
  }
  if (parsed.profile !== undefined && !['agent', 'runbook'].includes(parsed.profile)) {
    throw invalid(`unknown profile "${parsed.profile}"`);
  }
  const profile = parsed.profile || 'agent';
  const frontDoor = typeof parsed.front_door === 'string' ? parsed.front_door.trim() : null;

  let capabilities = [];
  if (parsed.capabilities !== undefined) {
    if (!Array.isArray(parsed.capabilities)) throw invalid('capabilities must be a list');
    capabilities = parsed.capabilities.map(String);
  }

  let rawPolicy = {};
  if (parsed.policy !== undefined) {
    if (!isPlainObject(parsed.policy)) throw invalid('policy must be a mapping');
    rawPolicy = parsed.policy;
  }

  let allowedRoots = [];
  if (rawPolicy.allowed_roots !== undefined) {
    if (!isStringList(rawPolicy.allowed_roots, { nonEmpty: true })) {
      throw invalid('policy.allowed_roots must be a list of non-empty strings');
    }
    allowedRoots = rawPolicy.allowed_roots.map((r) => path.resolve(r));
  }

  let rawRemoteSessions = {};
  if (rawPolicy.remote_sessions !== undefined) {
    if (!isPlainObject(rawPolicy.remote_sessions)) throw invalid('policy.remote_sessions must be a mapping');
    rawRemoteSessions = rawPolicy.remote_sessions;
  }

  let alwaysConfirm = [...DEFAULT_ALWAYS_CONFIRM];
  if (rawRemoteSessions.always_confirm !== undefined) {
    if (!isStringList(rawRemoteSessions.always_confirm)) {
      throw invalid('policy.remote_sessions.always_confirm must be a list of strings');
    }
    alwaysConfirm = [...rawRemoteSessions.always_confirm];
  }

  let deny = [...DEFAULT_DENY];
  if (rawRemoteSessions.deny !== undefined) {
    if (!isStringList(rawRemoteSessions.deny)) {
      throw invalid('policy.remote_sessions.deny must be a list of strings');
    }
    deny = [...rawRemoteSessions.deny];
  }

  let maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS;
  if (rawPolicy.max_concurrent_jobs !== undefined) {
    if (!Number.isInteger(rawPolicy.max_concurrent_jobs) || rawPolicy.max_concurrent_jobs < 1) {
      throw invalid('policy.max_concurrent_jobs must be a positive integer');
    }
    maxConcurrentJobs = rawPolicy.max_concurrent_jobs;
  }

  const rawRunbooksDir = typeof parsed.runbooks_dir === 'string' && parsed.runbooks_dir.trim()
    ? parsed.runbooks_dir.trim()
    : 'runbooks';

  const runbooksDir = path.isAbsolute(rawRunbooksDir)
    ? path.normalize(rawRunbooksDir)
    : path.normalize(path.join(adminDir, rawRunbooksDir));

  return {
    name,
    profile,
    frontDoor,
    capabilities,
    policy: {
      allowed_roots: allowedRoots,
      remote_sessions: {
        always_confirm: alwaysConfirm,
        deny
      },
      max_concurrent_jobs: maxConcurrentJobs
    },
    runbooksDir
  };
}

module.exports = { loadNodeConfig, assertAdminOwned, NODE_CONFIG_FILE, NODE_YAML_KEYS };

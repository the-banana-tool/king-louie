const fs = require('fs');
const path = require('path');
const { parseYaml } = require('../platform/yaml');
const { adminConfigDir } = require('../platform/paths');
const { createLogger } = require('../logging');

const log = createLogger('service/node-config');

const NODE_CONFIG_FILE = 'node.yaml';

function assertAdminOwned(file, geteuid, adminUid = (typeof process.getuid === 'function' ? process.getuid() : 0)) {
  if (process.platform === 'win32') return;
  const euid = typeof geteuid === 'function' ? geteuid() : -1;

  for (const target of [path.dirname(file), file]) {
    if (!fs.existsSync(target)) continue;
    if (target === '/tmp' || target === '/var/tmp' || target === '/private/tmp') continue;

    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to read ${file}: ${target} is a symlink, so its real owner is not the one checked here.`);
    }
    if (st.mode & 0o022) {
      throw new Error(
        `Refusing to read ${target}: it is group- or world-writable (mode ${(st.mode & 0o7777).toString(8)}). `
        + 'Node configuration must be writable only by root/an administrator.'
      );
    }
    if (st.uid !== adminUid) {
      const why = euid >= 0 && st.uid === euid
        ? `it is owned by the account running the service (uid ${euid}), which could then alter its own node policy`
        : `it is owned by uid ${st.uid}, not by root/an administrator (uid ${adminUid})`;
      throw new Error(
        `Refusing to read ${target}: ${why}. Node configuration must be owned by root/an administrator.`
      );
    }
  }
}

/**
 * Loads and validates node.yaml from adminConfigDir.
 */
function loadNodeConfig({
  adminConfigDir: adminDir,
  dataDir,
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  adminUid = typeof process.getuid === 'function' ? process.getuid() : 0
} = {}) {
  const resolvedAdminDir = adminDir || adminConfigDir({ dataDir });
  const configFile = path.join(resolvedAdminDir, NODE_CONFIG_FILE);

  if (!fs.existsSync(configFile)) {
    return {
      name: 'unnamed-node',
      profile: 'agent',
      capabilities: [],
      policy: {
        allowed_roots: [],
        remote_sessions: {
          always_confirm: [
            'Bash(ssh *)',
            'Bash(scp *)',
            'Bash(git push*)',
            'Vault(*)',
            'Bash(*deploy*)'
          ],
          deny: ['Bash(rm -rf /*)']
        },
        max_concurrent_jobs: 2
      },
      runbooksDir: path.join(resolvedAdminDir, 'runbooks')
    };
  }

  assertAdminOwned(configFile, geteuid, adminUid);

  let raw;
  try {
    raw = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${configFile}: ${err.message}`);
  }

  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid ${configFile}: must contain a YAML object`);
  }

  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'unnamed-node';
  const profile = parsed.profile === 'runbook' ? 'runbook' : 'agent';
  const frontDoor = typeof parsed.front_door === 'string' ? parsed.front_door.trim() : null;
  const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities.map(String) : [];

  const rawPolicy = parsed.policy && typeof parsed.policy === 'object' ? parsed.policy : {};
  const allowedRoots = Array.isArray(rawPolicy.allowed_roots)
    ? rawPolicy.allowed_roots.map((r) => path.resolve(String(r)))
    : [];

  const rawRemoteSessions = rawPolicy.remote_sessions && typeof rawPolicy.remote_sessions === 'object'
    ? rawPolicy.remote_sessions
    : {};

  const alwaysConfirm = Array.isArray(rawRemoteSessions.always_confirm)
    ? rawRemoteSessions.always_confirm.map(String)
    : [
        'Bash(ssh *)',
        'Bash(scp *)',
        'Bash(git push*)',
        'Vault(*)',
        'Bash(*deploy*)'
      ];

  const deny = Array.isArray(rawRemoteSessions.deny)
    ? rawRemoteSessions.deny.map(String)
    : ['Bash(rm -rf /*)'];

  const maxConcurrentJobs = Number.isInteger(rawPolicy.max_concurrent_jobs) && rawPolicy.max_concurrent_jobs > 0
    ? rawPolicy.max_concurrent_jobs
    : 2;

  const rawRunbooksDir = typeof parsed.runbooks_dir === 'string' && parsed.runbooks_dir.trim()
    ? parsed.runbooks_dir.trim()
    : 'runbooks';

  const runbooksDir = path.isAbsolute(rawRunbooksDir)
    ? path.normalize(rawRunbooksDir)
    : path.normalize(path.join(resolvedAdminDir, rawRunbooksDir));

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

module.exports = { loadNodeConfig, assertAdminOwned, NODE_CONFIG_FILE };

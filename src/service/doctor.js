const fs = require('fs');
const path = require('path');

function posixPrivate(file) {
  const mode = fs.statSync(file).mode & 0o777;
  return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
}

// adminUid is the uid that must own node.yaml and the runbooks on POSIX
// (default root). The CLI never passes it; tests pass their own euid so the
// wiring runs unprivileged too.
function runDoctor({ dataDir, platform = process.platform, adminUid = 0 }) {
  const results = [];
  const major = Number(process.versions.node.split('.')[0]);
  results.push({ check: 'node >= 22', ok: major >= 22, detail: process.versions.node });

  const exists = fs.existsSync(dataDir);
  results.push({ check: 'data dir exists', ok: exists, detail: dataDir });
  if (!exists) return results;

  if (platform !== 'win32') {
    results.push({ check: 'data dir is private', ...posixPrivate(dataDir) });
    for (const name of ['master.key', 'gateway-token', 'chat-data.json', 'config.json']) {
      const file = path.join(dataDir, name);
      if (fs.existsSync(file)) results.push({ check: `${name} is private`, ...posixPrivate(file) });
    }
    if (typeof process.getuid === 'function') {
      results.push({ check: 'not running as root', ok: process.getuid() !== 0, detail: `uid ${process.getuid()}` });
    }
  } else {
    results.push({ check: 'DPAPI-wrapped master key present', ok: fs.existsSync(path.join(dataDir, 'master.key.dpapi')), detail: 'created on first run' });
  }

  // Check Node Config & Runbooks health
  try {
    const { loadNodeConfig } = require('./node-config');
    const { RunbookEngine } = require('../runbooks/runbook-engine');
    const nodeCfg = loadNodeConfig({ dataDir, adminUid });

    results.push({ check: 'node configuration loaded', ok: true, detail: `name: ${nodeCfg.name}, profile: ${nodeCfg.profile}` });

    if (fs.existsSync(nodeCfg.runbooksDir)) {
      const engine = new RunbookEngine({
        runbooksDir: nodeCfg.runbooksDir,
        allowedRoots: nodeCfg.policy.allowed_roots,
        adminUid
      });
      const runbooks = engine.loadRunbooks();
      results.push({ check: 'runbooks loaded', ok: true, detail: `${runbooks.size} runbook(s) found in ${nodeCfg.runbooksDir}` });
      const { checkRunbookCommands } = require('./doctor-runbooks');
      results.push(...checkRunbookCommands(runbooks, {
        platform,
        env: process.env,
        cwd: process.cwd(),
        geteuid: typeof process.geteuid === 'function' ? () => process.geteuid() : null,
        spawnSync: require('child_process').spawnSync
      }));
    }
  } catch (err) {
    results.push({ check: 'node config / runbooks health', ok: false, detail: err.message });
  }

  return results;
}

module.exports = { runDoctor };

const fs = require('fs');
const path = require('path');

function posixPrivate(file) {
  const mode = fs.statSync(file).mode & 0o777;
  return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
}

// adminUid is the uid that must own node.yaml and the runbooks on POSIX
// (default root). The CLI never passes it; tests pass their own euid so the
// wiring runs unprivileged too.
// Async: the approval checks wait for the approver store to load.
async function runDoctor({ dataDir, platform = process.platform, adminUid = 0 }) {
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

  results.push(...(await approvalChecks({ dataDir, platform, adminUid })));
  return results;
}

// Fleet stage 3: the approver set must be admin-only, the relay linked when
// one is configured, and the audit chain intact.
async function approvalChecks({ dataDir, platform, adminUid = 0 }) {
  const out = [];
  const attempt = async (check, fn) => {
    try {
      out.push({ check, ...(await fn()) });
    } catch (err) {
      out.push({ check, ok: false, detail: err.message });
    }
  };
  const { adminConfigDir } = require('../platform/paths');
  const dir = path.join(adminConfigDir({ dataDir }), 'approvers');
  const stagedDir = path.join(dataDir, 'approvals', 'staged');
  let problem = null;
  await attempt('approvers dir is writable only by an administrator', () => {
    const { checkApproverDir } = require('../approvals/approver-store');
    // serviceProbe: false — doctor is run by an administrator, and on
    // Windows that account can always write approvers/, so a probe from here
    // proves nothing either way. Only the service's own probe (run as the
    // service account, at start) can tell, and the row says so.
    problem = checkApproverDir({ dir, platform, serviceProbe: false });
    if (problem) return { ok: false, detail: problem };
    if (platform === 'win32') {
      return { ok: true, detail: 'not verifiable from an admin shell on Windows; the service checks it at start' };
    }
    return { ok: true, detail: dir };
  });
  await attempt('active phone approvers', async () => {
    const { ApproverStore } = require('../approvals/approver-store');
    if (problem) return { ok: true, detail: '0 (the set is not trusted)' };
    // stagedDir: a verified revoke waiting for `device apply` already ends
    // that device's trust (the overlay), so it is not counted as active.
    const store = new ApproverStore({ dir, stagedDir, platform, serviceProbe: false });
    await store.ready();
    return { ok: true, detail: String(store.activeCount()) };
  });
  await attempt('relay paired and linked', () => {
    const { loadNodeConfig } = require('./node-config');
    const nodeCfg = loadNodeConfig({ dataDir, adminUid });
    if (!nodeCfg.approvers.relay) return { ok: true, detail: 'no relay configured (phone approvals off)' };
    let link = null;
    try {
      link = JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));
    } catch {
      link = null;
    }
    if (!link) return { ok: false, detail: `not paired with ${nodeCfg.approvers.relay} (run pair)` };
    return { ok: link.connected === true, detail: `${link.relay_id} ${link.connected ? 'connected' : 'disconnected'}` };
  });
  await attempt('audit ledger chain', () => {
    const { AuditLedger } = require('../audit/audit-ledger');
    const result = new AuditLedger({ dir: path.join(dataDir, 'audit'), nodeId: null }).verify();
    return { ok: result.ok, detail: result.ok ? `${result.entries} entries` : `broken at seq ${result.brokenAt} (${result.reason})` };
  });
  return out;
}

module.exports = { runDoctor };

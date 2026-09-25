const fs = require('fs');
const path = require('path');

function posixPrivate(file) {
  const mode = fs.statSync(file).mode & 0o777;
  return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
}

function runDoctor({ dataDir, platform = process.platform }) {
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
    const nodeCfg = loadNodeConfig({ dataDir });

    results.push({ check: 'node configuration loaded', ok: true, detail: `name: ${nodeCfg.name}, profile: ${nodeCfg.profile}` });

    if (fs.existsSync(nodeCfg.runbooksDir)) {
      const engine = new RunbookEngine({
        runbooksDir: nodeCfg.runbooksDir,
        allowedRoots: nodeCfg.policy.allowed_roots
      });
      const runbooks = engine.loadRunbooks();
      results.push({ check: 'runbooks loaded', ok: true, detail: `${runbooks.size} runbook(s) found in ${nodeCfg.runbooksDir}` });
    }
  } catch (err) {
    results.push({ check: 'node config / runbooks health', ok: false, detail: err.message });
  }

  results.push(...approvalChecks({ dataDir, platform }));
  return results;
}

// Fleet stage 3: the approver set must be admin-only, the relay linked when
// one is configured, and the audit chain intact.
function approvalChecks({ dataDir, platform }) {
  const out = [];
  const attempt = (check, fn) => {
    try {
      out.push({ check, ...fn() });
    } catch (err) {
      out.push({ check, ok: false, detail: err.message });
    }
  };
  const { adminConfigDir } = require('../platform/paths');
  const dir = path.join(adminConfigDir({ dataDir }), 'approvers');
  let problem = null;
  attempt('approvers dir is writable only by an administrator', () => {
    const { checkApproverDir } = require('../approvals/approver-store');
    // serviceProbe: false — doctor is run by an administrator (this check
    // covers the same ground as `device list`'s carry), and on Windows that
    // account can always write approvers/; only the service's own probe
    // (serviceProbe: true, run as the service account) means anything there.
    problem = checkApproverDir({ dir, platform, serviceProbe: false });
    return { ok: problem === null, detail: problem || dir };
  });
  attempt('active phone approvers', () => {
    const { ApproverStore } = require('../approvals/approver-store');
    if (problem) return { ok: true, detail: '0 (the set is not trusted)' };
    const store = new ApproverStore({ dir, platform, serviceProbe: false });
    // ready() is async only for interface symmetry with the service's own
    // (long-lived) use; its body awaits nothing, so this call's side effects
    // — untrusted/problem and the revoke overlay, from the same sync
    // checkApproverDir() this module already ran above — are already
    // applied by the time it returns. Without this, the store stays
    // permanently untrusted (its constructor's default) and activeCount()
    // would report 0 even for a healthy approver set.
    store.ready();
    return { ok: true, detail: String(store.activeCount()) };
  });
  attempt('relay paired and linked', () => {
    const { loadNodeConfig } = require('./node-config');
    const nodeCfg = loadNodeConfig({ dataDir });
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
  attempt('audit ledger chain', () => {
    const { AuditLedger } = require('../audit/audit-ledger');
    const result = new AuditLedger({ dir: path.join(dataDir, 'audit'), nodeId: null }).verify();
    return { ok: result.ok, detail: result.ok ? `${result.entries} entries` : `broken at seq ${result.brokenAt} (${result.reason})` };
  });
  return out;
}

module.exports = { runDoctor };

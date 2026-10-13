const fs = require('fs');
const path = require('path');

function posixPrivate(file) {
  const mode = fs.statSync(file).mode & 0o777;
  return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
}

// adminUid is the uid that must own node.yaml and the runbooks on POSIX
// The "node identity record" row for a record that names the identity in the
// data dir, with what doctor did not check said in it (fourth security
// review, finding 5): the row used to read as a plain "ok" where the service
// could still refuse. `acl`: recordAclProblem's answer on Windows (asked
// with `whole`: the config dir, the record's directory and the record, with
// their owners), null elsewhere. "Clean" is said only for that answer
// (fifth security review, finding 5); every other row says what was read
// and what was not.
function identityMatchRow({ seen, platform, acl = null }) {
  const check = 'node identity record';
  const privateHalf = 'that the data dir holds this key\'s private half (doctor does not resolve the master key; the service and "session install" check it)';
  const base = `${seen.recorded.nodeId}, recorded by an administrator in ${seen.file}`;
  if (platform !== 'win32') {
    return { check, ok: true, detail: `${base} (public keys compared; owner and mode read). Not checked here: ${privateHalf}` };
  }
  const probe = 'whether the account the service runs as can write the record (an administrator always can, so doctor\'s own attempt would show nothing; the service probes it itself when it starts and before each lease request, and refuses a record it can write)';
  const read = 'public keys compared; owners and access lists read, of the record, its directory and the config dir';
  if (acl && acl.state === 'writable' && acl.where === 'config') {
    return {
      check, ok: false,
      detail: `${seen.file} names this identity, but ${acl.detail}. Whoever can delete or add in the config dir can put a directory of its own in place of the one that holds the record, and with it a record that vouches for another identity. `
        + 'As root or an Administrator find out who changed the access list and set it so that only SYSTEM and Administrators can change the config dir (the account the service runs as needs read and execute, nothing more), '
        + 'then run "king-louie-service identity record --replace", which writes the record anew in a new directory with an access list of its own'
    };
  }
  if (acl && acl.state === 'writable') {
    return {
      check, ok: false,
      detail: `${seen.file} names this identity, but ${acl.detail}. Whoever can change the record can make it vouch for another identity, and the service refuses a record its own account can write. `
        + 'As root or an Administrator find out who changed the access list, then run "king-louie-service identity record --replace", which writes the record anew in a new directory with an access list of its own'
    };
  }
  if (acl && acl.state === 'clean') {
    return { check, ok: true, detail: `${base} (${read}: all three are owned by Administrators or SYSTEM, and no entry lets anyone else change them). Not checked here: ${privateHalf}; ${probe}` };
  }
  if (acl && acl.state === 'owner') {
    return {
      check, ok: true, warn: true,
      detail: `${base} (${read}: no entry lets anyone but SYSTEM and Administrators change them, but ${acl.detail}). Not checked here: ${privateHalf}; ${probe}`
    };
  }
  const why = (acl && acl.detail) || 'the access lists of the record and its directory were not read';
  return { check, ok: true, detail: `${base} (public keys compared; owners read). Not checked here: who can change the record (${why}; run doctor from an elevated prompt); ${privateHalf}; ${probe}` };
}

// (default root). The CLI never passes it; tests pass their own euid so the
// wiring runs unprivileged too.
// Async: the approval checks wait for the approver store to load.
// deps.identityRecord: tests only (how a temp dir's identity record is read).
async function runDoctor({ dataDir, platform = process.platform, adminUid = 0, configDir = null, deps = {} }) {
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
    // Fleet stage 5 §3.4: gui.apps entries that match by bare process name.
    for (const warning of (nodeCfg.gui && nodeCfg.gui.warnings) || []) {
      results.push({ check: 'gui app allowlist', ok: true, warn: true, detail: warning });
    }

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

  // Fleet stage 4 §3.14: a node linked to a front door (only when it has
  // front-door.json; a node.yaml problem is already the row above).
  {
    const { adminConfigDir } = require('../platform/paths');
    const dir = configDir || adminConfigDir({ dataDir });
    // lstat, as readPin does: a dangling front-door.json link is reported.
    let hasPin = true;
    try {
      fs.lstatSync(path.join(dir, 'front-door.json'));
    } catch (err) {
      hasPin = false;
      // Anything but "not there" is a problem to report, not a crash.
      if (err.code !== 'ENOENT') results.push({ check: 'front-door.json is admin-owned and valid', ok: false, detail: err.message });
    }
    if (hasPin) {
      let nodeConfig = null;
      try {
        nodeConfig = require('./node-config').loadNodeConfig({ dataDir, adminConfigDir: dir, adminUid });
      } catch {
        nodeConfig = null;
      }
      results.push(...(await require('../fleet/doctor-checks').nodeFrontDoorChecks({ configDir: dir, adminUid, nodeConfig })));
    }
  }

  // Fleet stage 5 (R-F5-11): the session helper file. A file that is there
  // but that the service would refuse turns desktop apps off; say so, with
  // the remedy. doctor has no master key, so it checks what it can (a regular
  // file, JSON, its shape, its owner); what the running service itself found
  // (a file that does not decrypt, say) is read from its status record.
  {
    const { adminConfigDir } = require('../platform/paths');
    const dir = configDir || adminConfigDir({ dataDir });
    const { inspectCanonical } = require('../gui/session-secret');
    const { readGuiStatusRecord, SESSION_FILE_REMEDY, remedyFor } = require('../gui/status');
    // What a status file or the helper file says is not doctor's own text.
    const { shown } = require('./commands/io');
    const seen = inspectCanonical({ configDir: dir, platform, adminUid, checkOwner: true, requireIdentity: false });
    const record = readGuiStatusRecord({ dataDir });
    const serviceSays = record && record.available !== true && typeof record.reason === 'string' && record.reason ? record : null;
    if (seen.state === 'invalid') {
      results.push({ check: 'session helper file', ok: false, detail: `session_file_invalid: ${seen.file} ${seen.reason}; desktop apps are off. To fix it, ${SESSION_FILE_REMEDY}` });
    } else if (serviceSays) {
      results.push({ check: 'desktop apps (running service)', ok: false, detail: `off, ${shown(serviceSays.reason)}${serviceSays.detail ? `: ${shown(serviceSays.detail)}` : ''}. To fix it, ${remedyFor(serviceSays.reason)}` });
    } else if (seen.state === 'installed') {
      // R-F5-14: installing the helper enables nothing; node.yaml does.
      let enabled = null;
      try {
        const gui = require('./node-config').loadNodeConfig({ dataDir, adminConfigDir: dir, adminUid }).gui;
        enabled = Boolean(gui && gui.enabled === true);
      } catch {
        enabled = null; // a node.yaml problem is the "node config" row above
      }
      if (enabled === false) {
        results.push({ check: 'session helper file', ok: true, warn: true, detail: `installed but not enabled in node.yaml: desktop apps stay off until ${path.join(dir, 'node.yaml')} has "gui:" with "enabled: true" under it, and the service is restarted` });
      } else {
        results.push({ check: 'session helper file', ok: true, detail: `installed for ${shown(seen.user)}; the service checks that it decrypts when it starts` });
      }
    }
  }

  // R-F5-17: the administrator's record of this node's identity, against the
  // public key the data dir holds. Doctor does not resolve the master key,
  // so this compares public keys only; the service and "session install"
  // also check that the private key is the public key's. Front doors and
  // relay hosts are not held to a record.
  {
    const { adminConfigDir } = require('../platform/paths');
    const dir = configDir || adminConfigDir({ dataDir });
    let profile = null;
    try {
      profile = require('./node-config').loadNodeConfig({ dataDir, adminConfigDir: dir, adminUid }).profile;
    } catch {
      profile = null; // a node.yaml problem is the "node config" row above
    }
    let held = null;
    try {
      const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8'));
      const key = store && store.mesh && store.mesh.identity && store.mesh.identity.publicKey;
      if (typeof key === 'string' && key) held = { publicKey: key };
    } catch {
      held = null; // no store yet, or one doctor cannot read: nothing to compare
    }
    if (held && profile !== 'frontdoor') {
      const { checkNodeIdentityRecord } = require('./identity-record');
      // serviceProbe: false: doctor is run by an administrator, who can
      // write the directory; the service's own probe is the one that counts.
      const seen = checkNodeIdentityRecord({ configDir: dir, dataDir, identity: held, platform, adminUid, serviceProbe: false, ...(deps.identityRecord || {}) });
      if (seen.state === 'match') {
        // Windows: who the access lists let change the record, which neither
        // the owner read above nor an administrator's own write would show.
        const { recordAclProblem } = require('./identity-record');
        const acl = platform === 'win32' ? recordAclProblem({ configDir: dir, whole: true, ...(deps.identityRecord && deps.identityRecord.inspectAcl ? { inspectAcl: deps.identityRecord.inspectAcl } : {}) }) : null;
        results.push(identityMatchRow({ seen, platform, acl }));
      } else if (seen.state === 'none') {
        results.push({ check: 'node identity record', ok: true, warn: true, detail: `${seen.problem}. Until then the service runs, computer use stays off and "session install" refuses` });
      } else if (seen.unreadable) {
        // doctor's own account may not read the record (not elevated): that says
        // nothing about the record, and nothing about what the service will do.
        results.push({ check: 'node identity record', ok: false, detail: `${seen.problem}. Nothing about the record was checked` });
      } else {
        results.push({ check: 'node identity record', ok: false, detail: `${seen.problem}. The service refuses to start until this is fixed` });
      }
    }
  }

  // Fleet stage 4 §3.14: doctor on a front door.
  {
    const { adminConfigDir } = require('../platform/paths');
    const dir = configDir || adminConfigDir({ dataDir });
    let nodeConfig = null;
    try {
      nodeConfig = require('./node-config').loadNodeConfig({ dataDir, adminConfigDir: dir, adminUid });
    } catch {
      nodeConfig = null;
    }
    if (nodeConfig && nodeConfig.profile === 'frontdoor') {
      let serviceConfig = null;
      try {
        serviceConfig = require('./config').loadServiceConfig(dataDir, {}, { adminConfigDir: dir, adminUid });
      } catch (err) {
        results.push({ check: 'service.json', ok: false, detail: err.message });
      }
      if (serviceConfig) results.push(...(await require('../frontdoor/doctor-checks').checks({ dataDir, configDir: dir, adminUid, nodeConfig, serviceConfig, platform })));
    }
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

module.exports = { runDoctor, identityMatchRow };

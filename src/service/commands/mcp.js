// `king-louie-service mcp` (fleet stage 4 §3.7, R24). With the service
// running on this data dir, every tool call goes to the service's own
// handler through the courier, so there is one JobManager per node. Without
// one (dev, or F6's per-runner instances, R52) this process builds its own
// engine and limits and says so. Neither branch loads the agent core.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { runningServicePid } = require('./io');

const log = createLogger('mcp');

const defaultGetuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

// Run as root against a running service, the courier directories must be
// real directories (not a symlink or junction the service account could
// point elsewhere) owned by the data dir's owner, or mcp refuses. An extra
// layer only: the real protection is that mcp never writes there as root
// (dropToDataDirOwner below).
function assertCourierDirsSafe(dataDir, { getuid = defaultGetuid, fsImpl = fs } = {}) {
  if (getuid() !== 0) return;
  const owner = fsImpl.lstatSync(dataDir);
  if (owner.isSymbolicLink() || !owner.isDirectory()) {
    throw new Error(`refusing to run mcp as root: ${dataDir} is not a real directory`);
  }
  const approvals = path.join(dataDir, 'approvals');
  for (const dir of [approvals, path.join(approvals, 'inbox'), path.join(approvals, 'outbox')]) {
    let st;
    try {
      st = fsImpl.lstatSync(dir);
    } catch {
      throw new Error(`refusing to run mcp as root: ${dir} does not exist (start the service first)`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to run mcp as root: ${dir} is not a real directory`);
    }
    if (st.uid !== owner.uid) {
      throw new Error(`refusing to run mcp as root: ${dir} is owned by uid ${st.uid}, not the data dir's owner (uid ${owner.uid})`);
    }
  }
}

// Ruling T13-dropprivs: run as root against a running service, `mcp` must
// not write into the courier directories as root at all — the service
// account owns approvals/ and could swap outbox/ or inbox/ for a link at any
// moment, turning each root write (or chown) into a file planted wherever
// root can write. So before the courier writes anything, the process becomes
// the data dir's owner, once, for the rest of its life: supplementary groups
// cleared, gid, then uid, then verified. A root-owned data dir has no one to
// become and is refused. `proc` is injectable for tests; on Windows there is
// no getuid and this is a no-op.
function isRoot(proc) {
  return (typeof proc.getuid === 'function' && proc.getuid() === 0)
    || (typeof proc.geteuid === 'function' && proc.geteuid() === 0);
}

function dropToDataDirOwner(dataDir, { proc = process, fsImpl = fs } = {}) {
  if (!isRoot(proc)) return null;
  const st = fsImpl.lstatSync(dataDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to run mcp as root: ${dataDir} is not a real directory`);
  }
  const { uid, gid } = st;
  if (uid === 0) {
    throw new Error(`refusing to run mcp as root: ${dataDir} is owned by root, so there is no service account to run as; run mcp as the service account`);
  }
  try {
    if (typeof proc.setgroups === 'function') proc.setgroups([]);
    proc.setgid(gid);
    proc.setuid(uid);
  } catch (err) {
    throw new Error(`refusing to run mcp as root: could not become the data dir's owner (uid ${uid}, gid ${gid}): ${err.message}`);
  }
  if (proc.getuid() !== uid || proc.geteuid() !== uid) {
    throw new Error(`refusing to run mcp as root: still running as uid ${proc.getuid()}/${proc.geteuid()} after dropping to the data dir's owner (uid ${uid})`);
  }
  return { uid, gid };
}

async function runMcp({ dataDir, io, deps = {} }) {
  const { loadNodeConfig } = require('../node-config');
  const { restoreDataDirOwnership } = require('../ownership');
  const StdioMcpServer = require('../../mcp/stdio-server');
  const adminOptions = {
    dataDir,
    ...(deps.configDir ? { adminConfigDir: deps.configDir } : {}),
    ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid })
  };
  const proc = deps.proc || process;
  const nodeCfg = loadNodeConfig(adminOptions);

  if (runningServicePid(dataDir)) {
    // Checked as root first (an extra layer), then root is given up for good
    // before the courier's first write (ruling T13-dropprivs).
    assertCourierDirsSafe(dataDir, { getuid: () => (isRoot(proc) ? 0 : -1) });
    const { FileCourier } = require('../../approvals/courier');
    const { CourierFleetClient } = require('../../fleet/courier-client');
    const dropped = dropToDataDirOwner(dataDir, { proc });
    if (dropped) log.info(`running as the data dir's owner (uid ${dropped.uid}, gid ${dropped.gid})`);
    const courier = new FileCourier({ dataDir }).start();
    const server = new StdioMcpServer({ handler: new CourierFleetClient({ courier, nodeConfig: nodeCfg }), stdin: io.stdin, stdout: io.stdout });
    server.start();
    return new Promise(() => {}); // keep listening on stdio
  }

  // Run as root, whatever this command creates in the data dir goes back to
  // the service account that owns it (as withServiceCore did for `mcp`).
  const written = [];
  try {
    log.warn(`no service is running on ${dataDir}: this mcp process enforces its own max_concurrent_jobs and rate limits, separately from any other King Louie process on this machine`);
    const { buildServicePorts } = require('../ports');
    const { RunbookEngine } = require('../../runbooks/runbook-engine');
    const { startMcpApprovals } = require('../../approvals/service-wiring');
    const ports = buildServicePorts({ dataDir, onPathWritten: (p) => written.push(p) });
    const approvals = await startMcpApprovals({
      dataDir, nodeConfig: nodeCfg, ports,
      ...(deps.configDir ? { configDir: deps.configDir } : {}),
      ...(deps.adminUid === undefined ? {} : { approverStoreOptions: { adminUid: deps.adminUid } })
    });
    const runbookEngine = new RunbookEngine({
      runbooksDir: nodeCfg.runbooksDir,
      allowedRoots: nodeCfg.policy.allowed_roots,
      ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid })
    });
    // Loaded once, here: a bad runbook file fails the command at startup.
    runbookEngine.loadRunbooks();
    const server = new StdioMcpServer({
      nodeConfig: nodeCfg, runbookEngine, approver: approvals.approver, auditLedger: approvals.auditLedger, stdin: io.stdin, stdout: io.stdout
    });
    server.start();
    return new Promise(() => {});
  } finally {
    restoreDataDirOwnership(dataDir, written, io.ownership);
  }
}

module.exports = { runMcp, assertCourierDirsSafe, dropToDataDirOwner };

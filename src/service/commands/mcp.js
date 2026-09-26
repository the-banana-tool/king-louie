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

// Run as root against a running service, this process writes into the
// courier directories the service account owns. Before any write, each must
// be a real directory (not a symlink or junction the service account could
// point elsewhere) owned by the data dir's owner; otherwise mcp refuses.
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

async function runMcp({ dataDir, io, deps = {} }) {
  const { loadNodeConfig } = require('../node-config');
  const { restoreDataDirOwnership } = require('../ownership');
  const StdioMcpServer = require('../../mcp/stdio-server');
  const adminOptions = {
    dataDir,
    ...(deps.configDir ? { adminConfigDir: deps.configDir } : {}),
    ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid })
  };
  const ownership = { ...(io.ownership || {}), ...(deps.getuid ? { getuid: deps.getuid } : {}) };
  const nodeCfg = loadNodeConfig(adminOptions);

  if (runningServicePid(dataDir)) {
    assertCourierDirsSafe(dataDir, { ...(deps.getuid ? { getuid: deps.getuid } : {}) });
    const { FileCourier } = require('../../approvals/courier');
    const { CourierFleetClient } = require('../../fleet/courier-client');
    // Each path is handed to the service account as it is written (a no-op
    // unless run as root): the inbox before the service must write replies
    // into it, and every request file before it is renamed into the outbox.
    const courier = new FileCourier({ dataDir, onPathWritten: (p) => restoreDataDirOwnership(dataDir, [p], ownership) }).start();
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
    restoreDataDirOwnership(dataDir, written, ownership);
  }
}

module.exports = { runMcp, assertCourierDirsSafe };

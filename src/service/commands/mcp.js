// `king-louie-service mcp` (fleet stage 4 §3.7, R24). With the service
// running on this data dir, every tool call goes to the service's own
// handler through the courier, so there is one JobManager per node. Without
// one (dev, or F6's per-runner instances, R52) this process builds its own
// engine and limits and says so. Neither branch loads the agent core.
const { createLogger } = require('../../logging');
const { runningServicePid } = require('./io');

const log = createLogger('mcp');

async function runMcp({ dataDir, io, deps = {} }) {
  const { loadNodeConfig } = require('../node-config');
  const { restoreDataDirOwnership } = require('../ownership');
  const StdioMcpServer = require('../../mcp/stdio-server');
  const adminOptions = {
    dataDir,
    ...(deps.configDir ? { adminConfigDir: deps.configDir } : {}),
    ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid })
  };
  const nodeCfg = loadNodeConfig(adminOptions);
  // Run as root, whatever this command creates in the data dir goes back to
  // the service account that owns it (as withServiceCore did for `mcp`).
  const written = [];
  const onPathWritten = (p) => written.push(p);

  try {
    if (runningServicePid(dataDir)) {
      const { FileCourier } = require('../../approvals/courier');
      const { CourierFleetClient } = require('../../fleet/courier-client');
      const courier = new FileCourier({ dataDir, onPathWritten }).start();
      const server = new StdioMcpServer({ handler: new CourierFleetClient({ courier, nodeConfig: nodeCfg }), stdin: io.stdin, stdout: io.stdout });
      server.start();
      return new Promise(() => {}); // keep listening on stdio
    }

    log.warn(`no service is running on ${dataDir}: this mcp process enforces its own max_concurrent_jobs and rate limits, separately from any other King Louie process on this machine`);
    const { buildServicePorts } = require('../ports');
    const { RunbookEngine } = require('../../runbooks/runbook-engine');
    const { startMcpApprovals } = require('../../approvals/service-wiring');
    const ports = buildServicePorts({ dataDir, onPathWritten });
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

module.exports = { runMcp };

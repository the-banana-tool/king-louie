// startFleetNode (fleet stage 4 §3.7): what every runbook and agent service
// hosts, whether or not a front door is configured — the runbook engine
// (loaded once), one JobManager sized from node policy, the FleetToolHandler,
// delegate sessions on the agent profile, the fleet.* link methods when a
// relay/front-door link exists, and the courier handler `mcp` routes to (R24).
// It never requires the agent core itself; the agent profile passes its core.
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { RunbookEngine, JobManager } = require('../runbooks/runbook-engine');
const { FleetToolHandler, ToolError, STDIO_ORIGIN } = require('./fleet-tools');
const { NodeFleetService } = require('./node-fleet-service');
const { CourierPump } = require('../approvals/courier');

const log = createLogger('fleet/start');

// F5's gui status reader (src/gui/status.js), when F5 has merged.
function defaultReadGuiStatus() {
  try {
    // eslint-disable-next-line global-require
    return require('../gui/status').readGuiStatus;
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /gui[\\/]status/.test(err.message)) return null;
    throw err;
  }
}

// The service side of CourierFleetClient: fleet.<tool> { args } → the handler.
function courierRpcHandler(handler) {
  return async (method, params = {}) => {
    if (typeof method !== 'string' || !method.startsWith('fleet.')) {
      throw Object.assign(new Error(`${method} is not a courier method`), { code: 'unknown_method' });
    }
    try {
      return { result: await handler.call(method.slice('fleet.'.length), params.args || {}, { origin: STDIO_ORIGIN }) };
    } catch (err) {
      if (err instanceof ToolError) return { tool_error: { code: err.code, message: err.message, data: err.data || {} } };
      throw err;
    }
  };
}

async function startFleetNode({ dataDir, nodeConfig, approvals, core = null, adminUid, geteuid, deps = {} } = {}) {
  const runbookEngine = new RunbookEngine({
    runbooksDir: nodeConfig.runbooksDir,
    allowedRoots: nodeConfig.policy.allowed_roots,
    ...(adminUid === undefined ? {} : { adminUid }),
    ...(geteuid ? { geteuid } : {})
  });
  // Loaded once: a bad runbook stops the service here, with its error.
  runbookEngine.loadRunbooks();
  const jobManager = new JobManager({ maxConcurrentJobs: nodeConfig.policy.max_concurrent_jobs });

  let delegateSessions = null;
  if (nodeConfig.profile === 'agent' && core) {
    // eslint-disable-next-line global-require -- agent profile only (it loads the provider registry)
    const { DelegateSessions } = require('./delegate-sessions');
    delegateSessions = new DelegateSessions({
      core, nodeConfig, jobManager, auditLedger: approvals.auditLedger, leaseManager: deps.leaseManager || null
    });
  }

  const readGuiStatus = deps.readGuiStatus === undefined ? defaultReadGuiStatus() : deps.readGuiStatus;
  const gui = readGuiStatus ? () => readGuiStatus({ dataDir }) : null;
  const handler = new FleetToolHandler({
    nodeConfig, runbookEngine, jobManager, approver: approvals.phoneApprover, auditLedger: approvals.auditLedger, delegateSessions, gui
  });

  const bootId = crypto.randomBytes(16).toString('hex');
  let fleetService = null;
  if (approvals.relayClient) {
    fleetService = new NodeFleetService({ handler, relayClient: approvals.relayClient, nodeConfig: { ...nodeConfig, nodeId: approvals.identity.nodeId }, bootId }).start();
  }

  let courierPump = approvals.courierPump || null;
  let ownPump = false;
  if (courierPump) {
    courierPump.setRpcHandler(courierRpcHandler(handler));
  } else {
    courierPump = new CourierPump({ dataDir, relayClient: null, identity: approvals.identity, rpcHandler: courierRpcHandler(handler) }).start();
    ownPump = true;
  }
  log.info('fleet node ready', { profile: nodeConfig.profile, runbooks: runbookEngine.runbooks.size, delegate: Boolean(delegateSessions), link: Boolean(fleetService) });

  return {
    handler,
    jobManager,
    runbookEngine,
    delegateSessions,
    fleetService,
    courierPump,
    bootId,
    async stop() {
      if (fleetService) fleetService.stop();
      if (delegateSessions) delegateSessions.stop();
      if (ownPump) courierPump.stop();
      else courierPump.setRpcHandler(null);
      for (const jobId of [...jobManager.jobs.keys()]) jobManager.cancelJob(jobId);
    }
  };
}

module.exports = { startFleetNode, courierRpcHandler };

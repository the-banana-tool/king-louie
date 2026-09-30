// startFleetNode (fleet stage 4 §3.7): what every runbook and agent service
// hosts, whether or not a front door is configured — the runbook engine
// (loaded once), one JobManager sized from node policy, the FleetToolHandler,
// delegate sessions on the agent profile, the fleet.* link methods when a
// relay/front-door link exists, and the courier handler `mcp` routes to (R24).
// It never requires the agent core itself; the agent profile passes its core.
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { RunbookEngine, JobManager } = require('../runbooks/runbook-engine');
const { FleetToolHandler, MCP_TOOLS, ToolError, STDIO_ORIGIN } = require('./fleet-tools');
const { NodeFleetService } = require('./node-fleet-service');
const { CourierPump } = require('../approvals/courier');

const log = createLogger('fleet/start');

// How long stop() waits for running job executions and delegate turns to
// settle after cancelling them, before the core is shut down under them.
const STOP_WAIT_MS = 10000;

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
// Always as the node's own local MCP client (STDIO_ORIGIN): an `origin` in
// the request file is never read. An error that is not a ToolError can name
// paths and internals, so it is logged here and answered as `internal`.
function courierRpcHandler(handler) {
  return async (method, params = {}) => {
    // The tool list `mcp` shows its client (cases stage 7: the case tools
    // are listed only by a handler that has a CaseRuntime).
    if (method === 'mcp.tools_list') return { result: typeof handler.listTools === 'function' ? handler.listTools() : MCP_TOOLS };
    if (typeof method !== 'string' || !method.startsWith('fleet.')) {
      throw Object.assign(new Error(`${method} is not a courier method`), { code: 'unknown_method' });
    }
    try {
      return { result: await handler.call(method.slice('fleet.'.length), params.args || {}, { origin: STDIO_ORIGIN }) };
    } catch (err) {
      if (err instanceof ToolError) return { tool_error: { code: err.code, message: err.message, data: err.data || {} } };
      log.warn(`courier ${method} failed: ${err && err.message}`);
      return { tool_error: { code: 'internal', message: 'internal error', data: {} } };
    }
  };
}

// Resolves once every promise has settled or after `ms`, whichever is first;
// true when all settled.
async function settleWithin(promises, ms) {
  if (promises.length === 0) return true;
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([Promise.allSettled(promises).then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function startFleetNode({ dataDir, nodeConfig, approvals, core = null, adminUid, geteuid, deps = {} } = {}) {
  const stopWaitMs = deps.stopWaitMs === undefined ? STOP_WAIT_MS : deps.stopWaitMs;
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
  let caseTools = null;
  let fleetService = null;
  let courierPump = approvals.courierPump || null;
  let ownPump = false;
  let rpcInstalled = false;
  // Undoes whatever has been started so far; used by stop() and by a
  // startup that fails partway (nothing may be left running either way).
  const teardown = () => {
    if (fleetService) fleetService.stop();
    if (delegateSessions) delegateSessions.stop();
    if (courierPump && ownPump) courierPump.stop();
    else if (courierPump && rpcInstalled) courierPump.setRpcHandler(null);
    for (const jobId of [...jobManager.jobs.keys()]) jobManager.cancelJob(jobId);
  };

  let handler;
  const bootId = crypto.randomBytes(16).toString('hex');
  try {
    if (nodeConfig.profile === 'agent' && core) {
      // eslint-disable-next-line global-require -- agent profile only (it loads the provider registry)
      const { DelegateSessions } = require('./delegate-sessions');
      delegateSessions = new DelegateSessions({
        core, nodeConfig, jobManager, auditLedger: approvals.auditLedger, leaseManager: deps.leaseManager || null
      });
      // Cases stage 7 (spec §3.7): the MCP case tools for this node's local
      // clients (mcp reaches them through the courier, R24).
      // eslint-disable-next-line global-require -- agent profile only (the runbook profile never loads src/mcp/)
      caseTools = require('../mcp/case-tools').createCaseToolHandler({
        getRuntime: () => core.context?.getCaseRuntime?.() || null,
        getContact: () => core.context?.getContact?.() || null,
        getExecutorRegistry: () => core.context?.getExecutorRegistry?.() || null,
        channel: 'mcp-stdio',
        audit: approvals.auditLedger || null
      });
    }

    const readGuiStatus = deps.readGuiStatus === undefined ? defaultReadGuiStatus() : deps.readGuiStatus;
    const gui = readGuiStatus ? () => readGuiStatus({ dataDir }) : null;
    handler = new FleetToolHandler({
      nodeConfig, runbookEngine, jobManager, approver: approvals.phoneApprover, auditLedger: approvals.auditLedger, delegateSessions, gui, caseTools
    });

    if (approvals.relayClient) {
      fleetService = new NodeFleetService({ handler, relayClient: approvals.relayClient, nodeConfig: { ...nodeConfig, nodeId: approvals.identity.nodeId }, bootId });
      // Cases stage 7 (spec §3.8): cases.<tool> for front-door clients, on the mcp-frontdoor channel.
      // eslint-disable-next-line global-require -- agent profile only (caseTools is set only there)
      if (caseTools) require('../mcp/case-tools').registerNodeCaseMethods(fleetService, {
        getRuntime: () => core.context?.getCaseRuntime?.() || null,
        getContact: () => core.context?.getContact?.() || null,
        getExecutorRegistry: () => core.context?.getExecutorRegistry?.() || null,
        audit: approvals.auditLedger || null
      });
      fleetService.start();
    }

    if (courierPump) {
      courierPump.setRpcHandler(courierRpcHandler(handler));
      rpcInstalled = true;
    } else {
      courierPump = new CourierPump({ dataDir, relayClient: null, identity: approvals.identity, rpcHandler: courierRpcHandler(handler) });
      ownPump = true;
      courierPump.start();
    }
  } catch (err) {
    try {
      teardown();
    } catch (teardownErr) {
      log.error(`fleet node teardown after a failed start also failed: ${teardownErr.message}`);
    }
    throw err;
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
    // Stops taking work (link methods refuse, the courier handler is
    // removed), cancels every job, then waits (bounded) for running job
    // executions and delegate turns to settle, so the core is not shut down
    // underneath them.
    async stop() {
      teardown();
      const running = [...handler.jobRuns.values(), ...(delegateSessions ? delegateSessions.turns.values() : [])];
      if (!(await settleWithin(running, stopWaitMs))) {
        log.warn(`fleet node stop: ${running.length} job run(s) or delegate turn(s) still running after ${stopWaitMs} ms; shutting down anyway`);
      }
    }
  };
}

module.exports = { startFleetNode, courierRpcHandler, STOP_WAIT_MS };

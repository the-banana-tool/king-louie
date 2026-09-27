// The `mcp` process's view of the running service's fleet tools (R24): every
// tool call goes to the service's FleetToolHandler through the file courier,
// so one JobManager, one set of limits and one rate limiter serve the node.
const { ToolError } = require('./fleet-tools');

// Seconds a client should wait before retrying a call the service did not
// answer in time.
const TIMEOUT_RETRY_AFTER_S = 5;

// A courier transport failure, as a coded tool error the MCP client can
// branch on (never prose): the service is gone or stopping, or it did not
// answer in time.
function transportError(err) {
  if (err && (err.code === 'unavailable' || err.code === 'closed')) {
    return new ToolError('service_unavailable', `service_unavailable: ${err.message}`);
  }
  if (err && err.code === 'timeout') {
    return new ToolError('timeout', 'timeout: the King Louie service did not answer in time', { retry_after: TIMEOUT_RETRY_AFTER_S });
  }
  const code = err && typeof err.code === 'string' && /^[a-z_]{1,64}$/.test(err.code) ? err.code : 'internal';
  return new ToolError(code, `${code}: the King Louie service could not run the call`);
}

class CourierFleetClient {
  constructor({ courier, nodeConfig = null, timeoutMs = 30000 } = {}) {
    this.courier = courier;
    this.nodeConfig = nodeConfig;
    this.timeoutMs = timeoutMs;
    this.jobManager = null;
    this.jobRuns = new Map();
    this.runbookEngine = null;
  }

  async call(name, args = {}) {
    let reply;
    try {
      reply = await this.courier.callService(`fleet.${name}`, { args: args || {} }, { timeoutMs: this.timeoutMs });
    } catch (err) {
      throw transportError(err);
    }
    if (reply && reply.tool_error) {
      const { code, message, data } = reply.tool_error;
      throw new ToolError(code, message, data || {});
    }
    return reply ? reply.result : null;
  }

  runRunbook() {
    throw new Error('runRunbook is not available through the courier; call run_runbook');
  }
}

module.exports = { CourierFleetClient, TIMEOUT_RETRY_AFTER_S };

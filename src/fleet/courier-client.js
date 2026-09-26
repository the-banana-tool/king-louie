// The `mcp` process's view of the running service's fleet tools (R24): every
// tool call goes to the service's FleetToolHandler through the file courier,
// so one JobManager, one set of limits and one rate limiter serve the node.
const { ToolError } = require('./fleet-tools');

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
    const reply = await this.courier.callService(`fleet.${name}`, { args: args || {} }, { timeoutMs: this.timeoutMs });
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

module.exports = { CourierFleetClient };

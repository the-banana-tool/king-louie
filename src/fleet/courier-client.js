// The `mcp` process's view of the running service's fleet tools (R24): every
// tool call goes to the service's FleetToolHandler through the file courier,
// so one JobManager, one set of limits and one rate limiter serve the node.
const { ToolError, MCP_TOOLS } = require('./fleet-tools');

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

// tools/list should not hang a client for a call's full timeout.
const LIST_TIMEOUT_MS = 5000;
const MAX_TOOLS = 64;
const isToolDef = (t) => Boolean(t) && typeof t === 'object' && !Array.isArray(t)
  && typeof t.name === 'string' && t.name.length > 0 && t.name.length <= 64
  && typeof t.description === 'string'
  && Boolean(t.inputSchema) && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema);
const isToolList = (v) => Array.isArray(v) && v.length > 0 && v.length <= MAX_TOOLS && v.every(isToolDef);

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

  // The service's tool list (the case tools only when the service has a
  // CaseRuntime). A service that is gone or slow leaves the fleet tools,
  // and each call then says why it fails.
  async listTools() {
    let reply;
    try {
      reply = await this.courier.callService('mcp.tools_list', {}, { timeoutMs: Math.min(this.timeoutMs, LIST_TIMEOUT_MS) });
    } catch {
      return MCP_TOOLS;
    }
    const tools = reply && reply.result;
    return isToolList(tools) ? tools : MCP_TOOLS;
  }

  runRunbook() {
    throw new Error('runRunbook is not available through the courier; call run_runbook');
  }
}

module.exports = { CourierFleetClient, TIMEOUT_RETRY_AFTER_S };

// The `mcp` process's view of the running service's fleet tools (R24): every
// tool call goes to the service's FleetToolHandler through the file courier,
// so one JobManager, one set of limits and one rate limiter serve the node.
const { ToolError, MCP_TOOLS } = require('./fleet-tools');
// Pure definitions (no requires): the courier branch never loads src/mcp/.
const { CASE_MCP_TOOLS } = require('../cases/mcp-tool-definitions');

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
// The only two lists the service can serve. Its reply is read as a set of
// names and the definitions shown are always these local ones, so a forged
// reply (anything that can write the courier inbox) cannot put its own
// names, descriptions or schemas in front of the client.
const WITH_CASES = Object.freeze([...MCP_TOOLS, ...CASE_MCP_TOOLS.map(({ tier, ...def }) => def)]);
function replyNames(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TOOLS) return null;
  const names = [];
  for (const t of v) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || t.name.length > 64) return null;
    names.push(t.name);
  }
  return new Set(names).size === names.length ? names.sort() : null;
}
const WITH_CASES_NAMES = WITH_CASES.map((t) => t.name).sort();

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
    const names = replyNames(reply && reply.result);
    if (names && names.length === WITH_CASES_NAMES.length && names.every((n, i) => n === WITH_CASES_NAMES[i])) return WITH_CASES;
    return MCP_TOOLS;
  }

  runRunbook() {
    throw new Error('runRunbook is not available through the courier; call run_runbook');
  }
}

module.exports = { CourierFleetClient, TIMEOUT_RETRY_AFTER_S };

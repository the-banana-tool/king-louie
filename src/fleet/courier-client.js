// The `mcp` process's view of the running service's fleet tools (R24): every
// tool call goes to the service's FleetToolHandler through the file courier,
// so one JobManager, one set of limits and one rate limiter serve the node.
const { ToolError, MCP_TOOLS } = require('./fleet-tools');
const { WAIT_MS_MAX } = require('./tool-definitions');
// Pure definitions (no requires): the courier branch never loads src/mcp/.
const { CASE_MCP_TOOLS } = require('../cases/mcp-tool-definitions');
const { createLogger } = require('../logging');

const log = createLogger('fleet/courier-client');

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
const WITH_CASES = Object.freeze([...MCP_TOOLS, ...CASE_MCP_TOOLS.map(({ tier, ...def }) => Object.freeze(def))]);
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
const FLEET_NAMES = MCP_TOOLS.map((t) => t.name).sort();
const sameNames = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);

// wait_ms (spec §11, C-9): the wait lives here, in the mcp process, as a
// plain call then one short get_job per poll, so no courier request is held
// open for the whole wait. JobManager's terminal statuses (src/runbooks/ is
// not loaded on this branch).
const WAIT_TOOLS = new Set(['send_to_job', 'get_job']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'denied', 'expired']);
const POLL_MS = 1000;
// Done waiting: the job is terminal, or it is a delegate session whose turn
// has ended. A job with no session (a runbook job) waits for its end.
function waitSettled(job) {
  if (!job || typeof job !== 'object') return true;
  if (TERMINAL_STATUSES.has(job.status)) return true;
  return typeof job.session === 'string' && job.session !== 'turn';
}
function readWaitMs(v) {
  if (v === undefined || v === null) return 0;
  if (!Number.isInteger(v) || v < 0) throw new ToolError('invalid_params', 'invalid_params: wait_ms must be a non-negative integer');
  if (v > WAIT_MS_MAX) throw new ToolError('invalid_params', `invalid_params: wait_ms is at most ${WAIT_MS_MAX}`);
  return v;
}
// A ref'd timer: it keeps the process up for the wait.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CourierFleetClient {
  constructor({ courier, nodeConfig = null, timeoutMs = 30000, pollMs = POLL_MS, clock = Date.now } = {}) {
    this.courier = courier;
    this.nodeConfig = nodeConfig;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.clock = clock;
    this.jobManager = null;
    this.jobRuns = new Map();
    this.runbookEngine = null;
  }

  async call(name, args = {}) {
    if (WAIT_TOOLS.has(name) && args && typeof args === 'object' && 'wait_ms' in args) {
      const { wait_ms: raw, ...plain } = args;
      const waitMs = readWaitMs(raw);
      return waitMs > 0 ? this.callAndWait(name, plain, waitMs) : this.call(name, plain);
    }
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

  // The plain call, then get_job every pollMs until the turn ends, the job
  // is terminal or waitMs has passed; the reply is the last get_job's.
  async callAndWait(name, args, waitMs) {
    const started = this.clock();
    let job = await this.call(name, args);
    // send_to_job answers with an acknowledgement, not the job: always look.
    let looked = name === 'get_job';
    const jobId = args.job_id;
    for (;;) {
      if (looked && waitSettled(job)) return job;
      const left = waitMs - (this.clock() - started);
      if (left <= 0 && looked) return job;
      if (left > 0) await sleep(Math.min(this.pollMs, left));
      job = await this.call('get_job', { job_id: jobId });
      looked = true;
    }
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
    if (names && sameNames(names, WITH_CASES_NAMES)) return WITH_CASES;
    // A service without a CaseRuntime lists the fleet tools. Any other
    // well-formed list is neither form the service serves (final review
    // m7): say so, without echoing the names it sent.
    if (names && !sameNames(names, FLEET_NAMES)) {
      log.warn('mcp.tools_list named an unexpected set of tools; serving the fleet tools only', { count: names.length });
    }
    return MCP_TOOLS;
  }

  runRunbook() {
    throw new Error('runRunbook is not available through the courier; call run_runbook');
  }
}

module.exports = { CourierFleetClient, TIMEOUT_RETRY_AFTER_S };

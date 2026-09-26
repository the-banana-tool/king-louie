// The fleet tools behind every MCP transport (fleet stage 4 §3.7): the stdio
// server (F2), the running service's courier (R24) and the front door's link
// RPCs (NodeFleetService) all call FleetToolHandler.call(), so limits, audit
// and phone approvals are one implementation. Lives in src/fleet/ because the
// runbook profile hosts it and must never load src/mcp/ (Deviation 1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../logging');
const { JobManager } = require('../runbooks/runbook-engine');
const { runbookAction, actionHash } = require('../approvals/messages');
const { canonicalize, sha256b64url } = require('../platform/jcs');

const log = createLogger('fleet-tools');

// Tool definitions, ToolError and the untrusted-output wrapper are pure and
// live in tool-definitions.js, so the front door (which must not load
// src/runbooks/) can list the same tools (Task 27).
const { MCP_TOOLS, ToolError, untrustedOutput } = require('./tool-definitions');

function paramsSha256(params) {
  try {
    return sha256b64url(canonicalize(params === undefined || params === null ? {} : params));
  } catch {
    return null;
  }
}

// Free and total space for each allowed root, or for the filesystem holding
// the home directory when no roots are configured. A root that cannot be
// read reports its error instead of disappearing from the list.
function diskState(allowedRoots) {
  const targets = Array.isArray(allowedRoots) && allowedRoots.length
    ? allowedRoots
    : [path.parse(os.homedir()).root];
  return targets.map((p) => {
    try {
      const st = fs.statfsSync(p);
      return { path: p, free_bytes: st.bavail * st.bsize, total_bytes: st.blocks * st.bsize };
    } catch (err) {
      return { path: p, error: err.code || err.message };
    }
  });
}

const STDIO_ORIGIN = Object.freeze({ kind: 'stdio', client: 'stdio-mcp', session: null });
const ORIGIN_STRING_MAX = 200;

function cut(text, max) {
  const chars = Array.from(String(text));
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

// F3's approval origin is exactly { client, session, job_id } with strings
// of at most 200 code points (checkOrigin); a front-door call is described
// by its client's self-declared name and its MCP session (Deviation 12).
function approvalOrigin(origin, jobId = null) {
  const o = origin || STDIO_ORIGIN;
  if (o.kind === 'frontdoor') {
    return {
      client: cut(o.client_name || o.client_id || 'frontdoor-client', ORIGIN_STRING_MAX),
      session: o.mcp_session ? cut(o.mcp_session, ORIGIN_STRING_MAX) : null,
      job_id: jobId
    };
  }
  return {
    client: cut(o.client || 'stdio-mcp', ORIGIN_STRING_MAX),
    session: o.session === undefined || o.session === null ? null : cut(o.session, ORIGIN_STRING_MAX),
    job_id: jobId
  };
}

function auditOrigin(origin, jobId = null) {
  const base = approvalOrigin(origin, jobId);
  if (origin && origin.kind === 'frontdoor') return { ...base, via: 'frontdoor', grant_id: origin.grant_id || null, client_id: origin.client_id || null };
  return base;
}

class FleetToolHandler {
  constructor({ nodeConfig = null, runbookEngine = null, jobManager = null, approver = null, auditLedger = null, delegateSessions = null,
    gui = null, workingDirectory = null } = {}) {
    this.nodeConfig = nodeConfig || { name: 'local-node', profile: 'agent', capabilities: [], policy: {} };
    this.runbookEngine = runbookEngine;
    this.jobManager = jobManager
      || new JobManager({ maxConcurrentJobs: this.nodeConfig.policy?.max_concurrent_jobs ?? Infinity });
    // One entry per job whose execution has not settled yet, so a caller
    // (a test, a shutdown) can wait for background work to finish.
    this.jobRuns = new Map();
    // Fleet stage 3: a PhoneApprover (or null) for unsafe runbooks, and the
    // node's audit ledger.
    this.approver = approver;
    this.auditLedger = auditLedger;
    this.delegateSessions = delegateSessions;
    // () → the F5 gui block or null; absent until F5 merges.
    this.gui = typeof gui === 'function' ? gui : null;
    // The directory a runbook's steps actually run in, re-resolved into every
    // hashed action (resolveCwd()).
    this.workingDirectory = workingDirectory || process.cwd();
  }

  // Re-resolved every call: a symlink in this.workingDirectory that moves
  // between the initial request and the pre-run re-check must change the
  // action's cwd (and so its hash), not silently keep the approved value.
  // Never throws: if the directory cannot be resolved at all (e.g.
  // removed), the raw, unresolved path is returned instead, which no longer
  // matches a previously resolved value and fails the re-check closed.
  resolveCwd() {
    try {
      return fs.realpathSync(this.workingDirectory);
    } catch {
      return this.workingDirectory;
    }
  }

  guiBlock() {
    if (!this.gui) return null;
    try {
      return this.gui() || null;
    } catch (err) {
      log.warn(`gui status unavailable: ${err.message}`);
      return null;
    }
  }

  // This handler is scoped to the one node it runs on (§5.5). Acting on a
  // `machine` it is not would run the work here while the caller believes it
  // ran somewhere else.
  assertThisMachine(machine, { required = false } = {}) {
    const name = this.nodeConfig.name;
    if (machine === undefined || machine === null || machine === '') {
      if (required) throw new ToolError('invalid_params', `invalid_params: "machine" is required; this server only serves "${name}"`);
      return;
    }
    if (machine !== name) {
      throw new ToolError('unknown_machine', `unknown_machine: this server only serves "${name}"`);
    }
  }

  getJobOrThrow(jobId) {
    const job = this.jobManager.getJob(jobId);
    if (!job) throw new ToolError('job_not_found', `job_not_found: no job "${jobId}" on this node`);
    return job;
  }

  delegateUnavailable() {
    return this.nodeConfig.profile === 'runbook'
      ? new ToolError('capability_unavailable', 'capability_unavailable: delegate needs an agent-profile node')
      : new ToolError('capability_unavailable', 'capability_unavailable: delegate needs the King Louie service running on this node (not implemented in a standalone mcp process)');
  }

  async call(toolName, args = {}, { origin = STDIO_ORIGIN } = {}) {
    args = args || {};
    if (toolName === 'list_machines') {
      const gui = this.guiBlock();
      return [
        {
          name: this.nodeConfig.name,
          profile: this.nodeConfig.profile,
          capabilities: this.nodeConfig.capabilities,
          online: true,
          summary: `Node ${this.nodeConfig.name} (${this.nodeConfig.profile})`,
          ...(gui ? { gui } : {})
        }
      ];
    }

    if (toolName === 'describe_machine') {
      this.assertThisMachine(args.machine);
      // The catalog loaded at startup. Reloading from disk here would clear
      // the definitions of runbooks that jobs are running right now.
      const runbooksList = [];
      if (this.runbookEngine) {
        for (const r of this.runbookEngine.runbooks.values()) {
          runbooksList.push({ name: r.name, description: r.description, tier: r.tier, params: r.params });
        }
      }
      const gui = this.guiBlock();
      // A summary only: the deny and always_confirm pattern lists stay on the
      // node, since a client that can read them can also word its way around
      // them (§9).
      return {
        name: this.nodeConfig.name,
        profile: this.nodeConfig.profile,
        capabilities: this.nodeConfig.capabilities,
        allowed_roots: this.nodeConfig.policy?.allowed_roots || [],
        max_concurrent_jobs: this.jobManager.maxConcurrentJobs === Infinity ? null : this.jobManager.maxConcurrentJobs,
        runbooks: runbooksList,
        ...(gui ? { gui } : {})
      };
    }

    if (toolName === 'get_state') {
      this.assertThisMachine(args.machine);
      const cpus = os.cpus();
      // A cancelled job whose process has not exited yet is still using the
      // machine (and a max_concurrent_jobs slot), so it stays on the list,
      // marked as exiting.
      const jobs = this.jobManager;
      const running = [...jobs.jobs.values()]
        .filter((j) => j.status === 'queued' || j.status === 'running' || jobs.isExecuting(j.job_id))
        .map((j) => {
          const entry = { job_id: j.job_id, runbook: j.runbook, status: j.status, created_at: j.created_at };
          if (j.kind === 'delegate') {
            entry.kind = 'delegate';
            entry.session = j.session;
          }
          if (jobs.isExecuting(j.job_id) && jobs.isTerminal(j.job_id)) entry.exiting = true;
          return entry;
        });
      return {
        machine: this.nodeConfig.name,
        cpu: { count: cpus.length, model: cpus[0]?.model || '', load_average: os.loadavg() },
        memory: { free_bytes: os.freemem(), total_bytes: os.totalmem() },
        disk: diskState(this.nodeConfig.policy?.allowed_roots),
        running_jobs: running,
        last_boot: new Date(Date.now() - os.uptime() * 1000).toISOString(),
        uptime_seconds: os.uptime(),
        platform: process.platform,
        arch: process.arch,
        // Listed rather than left out, so a caller can tell "not collected"
        // from "none": each needs a per-OS probe that does not exist yet.
        not_collected: ['gpu', 'services', 'last_update']
      };
    }

    if (toolName === 'run_runbook') {
      return this.runRunbook(args, origin);
    }

    if (toolName === 'delegate') {
      this.assertThisMachine(args.machine);
      if (!this.delegateSessions) throw this.delegateUnavailable();
      return this.delegateSessions.start({
        task: args.task,
        cwd: args.cwd === undefined ? null : args.cwd,
        origin,
        request_id: args.request_id === undefined ? null : args.request_id
      });
    }

    if (toolName === 'send_to_job') {
      const job = this.getJobOrThrow(args.job_id);
      if (job.kind !== 'delegate') {
        throw new ToolError('not_accepted', `not_accepted: job "${job.job_id}" is a runbook job and does not accept messages`);
      }
      if (!this.delegateSessions) throw this.delegateUnavailable();
      return this.delegateSessions.send(job.job_id, args.message, { origin });
    }

    if (toolName === 'get_job') {
      const job = this.getJobOrThrow(args.job_id);
      const { logs, ...rest } = job;
      return { ...rest, output: untrustedOutput(logs), evidence: job.evidence || null };
    }

    if (toolName === 'get_job_logs') {
      const job = this.getJobOrThrow(args.job_id);
      const all = job.logs || [];
      let since = 0;
      if (args.since !== undefined && args.since !== null) {
        if (!Number.isInteger(args.since) || args.since < 0) {
          throw new ToolError('invalid_params', 'invalid_params: "since" must be a non-negative integer line offset');
        }
        since = args.since;
      }
      let lines = all.slice(since);
      if (args.tail !== undefined && args.tail !== null) {
        if (!Number.isInteger(args.tail) || args.tail < 1) {
          throw new ToolError('invalid_params', 'invalid_params: "tail" must be a positive integer');
        }
        lines = lines.slice(-args.tail);
      }
      return {
        job_id: job.job_id,
        status: job.status,
        total_lines: all.length,
        next_since: all.length,
        output: untrustedOutput(lines)
      };
    }

    if (toolName === 'cancel_job') {
      const job = this.getJobOrThrow(args.job_id);
      if (job.kind === 'delegate' && this.delegateSessions) return this.delegateSessions.cancel(job.job_id);
      const ok = this.jobManager.cancelJob(job.job_id);
      return { success: ok, job_id: job.job_id, status: job.status };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Audit is best effort for the inbound record; exec.start is not (below).
  auditBestEffort(kind, data) {
    if (!this.auditLedger) return;
    Promise.resolve()
      .then(() => this.auditLedger.append({ kind, data }))
      .catch((err) => log.warn(`audit ${kind} failed: ${err.message}`));
  }

  // Everything that can be refused is checked before a job exists, so a
  // refusal leaves nothing behind (§9); then the job starts in the
  // background and its id goes back at once (§8.2). An unsafe runbook waits
  // in awaiting_approval for a signed phone approval (fleet stage 3, §3.8).
  runRunbook(args, origin = STDIO_ORIGIN) {
    const name = args.runbook;
    const params = args.params || {};
    const inbound = auditOrigin(origin, null);
    this.auditBestEffort('request.inbound', {
      client: inbound.client, method: 'tools/call', name: typeof name === 'string' ? name : null,
      params_sha256: paramsSha256(params), job_id: null, origin: inbound
    });
    this.assertThisMachine(args.machine, { required: true });
    const engine = this.runbookEngine;
    if (!engine) {
      throw new Error('Runbook engine not configured on this node');
    }
    const runbook = engine.getRunbook(name);
    if (!runbook) {
      throw new ToolError('runbook_not_found', `runbook_not_found: no runbook "${name}" on node ${this.nodeConfig.name}`);
    }

    let validated;
    try {
      validated = engine.validateParameters(name, params);
    } catch (err) {
      if (err.code === 'invalid_params') {
        throw new ToolError('invalid_params', `invalid_params: ${err.message}`);
      }
      throw err;
    }

    if (runbook.tier === 'unsafe') return this.startUnsafe(runbook, params, validated, origin);

    // From the rate-limit check to recording this run there is no await, so
    // two requests read from one stdin chunk cannot both pass the check.
    const rate = engine.checkRateLimit(name);
    if (rate && rate.allowed === false) {
      const retryAfter = rate.retryAfterSeconds;
      throw new ToolError(
        'rate_limited',
        `rate_limited: runbook "${name}" has reached its rate limit; retry after ${retryAfter}s`,
        { retry_after: retryAfter }
      );
    }

    let job;
    try {
      job = this.jobManager.createJob({ machine: this.nodeConfig.name, runbook: name, params, tier: runbook.tier });
    } catch (err) {
      if (err.code) throw new ToolError(err.code, err.message);
      throw err;
    }
    const reservation = engine.recordExecution(name);

    this.track(job.job_id, this.executeJob(job.job_id, name, params, reservation, { validatedParams: validated, origin }));
    return { job_id: job.job_id, status: job.status };
  }

  track(jobId, promise) {
    const run = promise
      .catch((err) => log.error(`Job ${jobId} execution threw past its handler: ${err.message}`))
      .finally(() => this.jobRuns.delete(jobId));
    this.jobRuns.set(jobId, run);
  }

  startUnsafe(runbook, params, validated, origin = STDIO_ORIGIN) {
    const approver = this.approver;
    const unavailable = !approver
      ? 'unsafe runbooks need a phone approval and no device is enrolled on this node'
      : approver.unavailableReason();
    if (unavailable) {
      const job = this.jobManager.createJob({
        machine: this.nodeConfig.name, runbook: runbook.name, params, tier: runbook.tier,
        status: 'denied', reason: `denied_by_policy: ${unavailable}`
      });
      return { job_id: job.job_id, status: job.status, reason: job.reason };
    }
    const job = this.jobManager.createJob({ machine: this.nodeConfig.name, runbook: runbook.name, params, tier: runbook.tier, status: 'awaiting_approval' });
    this.track(job.job_id, this.awaitApproval(job.job_id, runbook, params, validated, origin));
    return { job_id: job.job_id, status: job.status };
  }

  // Never rejects: every path ends the job in a terminal status.
  async awaitApproval(jobId, runbook, params, validated, origin = STDIO_ORIGIN) {
    const jobs = this.jobManager;
    const engine = this.runbookEngine;
    const name = runbook.name;
    const nodeName = this.nodeConfig.name;
    let lastValidated = validated;
    let lastCwd = this.resolveCwd();
    // Rebuilt from live state: validation re-runs (so a realpath that moved
    // changes the action) and cwd is re-resolved (so a working directory
    // that moved does too); the result is kept for the run.
    const currentAction = () => {
      lastValidated = engine.validateParameters(name, params);
      lastCwd = this.resolveCwd();
      return runbookAction(engine.getRunbook(name), lastValidated, nodeName, lastCwd);
    };
    let outcome;
    try {
      outcome = await this.approver.requestAction(runbookAction(runbook, validated, nodeName, lastCwd), {
        origin: approvalOrigin(origin, jobId),
        signal: jobs.getSignal(jobId),
        currentAction
      });
    } catch (err) {
      outcome = { decision: 'error', reason: err.message };
    }

    if (jobs.isTerminal(jobId)) return; // cancel_job already decided it
    if (outcome.decision === 'deny') {
      jobs.updateJob(jobId, { status: 'denied', reason: `denied: ${outcome.reason || 'the phone denied it'}` });
      return;
    }
    if (outcome.decision === 'expired') {
      jobs.updateJob(jobId, { status: 'expired', reason: 'expired: no phone answered in time' });
      return;
    }
    if (outcome.decision === 'withdrawn') {
      jobs.updateJob(jobId, { status: 'cancelled' });
      return;
    }
    if (outcome.decision !== 'approve') {
      jobs.updateJob(jobId, { status: 'denied', reason: `denied_by_policy: ${outcome.reason || outcome.decision}` });
      return;
    }

    let rate;
    try {
      rate = engine.checkRateLimit(name);
    } catch (err) {
      jobs.updateJob(jobId, { status: 'failed', result: err.message });
      return;
    }
    if (rate && rate.allowed === false) {
      jobs.updateJob(jobId, { status: 'failed', result: `rate_limited: retry after ${rate.retryAfterSeconds}s` });
      return;
    }
    try {
      jobs.transition(jobId, 'awaiting_approval', 'queued');
    } catch (err) {
      jobs.updateJob(jobId, { status: 'failed', result: err.message });
      return;
    }
    const reservation = engine.recordExecution(name);
    // The pre-run re-check: the action about to run is still the approved
    // one. A throw building the live action is a mismatch on its own, and a
    // response whose action_hash is not a string can never match.
    let liveHash = null;
    let mismatch = typeof outcome.action_hash !== 'string';
    if (!mismatch) {
      try {
        liveHash = actionHash(currentAction());
      } catch {
        mismatch = true;
      }
    }
    if (!mismatch && liveHash !== outcome.action_hash) mismatch = true;
    if (mismatch) {
      engine.releaseExecution(name, reservation);
      jobs.updateJob(jobId, { status: 'failed', result: 'action_changed: the runbook or its parameters changed after approval; nothing ran' });
      return;
    }
    await this.executeJob(jobId, name, params, reservation, { validatedParams: lastValidated, requestId: outcome.request_id, cwd: lastCwd, origin });
  }

  // Never rejects: whatever the engine does, the job ends in a terminal
  // status, and a failure becomes that job's result.
  async executeJob(jobId, name, params, reservation, { validatedParams = null, requestId = null, cwd = null, origin = STDIO_ORIGIN } = {}) {
    const jobs = this.jobManager;
    const engine = this.runbookEngine;
    const signal = jobs.getSignal(jobId);
    const runOrigin = auditOrigin(origin, jobId);
    // Yield first, so the caller has its job_id before any work starts.
    await Promise.resolve();
    if (jobs.isTerminal(jobId) || signal?.aborted) {
      engine.releaseExecution(name, reservation);
      return;
    }
    if (this.auditLedger) {
      try {
        await this.auditLedger.append({ kind: 'exec.start', data: { kind: 'runbook', name, request_id: requestId, job_id: jobId, origin: runOrigin } });
      } catch (err) {
        engine.releaseExecution(name, reservation);
        if (!jobs.isTerminal(jobId)) jobs.updateJob(jobId, { status: 'failed', result: 'Audit ledger unavailable; nothing ran.' });
        return;
      }
    }
    // cancel_job can land while the append above was pending.
    if (jobs.isTerminal(jobId) || signal?.aborted) {
      engine.releaseExecution(name, reservation);
      return;
    }
    jobs.updateJob(jobId, { status: 'running' });
    jobs.markExecuting(jobId);
    let ok = false;
    let error = null;
    try {
      const res = await engine.executeRunbook(name, params, { signal, admitted: true, validatedParams, cwd });
      const logs = Array.isArray(res?.logs) ? res.logs : [];
      const evidence = { checks: Array.isArray(res?.checks) ? res.checks : [] };
      ok = Boolean(res?.success);
      error = ok ? null : (res?.error || 'runbook failed');
      if (jobs.isTerminal(jobId)) {
        jobs.updateJob(jobId, { logs, evidence });
      } else if (res?.success) {
        jobs.updateJob(jobId, { status: 'succeeded', logs, evidence });
      } else if (res?.error === 'cancelled') {
        jobs.updateJob(jobId, { status: 'cancelled', logs, evidence });
      } else {
        jobs.updateJob(jobId, { status: 'failed', logs, evidence, result: res?.error || 'runbook failed' });
      }
    } catch (err) {
      const result = err.code === 'rate_limited' && err.retryAfterSeconds !== undefined
        ? `rate_limited: retry after ${err.retryAfterSeconds}s`
        : err.message;
      error = result;
      log.warn(`Job ${jobId} (${name}) failed: ${err.message}`);
      if (!jobs.isTerminal(jobId)) jobs.updateJob(jobId, { status: 'failed', result });
    } finally {
      jobs.markSettled(jobId);
      this.auditBestEffort('exec.result', { kind: 'runbook', name, request_id: requestId, job_id: jobId, origin: runOrigin, ok, exit_status: null, error });
    }
  }
}

module.exports = { MCP_TOOLS, ToolError, untrustedOutput, diskState, STDIO_ORIGIN, approvalOrigin, auditOrigin, FleetToolHandler };

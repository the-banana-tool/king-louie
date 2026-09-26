// Node-side delegate sessions (fleet stage 4 §3.8, program §4.18, R10):
// multi-turn agent sessions on an agent-profile node, run through the core's
// agent executor under remoteApprovals 'phone'. A session holds a
// max_concurrent_jobs slot only while a turn runs; send_to_job during a turn
// is node_busy (no queue); an idle session closes after delegate.idle_close.
// Sessions live in memory: after a restart their job ids are unknown here and
// the front door reports node_restarted.
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { createLogger } = require('../logging');
const { isPathUnderRoots } = require('../platform/path-roots');
const { EvidenceLedger } = require('../verification/evidence-ledger');
const { ToolError, approvalOrigin } = require('./fleet-tools');
const { covers } = require('./scope-rules');

const log = createLogger('fleet/delegate');

const PARAMS_CAP = 2048;
const RESULT_CAP = 4096;
const FULL_CAP = 256 * 1024;
// The calls that start or report planner/workflow task graphs: kept in full
// (up to 256 KiB) so plans show up in exports (Deviation 23).
const FULL_TRANSCRIPT_TOOLS = Object.freeze(['SpawnAgent', 'BackgroundTask', 'TaskStatus']);
const EDITED_PATHS_MAX = 50;
const OPEN_STATES = new Set(['idle', 'turn']);
const LIVE_BACKGROUND_STATES = new Set(['pending', 'running']);

// Whether this delegate turn refuses unsafe calls itself (the phone is never
// asked). §3.8: refused unless the client holds fleet:unsafe for THIS node; a
// grant limited to other machines does not count here.
// Owner question M19 (pending): a local stdio session (STDIO_ORIGIN) has no
// scopes, so it refuses too. To send its unsafe calls to the phone instead,
// like stdio runbooks, change the return to:
//   return origin?.kind === 'frontdoor' && !covers(origin.scopes, 'fleet:unsafe', nodeConfig.name);
function shouldRefuseUnsafe(origin, nodeConfig) {
  return !covers(origin && origin.scopes, 'fleet:unsafe', nodeConfig && nodeConfig.name);
}

function capText(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= max) return text;
  // Cut on a byte boundary; a split multi-byte character decodes to U+FFFD,
  // which is dropped rather than shown.
  const head = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
  return `${head}… [cut at ${max} of ${bytes} bytes]`;
}

const toolOk = (result) => Boolean(result) && result.success !== false && result.ok !== false;

class DelegateSessions {
  constructor({ core, nodeConfig, jobManager, auditLedger = null, leaseManager = null, now = Date.now,
    fullTranscriptTools = FULL_TRANSCRIPT_TOOLS, providers = null, sweepMs = 60000 } = {}) {
    if (!core || !core.context || typeof core.context.getAgentExecutorAdapter !== 'function') {
      throw new TypeError('DelegateSessions needs the agent core (profile: agent)');
    }
    this.core = core;
    this.nodeConfig = nodeConfig;
    this.config = nodeConfig.delegate;
    this.jobs = jobManager;
    this.auditLedger = auditLedger;
    // F5's LeaseManager when it lands (wave 4); its job-scoped leases end
    // when the session does.
    this.leaseManager = leaseManager;
    this.now = now;
    this.fullTools = new Set(fullTranscriptTools);
    this.sessions = new Map();
    this.turns = new Map();
    // The session whose turn is running in this async context: a background
    // task created inside a turn (by the turn itself, a sub-agent, or another
    // background task) belongs to that session (T11-bg).
    this.turnScope = new AsyncLocalStorage();
    this.backgroundTasks = null;
    this.onBackgroundTask = (task) => {
      const session = this.turnScope.getStore();
      if (session && task && task.id) session.backgroundTaskIds.add(task.id);
    };

    this.agent = core.context.getAgent(this.config.agent);
    if (!this.agent) {
      const known = core.context.listAgents().map((a) => a.id).join(', ');
      throw new Error(`Invalid node.yaml: delegate.agent "${this.config.agent}" is not an agent (known: ${known})`);
    }
    if (this.config.provider) {
      // eslint-disable-next-line global-require -- agent profile only
      const known = providers || require('../providers/provider-factory').listRegistered();
      if (!known.includes(String(this.config.provider).toLowerCase())) {
        throw new Error(`Invalid node.yaml: delegate.provider "${this.config.provider}" is not a known provider (known: ${known.join(', ')})`);
      }
    }
    this.timer = setInterval(() => this.sweep(), sweepMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  _openCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (OPEN_STATES.has(s.state)) n += 1;
    return n;
  }

  _resolveCwd(requested) {
    const roots = (this.nodeConfig.policy && this.nodeConfig.policy.allowed_roots) || [];
    const cwd = requested || this.config.cwd || roots[0] || null;
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd) || !isPathUnderRoots(cwd, roots)) {
      throw new ToolError('invalid_params', 'invalid_params: cwd must be under policy.allowed_roots');
    }
    return path.resolve(cwd);
  }

  // The core builds its BackgroundTaskManager in start(), so it is looked up
  // on the first turn rather than at construction.
  _watchBackgroundTasks() {
    if (this.backgroundTasks) return;
    const getter = this.core.context.getBackgroundTaskManager;
    const manager = typeof getter === 'function' ? getter() : null;
    if (!manager || typeof manager.on !== 'function') return;
    this.backgroundTasks = manager;
    manager.on('taskCreated', this.onBackgroundTask);
  }

  // Async so every refusal reaches the caller as a rejection (preflight M8).
  async start({ task, cwd = null, origin, request_id: requestId = null } = {}) {
    if (typeof task !== 'string' || !task.trim()) throw new ToolError('invalid_params', 'invalid_params: "task" is required');
    const dir = this._resolveCwd(cwd);
    if (this._openCount() >= this.config.maxSessions) {
      throw new ToolError('node_busy', `node_busy: this node already has ${this.config.maxSessions} open delegate session(s)`, { retry_after: 5 });
    }
    if (!this.jobs.hasFreeSlot()) {
      throw new ToolError('max_concurrent_jobs', `max_concurrent_jobs: this node already has ${this.jobs.maxConcurrentJobs} job(s) running; try again when one finishes`);
    }
    const job = this.jobs.createDelegateJob({ machine: this.nodeConfig.name, task, cwd: dir });
    const session = {
      jobId: job.job_id, cwd: dir, state: 'idle', history: [], evidence: new EvidenceLedger(),
      lastActivity: this.now(), turnAbort: null, requestId, backgroundTaskIds: new Set()
    };
    this.sessions.set(job.job_id, session);
    this.jobs.getSignal(job.job_id).addEventListener('abort', () => this._onJobAborted(session), { once: true });
    this._beginTurn(session, task, origin);
    return { job_id: job.job_id, status: 'running' };
  }

  async send(jobId, message, { origin } = {}) {
    const session = this.sessions.get(jobId);
    if (!session) throw new ToolError('job_not_found', `job_not_found: no delegate session "${jobId}" on this node`);
    if (session.state === 'turn') {
      throw new ToolError('node_busy', 'node_busy: a turn is running in this session; send the message when it ends', { retry_after: 5 });
    }
    if (!OPEN_STATES.has(session.state)) throw new ToolError('not_accepted', `not_accepted: session is ${session.state}`);
    if (typeof message !== 'string' || !message.trim()) throw new ToolError('invalid_params', 'invalid_params: "message" is required');
    try {
      this._beginTurn(session, message, origin);
    } catch (err) {
      if (err.code === 'max_concurrent_jobs' || err.code === 'node_busy') throw new ToolError(err.code, err.message, err.code === 'node_busy' ? { retry_after: 5 } : {});
      throw err;
    }
    return { job_id: jobId, status: 'running', session: 'turn' };
  }

  cancel(jobId) {
    const ok = this.jobs.cancelJob(jobId);
    const job = this.jobs.getJob(jobId);
    return { success: ok, job_id: jobId, status: job ? job.status : null };
  }

  sweep() {
    const t = this.now();
    for (const session of this.sessions.values()) {
      if (session.state === 'idle' && t - session.lastActivity >= this.config.idleCloseMs) this._close(session, 'closed', true);
    }
  }

  stop() {
    clearInterval(this.timer);
    if (this.backgroundTasks) this.backgroundTasks.off('taskCreated', this.onBackgroundTask);
    for (const session of this.sessions.values()) if (session.turnAbort) session.turnAbort.abort();
  }

  _beginTurn(session, message, origin) {
    this._watchBackgroundTasks();
    this.jobs.beginTurn(session.jobId);
    session.state = 'turn';
    const run = this._runTurn(session, message, origin)
      .catch((err) => log.error(`delegate turn on ${session.jobId} failed past its handler: ${err.message}`))
      .finally(() => this.turns.delete(session.jobId));
    this.turns.set(session.jobId, run);
  }

  _append(jobId, lines) {
    const job = this.jobs.getJob(jobId);
    if (job) this.jobs.updateJob(jobId, { logs: [...job.logs, ...lines] });
  }

  _toolLine(t) {
    const full = this.fullTools.has(t.name);
    const params = capText(t.parameters === undefined ? {} : t.parameters, full ? FULL_CAP : PARAMS_CAP);
    const result = capText(t.result === undefined ? null : t.result, full ? FULL_CAP : RESULT_CAP);
    return `tool ${t.name} ${params} → ${toolOk(t.result) ? 'ok' : 'error'} ${result}`;
  }

  _summary(session) {
    const s = session.evidence.status(session.cwd);
    return {
      hasEdits: s.hasEdits,
      editedPaths: s.editedPaths.slice(0, EDITED_PATHS_MAX),
      hasFullPass: s.hasFullPass,
      hasTargetedPass: s.hasTargetedPass,
      hasFreshFailure: s.hasFreshFailure
    };
  }

  // Everything that can throw sits inside the try; the finally frees the
  // slot on every exit (a result, an abort, a throw), so none can leak.
  async _runTurn(session, message, origin) {
    const jobId = session.jobId;
    session.turnAbort = new AbortController();
    let failure = null;
    try {
      this._append(jobId, [`> user: ${message}`]);
      // History is user/assistant text pairs; tool detail stays in the
      // transcript and is not replayed.
      const messages = [];
      for (const h of session.history) messages.push({ role: 'user', content: h.user }, { role: 'assistant', content: h.assistant });
      messages.push({ role: 'user', content: message });
      const result = await this.turnScope.run(session, () => this.core.context.getAgentExecutorAdapter().execute(this.agent, message, {
        ...(this.config.provider ? { provider: this.config.provider } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
        workingDirectory: session.cwd,
        messages,
        abortSignal: session.turnAbort.signal,
        evidenceLedger: session.evidence,
        executorOptions: {
          origin: approvalOrigin(origin, jobId),
          chatId: `delegate:${jobId}`,
          refuseUnsafe: shouldRefuseUnsafe(origin, this.nodeConfig),
          // T11-roots: with no node policy, the refuseUnsafe classifier
          // allows paths under the session's cwd and nowhere else.
          allowedRoots: [session.cwd]
        }
      }));
      this._record(session, message, result);
    } catch (err) {
      failure = err;
    } finally {
      session.turnAbort = null;
      session.lastActivity = this.now();
      try {
        this.jobs.endTurn(jobId);
      } catch (err) {
        // endTurn frees the slot before it emits 'update'; a listener that
        // throws must not leave the session stuck in "turn".
        log.warn(`endTurn(${jobId}) listener failed: ${err.message}`);
      }
    }
    if (this.jobs.isTerminal(jobId)) return; // cancelled while the turn ran
    if (failure) {
      this._append(jobId, [`! error: ${failure.message}`]);
      this._close(session, 'failed', false, failure.message);
      return;
    }
    session.state = 'idle';
  }

  _record(session, message, result) {
    if (!result) return;
    const content = typeof result.content === 'string' ? result.content : '';
    const lines = (Array.isArray(result.tools) ? result.tools : []).map((t) => this._toolLine(t));
    lines.push(`< assistant: ${content}`);
    this._append(session.jobId, lines);
    session.history.push({ user: message, assistant: content });
    this.jobs.updateJob(session.jobId, { result: content, evidence: { summary: this._summary(session) } });
  }

  _onJobAborted(session) {
    if (session.turnAbort) session.turnAbort.abort();
    this._stopBackgroundTasks(session);
    this._close(session, 'cancelled', false);
  }

  // T11-bg: cancel_job also stops the background tasks this session's turns
  // started; they otherwise outlive the turn that spawned them.
  _stopBackgroundTasks(session) {
    if (!this.backgroundTasks) return;
    for (const id of session.backgroundTaskIds) {
      const task = this.backgroundTasks.get(id);
      if (!task || !LIVE_BACKGROUND_STATES.has(task.state)) continue;
      try {
        this.backgroundTasks.stop(id);
      } catch (err) {
        log.warn(`stopping background task ${id} of ${session.jobId} failed: ${err.message}`);
      }
    }
  }

  _close(session, state, ok, error = null) {
    if (!OPEN_STATES.has(session.state)) return;
    session.state = state;
    const status = state === 'closed' ? 'succeeded' : state;
    this.jobs.updateJob(session.jobId, { status, session: state, ...(error ? { reason: error } : {}) });
    if (this.leaseManager && typeof this.leaseManager.endForJob === 'function') {
      try {
        this.leaseManager.endForJob(session.jobId, 'job_closed');
      } catch (err) {
        log.warn(`endForJob(${session.jobId}) failed: ${err.message}`);
      }
    }
    if (this.auditLedger) {
      Promise.resolve()
        .then(() => this.auditLedger.append({ kind: 'exec.result', data: { kind: 'tool', name: 'delegate', job_id: session.jobId, ok } }))
        .catch((err) => log.warn(`audit exec.result failed: ${err.message}`));
    }
  }
}

module.exports = { DelegateSessions, FULL_TRANSCRIPT_TOOLS, PARAMS_CAP, RESULT_CAP, FULL_CAP, capText, shouldRefuseUnsafe };

// Node-side delegate sessions (fleet stage 4 §3.8, program §4.18, R10):
// multi-turn agent sessions on an agent-profile node, run through the core's
// agent executor under remoteApprovals 'phone'. A session holds a
// max_concurrent_jobs slot only while a turn runs; send_to_job during a turn
// is node_busy (no queue); an idle session closes after delegate.idle_close.
// Sessions live in memory: after a restart their job ids are unknown here and
// the front door reports node_restarted.
const path = require('path');
const { createLogger } = require('../logging');
const { isPathUnderRoots, realResolve } = require('../platform/path-roots');
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
// A closed session is forgotten this long after it closed (final review
// M-6); its job stays in JobManager, but no caller owns it any more.
const CLOSED_RETAIN_MS = 24 * 3600000;
// Ruling T11-sessions: the node's gateway sessions are the owner's other
// chats (Telegram, Slack, …). A delegate turn, and every sub-agent it
// starts, runs without the tools that list, read, post to or spawn them (a
// spawned owner session would run outside the delegate's own tool limits).
const DELEGATE_EXCLUDED_TOOLS = Object.freeze(['sessions_list', 'sessions_history', 'message', 'sessions_spawn']);

// Every registered tool but the excluded ones, read at each turn so a tool
// registered after start (MCP) is included.
function delegateToolNames(registry) {
  const excluded = new Set(DELEGATE_EXCLUDED_TOOLS);
  return new Set(registry.list().map((tool) => tool.name).filter((name) => !excluded.has(name)));
}

// Whether this delegate turn refuses unsafe calls itself (the phone is never
// asked). §3.8: refused unless the caller holds fleet:unsafe for THIS node; a
// grant limited to other machines does not count here.
// Owner decision M19 (2026-09-26): a session this node started itself (no
// origin, or STDIO_ORIGIN, kind 'stdio') has no scopes and is not refused;
// its unsafe calls go to the phone, like stdio runbooks. Ruling T26-m19: it
// fails closed, so every other origin (a front-door client, a malformed
// origin, an unknown kind) is refused unless it covers fleet:unsafe here.
function shouldRefuseUnsafe(origin, nodeConfig) {
  if (origin === null || origin === undefined) return false;
  if (typeof origin === 'object' && origin.kind === 'stdio') return false;
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

// Who a session belongs to (ruling T11-owner): the grant for a front-door
// caller, 'stdio' for this node's own callers (STDIO_ORIGIN, or none). A
// front-door origin without a grant id belongs to no one.
function sessionOwner(origin) {
  if (origin && origin.kind === 'frontdoor') {
    return typeof origin.grant_id === 'string' && origin.grant_id ? `grant:${origin.grant_id}` : null;
  }
  return 'stdio';
}

// The BackgroundTaskManager as one session's turns see it (ruling
// T11-taskstatus): BackgroundTask records what it spawns here, and TaskStatus
// can get, list, read and stop only those. A foreign id answers exactly like
// an unknown one.
function scopedBackgroundTasks(manager, ids) {
  const mine = (id) => ids.has(id);
  const notFound = (id) => new Error(`Background task not found: ${id}`);
  return Object.freeze({
    async spawn(config, executor) {
      // Recorded before the executor runs: it writes the task's output
      // through this view straight away.
      const task = await manager.spawn(config, (bgTask) => {
        ids.add(bgTask.id);
        return executor(bgTask);
      });
      ids.add(task.id);
      return task;
    },
    get: (id) => (mine(id) ? manager.get(id) : undefined),
    list: () => manager.list().filter((t) => mine(t.id)),
    readOutput(id) {
      if (!mine(id)) throw notFound(id);
      return manager.readOutput(id);
    },
    stop(id) {
      if (!mine(id)) throw notFound(id);
      return manager.stop(id);
    },
    appendOutput(id, text) {
      if (mine(id)) manager.appendOutput(id, text);
    }
  });
}

class DelegateSessions {
  constructor({ core, nodeConfig, jobManager, auditLedger = null, leaseManager = null, now = Date.now,
    fullTranscriptTools = FULL_TRANSCRIPT_TOOLS, providers = null, sweepMs = 60000, toolRegistry = null, closedRetainMs = CLOSED_RETAIN_MS } = {}) {
    if (!core || !core.context || typeof core.context.getAgentExecutorAdapter !== 'function') {
      throw new TypeError('DelegateSessions needs the agent core (profile: agent)');
    }
    this.core = core;
    // eslint-disable-next-line global-require -- the core's one registry
    this.toolRegistry = toolRegistry || require('../tools/tool-registry').registry;
    this.nodeConfig = nodeConfig;
    this.config = nodeConfig.delegate;
    this.jobs = jobManager;
    this.auditLedger = auditLedger;
    // F5's LeaseManager when it lands (wave 4); its job-scoped leases end
    // when the session does.
    this.leaseManager = leaseManager;
    this.now = now;
    this.closedRetainMs = closedRetainMs;
    this.fullTools = new Set(fullTranscriptTools);
    this.sessions = new Map();
    this.turns = new Map();

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
    // The real path: the roots the turn is confined to are this one, so a
    // link swapped later cannot move them.
    return realResolve(cwd);
  }

  // The core builds its BackgroundTaskManager in start(), so it is looked up
  // when a turn needs it rather than at construction.
  _backgroundTasks() {
    const getter = this.core.context.getBackgroundTaskManager;
    return typeof getter === 'function' ? getter() || null : null;
  }

  // The session a caller may act on, or job_not_found: another caller's
  // session answers exactly like one that does not exist (T11-owner).
  _sessionFor(jobId, origin) {
    const session = this.sessions.get(jobId);
    if (!session || session.owner !== sessionOwner(origin)) {
      throw new ToolError('job_not_found', `job_not_found: no delegate session "${jobId}" on this node`);
    }
    return session;
  }

  // For FleetToolHandler's job reads: true only for a delegate session this
  // caller started.
  ownsJob(jobId, origin) {
    const session = this.sessions.get(jobId);
    return Boolean(session) && session.owner === sessionOwner(origin);
  }

  // For NodeFleetService's fleet.job_update: true only for a session a
  // front-door grant started, so the front door never hears of this node's
  // own stdio sessions.
  startedByFrontDoor(jobId) {
    const session = this.sessions.get(jobId);
    return Boolean(session) && typeof session.owner === 'string' && session.owner.startsWith('grant:');
  }

  // Async so every refusal reaches the caller as a rejection (preflight M8).
  async start({ task, cwd = null, origin, request_id: requestId = null } = {}) {
    if (typeof task !== 'string' || !task.trim()) throw new ToolError('invalid_params', 'invalid_params: "task" is required');
    const owner = sessionOwner(origin);
    if (!owner) throw new ToolError('invalid_params', 'invalid_params: a front-door caller needs a grant');
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
      lastActivity: this.now(), turnAbort: null, requestId, owner, backgroundTaskIds: new Set(), backgroundView: null
    };
    this.sessions.set(job.job_id, session);
    this.jobs.getSignal(job.job_id).addEventListener('abort', () => this._onJobAborted(session), { once: true });
    try {
      this._beginTurn(session, task, origin);
    } catch (err) {
      // The session never ran a turn; nothing may be left open behind it.
      this._close(session, 'failed', false, err.message);
      throw err;
    }
    return { job_id: job.job_id, status: 'running' };
  }

  async send(jobId, message, { origin } = {}) {
    const session = this._sessionFor(jobId, origin);
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

  // Only this caller's own delegate sessions; a runbook job is not ours.
  cancel(jobId, { origin } = {}) {
    this._sessionFor(jobId, origin);
    const ok = this.jobs.cancelJob(jobId);
    const job = this.jobs.getJob(jobId);
    return { success: ok, job_id: jobId, status: job ? job.status : null };
  }

  // Runs from setInterval: one session that fails to close must not stop the
  // others, nor throw into the timer.
  sweep() {
    const t = this.now();
    for (const [jobId, session] of this.sessions) {
      if (!OPEN_STATES.has(session.state) && typeof session.closedAt === 'number' && t - session.closedAt >= this.closedRetainMs && !this.turns.has(jobId)) {
        this.sessions.delete(jobId);
        continue;
      }
      if (session.state !== 'idle' || t - session.lastActivity < this.config.idleCloseMs) continue;
      try {
        this._close(session, 'closed', true);
      } catch (err) {
        log.warn(`idle close of ${session.jobId} failed: ${err.message}`);
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) {
      this._stopBackgroundTasks(session);
      if (session.turnAbort) session.turnAbort.abort();
    }
  }

  _beginTurn(session, message, origin) {
    const wasExecuting = this.jobs.isExecuting(session.jobId);
    try {
      this.jobs.beginTurn(session.jobId);
    } catch (err) {
      // beginTurn takes the slot before it emits 'update'; if a listener
      // throws there, give the slot back (a refusal never took one).
      if (!wasExecuting && this.jobs.isExecuting(session.jobId)) {
        try {
          this.jobs.endTurn(session.jobId);
        } catch (endErr) {
          log.warn(`endTurn(${session.jobId}) listener failed: ${endErr.message}`);
        }
      }
      throw err;
    }
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
      const manager = this._backgroundTasks();
      if (manager && !session.backgroundView) session.backgroundView = scopedBackgroundTasks(manager, session.backgroundTaskIds);
      const result = await this.core.context.getAgentExecutorAdapter().execute(this.agent, message, {
        ...(this.config.provider ? { provider: this.config.provider } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
        workingDirectory: session.cwd,
        messages,
        abortSignal: session.turnAbort.signal,
        evidenceLedger: session.evidence,
        // T11-sessions; the re-threaded requester carries it to sub-agents.
        allowedToolNames: delegateToolNames(this.toolRegistry),
        executorOptions: {
          origin: approvalOrigin(origin, jobId),
          chatId: `delegate:${jobId}`,
          refuseUnsafe: shouldRefuseUnsafe(origin, this.nodeConfig),
          // T11-roots: with no node policy, the refuseUnsafe classifier
          // allows paths under the session's cwd and nowhere else.
          allowedRoots: [session.cwd],
          // T11-taskstatus: this session's background tasks only.
          ...(session.backgroundView ? { scopedBackgroundTasks: session.backgroundView } : {})
        }
      });
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
    // A session closed while this turn ran (cancel_job) has dropped its
    // history and evidence; its transcript still gets the turn's lines.
    if (!session.history) return;
    session.history.push({ user: message, assistant: content });
    this.jobs.updateJob(session.jobId, { result: content, evidence: { summary: this._summary(session) } });
  }

  // Runs from the job signal's abort listener, which must never throw.
  _onJobAborted(session) {
    try {
      if (session.turnAbort) session.turnAbort.abort();
      this._close(session, 'cancelled', false);
    } catch (err) {
      log.warn(`cancelling ${session.jobId} failed: ${err.message}`);
    }
  }

  // T11-bg / T11-bg2: a session that ends for any reason (closed, failed,
  // cancelled, or the service stopping) stops the background tasks its turns
  // started; they otherwise outlive the turn that spawned them.
  _stopBackgroundTasks(session) {
    const manager = this._backgroundTasks();
    if (!manager) return;
    for (const id of session.backgroundTaskIds) {
      const task = manager.get(id);
      if (!task || !LIVE_BACKGROUND_STATES.has(task.state)) continue;
      try {
        manager.stop(id);
      } catch (err) {
        log.warn(`stopping background task ${id} of ${session.jobId} failed: ${err.message}`);
      }
    }
  }

  // Every step runs even if an earlier one throws (a JobManager listener),
  // so a close always stops the tasks, ends the leases and is audited.
  _close(session, state, ok, error = null) {
    if (!OPEN_STATES.has(session.state)) return;
    session.state = state;
    session.closedAt = this.now();
    this._stopBackgroundTasks(session);
    // A closed session keeps only its state (and its task ids, for stop()).
    session.history = null;
    session.evidence = null;
    const status = state === 'closed' ? 'succeeded' : state;
    try {
      this.jobs.updateJob(session.jobId, { status, session: state, ...(error ? { reason: error } : {}) });
    } catch (err) {
      log.warn(`closing ${session.jobId}: an update listener failed: ${err.message}`);
    }
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

module.exports = { DelegateSessions, DELEGATE_EXCLUDED_TOOLS, delegateToolNames, FULL_TRANSCRIPT_TOOLS, PARAMS_CAP, RESULT_CAP, FULL_CAP, capText, shouldRefuseUnsafe, sessionOwner };

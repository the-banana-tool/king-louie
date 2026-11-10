'use strict';

// A task on this node (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.3, §4.4,
// §4.6, §4.8): a real chat in the history store, run by the node's agent executor, with a durable
// record beside it. One task runs per node. A client's words are never the owner's: every run has
// no owner text and denyAutoApproval, so only the task policy or the phone lets a gated call run.
//
// Every record write goes through _update, which wakes the clients waiting on that task. A turn is
// ended by what it returned or by a cut (`turn.cut`, the first reason wins): a cancel and a stop
// write the record themselves, at once, so the policy refuses from that instant; a spend or
// duration cut is written when the turn has unwound.

const { auditOriginOf } = require('../approvals/audit-fields');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { realResolve } = require('../platform/path-roots');
const { TASK_GUIDANCE, parseStuck } = require('../context/system-sections');
const { summarizeTurnLlm } = require('../tracking/llm-totals');
const { ToolError, executorOrigin } = require('../fleet/fleet-tools');
const { shouldRefuseUnsafe } = require('../fleet/delegate-sessions');
const { TaskCards } = require('./cards');
const { createTaskPolicy } = require('./policy');
const { proposeScope } = require('./proposal');
const { TASK_STATES } = require('./store');
const { publicView, privateView, taskToolNames, taskTitle, clientOf, failureCode, pricedAt, overCap, DEFAULT_MINUTES, FINAL_STATES } = require('./values');

const log = createLogger('tasks/manager');

const MAX_TEXT = 8000;
const MAX_LIST = 50;
const MAX_WAIT_MS = 25000;
const STOP_WAIT_MS = 10000;
// How long a waiting task may go with no change before the next task's run frees the node.
const WAITING_BOUND_MS = 24 * 60 * 60 * 1000;
// What a task with no proposal runs under: nobody was shown more, so the spec's lowest spend.
const DEFAULT_USD = 2;
const BUSY_STATES = new Set(['requested', 'awaiting_grant', 'running', 'waiting']);
const OVER_STATES = new Set([...FINAL_STATES, 'interrupted']);
const TURN_MAX_ITERATIONS = 40;
const CONTINUABLE_STATES =new Set(['waiting', 'interrupted', 'done']);
// A loop's other ends, safe to name; its `error` and `stopped` say nothing more than turn_failed.
const ENDED_TYPES = new Set(['max_iterations', 'guardrail_halt']);
// The cuts that leave a task waiting. The others wrote their ending when they were asked.
const LANDING_CUTS = new Set(['spend_cap', 'duration', 'grant_pending']);
// The owner took the chat, or it is gone. A send never runs in such a chat (tasks spec §4.3, §6).
const TAKEN_REASONS = new Set(['became_case', 'private', 'chat_deleted']);

const REAL_TIMERS = Object.freeze({
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
  },
  clear: (t) => clearTimeout(t),
});

const taskEnded = () => new ToolError('task_ended', 'task_ended: this task has ended; nothing ran');

function checkText(text, what) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
    throw new ToolError('invalid_params', `invalid_params: "${what}" must be 1 to ${MAX_TEXT} characters`);
  }
}

class TaskManager {
  constructor({ core, nodeConfig, dataDir, store, grants = null, push = null, audit = null, currentUrl = null, callUtility = null,
    clock = Date.now, timers = REAL_TIMERS, toolRegistry = null, stopWaitMs = STOP_WAIT_MS } = {}) {
    if (!core || !core.context || typeof core.context.getAgentExecutorAdapter !== 'function') {
      throw new TypeError('TaskManager needs the agent core (profile: agent)');
    }
    Object.assign(this, { core, nodeConfig, dataDir, store, grants, push, audit, currentUrl, callUtility, clock, timers, stopWaitMs });
    // eslint-disable-next-line global-require -- the core's one registry
    this.toolRegistry = toolRegistry || require('../tools/tool-registry').registry;
    this.turn = null; // the one running turn, from `run` or `send` until it has unwound
    this.stopped = false;
    this.waiters = new Map(); // task id → Set of wake functions
    this.handles = new Map(); // task id → the grant handle (TaskGrants)
    this.cards = new TaskCards(this);
  }

  // ---- what a client calls ----

  // Nothing is awaited before the record exists, so two calls at once cannot both start.
  async run({ text, origin = null, placement = null } = {}) {
    checkText(text, 'task');
    this._assertFree();
    const chatId = crypto.randomUUID();
    const client = clientOf(origin);
    const created = this.store.create({
      chat_id: chatId, node: this.nodeConfig.name, client, text, state: 'requested', placement,
      spend: { usd: 0, calls: 0, cap_usd: DEFAULT_USD, unpriced: 0 },
    });
    const taskId = created.task_id;
    // The ledger is mirrored: the kind of client, never its self-declared name (the record keeps that).
    this._audit('task.requested', { task_id: taskId, origin: auditOriginOf(client), node: this.nodeConfig.name });
    let seq;
    try {
      const workDir = this._workDir(taskId);
      const at = new Date(this.clock()).toISOString();
      this.core.context.createChat({ id: chatId, title: taskTitle(text), createdAt: at, updatedAt: at, messages: [], taskId, client, agentMode: true, workingDirectory: workDir });
      seq = this._appendClientRow(chatId, text);
    } catch (err) {
      this._end(taskId, 'failed', failureCode(err));
      throw err;
    }
    this._beginTurn(taskId, chatId, text, seq, origin, { propose: true });
    return this._view(this.store.get(taskId));
  }

  async get(taskId, { seenSeq = null, waitMs = 0 } = {}) {
    const record = this._record(taskId);
    if (this.stopped || record.seq !== seenSeq || !(waitMs > 0)) return this._view(record);
    await this._wait(taskId, Math.min(waitMs, MAX_WAIT_MS));
    return this._view(this._record(taskId));
  }

  // A revoked device is found first, so an ending it causes is what the rest reads. What the send
  // comes to is sendOutcome's (send-rules.js).
  async send(taskId, message, { origin = null } = {}) {
    this._checkGrantingDevice(taskId);
    const record = this._record(taskId);
    if (this.turn && this.turn.taskId === taskId) throw new ToolError('task_busy', 'task_busy: a turn is running; send the message when it ends', { retry_after: 5 });
    if (record.ended && TAKEN_REASONS.has(record.ended.reason)) throw taskEnded();
    if (CONTINUABLE_STATES.has(record.state)) {
      const taken = this._takenReason(record);
      if (taken) {
        this._endTaken(record, taken);
        throw taskEnded();
      }
    }
    if (!CONTINUABLE_STATES.has(record.state)) throw new ToolError('invalid_params', `invalid_params: this task is ${record.state}`);
    checkText(message, 'message');
    this._assertFree(taskId);
    const outcome = this.cards.outcome(record);
    if (!outcome.act.startsWith('run')) throw await this.cards.refuse(record, origin, outcome);
    const seq = this._appendClientRow(record.chat_id, message);
    if (seq === null) throw new ToolError('invalid_params', 'invalid_params: this task\'s chat is gone');
    const handle = this.handles.get(taskId);
    if (outcome.act === 'run_one_more') handle.resend();
    this._update(taskId, {
      state: handle && handle.state().awaiting ? 'awaiting_grant' : 'running',
      reason: null, ended: null, deadline_at: record.deadline_at || this._deadlineFrom(record.proposal),
    });
    // Leases are memory: one this task held did not outlive the service. A done task's ended with
    // it, and a follow-up asks per call.
    this._beginTurn(taskId, record.chat_id, message, seq, origin, { recard: outcome.act === 'run_recard' });
    return this._view(this.store.get(taskId));
  }

  async cancel(taskId) {
    const record = this._record(taskId);
    if (FINAL_STATES.includes(record.state)) return this._view(record);
    const view = this._view(this._end(taskId, 'cancelled', 'cancelled'));
    if (this.turn && this.turn.taskId === taskId) this._cut(this.turn, 'cancelled');
    return view;
  }

  async list({ state = null } = {}) {
    if (state !== null && !TASK_STATES.includes(state)) throw new ToolError('invalid_params', 'invalid_params: unknown task state');
    return this.store.list().filter((r) => state === null || r.state === state).slice(0, MAX_LIST).map((r) => this._view(r));
  }

  // A running task's chat is not the owner's to send into, attach or mark.
  isChatRunning(chatId) {
    return Boolean(this.turn) && this.turn.chatId === chatId;
  }

  // ---- the node's life ----

  // What the last run left unfinished. A crash told nobody, so this is where the phone hears.
  async start() {
    for (const taskId of this.store.markInterrupted()) this._announce(this.store.get(taskId), 'interrupted');
  }

  async stop() {
    this.stopped = true;
    const { turn } = this;
    if (turn) {
      const record = this.store.get(turn.taskId);
      if (record && !OVER_STATES.has(record.state)) {
        const at = new Date(this.clock()).toISOString();
        const marked = this._update(turn.taskId, { state: 'interrupted', ended: null, interrupted_at: at });
        this._announce(marked, 'interrupted');
      }
      this._cut(turn, 'shutdown');
    }
    // A task that waits for its client stays as it is; its lease is memory and does not.
    for (const [taskId, handle] of this.handles) {
      this.handles.delete(taskId);
      this._closeHandle(taskId, handle, 'service_stopped');
    }
    for (const taskId of [...this.waiters.keys()]) this._wake(taskId);
    if (turn) await this._bounded(turn.done);
  }

  async _bounded(promise) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, this.stopWaitMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    await Promise.race([promise, timeout]);
    clearTimeout(timer);
  }

  // ---- records ----

  // What a client reads. The record keeps who pressed after the lease has lapsed, so the grant
  // says whether it lets the task act now: `live`, read from the handle, never stored.
  _view(record) {
    if (this._chatPrivate(record.chat_id)) return privateView(record);
    const view = publicView(record);
    if (view.grant) {
      const handle = this.handles.get(record.task_id);
      view.grant = { ...view.grant, live: Boolean(handle && handle.state().grant) };
    }
    return view;
  }

  // The chat's mark and its case's, as a model call reads them (egressFor: a case marked private
  // marks its chats, and case.yaml alone counts). Whatever cannot be read is private.
  _chatPrivate(chatId) {
    try {
      return this.core.context.egressFor({ chatId }) !== null;
    } catch (err) {
      log.warn('a task chat\'s private mark was not read, so it counts as private', { chatId, error: err.message });
      return true;
    }
  }

  // Why no client's turn may run in this task's chat any more, or null. Only an answer ends a task:
  // a read that failed throws task_busy (the core's `unknown-mark` is one), and the record stays as
  // it was. Reading text is _chatPrivate's, where the same failure counts as private.
  _takenReason(record) {
    const unread = (error) => {
      log.warn('a task\'s chat was not read, so nothing is decided on it', { taskId: record.task_id, error });
      return new ToolError('task_busy', 'task_busy: this task\'s chat could not be read just now; nothing ran', { retry_after: 5 });
    };
    let egress;
    try {
      const chat = this.core.context.getChat(record.chat_id, { messages: false });
      if (!chat) return 'chat_deleted';
      if (chat.caseId) return 'became_case';
      egress = this.core.context.egressFor({ chatId: record.chat_id });
    } catch (err) {
      throw unread(err.message);
    }
    if (egress && egress.reason === 'unknown-mark') throw unread('unknown-mark');
    return egress ? 'private' : null;
  }

  // Frees the node and closes any lease, through _end. A done task stays done, as a cancel leaves
  // it: it was told when it ended, and only says why it takes no more. An open one ends as if the
  // owner had cancelled it, its answer kept; a chat that is gone is a failure.
  _endTaken(record, reason) {
    const taskId = record.task_id;
    if (record.state === 'done') this._update(taskId, { ended: { reason, at: record.ended ? record.ended.at : new Date(this.clock()).toISOString() } });
    else this._end(taskId, reason === 'chat_deleted' ? 'failed' : 'cancelled', reason);
  }

  _record(taskId) {
    const record = this.store.get(taskId);
    if (!record) throw new ToolError('task_not_found', 'task_not_found: no such task on this node');
    return record;
  }

  // One running task per node, naming nothing but the state (spec §4.3). A task that waits for its
  // client still holds the node.
  _assertFree(exceptTaskId = null) {
    if (!this.stopped && !this.turn) this._sweepTaken(exceptTaskId);
    const busy = this.stopped || this.turn
      || this.store.list().some((r) => r.task_id !== exceptTaskId && BUSY_STATES.has(r.state));
    if (busy) throw new ToolError('task_busy', 'task_busy: a task is already under way on this node', { retry_after: 5 });
  }

  // A waiting task whose client never sends again would hold the node for good once the owner has
  // taken its chat, or deleted it, or once nobody has come back to it. A chat that will not read is
  // left for the next look.
  _sweepTaken(exceptTaskId) {
    for (const record of this.store.list()) {
      if (record.task_id === exceptTaskId || record.state !== 'waiting') continue;
      let taken;
      try {
        taken = this._takenReason(record);
      } catch {
        continue;
      }
      if (taken) this._endTaken(record, taken);
      else if (this._abandoned(record)) this._end(record.task_id, 'cancelled', 'abandoned');
    }
  }

  // No change for the bound, and nothing of the owner's still out. A lease is at most 240 minutes and
  // a press or a card writes the record, so a real lease has lapsed long before this holds.
  _abandoned(record) {
    if (!(this.clock() - Date.parse(record.updated_at) >= WAITING_BOUND_MS)) return false;
    const handle = this.handles.get(record.task_id);
    const { awaiting = false, grant = null } = handle ? handle.state() : {};
    return !awaiting && !grant;
  }

  _update(taskId, patch) {
    const record = this.store.update(taskId, patch);
    this._wake(taskId);
    return record;
  }

  // An ending: the record, then everything told of it. → the record.
  _end(taskId, state, reason, extra = {}) {
    const at = new Date(this.clock()).toISOString();
    const record = this._update(taskId, { state, reason: null, ended: { reason, at }, ...extra });
    this._announce(record, reason);
    return record;
  }

  _announce(record, reason) {
    const handle = this.handles.get(record.task_id);
    if (handle) {
      this.handles.delete(record.task_id);
      this._closeHandle(record.task_id, handle, reason);
    }
    if (this.push) {
      try {
        this.push.enqueue({ kind: 'task_ended', id: record.task_id });
      } catch (err) {
        log.warn('the task_ended push was not queued', { taskId: record.task_id, error: err.message });
      }
    }
    this._audit('task.ended', { task_id: record.task_id, reason, usd: (record.spend && record.spend.usd) || 0 });
  }

  _closeHandle(taskId, handle, reason) {
    try {
      handle.close(reason);
    } catch (err) {
      log.warn('a task\'s grant did not close', { taskId, error: err.message });
    }
  }

  _audit(kind, data) {
    if (!this.audit) return;
    Promise.resolve()
      .then(() => this.audit.append({ kind, data }))
      .catch((err) => log.warn(`audit ${kind} failed`, { error: err.message }));
  }

  _wait(taskId, ms) {
    return new Promise((resolve) => {
      let timer = null;
      const set = this.waiters.get(taskId) || new Set();
      this.waiters.set(taskId, set);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      set.add(wake);
      timer = setTimeout(() => {
        set.delete(wake);
        if (set.size === 0 && this.waiters.get(taskId) === set) this.waiters.delete(taskId);
        resolve();
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  _wake(taskId) {
    const set = this.waiters.get(taskId);
    if (!set) return;
    this.waiters.delete(taskId);
    for (const wake of set) wake();
  }

  // ---- chat ----

  _workDir(taskId) {
    const dir = path.join(this.dataDir, 'tasks', taskId, 'work');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return realResolve(dir);
  }

  // → the row's seq, or null when the chat is gone. `author` keeps a client's words out of what a
  // case takes as the owner's.
  _appendClientRow(chatId, text) {
    const appended = this.core.context.appendMessageToChat(chatId, 'user', text, { author: 'client' }, { returnChat: false });
    return appended ? appended.seq : null;
  }

  // The tail of the chat as text pairs, and what recall finds, in this chat alone: no crossChat.
  async _context(chatId, message, seq) {
    const builder = typeof this.core.context.getContextBuilder === 'function' ? this.core.context.getContextBuilder() : null;
    let tail = [];
    let recalled = '';
    if (builder) {
      try {
        const built = await builder.build({ chatId, message, upToSeq: seq });
        tail = built.tail
          .map((m) => ({ role: m.sender === 'assistant' ? 'assistant' : 'user', content: String(m.text || '') }))
          .filter((m) => m.content.trim());
        recalled = (built.recalled && built.recalled.text) || '';
      } catch (err) {
        log.warn('the task\'s chat context was not read', { chatId, error: err.message });
      }
    }
    return {
      messages: [...tail, { role: 'user', content: message }],
      systemPromptDynamic: [TASK_GUIDANCE, recalled].filter(Boolean).join('\n\n'),
    };
  }

  // ---- turns ----

  _beginTurn(taskId, chatId, message, seq, origin, { propose = false, recard = false }) {
    const turn = { taskId, chatId, origin, runId: crypto.randomUUID(), abort: new AbortController(), cut: null, timer: null, done: null };
    this.turn = turn;
    turn.done = this._driveTurn(turn, message, seq, origin, { propose, recard })
      .catch((err) => log.error('a task turn failed past its handler', { taskId, error: err.message }))
      .finally(() => {
        if (turn.timer !== null) this.timers.clear(turn.timer);
        if (this.turn === turn) this.turn = null;
      });
  }

  async _driveTurn(turn, message, seq, origin, { propose, recard }) {
    const { taskId } = turn;
    let result = null;
    let failure = null;
    try {
      if (propose) await this._propose(turn, message);
      if (recard) await this._repropose(turn, message);
      // A cut this early still lands, below: a charge for the proposal can be one.
      if (!turn.cut) {
        this._armDeadline(turn);
        result = await this._execute(turn, message, seq, origin);
      }
    } catch (err) {
      failure = err;
    }
    try {
      this._finishTurn(turn, result, failure);
    } catch (err) {
      this._failUnfinished(taskId, err);
    }
  }

  // A turn's end that would not write must not leave a record running with no turn behind it. If
  // this write fails too, the next start marks it interrupted.
  _failUnfinished(taskId, err) {
    log.error('a task turn\'s end was not written', { taskId, error: err.message });
    const record = this.store.get(taskId);
    if (record && !OVER_STATES.has(record.state)) this._end(taskId, 'failed', 'turn_failed');
  }

  // The scope, before any work: the record gets the proposal as proposed, and the card goes. A bad
  // or absent proposal still runs (spec §4.5). The turn does not wait for the press, and until a
  // press nothing a model proposed binds the owner's money or time: the lowest spend and at most
  // the default minutes, card or no card. A press sets the card's.
  async _propose(turn, text) {
    const proposal = await this._askScope(turn, text);
    if (turn.cut) return;
    const record = this.store.get(turn.taskId);
    this._update(turn.taskId, {
      state: 'running',
      proposal,
      spend: { ...record.spend, cap_usd: DEFAULT_USD },
      deadline_at: this._deadlineFrom(proposal),
    });
    this.cards.open(turn, proposal);
  }

  // A task the last run left, whose lease went with it (spec §4.6): the scope again, and a card
  // before any acting call. A bad answer keeps the scope the task had.
  async _repropose(turn, message) {
    const before = this.store.get(turn.taskId);
    const fresh = await this._askScope(turn, `${before.text}\n\n${message}`);
    if (turn.cut) return;
    const proposal = fresh || before.proposal;
    this._update(turn.taskId, { proposal });
    this.cards.open(turn, proposal && { ...proposal, usd: this.cards.usdFor(before, proposal, before.spend.cap_usd) });
  }

  async _askScope(turn, text) {
    if (typeof this.callUtility !== 'function') return null;
    const aborted = new Promise((resolve) => {
      turn.abort.signal.addEventListener('abort', () => resolve({ proposal: null }), { once: true });
    });
    // The scope call is the task's own: it is charged like any other, under the chat's policy.
    const callUtility = (prompt) => this.callUtility(prompt, {
      chatId: turn.chatId,
      signal: turn.abort.signal,
      onUsage: (event) => this._charge(turn, [event]),
    });
    const { proposal } = await Promise.race([proposeScope({ text, callUtility }), aborted]);
    return proposal;
  }

  // A turn runs to its deadline, card out or not. A press moves the deadline and arms this again.
  _armDeadline(turn) {
    if (turn.timer !== null) this.timers.clear(turn.timer);
    const record = this.store.get(turn.taskId);
    turn.timer = this.timers.set(() => this._cut(turn, 'duration'), Math.max(0, Date.parse(record.deadline_at) - this.clock()));
  }

  // With no press: at most the default minutes, whatever was proposed.
  _deadlineFrom(proposal) {
    const minutes = proposal ? Math.min(proposal.minutes, DEFAULT_MINUTES) : DEFAULT_MINUTES;
    return new Date(this.clock() + minutes * 60000).toISOString();
  }

  async _execute(turn, message, seq, origin) {
    const { taskId, chatId, runId } = turn;
    const { delegate = {} } = this.nodeConfig;
    const agentId = delegate.agent || 'main';
    const agent = this.core.context.getAgent(agentId);
    if (!agent) throw Object.assign(new Error(`no agent ${agentId}`), { code: 'no_agent' });
    const workDir = this._workDir(taskId);
    const context = await this._context(chatId, message, seq);
    if (turn.cut) return null;
    const append = (sender, metadata) => {
      // Null is a chat deleted mid-turn: nothing more of this turn has anywhere to land.
      const row = this.core.context.appendMessageToChat(chatId, sender, '', { ...metadata, runId }, { returnChat: false });
      if (!row) this._cut(turn, 'chat_deleted');
      return row;
    };
    return this.core.context.getAgentExecutorAdapter().execute(agent, message, {
      ...(delegate.provider ? { provider: delegate.provider } : {}),
      ...(delegate.model ? { model: delegate.model } : {}),
      workingDirectory: workDir,
      messages: context.messages,
      systemPromptDynamic: context.systemPromptDynamic,
      abortSignal: turn.abort.signal,
      allowedToolNames: taskToolNames(this.toolRegistry),
      // An owner chat's turn gets this many steps; the agent's own default (10) is for a child run.
      maxIterations: TURN_MAX_ITERATIONS,
      onUsageRecorded: (event) => this._charge(turn, [event]),
      executorOptions: {
        origin: executorOrigin(origin, `chat:${chatId}`),
        chatId,
        refuseUnsafe: shouldRefuseUnsafe(origin, this.nodeConfig),
        allowedRoots: [workDir],
        denyAutoApproval: true,
        taskPolicy: createTaskPolicy({
          getState: () => this._policyState(taskId),
          currentUrl: this.currentUrl,
          workDir,
          waitForGrant: async () => {
            const handle = this.handles.get(taskId);
            if (handle) await handle.wait();
          },
        }),
        // Kept whatever became of the turn: the attach check reads these rows, and what ran ran.
        toolEvents: {
          pre: ({ toolName, parameters }) => append('toolUse', { toolName, parameters }),
          post: ({ toolName, result }) => append('toolResult', { toolName, result }),
        },
        onSubagentLlm: (run) => this._charge(turn, run.calls || []),
      },
    });
  }

  // A device revoked out of band ends the task here, not at the next five-second look. Reading a
  // handle never does.
  _checkGrantingDevice(taskId) {
    const handle = this.handles.get(taskId);
    if (handle) handle.checkDevice();
  }

  // Live on every call: a child can outlive its turn. A waiting task is not over; its grant is
  // whatever is live.
  _policyState(taskId) {
    this._checkGrantingDevice(taskId);
    const record = this.store.get(taskId);
    if (!record || OVER_STATES.has(record.state)) return { ended: true, grant: null, awaiting: false, proposal: null };
    const handle = this.handles.get(taskId);
    const { awaiting = false, grant = null } = handle ? handle.state() : {};
    return { ended: false, grant, awaiting, proposal: record.proposal };
  }

  // Charged whatever the turn has become: the money is spent. Only the running turn can be cut.
  _charge(turn, events) {
    const record = this.store.get(turn.taskId);
    if (!record || !events.length) return;
    const spend = { usd: 0, calls: 0, unpriced: 0, cap_usd: DEFAULT_USD, ...record.spend };
    for (const event of events) {
      const cost = pricedAt(event);
      spend.calls += 1;
      if (cost === null) spend.unpriced += 1;
      else spend.usd = Number((spend.usd + cost).toFixed(8));
    }
    this._update(turn.taskId, { spend });
    if (overCap(spend)) this._cut(turn, 'spend_cap');
  }

  // Waiting for a press that can raise the cap, or for the client after the duration or an hour
  // of an unanswered card. With no grants no press can move a cap or a deadline, so the task is over.
  _landCut(turn) {
    const { taskId, cut } = turn;
    const record = this.store.get(taskId);
    if (!record || OVER_STATES.has(record.state)) return;
    if ((cut === 'spend_cap' || cut === 'duration') && !this.grants) {
      this._end(taskId, 'failed', cut);
      return;
    }
    const waiting = this._update(taskId, { state: 'waiting', reason: cut });
    if (cut === 'spend_cap') this.cards.askMore(waiting, turn.origin, 'spend_cap');
  }

  _cut(turn, reason) {
    if (turn.cut) return;
    turn.cut = reason;
    turn.abort.abort();
  }

  // A cancel and a stop wrote the record when they were asked, and stand even over an earlier cut
  // still unwinding. A reply that landed before a cut is kept in the chat as stopped; the loop's
  // canned text for a stopped run is no reply.
  _finishTurn(turn, result, failure) {
    const { taskId, chatId, runId, cut } = turn;
    if (!this.core.context.getChat(chatId, { messages: false })) {
      if (failure) log.warn('a task turn failed, and its chat is gone', { taskId, code: failureCode(failure), error: failure.message });
      const record = this.store.get(taskId);
      if (record && !OVER_STATES.has(record.state)) this._end(taskId, 'failed', 'chat_deleted');
      return;
    }
    const type = result && result.type;
    const complete = !failure && result && (!type || type === 'complete');
    const text = complete && typeof result.content === 'string' && result.content.trim() ? result.content : null;
    const llm = result && result.llm ? { llm: summarizeTurnLlm({ calls: result.llm.calls }) } : {};
    if (cut) {
      if (text) this.core.context.appendMessageToChat(chatId, 'assistant', text, { ...llm, runId, stopped: true }, { returnChat: false });
      if (LANDING_CUTS.has(cut)) this._landCut(turn);
      return;
    }
    if (!complete) {
      const reason = failure ? failureCode(failure) : (ENDED_TYPES.has(type) ? type : 'turn_failed');
      if (failure) log.warn('a task turn failed', { taskId, code: reason, error: failure.message });
      this._end(taskId, 'failed', reason);
      return;
    }
    const reply = text || '(No response)';
    const row = this.core.context.appendMessageToChat(chatId, 'assistant', reply, { ...llm, runId }, { returnChat: false });
    const at = new Date(this.clock()).toISOString();
    const answer = { text: reply, at, seq: row ? row.seq : null };
    if (parseStuck(reply)) this._update(taskId, { state: 'waiting', reason: 'stuck', answer });
    else this._end(taskId, 'done', 'done', { answer });
  }
}

module.exports = { TaskManager, publicView, taskToolNames };

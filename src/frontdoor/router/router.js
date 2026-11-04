// Routes MCP tool calls from the front door to fleet nodes (fleet stage 4
// §3.6): scope, machine and tier are checked here before anything is sent;
// the node re-checks the scopes it is given (bounding router bugs, §8), and
// node policy plus a fresh phone signature stay the real ceiling.
//
// Two checks decide which machines a call may reach, and both must pass:
// the token's scope strings (`allows`, which a refresh may have narrowed) and
// the grant itself (`machineMatches`, which pins each named machine to the
// node id the owner approved, ruling T23-nodeid). A delegate job belongs to
// the grant that started it (ruling T11-owner): the cache records that owner
// and every cached read and every watch checks it; another grant is told the
// job does not exist. Clients only ever see public job ids.
//
// A task (tasks spec §4.1, §4.2, §4.4) is the node's: the router places it,
// forwards it and rewrites its id, and keeps nothing of it. Every grant that
// may read the node reads its tasks, so the job cache is not consulted, and an
// offline node has no cached answer.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { MCP_TOOLS, TASK_TOOL_NAMES, WAIT_MS_MAX, untrustedOutput } = require('../../fleet/tool-definitions');
const { REQUIRED_SCOPE, allows, machineVisible } = require('../../fleet/scope-rules');
const { LinkRpcError } = require('../../approvals/link-rpc');
const { GRANT_ID_RE } = require('../protocol/messages');
const { machineMatches } = require('../oauth/grants');
const { TERMINAL_STATUSES, NODE_JOB_ID_RE, publicJobId, parsePublicJobId, visibleTo } = require('./job-cache');

const log = createLogger('frontdoor/router');

const MAX_BYTES = 524288;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const METHODS = Object.freeze({
  describe_machine: 'fleet.describe',
  get_state: 'fleet.get_state',
  run_runbook: 'fleet.run_runbook',
  delegate: 'fleet.delegate',
  send_to_job: 'fleet.send_to_job',
  get_job: 'fleet.get_job',
  get_job_logs: 'fleet.get_job_logs',
  cancel_job: 'fleet.cancel_job',
  run_task: 'fleet.run_task',
  get_task: 'fleet.get_task',
  send_to_task: 'fleet.send_to_task',
  cancel_task: 'fleet.cancel_task',
  list_tasks: 'fleet.list_tasks'
});
const JOB_TOOLS = new Set(['get_job', 'get_job_logs', 'send_to_job', 'cancel_job']);
const CACHED_WHEN_OFFLINE = new Set(['describe_machine', 'get_state', 'get_job']);
// A fleet.job_update for a job the router has not recorded yet (it can beat
// the fleet.delegate reply that names the job) is held briefly, keyed by
// node id and job id, and applied only when that reply records the job.
const EARLY_UPDATE_MS = 60000;
const EARLY_UPDATE_MAX = 256;
// A write tool (registerTool's perGrantLimit: every tool in a case write
// scope, management surfaces spec §3.3) takes a slot in its grant's sliding
// window before it is forwarded; the 31st in a minute is refused with the
// node handler's own rate_limited / retry_after shape. The window is per
// grant id, from the grant the endpoint authenticated, never the arguments.
const GRANT_WRITE_LIMIT = 30;
const GRANT_WRITE_WINDOW_MS = 60000;
const OFFLINE_CODES = new Set(['offline', 'peer_disconnected', 'unknown_node', 'closed', 'not_linked']);
// What each task tool also sends beside the id, the origin and max_bytes.
const TASK_TOOLS = Object.freeze({ get_task: ['seen_seq', 'wait_ms'], send_to_task: ['message', 'wait_ms'], cancel_task: [] });
const taskProps = (name) => MCP_TOOLS.find((t) => t.name === name).inputSchema.properties;
const TASK_TEXT_MAX = taskProps('run_task').task.maxLength;
const TASK_STATES = taskProps('list_tasks').state.enum;
const TASK_LIST_MAX = 50;
// A link failure that says the call never reached the node. Any other failure
// may have come after the node began: the link has no request_id for a task, so
// nothing here is ever sent twice, and the client is told to look instead.
const NOT_SENT_CODES = new Set(['offline', 'unknown_node', 'not_linked', 'peer_busy', 'no_local_node']);
const TASK_UNANSWERED = Object.freeze({
  run_task: 'the task may have started; look with list_tasks, and do not run it again',
  send_to_task: 'the message may have reached the task; look with get_task, and do not send it again',
  cancel_task: 'the cancel may have landed; look with get_task, or send it again, which is safe: a cancel changes nothing on a task that has ended'
});
// The router's own calls (the catalog refresh after fleet.hello): read-only.
// The node refuses any origin without a grant_id (Task 12), so the router
// names itself with one that can never be a client's (GRANT_ID_RE).
const ROUTER_ORIGIN = Object.freeze({ kind: 'frontdoor', client_id: null, client_name: 'King Louie front door', grant_id: 'frontdoor-router', scopes: Object.freeze(['fleet:read']), mcp_session: null });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortText = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const refusal = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
const scopeRefusal = (check) => (check.code === 'unknown_machine'
  ? refusal('unknown_machine', 'unknown_machine: this client may not use that machine')
  : refusal('insufficient_scope', `insufficient_scope: this client was not granted ${check.required}`, { required: check.required }));
const offline = (machine) => refusal('machine_offline', `machine_offline: ${machine} is offline; nothing was queued`);
const unknownMachine = (machine) => refusal('unknown_machine', `unknown_machine: no machine "${String(machine).slice(0, 64)}" for this client`);
// One answer for a job that does not exist, one this client may not see and
// one only another grant's cache entry knows: existence never leaks.
const jobNotFound = (publicId) => refusal('job_not_found', `job_not_found: no job "${publicId}" for this client`);
const notAJobId = () => refusal('job_not_found', 'job_not_found: that is not a front-door job id (<machine>:<job>)');
const taskNotFound = (publicId) => refusal('task_not_found', `task_not_found: no task "${publicId}" for this client`);
const notATaskId = () => refusal('task_not_found', 'task_not_found: that is not a front-door task id (<machine>:<task>)');
const badTaskAnswer = (name, machine) => refusal('bad_node_answer',
  `bad_node_answer: ${machine} sent no usable task${TASK_UNANSWERED[name] ? `; ${TASK_UNANSWERED[name]}` : ''}`);

// A grant the router can act for: a live grant record as GrantStore#live
// returns it. Anything else reaches nothing.
const grantOk = (grant) => isPlainObject(grant) && typeof grant.grant_id === 'string' && GRANT_ID_RE.test(grant.grant_id) && Array.isArray(grant.scopes);

// Whether a runbook of this tier needs fleet:unsafe, by scope-rules' own
// table: fleet:run alone covers it or it does not.
const needsUnsafe = (tier) => !allows(['fleet:run'], 'run_runbook', { tier }).ok;
// The same for a task tool: its own scope alone covers it or it does not.
const taskNeedsUnsafe = (tool) => !allows([REQUIRED_SCOPE[tool]], tool).ok;

// logs / lines → output; a string result or reply → a one-item wrapper.
// Whatever the node sent, it goes out labelled as data (§3.5).
function wrapUntrusted(reply) {
  const { logs, lines, ...rest } = reply;
  const out = { ...rest };
  if (Array.isArray(logs) || Array.isArray(lines)) out.output = untrustedOutput(Array.isArray(logs) ? logs : lines);
  for (const k of ['result', 'reply']) if (typeof out[k] === 'string') out[k] = untrustedOutput([out[k]]);
  return out;
}

// The fields a task tool passes on, by name; absent ones stay absent.
function copied(args, keys) {
  const out = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) out[k] = args[k];
  return out;
}

// What the router itself must know of a task call's arguments: wait_ms because
// _sendTask adds it to the forward's timeout, the rest because they decide
// placement or the fan-out. The node checks everything else.
function taskArgsProblem(name, a) {
  if (taskProps(name).wait_ms && a.wait_ms !== undefined && a.wait_ms !== null && !(Number.isInteger(a.wait_ms) && a.wait_ms >= 0 && a.wait_ms <= WAIT_MS_MAX)) {
    return `"wait_ms" must be an integer from 0 to ${WAIT_MS_MAX}`;
  }
  if (name === 'run_task' && (typeof a.task !== 'string' || !a.task.trim() || a.task.length > TASK_TEXT_MAX)) return `"task" must be 1 to ${TASK_TEXT_MAX} characters`;
  if (taskProps(name).node && a.node !== undefined && a.node !== null && (typeof a.node !== 'string' || !a.node)) return '"node" must be a node name';
  if (name === 'list_tasks' && a.state !== undefined && a.state !== null && !TASK_STATES.includes(a.state)) return 'unknown task state';
  return null;
}

// A node's task as a client sees it: the public id, the name the router knows
// the node by, and its words labelled as data whatever the node sent.
function taskView(machine, view) {
  const out = { ...view, task_id: publicJobId(machine, view.task_id), node: machine };
  if (typeof out.text === 'string') out.text = untrustedOutput([out.text]);
  if (isPlainObject(out.answer) && typeof out.answer.text === 'string') out.answer = { ...out.answer, text: untrustedOutput([out.answer.text]) };
  return out;
}

const createdAtMs = (row) => {
  const at = Date.parse(row.created_at);
  return Number.isNaN(at) ? 0 : at;
};

// What a list of several nodes leaves out: what each node's own page left out,
// added up, and what the router's cap took. A node's note is not passed on.
function mergedLeftOut(replies, cut) {
  const left = replies.map((r) => (isPlainObject(r.left_out) ? r.left_out : {}));
  const words = left.some((l) => l.words === true);
  const tasks = cut + left.reduce((sum, l) => sum + (Number.isInteger(l.tasks) && l.tasks > 0 ? l.tasks : 0), 0);
  if (!words && tasks === 0) return null;
  const note = [
    words ? 'Some rows have no text or answer; get_task reads one whole.' : null,
    tasks > 0 ? `${tasks} more task(s) are not on this page; narrow with node or state.` : null
  ].filter(Boolean).join(' ');
  return { words, tasks, note };
}

// What the router keeps of a node's fleet.hello: typed and bounded, since
// list_machines hands parts of it to clients.
function cleanHello(p) {
  return {
    node_id: p.node_id,
    name: shortText(p.name, 64),
    profile: shortText(p.profile, 32),
    capabilities: Array.isArray(p.capabilities) ? p.capabilities.filter((c) => typeof c === 'string' && c.length <= 64).slice(0, 32) : [],
    catalog_digest: shortText(p.catalog_digest, 128),
    boot_id: shortText(p.boot_id, 128),
    version: shortText(p.version, 64)
  };
}

function requireFns(obj, fns, what) {
  for (const fn of fns) if (!obj || typeof obj[fn] !== 'function') throw new TypeError(`FleetRouter needs ${what}.${fn}()`);
}

class FleetRouter extends EventEmitter {
  constructor({ registry, nodeHub, cache, scopeRegistry, timeoutMs = 30000, perNodeLimit = 64, totalLimit = 256, maxBytes = MAX_BYTES,
    saveEveryMs = 60000, now = Date.now, uuid = () => crypto.randomUUID(), grantWriteLimit = GRANT_WRITE_LIMIT } = {}) {
    super();
    // Fail closed: without these nothing can be checked or reached.
    requireFns(registry, ['byId', 'byName', 'list', 'presence', 'markOnline', 'markOffline'], 'registry');
    requireFns(nodeHub, ['rpc', 'onNodeMessage', 'onConnection'], 'nodeHub');
    requireFns(cache, ['get', 'lookup', 'put', 'patch', 'failNonTerminal', 'setNode', 'node', 'save', 'on'], 'cache');
    this.registry = registry;
    this.nodeHub = nodeHub;
    this.cache = cache;
    this.scopeRegistry = scopeRegistry;
    this.timeoutMs = timeoutMs;
    this.perNodeLimit = perNodeLimit;
    this.totalLimit = totalLimit;
    this.maxBytes = maxBytes;
    this.saveEveryMs = saveEveryMs;
    this.now = now;
    this.uuid = uuid;
    this.inflight = new Map();
    this.total = 0;
    this.extraTools = new Map();
    this.grantWriteLimit = grantWriteLimit;
    this.grantWrites = new Map(); // grant id → call times inside the window, oldest first
    this.watchers = new Map(); // public id → Set<{ grantId, fn }>
    this.refreshing = new Map();
    this.refreshAgain = new Map();
    this.earlyUpdates = new Map(); // JSON [nodeId, nodeJobId] → { at, update }
    this.saveTimer = null;
    this.cache.on('update', (id, entry) => this._notify(id, { status: entry.status, log_lines: entry.log_lines || 0, session: entry.session || null }));
  }

  attach() {
    this.nodeHub.onNodeMessage('fleet.hello', (params, ctx) => this._onHello(params, ctx));
    this.nodeHub.onNodeMessage('fleet.job_update', (params, ctx) => this._onJobUpdate(params, ctx));
    this.nodeHub.onNodeMessage('fleet.catalog_changed', (params, ctx) => this._onCatalogChanged(params, ctx));
    this.nodeHub.onConnection(({ nodeId, connected }) => {
      if (connected) return; // presence starts with fleet.hello
      const node = this.registry.byId(nodeId);
      this.registry.markOffline(nodeId);
      if (!node) return;
      for (const id of [...this.watchers.keys()]) {
        const entry = this.cache.lookup(id, nodeId);
        if (entry) this._notify(id, { status: entry.status, log_lines: entry.log_lines || 0, session: entry.session || null, offline: true });
      }
    });
    return this;
  }

  start() {
    if (this.saveTimer) return this;
    this.saveTimer = setInterval(() => this._save(), this.saveEveryMs);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
    return this;
  }

  stop() {
    clearInterval(this.saveTimer);
    this.saveTimer = null;
    this._save();
  }

  _save() {
    try {
      this.cache.save();
    } catch (err) {
      log.warn(`saving node-status.json failed: ${err.message}`);
    }
  }

  toolDefinitions() {
    return [...MCP_TOOLS, ...[...this.extraTools.values()].map((t) => t.def)];
  }

  isTerminal(status) {
    return TERMINAL_STATUSES.includes(status);
  }

  // C7 (program §4.19): route(args, ctx) → { machine } | { fanout: true }.
  // perGrantLimit: the tool's calls count against its grant's write window.
  // fanout: the tool may route to every reachable node; only a read tool
  // may, so a write tool (perGrantLimit) declared fan-out is refused here,
  // and a route that fans out for a tool not declared so is refused at call.
  registerTool(def, { scope, route, perGrantLimit = false, fanout = false } = {}) {
    if (!def || typeof def.name !== 'string') throw new TypeError('registerTool needs a tool definition with a name');
    if (Object.hasOwn(METHODS, def.name) || def.name === 'list_machines' || this.extraTools.has(def.name)) throw new Error(`tool ${def.name} is already registered`);
    if (typeof scope !== 'string' || typeof route !== 'function') throw new TypeError(`tool ${def.name}: registerTool needs { scope, route }`);
    if (perGrantLimit === true && fanout === true) throw new Error(`tool ${def.name}: a write tool (perGrantLimit) cannot fan out`);
    this.extraTools.set(def.name, { def, scope, route, perGrantLimit: perGrantLimit === true, fanout: fanout === true });
  }

  // Takes a slot in `grantId`'s write window: → a release for it, or a
  // rate_limited refusal. Empty windows are dropped as they are met.
  _takeGrantSlot(grantId) {
    const t = this.now();
    for (const [id, times] of this.grantWrites) {
      while (times.length && times[0] <= t - GRANT_WRITE_WINDOW_MS) times.shift();
      if (times.length === 0) this.grantWrites.delete(id);
    }
    const times = this.grantWrites.get(grantId) || [];
    if (times.length >= this.grantWriteLimit) {
      const retryAfter = Math.max(1, Math.ceil((times[0] + GRANT_WRITE_WINDOW_MS - t) / 1000));
      return { refused: refusal('rate_limited', `rate_limited: at most ${this.grantWriteLimit} case write calls per minute for this client; retry after ${retryAfter}s`, { retry_after: retryAfter }) };
    }
    times.push(t);
    this.grantWrites.set(grantId, times);
    return {
      release: () => {
        const i = times.indexOf(t);
        if (i !== -1) times.splice(i, 1);
      }
    };
  }

  // Whether this grant, with these token scopes, may reach `node` for
  // `tool` (whose scope is `required`): the token's scopes and the grant's
  // own machine pins must both cover it.
  _reaches(grant, scopes, tool, required, node, opts = {}) {
    return Boolean(node) && allows(scopes, tool, { ...opts, machine: node.node_name }).ok
      && machineMatches(grant, required, node.node_name, node.node_id);
  }

  // The endpoint's long-poll (Task 26) watches a job only for the caller it
  // answered: `ctx` is that call's { grant, scopes }. A job on a machine the
  // grant may not read, or one it may not see, throws job_not_found; each
  // update is checked against the entry again before it is delivered.
  watchJob(publicId, onUpdate, { grant = null, scopes = [] } = {}) {
    if (typeof onUpdate !== 'function') throw new TypeError('watchJob needs onUpdate');
    const notFound = () => Object.assign(new Error(jobNotFound(String(publicId).slice(0, 256)).error.message), { code: 'job_not_found' });
    if (!grantOk(grant)) throw notFound();
    const parsed = parsePublicJobId(publicId);
    if (!parsed) throw notFound();
    const node = this.registry.byName(parsed.machine);
    if (!this._reaches(grant, scopes, 'get_job', REQUIRED_SCOPE.get_job, node)) throw notFound();
    if (!visibleTo(this.cache.lookup(publicId, node.node_id), grant.grant_id)) throw notFound();
    // A watcher is bound to the node that ran the job as well as its grant.
    const watcher = { grantId: grant.grant_id, nodeId: node.node_id, fn: onUpdate };
    const set = this.watchers.get(publicId) || new Set();
    set.add(watcher);
    this.watchers.set(publicId, set);
    return () => {
      set.delete(watcher);
      if (set.size === 0 && this.watchers.get(publicId) === set) this.watchers.delete(publicId);
    };
  }

  _notify(id, update) {
    const set = this.watchers.get(id);
    if (!set) return;
    for (const w of [...set]) {
      if (!visibleTo(this.cache.lookup(id, w.nodeId), w.grantId)) continue;
      try {
        w.fn({ ...update });
      } catch (err) {
        log.warn(`a job watcher failed: ${err.message}`);
      }
    }
  }

  async whenIdle() {
    while (this.refreshing.size > 0) await Promise.all([...this.refreshing.values()]);
  }

  _online(nodeId) {
    const p = this.registry.presence(nodeId);
    return Boolean(p && p.online);
  }

  _origin(grant, scopes, session) {
    return {
      kind: 'frontdoor',
      client_id: typeof grant.client_id === 'string' ? grant.client_id : null,
      client_name: typeof grant.client_name === 'string' ? grant.client_name : null,
      grant_id: grant.grant_id,
      scopes: Array.isArray(scopes) ? [...scopes] : [],
      mcp_session: typeof session === 'string' ? session : null
    };
  }

  // Everything before the first await is synchronous, so the in-flight
  // counters are claimed in call order.
  async callTool(name, args = {}, { grant = null, scopes = [], session = null } = {}) {
    const a = isPlainObject(args) ? args : {};
    if (!grantOk(grant)) return refusal('unauthorized', 'unauthorized: this call carries no grant');
    const origin = this._origin(grant, scopes, session);
    const extra = typeof name === 'string' ? this.extraTools.get(name) : undefined;
    if (extra) return this._callExtra(name, extra, a, grant, origin);

    if (name === 'list_machines') {
      const check = allows(origin.scopes, name);
      return check.ok ? this._listMachines(grant, origin.scopes) : scopeRefusal(check);
    }
    if (typeof name !== 'string' || !Object.hasOwn(METHODS, name)) return refusal('invalid_params', 'invalid_params: no such tool');
    const base = allows(origin.scopes, name);
    if (!base.ok) return scopeRefusal(base);
    if (TASK_TOOL_NAMES.includes(name)) return this._callTask(name, a, grant, origin);
    const required = REQUIRED_SCOPE[name];

    let machine;
    let nodeJobId = null;
    if (JOB_TOOLS.has(name)) {
      const parsed = parsePublicJobId(a.job_id);
      if (!parsed) return notAJobId();
      ({ machine, nodeJobId } = parsed);
    } else {
      machine = a.machine;
      if (typeof machine !== 'string' || !machine) return refusal('invalid_params', 'invalid_params: "machine" is required');
    }
    const node = this.registry.byName(machine);
    if (!this._reaches(grant, origin.scopes, name, required, node)) return unknownMachine(machine);

    if (name === 'run_runbook') {
      const tier = this._tier(node, a.runbook);
      const check = allows(origin.scopes, name, { machine, tier });
      if (!check.ok) return scopeRefusal(check);
      if (needsUnsafe(tier) && !machineMatches(grant, 'fleet:unsafe', node.node_name, node.node_id)) {
        return scopeRefusal({ code: 'insufficient_scope', required: 'fleet:unsafe' });
      }
    }
    if (name === 'delegate' && node.profile !== 'agent') {
      return refusal('capability_unavailable', `capability_unavailable: ${machine} is a ${node.profile} node; delegate needs profile: agent`);
    }

    // Another grant's delegate job: refused here, before the node is asked.
    const publicId = nodeJobId === null ? null : publicJobId(machine, nodeJobId);
    if (publicId !== null) {
      const entry = this.cache.lookup(publicId, node.node_id);
      if (entry && !visibleTo(entry, grant.grant_id)) return jobNotFound(publicId);
    }

    if (!this._online(node.node_id)) return CACHED_WHEN_OFFLINE.has(name) ? this._stale(name, node, machine, publicId, grant) : offline(machine);

    // Client arguments are copied field by field: none of them can replace
    // the origin, max_bytes or request_id the router sends.
    const params = { origin, max_bytes: this.maxBytes };
    let requestId = null;
    if (name === 'run_runbook' || name === 'delegate') {
      requestId = typeof a.request_id === 'string' && UUID_V4_RE.test(a.request_id) ? a.request_id : this.uuid();
      params.request_id = requestId;
      if (name === 'run_runbook') Object.assign(params, { runbook: a.runbook, params: a.params || {} });
      else Object.assign(params, { task: a.task, ...(a.cwd === undefined ? {} : { cwd: a.cwd }) });
    } else if (name === 'send_to_job') {
      Object.assign(params, { job_id: nodeJobId, message: a.message });
    } else if (name === 'get_job_logs') {
      Object.assign(params, { job_id: nodeJobId, ...(a.since === undefined ? {} : { since: a.since }), ...(a.tail === undefined ? {} : { tail: a.tail }) });
    } else if (nodeJobId !== null) {
      params.job_id = nodeJobId;
    }

    let reply;
    try {
      reply = await this._forward(node.node_id, METHODS[name], params);
    } catch (err) {
      return this._forwardError(err, machine, requestId);
    }
    if (!isPlainObject(reply)) return refusal('bad_node_answer', `bad_node_answer: ${machine} sent no result`);
    if (reply.ok === false) return this._nodeRefusal(reply, nodeJobId, publicId, machine);
    return this._rewrite(name, node, machine, nodeJobId, grant, reply);
  }

  // The tier the cached catalog gives `runbook`. Without a catalog, or when
  // the catalog lacks the runbook (it may be stale), the tier is unknown,
  // which needs fleet:unsafe and its machine pin (fail closed), and the
  // catalog is fetched again.
  _tier(node, runbook) {
    const cached = this.cache.node(node.node_id) || {};
    const catalog = cached.catalog;
    const rb = isPlainObject(catalog) && Array.isArray(catalog.runbooks) ? catalog.runbooks.find((r) => isPlainObject(r) && r.name === runbook) : null;
    if (!rb) {
      if (this._online(node.node_id)) this._refreshCatalog(node.node_id, cached.catalog_digest || null);
      return 'unknown';
    }
    return typeof rb.tier === 'string' ? rb.tier : 'unknown';
  }

  // A node's refusal goes back with its code; a node job id in its text is
  // replaced by the public one, and job_not_found is the router's own answer.
  _nodeRefusal(reply, nodeJobId, publicId, machine) {
    const err = isPlainObject(reply.error) ? reply.error : null;
    if (!err || typeof err.code !== 'string') return refusal('bad_node_answer', `bad_node_answer: ${machine} refused without a code`);
    if (err.code === 'job_not_found' && publicId !== null) return jobNotFound(publicId);
    let message = typeof err.message === 'string' ? err.message : err.code;
    if (nodeJobId !== null) message = message.split(`"${nodeJobId}"`).join(`"${publicId}"`);
    return { ok: false, error: { ...err, message } };
  }

  async _forward(nodeId, method, params, { timeoutMs = this.timeoutMs } = {}) {
    const n = this.inflight.get(nodeId) || 0;
    if (n >= this.perNodeLimit || this.total >= this.totalLimit) throw Object.assign(new Error('busy'), { code: 'frontdoor_busy' });
    this.inflight.set(nodeId, n + 1);
    this.total += 1;
    try {
      return await this.nodeHub.rpc(nodeId, method, params, { timeoutMs });
    } finally {
      const left = (this.inflight.get(nodeId) || 1) - 1;
      if (left > 0) this.inflight.set(nodeId, left);
      else this.inflight.delete(nodeId);
      this.total -= 1;
    }
  }

  _forwardError(err, machine, requestId) {
    if (err && err.code === 'frontdoor_busy') return refusal('frontdoor_busy', 'frontdoor_busy: too many calls in flight; retry in a few seconds', { retry_after: 5 });
    if (err && err.code === 'timeout') {
      return refusal('node_timeout',
        `node_timeout: ${machine} did not answer within ${Math.round(this.timeoutMs / 1000)} s; the job may have started; call get_job or retry with the same request${requestId ? ` (request_id ${requestId})` : ''}`,
        requestId ? { request_id: requestId } : {});
    }
    if (err && OFFLINE_CODES.has(err.code)) return offline(machine);
    // Anything else is the link's or the router's own failure: logged here,
    // answered without its text.
    log.warn(`forwarding to ${machine} failed: ${err && err.message}`, { code: (err && err.code) || null });
    return refusal('node_error', `node_error: the call to ${machine} failed`);
  }

  // Whether this grant may use `node` for a task tool: null, or the refusal.
  // A machine it does not cover answers `denied`; a node it covers but
  // without fleet:unsafe says so. Token and grant must both agree, as in
  // _reaches, and a task tool that needs fleet:unsafe needs its pin as well.
  _taskRefusal(grant, scopes, tool, node, denied) {
    const check = allows(scopes, tool, { machine: node.node_name });
    if (!check.ok) return check.code === 'unknown_machine' ? denied : scopeRefusal(check);
    if (!machineMatches(grant, REQUIRED_SCOPE[tool], node.node_name, node.node_id)) return denied;
    if (taskNeedsUnsafe(tool) && !machineMatches(grant, 'fleet:unsafe', node.node_name, node.node_id)) {
      return scopeRefusal({ code: 'insufficient_scope', required: 'fleet:unsafe' });
    }
    return null;
  }

  // The nodes run_task may place on: agent nodes that are online and that
  // this grant may reach for it.
  _place(grant, scopes) {
    return this.registry.list().filter((r) => r.profile === 'agent' && this._online(r.node_id) && !this._taskRefusal(grant, scopes, 'run_task', r, true));
  }

  // A node the client named for run_task or list_tasks: { node } or { refused }.
  _namedTaskNode(name, machine, grant, scopes) {
    const node = this.registry.byName(machine);
    const refused = node ? this._taskRefusal(grant, scopes, name, node, unknownMachine(machine)) : unknownMachine(machine);
    if (refused) return { refused };
    if (node.profile !== 'agent') return { refused: refusal('capability_unavailable', `capability_unavailable: ${machine} is a ${node.profile} node; tasks need profile: agent`) };
    return { node };
  }

  async _callTask(name, a, grant, origin) {
    const problem = taskArgsProblem(name, a);
    if (problem) return refusal('invalid_params', `invalid_params: ${problem}`);
    if (name === 'run_task') return this._runTask(a, grant, origin);
    if (name === 'list_tasks') return this._listTasks(a, grant, origin);

    const parsed = parsePublicJobId(a.task_id);
    if (!parsed) return notATaskId();
    const { machine, nodeJobId: taskId } = parsed;
    const publicId = publicJobId(machine, taskId);
    const node = this.registry.byName(machine);
    if (!node || node.profile !== 'agent') return taskNotFound(publicId);
    const refused = this._taskRefusal(grant, origin.scopes, name, node, taskNotFound(publicId));
    if (refused) return refused;
    if (!this._online(node.node_id)) return offline(machine);
    return this._sendTask(name, node, { origin, max_bytes: this.maxBytes, task_id: taskId, ...copied(a, TASK_TOOLS[name]) }, taskId);
  }

  // Tasks spec §4.2: a node named, else the only one, else ask the client.
  async _runTask(a, grant, origin) {
    let node;
    let by = 'named';
    if (a.node === undefined || a.node === null) {
      const eligible = this._place(grant, origin.scopes);
      if (eligible.length !== 1) {
        const nodes = eligible.map((r) => ({ name: r.node_name, capabilities: this._capabilities(r), online: true }))
          .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
        return { needs_placement: true, nodes };
      }
      [node] = eligible;
      by = 'only-node';
    } else {
      const named = this._namedTaskNode('run_task', a.node, grant, origin.scopes);
      if (named.refused) return named.refused;
      ({ node } = named);
      if (!this._online(node.node_id)) return offline(a.node);
    }
    return this._sendTask('run_task', node, { origin, max_bytes: this.maxBytes, task: a.task, placement: { by }, ...copied(a, ['wait_ms']) });
  }

  // One forward, never repeated (see NOT_SENT_CODES). `taskId`: the node's id
  // of the task the client named; run_task takes it from the reply. The node
  // holds the reply for wait_ms, so the forward gets the router's whole timeout
  // on top of that: a full hold never reads as an unanswered call.
  async _sendTask(name, node, params, taskId = null) {
    const machine = node.node_name;
    const timeoutMs = this.timeoutMs + (params.wait_ms || 0);
    let reply;
    try {
      reply = await this._forward(node.node_id, METHODS[name], params, { timeoutMs });
    } catch (err) {
      return this._taskForwardError(err, name, machine, timeoutMs);
    }
    if (!isPlainObject(reply)) return badTaskAnswer(name, machine);
    const publicId = taskId === null ? null : publicJobId(machine, taskId);
    if (reply.ok === false) {
      if (publicId !== null && isPlainObject(reply.error) && reply.error.code === 'task_not_found') return taskNotFound(publicId);
      return this._nodeRefusal(reply, taskId, publicId, machine);
    }
    const id = taskId === null ? reply.task_id : taskId;
    if (typeof id !== 'string' || !NODE_JOB_ID_RE.test(id)) return badTaskAnswer(name, machine);
    return taskView(machine, { ...reply, task_id: id });
  }

  _taskForwardError(err, name, machine, timeoutMs) {
    const code = err ? err.code : null;
    // A node from before tasks, which is not a reason to look for one.
    if (code === 'unknown_method') return refusal('capability_unavailable', `capability_unavailable: ${machine} does not run tasks yet; upgrade it`);
    const unanswered = TASK_UNANSWERED[name];
    if (unanswered && code !== 'frontdoor_busy' && !NOT_SENT_CODES.has(code)) {
      log.warn(`${name} on ${machine} went unanswered`, { code });
      return refusal('task_unconfirmed', `task_unconfirmed: ${machine} did not answer; ${unanswered}`);
    }
    if (code === 'timeout') return refusal('node_timeout', `node_timeout: ${machine} did not answer within ${Math.round(timeoutMs / 1000)} s; call ${name} again`);
    return this._forwardError(err, machine, null);
  }

  // Every reachable agent node at once, or the one named. A node that does not
  // answer with a list is named in `unreachable`, so a short list never reads
  // as all there is. Each node gets the whole page: what it had to leave out
  // comes back in its left_out.
  async _listTasks(a, grant, origin) {
    let targets;
    if (a.node === undefined || a.node === null) {
      targets = this.registry.list().filter((r) => r.profile === 'agent' && !this._taskRefusal(grant, origin.scopes, 'list_tasks', r, true));
    } else {
      const named = this._namedTaskNode('list_tasks', a.node, grant, origin.scopes);
      if (named.refused) return named.refused;
      targets = [named.node];
    }
    const params = { origin, max_bytes: this.maxBytes, ...copied(a, ['state']) };
    const answers = await Promise.all(targets.map(async (r) => {
      if (!this._online(r.node_id)) return null;
      try {
        const reply = await this._forward(r.node_id, METHODS.list_tasks, params);
        return isPlainObject(reply) && Array.isArray(reply.tasks) ? reply : null;
      } catch (err) {
        log.debug(`list_tasks on ${r.node_name} failed: ${err.message}`);
        return null;
      }
    }));
    const replies = answers.filter(Boolean);
    const unreachable = targets.filter((_, i) => !answers[i]).map((r) => r.node_name).sort();
    const rows = targets.flatMap((r, i) => (answers[i] ? answers[i].tasks : [])
      .filter((row) => isPlainObject(row) && typeof row.task_id === 'string' && NODE_JOB_ID_RE.test(row.task_id))
      .map((row) => ({ ...taskView(r.node_name, row), machine: r.node_name })));
    rows.sort((x, y) => (createdAtMs(y) - createdAtMs(x)) || (x.task_id < y.task_id ? -1 : 1));
    const leftOut = mergedLeftOut(replies, Math.max(0, rows.length - TASK_LIST_MAX));
    return { tasks: rows.slice(0, TASK_LIST_MAX), unreachable, ...(leftOut ? { left_out: leftOut } : {}) };
  }

  // As the node last reported them: a change shows at its next connect.
  _capabilities(record) {
    const hello = (this.registry.presence(record.node_id) || {}).hello || {};
    return Array.isArray(hello.capabilities) ? hello.capabilities : ((this.cache.node(record.node_id) || {}).capabilities || []);
  }

  _listMachines(grant, scopes) {
    return this.registry.list()
      .filter((r) => machineVisible(scopes, r.node_name) && machineMatches(grant, REQUIRED_SCOPE.list_machines, r.node_name, r.node_id))
      .map((r) => {
        const p = this.registry.presence(r.node_id) || {};
        const cached = this.cache.node(r.node_id) || {};
        const gui = cached.catalog && cached.catalog.gui ? cached.catalog.gui : null;
        return {
          name: r.node_name,
          profile: r.profile,
          capabilities: this._capabilities(r),
          online: Boolean(p.online),
          last_seen: p.last_seen || cached.last_seen || null,
          summary: `Node ${r.node_name} (${r.profile})`,
          ...(gui ? { gui } : {})
        };
      })
      .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  }

  // Whether a get_state row may be shown to `grant`: a delegate row only
  // when the cache knows the job as that grant's.
  _rowVisible(row, grant, nodeId) {
    if (!isPlainObject(row)) return false;
    if (row.kind === undefined || row.kind === 'runbook') return true;
    return visibleTo(this.cache.lookup(row.job_id, nodeId), grant.grant_id);
  }

  _stale(name, node, machine, publicId, grant) {
    const cached = this.cache.node(node.node_id) || {};
    const nothing = refusal('machine_offline', `machine_offline: ${machine} is offline and nothing is cached for it`);
    if (name === 'describe_machine') return cached.catalog ? { ...cached.catalog, stale: true, cached_at: cached.catalog_at } : nothing;
    if (name === 'get_state') {
      if (!cached.state) return nothing;
      // The cached state came from whichever grant asked last.
      const rows = Array.isArray(cached.state.running_jobs) ? cached.state.running_jobs.filter((row) => this._rowVisible(row, grant, node.node_id)) : [];
      return { ...cached.state, running_jobs: rows, stale: true, cached_at: cached.state_at };
    }
    const job = this.cache.lookup(publicId, node.node_id, { touch: true });
    if (!visibleTo(job, grant.grant_id)) return jobNotFound(publicId);
    const view = job.view || { job_id: publicId, machine, status: job.status };
    return {
      ...view,
      job_id: publicId,
      status: job.status,
      ...(job.session ? { session: job.session } : {}),
      ...(job.error ? { error: job.error } : {}),
      stale: true,
      cached_at: job.cached_at
    };
  }

  // Records a job the node just started for `grant`. A cache entry left
  // under the same id with another kind, owner or node (a node that reused
  // an id, or another key under the name) is replaced: the node's answer
  // names this grant. A job_update that beat this reply is applied now.
  _recordStart(node, nodeJobId, kind, grant, reply) {
    const machine = node.node_name;
    const id = publicJobId(machine, nodeJobId);
    const owner = kind === 'delegate' ? grant.grant_id : null;
    const existing = this.cache.jobs.get(id);
    if (existing && (existing.kind !== kind || existing.owner !== owner || existing.node_id !== node.node_id)) this.cache.jobs.delete(id);
    this.cache.put(machine, nodeJobId, { node_id: node.node_id, kind, owner, status: shortText(reply.status, 64), session: shortText(reply.session, 32) });
    const early = this._takeEarlyUpdate(node.node_id, nodeJobId);
    if (early) this._applyUpdate(node, nodeJobId, early);
  }

  _sweepEarly() {
    const t = this.now();
    for (const [k, v] of this.earlyUpdates) if (t - v.at > EARLY_UPDATE_MS) this.earlyUpdates.delete(k);
  }

  // Holds an update for a job not recorded yet, bounded in time and size
  // (the oldest goes first); a newer update for the job merges over it.
  // Nothing here ever creates a cache entry.
  _holdEarlyUpdate(nodeId, nodeJobId, update) {
    this._sweepEarly();
    const key = JSON.stringify([nodeId, nodeJobId]);
    const prev = this.earlyUpdates.get(key);
    this.earlyUpdates.delete(key);
    while (this.earlyUpdates.size >= EARLY_UPDATE_MAX) this.earlyUpdates.delete(this.earlyUpdates.keys().next().value);
    this.earlyUpdates.set(key, { at: this.now(), update: { ...(prev ? prev.update : {}), ...update } });
  }

  _takeEarlyUpdate(nodeId, nodeJobId) {
    this._sweepEarly();
    const key = JSON.stringify([nodeId, nodeJobId]);
    const held = this.earlyUpdates.get(key);
    this.earlyUpdates.delete(key);
    return held ? held.update : null;
  }

  // Applies a cleaned update to the entry `node` ran, if the cache has one.
  // → entry | null
  _applyUpdate(node, nodeJobId, update) {
    const entry = this.cache.lookup(publicJobId(node.node_name, nodeJobId), node.node_id);
    if (!entry) return null;
    const { session, ...patch } = update;
    if (entry.kind === 'delegate' && session !== undefined) patch.session = session;
    return this.cache.patch(node.node_name, nodeJobId, node.node_id, patch);
  }

  _rewrite(name, node, machine, nodeJobId, grant, reply) {
    const at = new Date(this.now()).toISOString();
    if (name === 'describe_machine') {
      this.cache.setNode(node.node_id, { catalog: reply, catalog_at: at });
      return reply;
    }
    if (name === 'get_state') {
      const rows = Array.isArray(reply.running_jobs) ? reply.running_jobs : [];
      const state = {
        ...reply,
        running_jobs: rows.filter((j) => isPlainObject(j) && typeof j.job_id === 'string' && NODE_JOB_ID_RE.test(j.job_id))
          .map((j) => ({ ...j, job_id: publicJobId(machine, j.job_id) }))
      };
      this.cache.setNode(node.node_id, { state, state_at: at });
      return state;
    }
    if (name === 'run_runbook' || name === 'delegate') {
      if (typeof reply.job_id !== 'string' || !NODE_JOB_ID_RE.test(reply.job_id)) return refusal('bad_node_answer', `bad_node_answer: ${machine} started a job without a usable id`);
      this._recordStart(node, reply.job_id, name === 'delegate' ? 'delegate' : 'runbook', grant, reply);
      return wrapUntrusted({ ...reply, job_id: publicJobId(machine, reply.job_id) });
    }
    // Job tools: the id is always the one the client named.
    const publicId = publicJobId(machine, nodeJobId);
    if (name === 'get_job') {
      const wrapped = wrapUntrusted({ ...reply, job_id: publicId, logs_truncated: Boolean(reply.logs_truncated) });
      const { output, ...view } = wrapped;
      const patch = { status: shortText(reply.status, 64), session: shortText(reply.session, 32), updated_at: shortText(reply.updated_at, 64), view };
      const existing = this.cache.lookup(publicId, node.node_id);
      if (!existing) {
        // The node answered this grant, so a delegate job is this grant's.
        // An entry another key left under the name is replaced.
        const kind = reply.kind === 'delegate' ? 'delegate' : 'runbook';
        this.cache.jobs.delete(publicId);
        this.cache.put(machine, nodeJobId, { ...patch, node_id: node.node_id, kind, owner: kind === 'delegate' ? grant.grant_id : null });
      } else if (visibleTo(existing, grant.grant_id)) {
        this.cache.put(machine, nodeJobId, patch);
      }
      return wrapped;
    }
    if (name !== 'get_job_logs' && typeof reply.status === 'string') {
      const existing = this.cache.lookup(publicId, node.node_id);
      if (visibleTo(existing, grant.grant_id)) this.cache.patch(machine, nodeJobId, node.node_id, { status: shortText(reply.status, 64), ...(typeof reply.session === 'string' ? { session: shortText(reply.session, 32) } : {}) });
    }
    return wrapUntrusted({ ...reply, job_id: publicId });
  }

  async _callExtra(name, tool, args, grant, origin) {
    const check = allows(origin.scopes, name, { required: tool.scope });
    if (!check.ok) return scopeRefusal(check);
    let target;
    try {
      target = tool.route(args, { origin }) || {};
    } catch (err) {
      log.debug(`route for ${name} failed: ${err.message}`);
      return refusal('invalid_params', `invalid_params: ${name} could not be routed`);
    }
    // The router's fields go last: a client argument named origin or
    // max_bytes never replaces them.
    const params = { ...args, origin, max_bytes: this.maxBytes };
    if (target.fanout) {
      // Only a tool registered as fan-out (never a write tool) fans out.
      if (!tool.fanout) {
        log.warn(`route for ${name} fanned out, but the tool is not registered as fan-out`);
        return refusal('invalid_params', `invalid_params: ${name} names one machine`);
      }
      const rows = [];
      const unreachable = [];
      const nodes = this.registry.list().filter((r) => r.profile === 'agent' && this._reaches(grant, origin.scopes, name, tool.scope, r, { required: tool.scope }));
      for (const r of nodes) {
        if (!this._online(r.node_id)) {
          unreachable.push(r.node_name);
          continue;
        }
        try {
          const result = await this._forward(r.node_id, `cases.${name}`, params);
          if (Array.isArray(result)) for (const row of result) rows.push({ ...row, machine: r.node_name });
          else unreachable.push(r.node_name);
        } catch (err) {
          log.debug(`cases.${name} on ${r.node_name} failed: ${err.message}`);
          unreachable.push(r.node_name);
        }
      }
      return { rows, unreachable };
    }
    const machine = target.machine;
    const node = typeof machine === 'string' ? this.registry.byName(machine) : null;
    if (!this._reaches(grant, origin.scopes, name, tool.scope, node, { required: tool.scope })) return unknownMachine(machine);
    if (!this._online(node.node_id)) return offline(machine);
    const slot = tool.perGrantLimit ? this._takeGrantSlot(grant.grant_id) : null;
    if (slot && slot.refused) return slot.refused;
    try {
      return await this._forward(node.node_id, `cases.${name}`, params);
    } catch (err) {
      // Refused by the router's own in-flight bound: nothing reached the node.
      if (slot && err && err.code === 'frontdoor_busy') slot.release();
      return this._forwardError(err, machine, null);
    }
  }

  async _onHello(params, { nodeId }) {
    if (!isPlainObject(params) || params.node_id !== nodeId) throw new LinkRpcError('wrong_node', 'fleet.hello names another node');
    const node = this.registry.byId(nodeId);
    if (!node) throw new LinkRpcError('unknown_node', 'this node is not registered');
    const hello = cleanHello(params);
    const prev = this.cache.node(nodeId) || {};
    const { bootChanged } = this.registry.markOnline(nodeId, hello);
    if (bootChanged || (prev.boot_id && hello.boot_id && prev.boot_id !== hello.boot_id)) {
      const failed = this.cache.failNonTerminal(node.node_name, 'node_restarted', (e) => e.node_id === nodeId);
      if (failed.length) log.info(`${node.node_name} restarted: ${failed.length} cached job(s) marked node_restarted`);
    }
    // Jobs another key ran under this name (a re-enrolled node) can never
    // finish: they fail as restarted, and this key can neither read nor patch them.
    const orphaned = this.cache.failNonTerminal(node.node_name, 'node_restarted', (e) => e.node_id !== nodeId);
    if (orphaned.length) log.info(`${node.node_name} has a new key: ${orphaned.length} cached job(s) of the old one marked node_restarted`);
    this.cache.setNode(nodeId, { boot_id: hello.boot_id, last_seen: new Date(this.now()).toISOString(), capabilities: hello.capabilities });
    if (!prev.catalog || prev.catalog_digest !== hello.catalog_digest) this._refreshCatalog(nodeId, hello.catalog_digest);
    this.emit('hello', { nodeId, hello });
    return { ok: true };
  }

  // A job_update names no grant, so it only ever updates an entry the router
  // already holds for this node (from a reply to a grant); it never creates
  // one. An update for a job not recorded yet is held for _recordStart.
  _onJobUpdate(params, { nodeId }) {
    const node = this.registry.byId(nodeId);
    if (!node || !isPlainObject(params) || typeof params.job_id !== 'string' || !NODE_JOB_ID_RE.test(params.job_id)) return;
    const update = {};
    if (shortText(params.status, 64)) update.status = params.status;
    if (shortText(params.session, 32)) update.session = params.session;
    if (shortText(params.updated_at, 64)) update.updated_at = params.updated_at;
    if (Number.isInteger(params.log_lines) && params.log_lines >= 0) update.log_lines = params.log_lines;
    if (!this._applyUpdate(node, params.job_id, update)) this._holdEarlyUpdate(nodeId, params.job_id, update);
  }

  _onCatalogChanged(params, { nodeId }) {
    if (this.registry.byId(nodeId)) this._refreshCatalog(nodeId, isPlainObject(params) ? shortText(params.catalog_digest, 128) : null);
  }

  // One refresh per node at a time; a change announced during one runs
  // another when it ends, so the cache never keeps the older catalog.
  _refreshCatalog(nodeId, digest) {
    if (this.refreshing.has(nodeId)) {
      this.refreshAgain.set(nodeId, digest);
      return;
    }
    let done;
    this.refreshing.set(nodeId, new Promise((resolve) => { done = resolve; }));
    (async () => {
      try {
        const reply = await this.nodeHub.rpc(nodeId, 'fleet.describe', { origin: ROUTER_ORIGIN, max_bytes: this.maxBytes }, { timeoutMs: this.timeoutMs });
        if (isPlainObject(reply) && reply.ok !== false && Array.isArray(reply.runbooks)) {
          this.cache.setNode(nodeId, { catalog: reply, catalog_at: new Date(this.now()).toISOString(), catalog_digest: digest || null });
        } else {
          log.debug(`catalog refresh for ${nodeId} got no catalog`);
        }
      } catch (err) {
        log.debug(`catalog refresh for ${nodeId} failed: ${err.message}`);
      } finally {
        this.refreshing.delete(nodeId);
        done();
        if (this.refreshAgain.has(nodeId)) {
          const next = this.refreshAgain.get(nodeId);
          this.refreshAgain.delete(nodeId);
          this._refreshCatalog(nodeId, next);
        }
      }
    })();
  }
}

module.exports = { FleetRouter, ROUTER_ORIGIN, wrapUntrusted };

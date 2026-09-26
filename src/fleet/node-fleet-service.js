// The node's side of the front-door link (fleet stage 4 §3.7, §4.7): the
// fleet.* methods the front door calls through F3's NodeHub, registered on
// the node's RelayClient (E5). Every call re-checks the scopes the front door
// sent against this node's own catalog; that bounds router bugs, not a
// compromised front door, whose scopes these are (§8). The binding limits
// stay node policy and the phone signature.
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const { allows, SCOPE_NAME_RE } = require('./scope-rules');
const { ToolError, untrustedOutput } = require('./fleet-tools');

const log = createLogger('fleet/node-service');

const MAX_BYTES_DEFAULT = 524288;
const MAX_BYTES_MIN = 4096;
const GET_JOB_LOG_TAIL_BYTES = 65536;
const RESERVE_BYTES = 1024; // the reply's own keys and punctuation
const LOG_FLOOR_BYTES = 1024; // get_job always has room for some log tail
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FLEET_METHODS = Object.freeze({
  'fleet.describe': 'describe_machine',
  'fleet.get_state': 'get_state',
  'fleet.run_runbook': 'run_runbook',
  'fleet.delegate': 'delegate',
  'fleet.send_to_job': 'send_to_job',
  'fleet.get_job': 'get_job',
  'fleet.get_job_logs': 'get_job_logs',
  'fleet.cancel_job': 'cancel_job'
});

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// A line bigger than the page is cut (with the marker saying how big it
// was), so paging always advances.
function cutLine(line, maxBytes) {
  const text = String(line);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (jsonBytes(text) <= maxBytes) return text;
  const marker = ` [line truncated: ${bytes} bytes]`;
  let keep = Math.max(0, maxBytes - Buffer.byteLength(marker) - 16);
  let head = Buffer.from(text, 'utf8').subarray(0, keep).toString('utf8').replace(/�+$/, '');
  // JSON escaping can grow the head; shrink until the quoted line fits.
  while (head.length > 0 && jsonBytes(`${head}…${marker}`) > maxBytes) {
    keep = Math.floor(keep * 0.9);
    head = head.slice(0, keep);
  }
  return `${head}…${marker}`;
}

function pageLines(all, { since = 0, tail = null, maxBytes = MAX_BYTES_DEFAULT } = {}) {
  let start = Math.min(Math.max(0, since), all.length);
  let window = all.slice(start);
  if (tail !== null && tail !== undefined) {
    const skip = Math.max(0, window.length - tail);
    start += skip;
    window = window.slice(skip);
  }
  const budget = Math.max(MAX_BYTES_MIN, maxBytes) - RESERVE_BYTES;
  const out = [];
  let used = 2;
  for (const raw of window) {
    const line = cutLine(raw, budget - 2);
    const size = jsonBytes(line) + 1;
    if (out.length > 0 && used + size > budget) break;
    out.push(line);
    used += size;
  }
  const next = start + out.length;
  return { lines: out, next_since: next, more: next < all.length };
}

function tailWithin(lines, maxBytes) {
  const out = [];
  let used = 2;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = cutLine(lines[i], maxBytes - 2);
    const size = jsonBytes(line) + 1;
    if (out.length > 0 && used + size > maxBytes) break;
    out.unshift(line);
    used += size;
  }
  return { logs: out, truncated: out.length < lines.length };
}

const refusal = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

// A ToolError is meant for the client: its code, message, retry_after and
// required go back. Anything else is this node's own failure, whose message
// can name paths and internals; it is logged here and answered as
// `internal` with no detail.
function errorReply(method, err) {
  if (err instanceof ToolError) {
    const data = err.data && typeof err.data === 'object' ? err.data : {};
    const extra = {};
    if (data.retry_after !== undefined) extra.retry_after = data.retry_after;
    if (data.required !== undefined) extra.required = data.required;
    return refusal(err.code, err.message, extra);
  }
  log.warn(`${method} failed`, { error: err && err.message ? err.message : String(err), code: (err && err.code) || null });
  return refusal('internal', 'internal error');
}

// Every link call must say which front-door client and grant it acts for.
// The handler's own default is the local stdio caller, so a call that
// arrived without a usable origin would act as this node's owner; it is
// refused instead.
function validOrigin(origin) {
  return Boolean(origin) && typeof origin === 'object' && !Array.isArray(origin)
    && origin.kind === 'frontdoor'
    && Array.isArray(origin.scopes)
    && typeof origin.grant_id === 'string' && origin.grant_id.length > 0;
}

class NodeFleetService {
  constructor({ handler, relayClient = null, nodeConfig, bootId = crypto.randomBytes(16).toString('hex'), version = null, now = Date.now, dedupeMs = 600000 } = {}) {
    this.handler = handler;
    this.relayClient = relayClient;
    this.nodeConfig = nodeConfig;
    this.bootId = bootId;
    this.version = version || require('../../package.json').version;
    this.now = now;
    this.dedupeMs = dedupeMs;
    this.dedupe = new Map();
    this.extra = new Map();
    this.started = false;
    this.stopped = false;
    this._onUpdate = (job) => {
      // Runs inside JobManager.updateJob's emit: it must never throw there.
      try {
        this._jobUpdate(job);
      } catch (err) {
        log.warn(`fleet.job_update failed: ${err.message}`);
      }
    };
    this._onConnected = () => { this.hello().catch((err) => log.warn(`fleet.hello failed: ${err.message}`)); };
  }

  start() {
    if (this.started) return this;
    this.started = true;
    if (this.relayClient) {
      for (const method of Object.keys(FLEET_METHODS)) this.relayClient.registerMethod(method, (params) => this.dispatch(method, params));
      for (const name of this.extra.keys()) this.relayClient.registerMethod(name, (params) => this.dispatch(name, params));
      this.relayClient.on('connected', this._onConnected);
    }
    this.handler.jobManager.on('update', this._onUpdate);
    return this;
  }

  // RelayClient cannot unregister a method, so a stopped service keeps
  // answering its link methods; every answer is a refusal (ruling T12-stop).
  stop() {
    this.stopped = true;
    this.started = false;
    this.handler.jobManager.removeListener('update', this._onUpdate);
    if (this.relayClient && typeof this.relayClient.off === 'function') this.relayClient.off('connected', this._onConnected);
  }

  catalog() {
    const engine = this.handler.runbookEngine;
    const runbooks = engine ? [...engine.runbooks.values()].map((r) => ({ name: r.name, description: r.description || '', tier: r.tier, params: r.params || {} })) : [];
    return runbooks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  catalogDigest() {
    return sha256b64url(canonicalize(this.catalog()));
  }

  async hello() {
    if (!this.relayClient) return null;
    return this.relayClient.call('fleet.hello', {
      node_id: this.nodeConfig.nodeId || null,
      name: this.nodeConfig.name,
      profile: this.nodeConfig.profile,
      capabilities: this.nodeConfig.capabilities || [],
      catalog_digest: this.catalogDigest(),
      boot_id: this.bootId,
      version: this.version
    });
  }

  catalogChanged() {
    if (this.relayClient) this.relayClient.notify('fleet.catalog_changed', { catalog_digest: this.catalogDigest() });
  }

  // A delegate session belongs to whoever started it (ruling T11-owner): the
  // front door hears only about sessions a front-door grant started, never
  // this node's own stdio sessions. At creation the owner is not recorded
  // yet, so that first update is skipped; the turn's update follows at once.
  _reportable(job) {
    if (job.kind !== 'delegate') return true;
    const sessions = this.handler.delegateSessions;
    return Boolean(sessions && typeof sessions.startedByFrontDoor === 'function' && sessions.startedByFrontDoor(job.job_id) === true);
  }

  _jobUpdate(job) {
    if (!this.relayClient || !this._reportable(job)) return;
    this.relayClient.notify('fleet.job_update', {
      job_id: job.job_id,
      status: job.status,
      ...(job.kind === 'delegate' ? { session: job.session } : {}),
      updated_at: job.updated_at,
      log_lines: Array.isArray(job.logs) ? job.logs.length : 0
    });
  }

  // C7 (program §4.19): cases.<tool> link methods, each behind its scope.
  registerMethod(name, fn, { scope = null } = {}) {
    if (typeof name !== 'string' || !name.startsWith('cases.') || name.length === 'cases.'.length) {
      throw new TypeError('NodeFleetService.registerMethod takes cases.<tool> names only');
    }
    if (typeof scope !== 'string' || !SCOPE_NAME_RE.test(scope)) throw new TypeError(`${name}: a scope such as cases:read is required`);
    if (this.extra.has(name)) throw new Error(`${name} is already registered`);
    if (typeof fn !== 'function') throw new TypeError(`${name}: handler must be a function`);
    this.extra.set(name, { fn, scope });
    if (this.started && this.relayClient) this.relayClient.registerMethod(name, (params) => this.dispatch(name, params));
  }

  // One client's request_id is its own: the key names the grant and client
  // it came from, so another client reusing the id gets its own job.
  _dedupeKey(method, origin, requestId) {
    return JSON.stringify([method, origin.grant_id, typeof origin.client_id === 'string' ? origin.client_id : null, requestId]);
  }

  _dedupeLookup(key) {
    const t = this.now();
    for (const [k, v] of this.dedupe) if (t - v.at > this.dedupeMs) this.dedupe.delete(k);
    return this.dedupe.get(key) || null;
  }

  // Never throws: every failure is a coded refusal (errorReply).
  async dispatch(method, params = {}) {
    if (this.stopped) return refusal('unavailable', 'unavailable: this node is stopping');
    const origin = params && typeof params === 'object' ? params.origin : undefined;
    if (!validOrigin(origin)) {
      return refusal('invalid_params', 'invalid_params: fleet calls carry a front-door origin with a grant and scopes');
    }
    const maxBytes = Number.isInteger(params.max_bytes) ? Math.min(Math.max(params.max_bytes, MAX_BYTES_MIN), MAX_BYTES_DEFAULT) : MAX_BYTES_DEFAULT;
    const machine = this.nodeConfig.name;

    if (this.extra.has(method)) {
      const { fn, scope } = this.extra.get(method);
      const ok = allows(origin.scopes, method, { machine, required: scope });
      if (!ok.ok) return this._scopeRefusal(ok);
      return this._bounded(method, maxBytes, () => fn(params, { origin, maxBytes }));
    }

    const tool = Object.hasOwn(FLEET_METHODS, method) ? FLEET_METHODS[method] : null;
    if (!tool) return refusal('unknown_method', `no fleet method ${method}`);
    let tier = null;
    if (tool === 'run_runbook') {
      try {
        const rb = this.handler.runbookEngine && this.handler.runbookEngine.getRunbook(params.runbook);
        tier = rb ? rb.tier : null;
      } catch (err) {
        return errorReply(method, err);
      }
    }
    const check = allows(origin.scopes, tool, { machine, tier });
    if (!check.ok) return this._scopeRefusal(check);

    const run = () => this._bounded(method, maxBytes, () => this._invoke(tool, params, origin, maxBytes));
    if (tool !== 'run_runbook' && tool !== 'delegate') return run();

    if (typeof params.request_id !== 'string' || !UUID_V4_RE.test(params.request_id)) {
      return refusal('invalid_params', 'invalid_params: request_id must be a UUIDv4');
    }
    // The pending reply is remembered at once, so a retry that lands while
    // the first call is still running gets the same job. A refusal is
    // forgotten, so the retry can succeed once the reason has gone.
    const key = this._dedupeKey(method, origin, params.request_id);
    const seen = this._dedupeLookup(key);
    if (seen) return seen.reply;
    const reply = run();
    const entry = { reply, at: this.now() };
    this.dedupe.set(key, entry);
    const result = await reply;
    if (result && result.ok === false && this.dedupe.get(key) === entry) this.dedupe.delete(key);
    return result;
  }

  _scopeRefusal(check) {
    const message = check.code === 'unknown_machine'
      ? 'unknown_machine: this client may not use this machine'
      : `${check.code}: this client lacks ${check.required}`;
    return refusal(check.code, message, { required: check.required });
  }

  async _bounded(method, maxBytes, work) {
    let result;
    try {
      result = await work();
    } catch (err) {
      return errorReply(method, err);
    }
    if (jsonBytes(result === undefined ? null : result) > maxBytes) return refusal('too_large', `the ${method} reply is over max_bytes (${maxBytes})`);
    return result;
  }

  // Every handler call carries the caller's origin: the handler's default is
  // the local stdio caller, whose delegate sessions a remote caller must
  // never see or touch.
  async _invoke(tool, params, origin, maxBytes) {
    const machine = this.nodeConfig.name;
    switch (tool) {
      case 'get_job': return this._jobView(params.job_id, origin, maxBytes);
      case 'get_job_logs': return this._jobLogs(params, origin, maxBytes);
      case 'describe_machine':
      case 'get_state': return this.handler.call(tool, { machine }, { origin });
      case 'run_runbook': return this.handler.call(tool, { machine, runbook: params.runbook, params: params.params || {} }, { origin });
      case 'delegate': return this.handler.call(tool, { machine, task: params.task, cwd: params.cwd === undefined ? null : params.cwd, request_id: params.request_id }, { origin });
      case 'send_to_job': return this.handler.call(tool, { job_id: params.job_id, message: params.message }, { origin });
      case 'cancel_job': return this.handler.call(tool, { job_id: params.job_id }, { origin });
      default: throw new Error(`no fleet tool ${tool}`);
    }
  }

  // The stdio get_job shape with raw logs (the front door wraps them,
  // Deviation 6). A delegate job's result is the agent's reply and stays
  // wrapped as untrusted, as in FleetToolHandler (ruling T9-wrap). A reply
  // too big for the page is cut like a log line, so get_job never refuses a
  // job for good because its reply is large.
  _jobView(jobId, origin, maxBytes) {
    const job = this.handler.getJobOrThrow(jobId, origin);
    const { logs, ...rest } = job;
    if (job.kind === 'delegate' && typeof rest.result === 'string') {
      const others = jsonBytes({ ...rest, result: untrustedOutput(['']), evidence: job.evidence || null });
      const room = Math.max(256, maxBytes - RESERVE_BYTES - LOG_FLOOR_BYTES - others);
      rest.result = untrustedOutput([cutLine(rest.result, room)]);
    }
    const budget = Math.min(GET_JOB_LOG_TAIL_BYTES, maxBytes - RESERVE_BYTES - jsonBytes({ ...rest, evidence: job.evidence || null }));
    const tail = tailWithin(Array.isArray(logs) ? logs : [], Math.max(LOG_FLOOR_BYTES, budget));
    return { ...rest, logs: tail.logs, logs_truncated: tail.truncated, evidence: job.evidence || null };
  }

  _jobLogs({ job_id: jobId, since = 0, tail = null }, origin, maxBytes) {
    const job = this.handler.getJobOrThrow(jobId, origin);
    if (!Number.isInteger(since) || since < 0) throw new ToolError('invalid_params', 'invalid_params: "since" must be a non-negative integer line offset');
    if (tail !== null && tail !== undefined && (!Number.isInteger(tail) || tail < 1)) throw new ToolError('invalid_params', 'invalid_params: "tail" must be a positive integer');
    const all = Array.isArray(job.logs) ? job.logs : [];
    const page = pageLines(all, { since, tail, maxBytes: maxBytes - 256 });
    return { job_id: job.job_id, status: job.status, total_lines: all.length, ...page };
  }
}

module.exports = { NodeFleetService, FLEET_METHODS, MAX_BYTES_DEFAULT, GET_JOB_LOG_TAIL_BYTES, pageLines, cutLine };

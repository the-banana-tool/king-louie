// The front door's view of jobs and nodes (fleet stage 4 §3.6): an LRU of
// jobs fed by get_job replies and fleet.job_update, plus each node's catalog,
// last get_state, last_seen and boot_id. Persisted to node-status.json every
// 60 s and at shutdown, so an offline node's last state survives a restart.
//
// Each entry records its `kind` and, for a delegate job, the grant that
// started it (`owner`). A delegate job belongs to that grant alone (ruling
// T11-owner): `visibleTo` is the one check every cached read and watch goes
// through. An entry is only ever created from a reply the node gave the
// router for a grant, never from a fleet.job_update, which names no grant.
//
// Entries are keyed by machine name (public ids are stateless), and each also
// records the node_id that ran the job. Reads through `lookup` and writes
// through `patch` require that node_id: a different key re-enrolled under the
// same name finds nothing of the old node's and can change none of it.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { writeFileAtomic } = require('../../approvals/approver-store');

const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled', 'denied', 'expired']);
const KINDS = Object.freeze(['runbook', 'delegate']);
// A node job id as a client may name it: the JobManager's `job-<ms>-<rand>`
// and anything like it, never a path or a separator.
const NODE_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Public job ids are <machine>:<nodeJobId>: stateless, so they survive a
// front-door restart. Machine names never contain ':'.
function publicJobId(machine, nodeJobId) {
  return `${machine}:${nodeJobId}`;
}

function parsePublicJobId(id) {
  if (typeof id !== 'string' || id.length > 256) return null;
  const i = id.indexOf(':');
  if (i < 1 || i === id.length - 1) return null;
  const nodeJobId = id.slice(i + 1);
  if (!NODE_JOB_ID_RE.test(nodeJobId)) return null;
  return { machine: id.slice(0, i), nodeJobId };
}

// Whether `grantId` may see `entry`: a runbook job is visible to every grant
// that may read its machine (as on the node); a delegate job only to the
// grant recorded as its owner; anything else to no one.
function visibleTo(entry, grantId) {
  if (!entry || typeof grantId !== 'string' || !grantId) return false;
  if (entry.kind === 'runbook') return true;
  return entry.kind === 'delegate' && typeof entry.owner === 'string' && entry.owner === grantId;
}

// A persisted entry is kept only when it is whole: its id is the public id
// of its machine and node job id, and its kind (and a delegate's owner) is
// one this module writes. A kind of null is kept but visible to no one.
function wellFormed(j) {
  if (!isPlainObject(j) || typeof j.id !== 'string') return false;
  const parsed = parsePublicJobId(j.id);
  if (!parsed || parsed.machine !== j.machine || parsed.nodeJobId !== j.node_job_id) return false;
  if (j.kind !== null && !KINDS.includes(j.kind)) return false;
  return j.kind !== 'delegate' || (typeof j.owner === 'string' && j.owner.length > 0);
}

class JobCache extends EventEmitter {
  constructor({ file, max = 2000, now = Date.now } = {}) {
    super();
    this.file = file;
    this.max = max;
    this.now = now;
    this.jobs = new Map();
    this.nodes = new Map();
  }

  load() {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      data = null; // nothing cached yet
    }
    if (data && data.v === 1) {
      for (const j of Array.isArray(data.jobs) ? data.jobs : []) if (wellFormed(j)) this.jobs.set(j.id, { ...j });
      for (const [id, n] of Object.entries(isPlainObject(data.nodes) ? data.nodes : {})) if (isPlainObject(n)) this.nodes.set(id, { ...n });
    }
    this._bound();
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, saved_at: new Date(this.now()).toISOString(), jobs: [...this.jobs.values()], nodes: Object.fromEntries(this.nodes) })}\n`);
  }

  _bound() {
    while (this.jobs.size > this.max) this.jobs.delete(this.jobs.keys().next().value);
  }

  _touch(id, entry) {
    this.jobs.delete(id);
    this.jobs.set(id, entry);
    this._bound();
  }

  get(id) {
    const entry = this.jobs.get(id);
    if (!entry) return null;
    this._touch(id, entry);
    return entry;
  }

  // Creates or updates an entry. `kind` and `owner` are set once, when the
  // entry is created: a later patch never moves a job to another grant.
  put(machine, nodeJobId, patch = {}) {
    const id = publicJobId(machine, nodeJobId);
    const existing = this.jobs.get(id);
    const prev = existing || { id, machine, node_job_id: nodeJobId, node_id: null, kind: null, owner: null, status: null, session: null, log_lines: 0, updated_at: null, view: null };
    const { kind, owner, node_id: nodeId, ...rest } = patch;
    const fixed = existing
      ? { kind: prev.kind, owner: prev.owner, node_id: prev.node_id }
      : { kind: kind === undefined ? null : kind, owner: owner === undefined ? null : owner, node_id: nodeId === undefined ? null : nodeId };
    const entry = { ...prev, ...rest, ...fixed, id, machine, node_job_id: nodeJobId, cached_at: new Date(this.now()).toISOString() };
    this._touch(id, entry);
    if (prev.status !== entry.status || prev.log_lines !== entry.log_lines || prev.session !== entry.session) this.emit('update', id, entry);
    return entry;
  }

  // The entry for `id` when node `nodeId` ran it, else null (a mismatch is
  // not found). `touch` counts it as used for the LRU.
  lookup(id, nodeId, { touch = false } = {}) {
    const entry = this.jobs.get(id);
    if (!entry || typeof nodeId !== 'string' || !nodeId || entry.node_id !== nodeId) return null;
    if (touch) this._touch(id, entry);
    return entry;
  }

  // Updates an entry node `nodeId` ran; never creates one. → entry | null
  patch(machine, nodeJobId, nodeId, patch = {}) {
    return this.lookup(publicJobId(machine, nodeJobId), nodeId) ? this.put(machine, nodeJobId, patch) : null;
  }

  // Fails the non-terminal entries of `machine` that `match(entry)` selects.
  failNonTerminal(machine, reason, match = () => true) {
    const failed = [];
    for (const e of [...this.jobs.values()]) {
      if (e.machine !== machine || TERMINAL_STATUSES.includes(e.status) || !match(e)) continue;
      failed.push(this.put(machine, e.node_job_id, { status: 'failed', error: reason, view: e.view ? { ...e.view, status: 'failed', error: reason } : null }));
    }
    return failed;
  }

  setNode(nodeId, patch) {
    const next = { ...(this.nodes.get(nodeId) || {}), ...patch };
    this.nodes.set(nodeId, next);
    return next;
  }

  node(nodeId) {
    return this.nodes.get(nodeId) || null;
  }
}

module.exports = { JobCache, TERMINAL_STATUSES, NODE_JOB_ID_RE, publicJobId, parsePublicJobId, visibleTo };

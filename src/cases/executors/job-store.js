// src/cases/executors/job-store.js
// .kl/jobs/<id>.json and the .kl/executors.json snapshot (cases stage 3
// spec §4, program §4.7).
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const { readJsonSafe, writeJsonAtomic } = require('./util');

const log = createLogger('executors/jobs');

const OPEN_STATES = Object.freeze(['submitting', 'submitted', 'running', 'waiting']);
const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled', 'unreachable']);
const JOB_ID = /^job-(\d{4,})$/;
const isOpen = (state) => OPEN_STATES.includes(state);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// A write the job lifecycle does not allow: an unknown state, or a move out
// of a terminal state (a late poll must not revive a cancelled job). Same
// rule as PlanStore.updateStep (Task 5); thrown rather than returned because
// callers use the returned job directly.
class JobStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobStateError';
    this.code = 'JOB_STATE';
  }
}

const JOB_DEFAULTS = Object.freeze({
  caseId: null, executor: null, kind: null, externalId: null, envelopeId: null, planStepId: null, retryOf: null,
  n: null, signature: null, payloadHash: null, idempotencyKey: null, intent: '', state: 'submitting', recipients: [],
  payload: null, originalPayload: null, facts: [], createdAt: null, submittedAt: null, lastPolledAt: null, nextPollAt: null,
  lastChange: null, pollErrors: 0, stale: false, error: null, resultsCursor: null, recordsSaved: [], estimateUsd: 0,
  chargedUsd: 0, costReported: false, wakeupId: null, contacts: [], reason: null, reservedContacts: 0, newContacts: 0,
  questionId: null, copied: false, window: null, maxCostUsd: null
});

class JobStore {
  constructor(caseDir) {
    this.dir = path.join(caseDir, '.kl', 'jobs');
  }

  _file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  ids() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => JOB_ID.test(id))
      .sort((a, b) => Number(JOB_ID.exec(a)[1]) - Number(JOB_ID.exec(b)[1]));
  }

  // One unreadable job file (a directory, no permission) is skipped, not fatal.
  list() {
    const out = [];
    for (const id of this.ids()) {
      try {
        const job = this.get(id);
        if (isObject(job)) out.push(job);
      } catch (err) {
        log.warn(`Skipping job ${id}: ${err.message}`);
      }
    }
    return out;
  }

  get(id) {
    if (!JOB_ID.test(String(id))) return null;
    return readJsonSafe(this._file(id), null);
  }

  nextId() {
    const max = this.ids().reduce((m, id) => Math.max(m, Number(JOB_ID.exec(id)[1])), 0);
    return `job-${String(max + 1).padStart(4, '0')}`;
  }

  create(fields = {}) {
    const id = this.nextId();
    const job = JSON.parse(JSON.stringify({ ...JOB_DEFAULTS, ...fields, id }));
    return this.write(job);
  }

  write(job) {
    const states = [...OPEN_STATES, ...TERMINAL_STATES];
    if (!states.includes(job.state)) throw new JobStateError(`${job.id}: unknown state "${job.state}"`);
    const current = this.get(job.id);
    if (isObject(current) && TERMINAL_STATES.includes(current.state) && job.state !== current.state) {
      throw new JobStateError(`${job.id} is ${current.state} and cannot move to ${job.state}`);
    }
    writeJsonAtomic(this._file(job.id), job);
    return job;
  }

  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) throw new Error(`Job ${id} was not found in this case.`);
    return this.write({ ...current, ...patch, id });
  }
}

function snapshotPath(caseDir) {
  return path.join(caseDir, '.kl', 'executors.json');
}

function readSnapshot(caseDir) {
  let s;
  try {
    s = readJsonSafe(snapshotPath(caseDir), {});
  } catch (err) {
    log.warn(`Reading ${snapshotPath(caseDir)} failed; using an empty snapshot: ${err.message}`);
    return {};
  }
  return isObject(s) ? s : {};
}

function writeSnapshot(caseDir, snapshot) {
  const before = readJsonSafe(snapshotPath(caseDir), null);
  if (before && JSON.stringify(before) === JSON.stringify(snapshot)) return false;
  writeJsonAtomic(snapshotPath(caseDir), snapshot);
  return true;
}

module.exports = { OPEN_STATES, TERMINAL_STATES, JOB_DEFAULTS, isOpen, JobStateError, JobStore, readSnapshot, writeSnapshot };

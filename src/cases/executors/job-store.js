// src/cases/executors/job-store.js
// .kl/jobs/<id>.json and the .kl/executors.json snapshot (cases stage 3
// spec §4, program §4.7).
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./util');

const OPEN_STATES = Object.freeze(['submitting', 'submitted', 'running', 'waiting']);
const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled', 'unreachable']);
const JOB_ID = /^job-(\d{4,})$/;
const isOpen = (state) => OPEN_STATES.includes(state);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

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

  list() {
    return this.ids().map((id) => this.get(id)).filter(Boolean);
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
  const s = readJsonSafe(snapshotPath(caseDir), {});
  return isObject(s) ? s : {};
}

function writeSnapshot(caseDir, snapshot) {
  const before = readJsonSafe(snapshotPath(caseDir), null);
  if (before && JSON.stringify(before) === JSON.stringify(snapshot)) return false;
  writeJsonAtomic(snapshotPath(caseDir), snapshot);
  return true;
}

module.exports = { OPEN_STATES, TERMINAL_STATES, JOB_DEFAULTS, isOpen, JobStore, readSnapshot, writeSnapshot };

'use strict';

// The task record (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.4): one
// JSON file per task, `<dataDir>/tasks/<task_id>.json`, written by the service through this
// one writer (after src/gui/take-store.js). A task found unfinished at start is marked
// `interrupted` (`markInterrupted`); `send_to_task` continues it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');

// `reason` is why a task is `waiting`; `card_sends` counts the grant cards sent for it.
const TASK_KEYS = Object.freeze(['task_id', 'chat_id', 'node', 'client', 'text', 'state', 'seq',
  'proposal', 'grant', 'placement', 'spend', 'answer', 'reason', 'deadline_at', 'card_sends',
  'ended', 'interrupted_at', 'created_at', 'updated_at']);
const TASK_STATES = Object.freeze(['requested', 'awaiting_grant', 'running', 'waiting', 'done',
  'failed', 'cancelled', 'interrupted']);
const UNFINISHED = Object.freeze(['requested', 'awaiting_grant', 'running']);
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Set by the store, never by a caller's record or patch.
const HOST_KEYS = new Set(['task_id', 'seq', 'created_at', 'updated_at']);

const DEFAULTS = Object.freeze({
  chat_id: null, node: null, client: null, text: '', state: 'requested', proposal: null,
  grant: null, placement: null, spend: null, answer: null, reason: null, deadline_at: null,
  card_sends: 0, ended: null, interrupted_at: null,
});

function checkFields(fields, what) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError(`a task ${what} must be an object`);
  }
  for (const key of Object.keys(fields)) {
    if (!TASK_KEYS.includes(key)) throw new TypeError(`unknown task key: ${key}`);
    if (HOST_KEYS.has(key)) throw new TypeError(`a task ${what} cannot set ${key}`);
  }
  if ('state' in fields && !TASK_STATES.includes(fields.state)) {
    throw new TypeError(`task state must be one of ${TASK_STATES.join(', ')}`);
  }
}

function pick(record) {
  const out = {};
  for (const key of TASK_KEYS) out[key] = record[key] === undefined ? null : record[key];
  return out;
}

class TaskStore {
  constructor({ dataDir, clock = Date.now, log = createLogger('tasks/store') } = {}) {
    if (!dataDir) throw new TypeError('TaskStore needs a dataDir');
    this.dir = path.join(dataDir, 'tasks');
    this.clock = clock;
    this.log = log;
  }

  _file(taskId) {
    return path.join(this.dir, `${taskId}.json`);
  }

  _now() {
    return new Date(this.clock()).toISOString();
  }

  _write(record) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this._file(record.task_id), `${JSON.stringify(record, null, 2)}\n`);
  }

  // Missing: null. Not a task record: null with one warning that names the id only, never
  // the file's contents.
  _read(taskId) {
    let text;
    try {
      text = fs.readFileSync(this._file(taskId), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      this.log.warn('skipping a task file that cannot be read', { taskId, code: err.code });
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log.warn('skipping a task file that is not JSON', { taskId });
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.task_id !== taskId) {
      this.log.warn('skipping a task file that is not a task record', { taskId });
      return null;
    }
    return pick(parsed);
  }

  create(fields = {}) {
    checkFields(fields, 'record');
    const at = this._now();
    const full = pick({ ...DEFAULTS, ...fields, task_id: crypto.randomUUID(), seq: 1, created_at: at, updated_at: at });
    this._write(full);
    return full;
  }

  get(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null;
    return this._read(taskId);
  }

  update(taskId, patch) {
    checkFields(patch, 'patch');
    const current = this.get(taskId);
    if (!current) throw new Error(`no task ${TASK_ID_RE.test(String(taskId)) ? taskId : '(invalid id)'}`);
    const next = pick({ ...current, ...patch, task_id: current.task_id, seq: current.seq + 1, created_at: current.created_at, updated_at: this._now() });
    this._write(next);
    return next;
  }

  // Newest first.
  list() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      this.log.warn('cannot read the tasks folder', { code: err.code });
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -'.json'.length);
      if (!TASK_ID_RE.test(taskId)) continue;
      const record = this._read(taskId);
      if (record) out.push(record);
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  // Start-up sweep: what the last run left unfinished is `interrupted`. The answer stays;
  // `ended` is null (the task can be continued). A record that cannot be written is warned
  // about by its id and the rest still run.
  markInterrupted() {
    const at = this._now();
    const ids = [];
    for (const record of this.list()) {
      if (!UNFINISHED.includes(record.state)) continue;
      try {
        this.update(record.task_id, { state: 'interrupted', ended: null, interrupted_at: at });
      } catch (err) {
        this.log.warn('a task left unfinished was not marked interrupted', { taskId: record.task_id, code: (err && err.code) || 'error' });
        continue;
      }
      ids.push(record.task_id);
    }
    return ids;
  }
}

module.exports = { TaskStore, TASK_KEYS, TASK_STATES, UNFINISHED, TASK_ID_RE };

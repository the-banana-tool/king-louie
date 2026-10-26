'use strict';

// The take record (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md
// §5.3): one JSON file per take, `<dataDir>/takes/<take_id>.json`, written by the service
// through this one writer. The driver never reads it; it gets `summary()` (§11) on its job.
// A take found unfinished at start is ended `service_restarted` (`markLiveEnded`).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');

// `recorder` is `{ pid, started_at }` of the take's ffmpeg, written when it starts, so a
// start after a crash can end an ffmpeg the last run left recording.
const TAKE_KEYS = Object.freeze(['take_id', 'name', 'job_id', 'origin', 'lease_id', 'grant', 'state',
  'steps', 'recording', 'recorder', 'log', 'ended', 'created_at']);
const TAKE_STATES = Object.freeze(['requested', 'live', 'waiting', 'ended']);
const UNFINISHED_STATES = Object.freeze(['requested', 'live', 'waiting']);
const TAKE_ID_RE = /^take-[0-9a-f]{12}$/;
// Set by the store, never by a caller's record or patch.
const HOST_KEYS = new Set(['take_id', 'created_at']);

const DEFAULTS = Object.freeze({
  name: null, job_id: null, origin: null, lease_id: null, grant: null, state: 'requested',
  steps: [], recording: null, recorder: null, log: [], ended: null,
});

// The image name of the process with this pid, or null when there is none (or it cannot be
// told). Windows only: tasklist by absolute path, CSV, no header. Elsewhere null, so nothing
// is ever killed there (takes record on Windows only).
function defaultFindProcess(pid, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return null;
  const { execFileSync } = require('child_process');
  const { windowsSystemRoot } = require('../platform/windows-paths');
  const exe = path.win32.join(windowsSystemRoot(env), 'System32', 'tasklist.exe');
  let out;
  try {
    out = String(execFileSync(exe, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return { image: m[1] };
  }
  return null;
}

const isFfmpegImage = (image) => typeof image === 'string' && /^ffmpeg(\.exe)?$/i.test(image.trim());

function checkFields(fields, what) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError(`a take ${what} must be an object`);
  }
  for (const key of Object.keys(fields)) {
    if (!TAKE_KEYS.includes(key)) throw new TypeError(`unknown take key: ${key}`);
    if (HOST_KEYS.has(key)) throw new TypeError(`a take ${what} cannot set ${key}`);
  }
  if ('state' in fields && !TAKE_STATES.includes(fields.state)) {
    throw new TypeError(`take state must be one of ${TAKE_STATES.join(', ')}`);
  }
}

function pick(record) {
  const out = {};
  for (const key of TAKE_KEYS) out[key] = record[key] === undefined ? null : record[key];
  return out;
}

class TakeStore {
  constructor({ dir, clock = Date.now, log = createLogger('gui/take-store') } = {}) {
    if (!dir) throw new TypeError('TakeStore needs a dir');
    this.dir = dir;
    this.clock = clock;
    this.log = log;
  }

  _file(takeId) {
    return path.join(this.dir, `${takeId}.json`);
  }

  _write(record) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this._file(record.take_id), `${JSON.stringify(record, null, 2)}\n`);
  }

  // Reads one take's file. Missing: null. Not a take record: null with one warning that
  // names the take id only, never the file's contents.
  _read(takeId) {
    let text;
    try {
      text = fs.readFileSync(this._file(takeId), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      this.log.warn('skipping a take file that cannot be read', { takeId, code: err.code });
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log.warn('skipping a take file that is not JSON', { takeId });
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.take_id !== takeId) {
      this.log.warn('skipping a take file that is not a take record', { takeId });
      return null;
    }
    return pick(parsed);
  }

  create(record = {}) {
    checkFields(record, 'record');
    let takeId;
    do {
      takeId = `take-${crypto.randomBytes(6).toString('hex')}`;
    } while (fs.existsSync(this._file(takeId)));
    const full = pick({
      ...DEFAULTS,
      steps: [],
      log: [],
      ...record,
      take_id: takeId,
      created_at: new Date(this.clock()).toISOString(),
    });
    this._write(full);
    return full;
  }

  get(takeId) {
    if (typeof takeId !== 'string' || !TAKE_ID_RE.test(takeId)) return null;
    return this._read(takeId);
  }

  update(takeId, patch) {
    checkFields(patch, 'patch');
    const current = this.get(takeId);
    if (!current) throw new Error(`no take ${TAKE_ID_RE.test(String(takeId)) ? takeId : '(invalid id)'}`);
    const next = pick({ ...current, ...patch, take_id: current.take_id, created_at: current.created_at });
    this._write(next);
    return next;
  }

  list() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      this.log.warn('cannot read the takes folder', { code: err.code });
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const takeId = name.slice(0, -'.json'.length);
      if (!TAKE_ID_RE.test(takeId)) continue;
      const record = this._read(takeId);
      if (record) out.push(record);
    }
    return out;
  }

  // The ending goes in the log in the same write as the state (§5.3: the log holds every
  // ending). A record that cannot be written is warned about by its id and the rest still run.
  //
  // A record with a `recorder` pid had an ffmpeg when the last run stopped. It is killed only
  // when a process with that pid still runs and its image name is ffmpeg: pids are reused, so
  // anything else under the pid is left alone. Logged by code only.
  markLiveEnded(reason, { findProcess = defaultFindProcess, kill = (pid) => process.kill(pid) } = {}) {
    const at = new Date(this.clock()).toISOString();
    const ids = [];
    for (const record of this.list()) {
      if (!UNFINISHED_STATES.includes(record.state)) continue;
      this._endStaleRecorder(record, { findProcess, kill });
      const log = Array.isArray(record.log) ? record.log : [];
      try {
        this.update(record.take_id, { state: 'ended', ended: { at, reason }, log: [...log, { at, ended: reason }] });
      } catch (err) {
        this.log.warn('a take left live was not marked ended', { takeId: record.take_id, code: (err && err.code) || 'error' });
        continue;
      }
      ids.push(record.take_id);
    }
    return ids;
  }

  _endStaleRecorder(record, { findProcess, kill }) {
    const pid = record.recorder && typeof record.recorder === 'object' ? record.recorder.pid : null;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    let found;
    try {
      found = findProcess(pid);
    } catch (err) {
      this.log.warn('could not look up a take\'s recorder', { takeId: record.take_id, code: (err && err.code) || 'error' });
      return false;
    }
    if (!found || !isFfmpegImage(found.image)) return false;
    try {
      kill(pid);
    } catch (err) {
      this.log.warn('could not end a take\'s recorder left running', { takeId: record.take_id, code: (err && err.code) || 'error' });
      return false;
    }
    this.log.info('ended a take\'s recorder left running', { takeId: record.take_id });
    return true;
  }

  summary(record) {
    const steps = Array.isArray(record.steps) ? record.steps : [];
    // A step is a `Take.run_steps` result, `{ index, action, ok, ms, error?, url?, screenshot? }`;
    // one with no `ok` yet counts in neither.
    const count = (ok) => steps.filter((s) => s && s.ok === ok).length;
    const rec = record.recording && typeof record.recording === 'object' ? record.recording : null;
    const grant = record.grant && typeof record.grant === 'object' ? record.grant : null;
    return {
      take_id: record.take_id,
      name: record.name,
      state: record.state,
      steps: { done: count(true), failed: count(false), total: steps.length },
      recording: rec ? { path: rec.path ?? null, duration_s: rec.duration_s ?? null } : null,
      lease: { expires_at: grant?.expires_at ?? null },
    };
  }
}

module.exports = { TakeStore, TAKE_KEYS, TAKE_STATES, TAKE_ID_RE, defaultFindProcess };

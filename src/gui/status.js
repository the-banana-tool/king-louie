// src/gui/status.js
// <dataDir>/session/status.json (fleet stage 5 spec §4.5): what the service
// last knew about the helper, for `session status`, the stdio `mcp` process
// and F7. Output only; it grants nothing. Dependency-light: F4's
// src/fleet/start.js loads readGuiStatus on every profile.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STALE_MS = 30000;
const statusPath = (dataDir) => path.join(dataDir, 'session', 'status.json');
const UNAVAILABLE = Object.freeze({ available: false, capabilities: [], apps: [], limits: [], lease: null });
// R-F5-11: what an administrator does about a session helper file the
// service refused. Said by the log, the GUI tools, "session status" and doctor.
// The same for a GUI that could not be built or started for another reason.
const GUI_START_REMEDY = 'see the service log for the cause, fix it and restart the service';
const SESSION_FILE_REMEDY = 'as root or an Administrator run "king-louie-service session uninstall --user NAME", then "king-louie-service session install --user NAME", and restart the service';

// What to do about a reason the service gave for turning desktop apps off.
function remedyFor(reason) {
  return reason === 'session_file_invalid' ? SESSION_FILE_REMEDY : GUI_START_REMEDY;
}

function writeGuiStatus(dataDir, record) {
  const dir = path.dirname(statusPath(dataDir));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = statusPath(dataDir);
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function defaultReadPid(dataDir) {
  return require('../service/pidfile').readPidfile(dataDir);
}

function defaultIsRunning(pid) {
  return require('../service/pidfile').isRunning(pid);
}

function readGuiStatusRecord({ dataDir, now = Date.now(), readPid = defaultReadPid, isRunning = defaultIsRunning } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || raw.v !== 1 || !Number.isInteger(raw.pid)) return null;
  if (raw.pid !== readPid(dataDir) || !isRunning(raw.pid)) return null;
  const updated = Date.parse(raw.updated_at);
  if (!Number.isFinite(updated) || now - updated >= STALE_MS) return null;
  return raw;
}

// The block list_machines/describe_machine carry: never paths or arg globs.
function readGuiStatus(options = {}) {
  const raw = readGuiStatusRecord(options);
  if (!raw || raw.available !== true) return { ...UNAVAILABLE };
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
  return {
    available: true,
    capabilities: strings(raw.capabilities),
    apps: (Array.isArray(raw.apps) ? raw.apps : []).filter((a) => a && typeof a.id === 'string').map((a) => ({ id: a.id, name: String(a.name || a.id) })),
    limits: strings(raw.limits),
    lease: raw.lease ? { active: raw.lease.active === true } : null
  };
}

module.exports = { statusPath, writeGuiStatus, readGuiStatus, readGuiStatusRecord, STALE_MS, SESSION_FILE_REMEDY, GUI_START_REMEDY, remedyFor };

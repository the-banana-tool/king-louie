// `king-louie-service stop`: the stop request a running service obeys.
//
// A personal node runs hidden under a logon task, and on Windows nothing
// outside can send a hidden node Ctrl-C; `schtasks /End` kills the
// PowerShell wrapper and leaves node.exe running. So the CLI asks the
// service itself: it writes `<dataDir>/service.stop` naming the pid the
// pidfile names, and the service, which checks for the file once a second,
// takes the same shutdown path as SIGINT.
//
// Why the file can be trusted: the data dir is private to the account that
// owns it (0700 on POSIX, the owner account on a personal node, the service
// account and administrators on a fleet node), and anything that can write
// there can already rewrite the service's stores. The file must also name
// this process's pid, so a request left from an earlier run (the service
// died before it read it) is never obeyed by the next one: it is removed at
// start.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('service/stop-request');

const STOP_FILE = 'service.stop';
const stopRequestPath = (dataDir) => path.join(dataDir, STOP_FILE);

// The pid a stop request names, or null for no file, a link, a directory or
// anything that does not parse.
function readStopRequest(dataDir, { fsImpl = fs } = {}) {
  const file = stopRequestPath(dataDir);
  try {
    const st = fsImpl.lstatSync(file);
    if (!st.isFile()) return { present: true, pid: null };
  } catch {
    return { present: false, pid: null };
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const pid = parsed && Number(parsed.pid);
    return { present: true, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
  } catch {
    return { present: true, pid: null };
  }
}

function removeStopRequest(dataDir, { fsImpl = fs } = {}) {
  const file = stopRequestPath(dataDir);
  try {
    fsImpl.rmSync(file, { force: true });
  } catch (err) {
    // An empty directory by that name (never a request) goes too; anything
    // more is left for the owner, never removed recursively.
    try {
      fsImpl.rmdirSync(file);
    } catch {
      log.warn(`could not remove ${STOP_FILE}: ${err.message}`);
    }
  }
}

// The CLI's side. 0644 inside a 0700 data dir: on POSIX the CLI may run as
// root and the service as the data dir's owner, which must be able to read
// it; nobody else can reach the directory.
function writeStopRequest(dataDir, pid, { fsImpl = fs, now = Date.now } = {}) {
  const file = stopRequestPath(dataDir);
  removeStopRequest(dataDir, { fsImpl });
  fsImpl.writeFileSync(file, `${JSON.stringify({ pid, at: new Date(now()).toISOString() })}\n`, { mode: 0o644, flag: 'wx' });
  return file;
}

// At start, after the instance lock: a request that names another pid is
// left from before (the CLI writes only for the pid the pidfile names) and
// is removed, never obeyed.
function clearStaleStopRequest(dataDir, { pid = process.pid, fsImpl = fs } = {}) {
  const req = readStopRequest(dataDir, { fsImpl });
  if (!req.present || req.pid === pid) return false;
  log.warn(`removed a stop request left from before this start${req.pid ? ` (it named pid ${req.pid})` : ''}`);
  removeStopRequest(dataDir, { fsImpl });
  return true;
}

// Checks every `intervalMs` and calls `onStop` once for a request naming
// `pid`; a request naming anything else is removed. The interval is
// unref'd: a running service holds the loop open with its own handles, and a
// watcher must never keep a stopped one alive.
function watchStopRequest(dataDir, onStop, {
  pid = process.pid,
  intervalMs = 1000,
  fsImpl = fs,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  let done = false;
  const check = () => {
    if (done) return;
    const req = readStopRequest(dataDir, { fsImpl });
    if (!req.present) return;
    removeStopRequest(dataDir, { fsImpl });
    if (req.pid !== pid) {
      log.warn(`ignored a stop request that does not name this service (pid ${pid})`);
      return;
    }
    done = true;
    clearIntervalImpl(timer);
    log.info('stop requested (king-louie-service stop)');
    onStop();
  };
  const timer = setIntervalImpl(check, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    check,
    close() {
      done = true;
      clearIntervalImpl(timer);
    }
  };
}

module.exports = {
  STOP_FILE, stopRequestPath, readStopRequest, writeStopRequest, removeStopRequest,
  clearStaleStopRequest, watchStopRequest
};

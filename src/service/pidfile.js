const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('service/pidfile');

const pidPath = (dataDir) => path.join(dataDir, 'service.pid');

function readPidfile(dataDir) {
  try {
    const pid = Number(fs.readFileSync(pidPath(dataDir), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function removePidfile(dataDir) {
  try { fs.unlinkSync(pidPath(dataDir)); } catch { /* already gone */ }
}

// Takes exclusive ownership of a data dir for the lifetime of this process.
//
// The pidfile used to be written unconditionally, after the core had already
// started, so a second `run` against the same data dir simply overwrote the
// first one's pid. Both processes then shared one data dir: two cron
// schedulers firing the same jobs, two writers racing on the cached JSON
// stores (last flush wins, so one process's writes silently disappear), and a
// pidfile naming only the newer of them — whichever shut down first deleted
// it, after which `status` reported "not running" for a live service and a
// second `run` could start a third. Nothing caught it, because with the
// default feature set no listener binds, and a port clash is the only thing
// that used to make a duplicate fail.
//
// O_CREAT|O_EXCL is the lock: creating the pidfile and claiming the data dir
// are the same operation, so two processes cannot both believe they won. A
// pidfile left by a crash names a pid that is gone; that one is cleared and
// retried. A pid that is alive — including one this process cannot signal,
// which `isRunning` reports through EPERM — is a running instance and the
// caller is turned away.
function acquireInstanceLock(dataDir, { maxAttempts = 3 } = {}) {
  const file = pidPath(dataDir);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const owner = readPidfile(dataDir);
      if (owner && owner !== process.pid && isRunning(owner)) {
        throw new Error(
          `refusing to run: another King Louie service already owns ${dataDir} (pid ${owner}). `
          + 'Stop it first, or use a different --data-dir. If that pid is not King Louie, remove '
          + `${file} and try again.`
        );
      }
      log.warn(`clearing a stale pidfile for ${dataDir}${owner ? ` (pid ${owner} is gone)` : ''}`);
      try {
        fs.unlinkSync(file);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
      continue;
    }

    try {
      fs.writeFileSync(fd, String(process.pid));
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    // Only ever removes a pidfile that still names this process, so a release
    // racing a successor's acquire cannot delete the successor's claim.
    return {
      release() {
        if (readPidfile(dataDir) !== process.pid) return;
        removePidfile(dataDir);
      }
    };
  }

  throw new Error(`refusing to run: could not take the instance lock on ${dataDir} after ${maxAttempts} attempts`);
}

module.exports = { readPidfile, isRunning, removePidfile, acquireInstanceLock };

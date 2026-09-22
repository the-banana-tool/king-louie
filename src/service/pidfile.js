const fs = require('fs');
const path = require('path');

const pidPath = (dataDir) => path.join(dataDir, 'service.pid');

function writePidfile(dataDir) {
  fs.writeFileSync(pidPath(dataDir), String(process.pid), { mode: 0o600 });
}

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

module.exports = { writePidfile, readPidfile, isRunning, removePidfile };

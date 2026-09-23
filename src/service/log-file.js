// Mirrors every log record into <logsDir>/service.log. A Windows scheduled
// task has no console anyone can read, so without this the service's only
// output would be lost; on Linux/macOS it complements journald/launchd logs.
const fs = require('fs');
const path = require('path');
const { addSink } = require('../logging');

const SERVICE_LOG_NAME = 'service.log';

function attachServiceLogFile(logsDir, { platform = process.platform } = {}) {
  const file = path.join(logsDir, SERVICE_LOG_NAME);
  const fd = fs.openSync(file, 'a', 0o600);
  // openSync's mode only applies on create and is subject to umask.
  if (platform !== 'win32') fs.fchmodSync(fd, 0o600);
  let open = true;
  const removeSink = addSink((record) => {
    if (!open) return;
    fs.writeSync(fd, `${record.time} ${record.level.toUpperCase()} ${record.line}\n`);
  });
  return {
    file,
    close() {
      if (!open) return;
      open = false;
      removeSink();
      fs.closeSync(fd);
    }
  };
}

module.exports = { attachServiceLogFile, SERVICE_LOG_NAME };

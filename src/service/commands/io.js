// Shared CLI helpers for the approval commands. CLI output goes to
// stdout/stderr on purpose; everything else logs via createLogger.
const { readPidfile, isRunning } = require('../pidfile');

// The first line typed on stdin (without its newline); '' at end of input.
function readLine(stdin) {
  return new Promise((resolve) => {
    let buffered = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      if (typeof stdin.pause === 'function') stdin.pause();
    };
    const onData = (chunk) => {
      buffered += String(chunk);
      const nl = buffered.indexOf('\n');
      if (nl === -1) return;
      cleanup();
      resolve(buffered.slice(0, nl).replace(/\r$/, ''));
    };
    const onEnd = () => {
      cleanup();
      resolve(buffered.replace(/\r?\n$/, ''));
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    if (typeof stdin.resume === 'function') stdin.resume();
  });
}

function runningServicePid(dataDir) {
  const pid = readPidfile(dataDir);
  return pid && isRunning(pid) ? pid : null;
}

// `qrcode` is loaded only here, by the CLI commands that print a code.
async function renderQr(text) {
  const QRCode = require('qrcode');
  return QRCode.toString(text, { type: 'terminal', small: true });
}

module.exports = { readLine, runningServicePid, renderQr };

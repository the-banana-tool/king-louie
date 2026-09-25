// Shared CLI helpers for the approval commands. CLI output goes to
// stdout/stderr on purpose; everything else logs via createLogger.
const { readPidfile, isRunning } = require('../pidfile');

// The first line typed on stdin (without its newline); '' at end of input.
// With `signal`, an abort stops listening and resolves null.
function readLine(stdin, { signal } = {}) {
  return new Promise((resolve) => {
    let buffered = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      if (signal) signal.removeEventListener('abort', onAbort);
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
    const onAbort = () => {
      cleanup();
      resolve(null);
    };
    if (signal && signal.aborted) {
      resolve(null);
      return;
    }
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (typeof stdin.resume === 'function') stdin.resume();
  });
}

// C0 and C1 controls, and the bidi controls (LRM/RLM/ALM, embeddings,
// overrides, isolates) that can make a name read differently on a terminal.
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

// A device-supplied string made safe to print on the administrator's terminal.
function printable(value) {
  return String(value == null ? '' : value).replace(UNPRINTABLE_RE, '');
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

module.exports = { readLine, printable, runningServicePid, renderQr };

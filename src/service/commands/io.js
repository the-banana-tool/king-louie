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

// One line for the administrator's terminal out of text this program did not
// write: what a session helper (the session user's own process) reported
// about itself, what a status file or a helper file holds. Text that is one
// plain line (plainLineProblem, the one shared definition: no control,
// hidden or bidi character, no odd space, no run of spaces) is shown as it
// is, cut to `max` code points; anything else is shown without those
// characters and marked, so a name cannot redraw the line it is on or add a
// line that reads as the program's own.
function shown(value, max = 200) {
  // Required here: this file is loaded by every profile's CLI.
  const { plainLineProblem } = require('../../cases/hidden-chars');
  const text = Array.from(String(value === null || value === undefined ? '' : value)).slice(0, max).join('');
  if (plainLineProblem(text) === null) return text;
  let kept = Array.from(text).map((ch) => (plainLineProblem(ch) === null ? ch : (/\s|\p{Zs}/u.test(ch) ? ' ' : ''))).join('').replace(/ {2,}/g, ' ').trim();
  if (plainLineProblem(kept) !== null) kept = kept.replace(/\p{M}/gu, '');
  return `${kept} [hidden or control characters removed]`;
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

module.exports = { readLine, printable, shown, runningServicePid, renderQr };

// `king-louie-service stop [--data-dir DIR] [--timeout S] [--force]`.
//
// Asks the service running on a data dir to shut down (the service.stop
// file, src/service/stop-request.js) and waits for its process to exit. It
// writes the request only when the pidfile names a live process whose
// command line is the service's own (`king-louie-service ... run`), and says
// "stopped" only once that pid is gone. Past --timeout (default 30 s) it says
// so; --force then kills the pid, after checking again that the pidfile
// still names it and it is still the service. On a personal node it also
// ends the logon task, so the task reads Ready afterwards.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { runningServicePid } = require('./io');
const { writeStopRequest, removeStopRequest } = require('../stop-request');

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 3600;
const FORCE_WAIT_MS = 5000;
const POLL_MS = 250;

// How a command names its data dir to the operator, quoted when it holds a
// space.
function stopCommandText(dataDir) {
  const dir = /\s/.test(String(dataDir)) ? `"${dataDir}"` : String(dataDir);
  return `king-louie-service stop --data-dir ${dir}`;
}

// The sentence every "the service is running" refusal ends with.
function stopFirstText(pid, dataDir, what = 'service') {
  return `The ${what} is running (pid ${pid}) on ${dataDir}. Stop it first (${stopCommandText(dataDir)}), run this again, then start it.`;
}

// The command line of `pid`, or null when it cannot be read.
function defaultCommandLine(pid, { platform = process.platform, env = process.env } = {}) {
  try {
    if (platform === 'win32') {
      const { windowsPowerShellExe } = require('../../platform/windows-paths');
      // Get-CimInstance is CimCmdlets, not Microsoft.PowerShell.Security, so
      // a pwsh 7 PSModulePath does not break it.
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
      const out = execFileSync(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim() || null;
    }
    if (platform === 'linux') {
      const raw = fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8');
      return raw.split('\0').filter(Boolean).join(' ') || null;
    }
    const out = execFileSync('ps', ['-o', 'args=', '-p', String(Number(pid))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// The service's own command line: the CLI entry with `run` as its command
// (not `relay run`, which holds the same pidfile but watches no stop
// request). `run` takes --data-dir and --profile, each with a value.
function isServiceCommandLine(cmdline) {
  if (typeof cmdline !== 'string') return false;
  const words = cmdline.split(/[\s"']+/).filter(Boolean);
  const entry = words.findIndex((w) => /(^|[\\/])king-louie-service(\.js)?$/i.test(w));
  if (entry === -1) return false;
  for (let i = entry + 1; i < words.length; i += 1) {
    const w = words[i];
    if (w.startsWith('--')) {
      if (!w.includes('=') && (w === '--data-dir' || w === '--profile')) i += 1;
      continue;
    }
    return w === 'run';
  }
  return false;
}

function defaultEndTask({ env = process.env } = {}) {
  const { windowsSchtasksExe } = require('../../platform/windows-paths');
  const { PERSONAL_TASK_NAME } = require('../personal-install');
  try {
    execFileSync(windowsSchtasksExe(env), ['/End', '/TN', PERSONAL_TASK_NAME], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
    return true;
  } catch {
    // Not running (already Ready) or not registered.
    return false;
  }
}

function defaultIsPersonal(dataDir) {
  try {
    return require('../node-config').loadNodeConfig({ dataDir }).hosting === 'personal';
  } catch {
    return false;
  }
}

function defaultIsRunning(pid) {
  return require('../pidfile').isRunning(pid);
}

function resolveDeps(deps = {}) {
  return {
    platform: deps.platform || process.platform,
    runningServicePid: deps.runningServicePid || runningServicePid,
    isRunning: deps.isRunning || defaultIsRunning,
    commandLine: deps.commandLine || ((pid) => defaultCommandLine(pid)),
    writeStopRequest: deps.writeStopRequest || writeStopRequest,
    removeStopRequest: deps.removeStopRequest || removeStopRequest,
    kill: deps.kill || ((pid) => process.kill(pid, 'SIGKILL')),
    isPersonal: deps.isPersonal || defaultIsPersonal,
    endTask: deps.endTask || defaultEndTask,
    now: deps.now || Date.now,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };
}

function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_S;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(n) || n > MAX_TIMEOUT_S) return null;
  return n;
}

async function waitGone(pid, ms, c) {
  const until = c.now() + ms;
  for (;;) {
    if (!c.isRunning(pid)) return true;
    if (c.now() >= until) return false;
    await c.sleep(Math.min(POLL_MS, Math.max(1, until - c.now())));
  }
}

// The live pid the pidfile names, when it is the service; else a refusal.
function serviceProcess(dataDir, c) {
  const pid = c.runningServicePid(dataDir);
  if (!pid) return { pid: null, why: 'none' };
  const cmdline = c.commandLine(pid);
  if (cmdline === null) return { pid, why: 'unreadable' };
  if (!isServiceCommandLine(cmdline)) return { pid, why: 'other' };
  return { pid, why: null };
}

function finish(io, dataDir, c, personal) {
  if (personal && c.platform === 'win32') {
    const { PERSONAL_TASK_NAME } = require('../personal-install');
    c.endTask();
    io.stdout.write(`Stopped the service on ${dataDir}; the logon task "${PERSONAL_TASK_NAME}" is ended (start it again with schtasks /Run /TN "${PERSONAL_TASK_NAME}", or log in again).\n`);
  } else {
    io.stdout.write(`Stopped the service on ${dataDir}.\n`);
  }
  return 0;
}

async function runStopCommand({ dataDir, flags = {}, io, deps = {} }) {
  const c = resolveDeps(deps);
  const timeoutS = parseTimeout(flags.timeout);
  if (timeoutS === null) {
    io.stderr.write(`--timeout takes whole seconds, 0 to ${MAX_TIMEOUT_S}.\n`);
    return 2;
  }
  const personal = c.isPersonal(dataDir);
  const found = serviceProcess(dataDir, c);
  if (found.why === 'none') {
    // Nothing to stop. A personal node's task may still read Running (the
    // PowerShell wrapper outliving a node that crashed): end it too.
    if (personal && c.platform === 'win32') c.endTask();
    io.stderr.write(`No service is running on ${dataDir}.\n`);
    return 1;
  }
  if (found.why === 'unreadable') {
    io.stderr.write(`The pidfile on ${dataDir} names pid ${found.pid}, whose command line cannot be read from this account; nothing was sent. Run this as the account the service runs as, or as an administrator.\n`);
    return 1;
  }
  if (found.why === 'other') {
    io.stderr.write(`The pidfile on ${dataDir} names pid ${found.pid}, which is not a King Louie service; nothing was sent or killed. If no service is running there, remove ${require('path').join(dataDir, 'service.pid')}.\n`);
    return 1;
  }
  const { pid } = found;
  try {
    c.writeStopRequest(dataDir, pid);
  } catch (err) {
    io.stderr.write(`Could not write the stop request in ${dataDir}: ${err.message}\n`);
    return 1;
  }
  io.stdout.write(`Asked the service (pid ${pid}) on ${dataDir} to stop; waiting up to ${timeoutS} s.\n`);
  if (await waitGone(pid, timeoutS * 1000, c)) return finish(io, dataDir, c, personal);

  if (!flags.force) {
    io.stderr.write(`The service (pid ${pid}) is still running after ${timeoutS} s. It may still be shutting down: run this again to wait longer (--timeout S), or pass --force to kill it.\n`);
    return 1;
  }
  // The pid may have been reused, or the pidfile rewritten by a new start,
  // while we waited: kill only what is still this data dir's service.
  const again = serviceProcess(dataDir, c);
  if (again.pid !== pid || again.why !== null) {
    if (!c.isRunning(pid)) return finish(io, dataDir, c, personal);
    io.stderr.write(`Pid ${pid} is no longer the service on ${dataDir}; not killing it.\n`);
    return 1;
  }
  try {
    c.kill(pid);
  } catch (err) {
    io.stderr.write(`Could not kill pid ${pid}: ${err.message}\n`);
    return 1;
  }
  if (!(await waitGone(pid, FORCE_WAIT_MS, c))) {
    io.stderr.write(`Killed pid ${pid}, but it is still there after ${FORCE_WAIT_MS / 1000} s.\n`);
    return 1;
  }
  // A killed service never read its request; the next start would remove it
  // as stale anyway.
  c.removeStopRequest(dataDir);
  io.stdout.write(`Killed the service (pid ${pid}) after ${timeoutS} s without a clean shutdown.\n`);
  return finish(io, dataDir, c, personal);
}

module.exports = { runStopCommand, stopFirstText, stopCommandText, isServiceCommandLine, defaultCommandLine, DEFAULT_TIMEOUT_S };

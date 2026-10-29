'use strict';

// The desktop's side of a personal node on this machine (spec
// docs/superpowers/specs/2026-10-28-desktop-attached-to-personal-node-design.md
// §5.2, §6.3, §7.1). Electron-free: it reads files and spawns processes only,
// every one of them injectable; the controller in src/ipc/ wires it.
//
// What it answers:
// - is there a personal node here (detectPersonalNode: the config dir,
//   node.yaml and the data dir owned by this account, no link, node.yaml says
//   hosting: personal; the rule is pairing.js's judgePersonalPaths, never a
//   copy), and, from the same single inspector call, the bridge file's trust
//   (inspectLocal, C-1);
// - is the logon task registered, enabled and this account's (queryTask: the
//   task's XML, never schtasks' localised text, C-10);
// - is a node running on the data dir (nodeRunning: the pidfile names a live
//   pid whose command line is `king-louie-service … run`);
// - did it fail to start (startFailureSince: the node's own log).
// What it runs: `schtasks /Run` (runTask), the CLI with the app's own binary
// as Node (runCli, C-9), and the CLI's `stop` (stopNode). A restart is the
// controller's: the task checked, then stop, then `/Run`. Never `/End`,
// `/Change` or `/Create`.

const fs = require('fs');
const path = require('path');
const { execFile: execFileCallback, spawn: spawnDefault } = require('child_process');
const { createLogger } = require('../logging');
const { adminConfigDir } = require('../platform/paths');
const { windowsSchtasksExe, windowsPowerShellExe, windowsSystemRoot } = require('../platform/windows-paths');
const { shown } = require('../service/commands/io');
const { isServiceCommandLine } = require('../service/commands/stop');
const pairing = require('./pairing');
const { PERSONAL_TASK_NAME } = require('./protocol');
const pidfile = require('../service/pidfile');

const log = createLogger('desktop-bridge/personal-node');

const ENTRY_PATH = path.resolve(__dirname, '..', '..', 'bin', 'king-louie-service.js');
const DEFAULT_CLI_TIMEOUT_MS = 120000;
const SCHTASKS_TIMEOUT_MS = 30000;
// `stop` waits up to 30 s for the node to go (its DEFAULT_TIMEOUT_S), then
// ends the task; the CLI's own start-up comes on top.
const STOP_TIMEOUT_MS = 90000;
const OUTPUT_CAP = 1024 * 1024;
const LOG_TAIL_BYTES = 256 * 1024;
const FAILED_TO_START = 'service failed to start';

function createPersonalNodeRunner(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const inspectOwners = deps.inspectOwners || ((paths, opts) => pairing.inspectWindowsOwnersAsync(paths, opts));
  const loadNodeConfig = deps.loadNodeConfig; // undefined: pairing.js's strict loader
  const execFile = deps.execFile || execFileCallback;
  const spawn = deps.spawn || spawnDefault;
  const readFile = deps.readFile || readTail;
  const now = deps.now || Date.now;
  const execPath = deps.execPath || process.execPath;
  const entryPath = deps.entryPath || ENTRY_PATH;
  const readPidfile = deps.readPidfile || (async (dataDir) => pidfile.readPidfile(dataDir));
  const isRunning = deps.isRunning || ((pid) => pidfile.isRunning(pid));
  const commandLineOf = deps.commandLineOf || ((pid) => defaultCommandLineOf(pid, { platform, env, execFile }));
  const whoAmI = deps.whoAmI || (() => defaultWhoAmI({ env, execFile }));
  const testOverride = env.KL_TEST_MODE === '1' && Boolean(env.KL_DESKTOP_BRIDGE_FILE);
  // The SID the last inspector call reported: queryTask compares the task's
  // principal with it.
  let lastMe = null;

  const defaultBridgeFile = () => deps.bridgeFile || pairing.bridgeFilePath({ env, platform });
  const bridgeFileFor = (dataDir) => (dataDir
    ? path.join(adminConfigDir({ platform, dataDir }), pairing.BRIDGE_FILE)
    : defaultBridgeFile());

  // One inspector call over bridgeTrustPaths(file); a failure is a report
  // with no entries, which every reader refuses.
  async function inspect(file) {
    const paths = pairing.bridgeTrustPaths(file);
    let report;
    try {
      report = await inspectOwners(paths, { env });
    } catch (err) {
      log.debug('owner read failed', { error: err && err.message });
      report = null;
    }
    if (report && typeof report.me === 'string' && report.me.trim()) lastMe = report.me.trim();
    return { paths, report };
  }

  function judgeNode(file, paths, report) {
    const configDir = path.dirname(file);
    const dataDir = paths[3];
    const base = { personal: false, dataDir, configDir };
    if (!report || !Array.isArray(report.entries) || report.entries.length !== paths.length) {
      return { ...base, reason: 'unreadable', problem: 'the owners could not be read' };
    }
    const verdict = pairing.judgePersonalPaths({
      me: report.me,
      checks: [0, 2, 3].map((i) => ({ path: paths[i], entry: report.entries[i] })),
      configDir,
      loadNodeConfig
    });
    if (!verdict.ok) return { ...base, reason: verdict.reason, problem: shown(verdict.problem, 400) };
    return { personal: true, name: shown(verdict.name || ''), dataDir, configDir, me: report.me };
  }

  function notApplicable(file) {
    const configDir = path.dirname(file);
    return { personal: false, dataDir: path.join(configDir, '..', 'data'), configDir, reason: 'not-windows' };
  }

  // §5.2: is there a personal node here (or for the recorded data dir).
  async function detectPersonalNode({ dataDir } = {}) {
    const file = bridgeFileFor(dataDir);
    if (platform !== 'win32' || testOverride) return notApplicable(file);
    const { paths, report } = await inspect(file);
    return judgeNode(file, paths, report);
  }

  // C-1: the bridge file's trust (readTrustedBridgeFile's result, with its
  // record and hosting) and detectPersonalNode's answer, from one inspector
  // call. The controller's unpaired view calls this.
  async function inspectLocal({ dataDir, bridgeFile } = {}) {
    const file = bridgeFile || bridgeFileFor(dataDir);
    if (platform !== 'win32' || testOverride) {
      const trust = await pairing.readTrustedBridgeFile(file, { env, platform, inspectOwners, loadNodeConfig });
      return { trust, node: notApplicable(file) };
    }
    const { paths, report } = await inspect(file);
    const replay = async () => {
      if (!report) throw new Error('the owners could not be read');
      return report;
    };
    const trust = await pairing.readTrustedBridgeFile(file, { env, platform, inspectOwners: replay, loadNodeConfig });
    return { trust, node: judgeNode(file, paths, report) };
  }

  // execFile as a promise that never rejects: { err, stdout, stderr }.
  function run(file, args, opts) {
    return new Promise((resolve) => {
      try {
        execFile(file, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      } catch (err) {
        resolve({ err, stdout: '', stderr: '' });
      }
    });
  }

  // §7.1, C-10: registered | disabled | missing | other-account | unknown.
  // The principal must be this account's SID: never run another account's
  // task. `me` defaults to the SID the last owner read reported, then whoami.
  async function queryTask({ me } = {}) {
    if (platform !== 'win32') return { state: 'unknown' };
    const { err, stdout } = await run(windowsSchtasksExe(env), ['/Query', '/TN', PERSONAL_TASK_NAME, '/XML', 'ONE'], {
      encoding: 'buffer', timeout: SCHTASKS_TIMEOUT_MS
    });
    if (err) {
      // A non-zero exit is "not registered"; a schtasks that did not run at
      // all (missing, killed at the timeout) tells nothing.
      if (Number.isInteger(err.code) && err.code !== 0 && !err.killed) return { state: 'missing' };
      log.debug('schtasks /Query did not run', { error: err.message });
      return { state: 'unknown' };
    }
    const task = parseTaskXml(decodeOutput(stdout));
    if (!task.userId) return { state: 'unknown' };
    let sid = typeof me === 'string' && me.trim() ? me.trim() : lastMe;
    if (!sid) {
      try { sid = await whoAmI(); } catch { sid = null; }
      if (typeof sid === 'string' && sid.trim()) lastMe = sid.trim();
    }
    if (typeof sid !== 'string' || !sid.trim()) return { state: 'unknown' };
    if (task.userId.toUpperCase() !== sid.trim().toUpperCase()) return { state: 'other-account', userId: shown(task.userId) };
    return { state: task.enabled ? 'registered' : 'disabled' };
  }

  // §7.1: the pidfile names a live pid whose command line is
  // `king-louie-service … run` (the test `stop` makes). `other: true` when a
  // live pid is not one.
  async function nodeRunning({ dataDir }) {
    const pid = await readPidfile(dataDir);
    if (!pid || !isRunning(pid)) return { running: false, pid: null };
    let cmdline = null;
    try { cmdline = await commandLineOf(pid); } catch { cmdline = null; }
    if (!isServiceCommandLine(cmdline)) return { running: false, pid, other: true };
    return { running: true, pid };
  }

  // §7.1: `schtasks /Run`. The caller checks nodeRunning first (C-11).
  async function runTask() {
    const ranAt = now();
    const { err, stderr, stdout } = await run(windowsSchtasksExe(env), ['/Run', '/TN', PERSONAL_TASK_NAME], {
      encoding: 'utf8', timeout: SCHTASKS_TIMEOUT_MS
    });
    if (err) {
      return { ok: false, code: 'NODE_TASK_RUN_FAILED', message: firstLine(stderr) || firstLine(stdout) || shown(err.message) };
    }
    return { ok: true, ranAt };
  }

  // §6.3, C-9: the app's own binary as Node, its own entry script. Resolves
  // { code, stdout, stderr, json, timedOut?, error? } and never rejects;
  // `json` is the last stdout line when it parses as JSON.
  function runCli(args, { timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(execPath, [entryPath, ...args], {
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
        });
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: '', json: null, error: err.message });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const take = (acc, chunk) => (acc.length >= OUTPUT_CAP ? acc : acc + String(chunk).slice(0, OUTPUT_CAP - acc.length));
      if (child.stdout) child.stdout.on('data', (chunk) => { stdout = take(stdout, chunk); });
      if (child.stderr) child.stderr.on('data', (chunk) => { stderr = take(stderr, chunk); });
      // Ref'd: it keeps the process alive while the child runs.
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* already gone */ }
      }, timeoutMs);
      const finish = (code, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = { code: timedOut ? null : code, stdout, stderr, json: lastJsonLine(stdout) };
        if (timedOut) out.timedOut = true;
        if (error) out.error = error;
        resolve(out);
      };
      child.on('error', (err) => finish(null, err && err.message ? err.message : String(err)));
      child.on('close', (code) => finish(Number.isInteger(code) ? code : null));
    });
  }

  // §7.1: the stop half of a restart (only on a press): the CLI's `stop`,
  // which under personal hosting also ends the task. Never `/End`. The
  // controller checks the task before it and runs /Run after it.
  async function stopNode({ dataDir }) {
    const stopped = await runCli(['stop', '--data-dir', dataDir], { timeoutMs: STOP_TIMEOUT_MS });
    if (stopped.code !== 0) {
      return {
        ok: false,
        code: 'NODE_STOP_FAILED',
        message: firstLine(stopped.stderr) || firstLine(stopped.stdout)
          || (stopped.timedOut ? 'stop did not finish' : shown(stopped.error || 'stop failed'))
      };
    }
    return { ok: true };
  }

  // §7.1: the newest `service failed to start` line of <A>\logs\service.log
  // written at or after `since`, through shown; null when there is none.
  async function startFailureSince(since, { dataDir }) {
    const sinceMs = since instanceof Date ? since.getTime() : Number(since);
    let text;
    try {
      text = String(await readFile(path.join(dataDir, 'logs', 'service.log')));
    } catch {
      return null;
    }
    let found = null;
    for (const raw of text.split(/\r?\n/)) {
      const m = /^(\S+) \S+ (.*)$/.exec(raw);
      if (!m) continue;
      const at = Date.parse(m[1]);
      const where = m[2].indexOf(FAILED_TO_START);
      if (!Number.isFinite(at) || where === -1 || at < sinceMs) continue;
      if (!found || at >= found.at) found = { at, line: shown(m[2].slice(where), 400) };
    }
    return found;
  }

  return {
    taskName: PERSONAL_TASK_NAME,
    entryPath,
    detectPersonalNode,
    inspectLocal,
    queryTask,
    nodeRunning,
    runTask,
    stopNode,
    runCli,
    startFailureSince
  };
}

// schtasks writes the XML as UTF-16 or in the console's code page.
function decodeOutput(out) {
  if (!Buffer.isBuffer(out)) return String(out || '');
  if (out.length >= 2 && out[0] === 0xff && out[1] === 0xfe) return out.subarray(2).toString('utf16le');
  if (out.length >= 2 && out[1] === 0x00) return out.toString('utf16le');
  const text = out.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// The principal's UserId and <Settings>' own <Enabled> (absent: enabled).
function parseTaskXml(xml) {
  const principal = /<Principal\b[^>]*>([\s\S]*?)<\/Principal>/.exec(xml);
  const user = principal && /<UserId>\s*([^<]*?)\s*<\/UserId>/.exec(principal[1]);
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(xml);
  const own = settings
    ? settings[1].replace(/<(IdleSettings|NetworkSettings|MaintenanceSettings|RestartOnFailure)\b[\s\S]*?<\/\1>/g, '')
    : '';
  const enabled = /<Enabled>\s*([^<]*?)\s*<\/Enabled>/.exec(own);
  return {
    userId: user && user[1] ? unescapeXml(user[1]) : null,
    enabled: !(enabled && enabled[1].toLowerCase() === 'false')
  };
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? shown(line, 400) : '';
}

function lastJsonLine(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last || last[0] !== '{') return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

function execText(execFile, file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch {
      resolve(null);
    }
  });
}

// The command line of `pid`, or null; async, never a blocking call in the
// Electron main process. Get-CimInstance is CimCmdlets, not
// Microsoft.PowerShell.Security (as stop.js's defaultCommandLine says).
async function defaultCommandLineOf(pid, { platform, env, execFile }) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (platform === 'win32') {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
    const out = await execText(execFile, windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script]);
    return out && out.trim() ? out.trim() : null;
  }
  if (platform === 'linux') {
    try {
      const raw = await fs.promises.readFile(`/proc/${n}/cmdline`, 'utf8');
      return raw.split('\0').filter(Boolean).join(' ') || null;
    } catch {
      return null;
    }
  }
  const out = await execText(execFile, '/bin/ps', ['-o', 'args=', '-p', String(n)]);
  return out && out.trim() ? out.trim() : null;
}

// `whoami /user /fo csv`: a header line, then "domain\user","S-1-…".
async function defaultWhoAmI({ env, execFile }) {
  const out = await execText(execFile, path.win32.join(windowsSystemRoot(env), 'System32', 'whoami.exe'), ['/user', '/fo', 'csv']);
  const line = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  const m = /^"([^"]*)","(S-1-[0-9-]+)"$/.exec(line);
  return m ? m[2] : null;
}

async function readTail(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

module.exports = {
  createPersonalNodeRunner,
  PERSONAL_TASK_NAME,
  ENTRY_PATH,
  DEFAULT_CLI_TIMEOUT_MS,
  FAILED_TO_START,
  firstLine,
  parseTaskXml
};

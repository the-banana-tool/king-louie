// src/session/helper.js
// `king-louie-service session` (fleet stage 5 spec §3.3): runs as the
// logged-in user, reads its own per-user file, authenticates the service
// and serves GUI ops through the OS backend. It reconnects with backoff,
// re-reading the file each time (that is how a rotation reaches it), and
// exits 0 at logout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createLogger } = require('../logging');
const { readUserCopy, userCopyPath, checkUserCopyTrust } = require('../gui/session-secret');
const { connectToService, createOpHandler, createRecordingGuard } = require('./connection');
const { selectBackend: defaultSelect, loadBackend, NO_BACKEND_REPORT } = require('./backends');
const { adminConfigDir, defaultServiceDataDir } = require('../platform/paths');
const { windowsPowerShellExe } = require('../platform/windows-paths');
const { version: HELPER_VERSION } = require('../../package.json');

const RECONNECT_DELAYS = Object.freeze([1000, 2000, 5000, 10000, 30000]);

function defaultCurrentSid(env) {
  const script = '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value';
  return execFileSync(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
}

function defaultSessionFile({ platform = process.platform, env = process.env, user = os.userInfo().username, currentSid = () => defaultCurrentSid(env) } = {}) {
  const configDir = adminConfigDir({ platform, dataDir: defaultServiceDataDir({ platform, env }) });
  return platform === 'win32' ? userCopyPath({ platform, configDir, sid: currentSid() }) : userCopyPath({ platform, configDir, user });
}

function helperLogDir({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return { dir: path.win32.join(env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || 'C:\\', 'AppData', 'Local'), 'KingLouie', 'session', 'logs'), name: 'helper.log' };
  const home = env.HOME || os.homedir();
  if (platform === 'darwin') return { dir: path.posix.join(home, 'Library', 'Logs', 'KingLouie'), name: 'session.log' };
  return { dir: path.posix.join(home, '.local', 'state', 'king-louie'), name: 'session.log' };
}

function attachHelperLog({ platform, env, log }) {
  try {
    const { dir, name } = helperLogDir({ platform, env });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return require('../service/log-file').attachServiceLogFile(dir, { platform, name });
  } catch (err) {
    log.warn(`no helper log file: ${err.message}`);
    return null;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function safeProbe(backend, log) {
  try {
    const r = await backend.probe();
    return { capabilities: r.capabilities || [], probes: r.probes || [], displays: r.displays || [], limits: r.limits || [], locked: r.locked === true };
  } catch (err) {
    log.warn(`probe failed: ${err.message}`);
    return NO_BACKEND_REPORT(`the probe failed: ${err.message}`);
  }
}

async function runSessionHelper({ env = process.env, platform = process.platform, signal = null, sessionFile = null, deps = {} } = {}) {
  const log = deps.log || createLogger('session-helper');
  const logFile = deps.attachLog === false ? null : attachHelperLog({ platform, env, log });
  const readOptions = {
    platform,
    ...(deps.rootUid === undefined ? {} : { rootUid: deps.rootUid }),
    ...(deps.getuid ? { getuid: deps.getuid } : {})
  };
  // Who owns the file, before it is believed (Windows; security review
  // finding 3). deps.trustCurrentUserAsOwner: tests only, like deps.rootUid.
  const checkTrust = deps.checkUserCopyTrust
    || ((options) => checkUserCopyTrust({ ...options, alsoTrustCurrentUser: deps.trustCurrentUserAsOwner === true }));
  const connect = deps.connect || connectToService;
  const delays = deps.delays || RECONNECT_DELAYS;
  let file;
  try {
    file = sessionFile || env.KL_SESSION_FILE || defaultSessionFile({ platform, env });
    await checkTrust({ path: file, platform, env });
    readUserCopy({ path: file, ...readOptions });
  } catch (err) {
    log.error(`${err.message}`);
    if (logFile) logFile.close();
    return 1;
  }

  let backend = deps.backend;
  if (backend === undefined) {
    const name = (deps.selectBackend || defaultSelect)({ platform, env });
    backend = name ? loadBackend(name, { env, log }) : null;
  }
  if (backend && typeof backend.requestPermissions === 'function') {
    await backend.requestPermissions().catch((err) => log.warn(`permission prompt failed: ${err.message}`));
  }
  let report = backend ? await safeProbe(backend, log) : NO_BACKEND_REPORT('no desktop session was found for this helper (no display, or Wayland without portals)');
  const handleOp = createOpHandler(backend, { platform });
  const recordingGuard = createRecordingGuard({ backend, log, ...(deps.timers ? { timers: deps.timers } : {}) });
  let attempt = 0;
  let exitCode = 0;

  while (!(signal && signal.aborted)) {
    let copy;
    try {
      // Again before every connection: the file is re-read each time.
      await checkTrust({ path: file, platform, env });
      copy = readUserCopy({ path: file, ...readOptions });
    } catch (err) {
      log.error(err.message);
      exitCode = 1;
      break;
    }
    try {
      const session = await connect({
        endpoint: copy.endpoint, secret: copy.secret, nodeId: copy.nodeId, user: os.userInfo().username, platform,
        pid: process.pid, helperVersion: HELPER_VERSION, probeReport: report, handleOp, log
      });
      attempt = 0;
      recordingGuard.connected();
      log.info('connected to the King Louie service');
      let lastLocked = report.locked;
      const reprobe = setInterval(async () => {
        if (!backend) return;
        const next = await safeProbe(backend, log);
        if (JSON.stringify(next.capabilities) !== JSON.stringify(report.capabilities) || JSON.stringify(next.limits) !== JSON.stringify(report.limits)) {
          report = next;
          session.sendEvent('probe_changed', next);
        }
      }, deps.reprobeMs || 60000);
      const lockPoll = setInterval(async () => {
        if (!backend || typeof backend.locked !== 'function') return;
        let now;
        try { now = await backend.locked(); } catch { return; }
        if (now === null || now === lastLocked) return;
        lastLocked = now;
        session.sendEvent(now ? 'locked' : 'unlocked', {});
      }, deps.lockPollMs || 2000);
      await new Promise((resolve) => {
        session.once('closed', resolve);
        if (signal) signal.addEventListener('abort', () => { session.close('logout'); resolve(); }, { once: true });
      });
      clearInterval(reprobe);
      clearInterval(lockPoll);
      // A recording outlives a short drop; 30 s without the service ends it.
      recordingGuard.disconnected();
      if (!(signal && signal.aborted)) log.warn('the service connection closed; reconnecting');
    } catch (err) {
      log.warn(`not connected: ${err.message}`);
    }
    if (signal && signal.aborted) break;
    await sleep(delays[Math.min(attempt, delays.length - 1)], signal);
    attempt += 1;
  }
  await recordingGuard.stop();
  if (backend && typeof backend.stop === 'function') await backend.stop().catch(() => {});
  if (logFile) logFile.close();
  return exitCode;
}

module.exports = { runSessionHelper, defaultSessionFile, helperLogDir, RECONNECT_DELAYS, HELPER_VERSION };

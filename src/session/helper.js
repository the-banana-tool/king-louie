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
const { findFfmpeg } = require('./recorder');
const { startSessionWatch, safeProbe } = require('./session-watch');
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
    if (signal && signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
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
  // deps.readCopy (the King Louie app serving its personal node, boot-node-tray
  // Task 7): an async () => ({ endpoint, secret, nodeId }) that replaces the
  // fleet per-user file and its owner check. The app can start before the
  // node, and a node restart writes a new file, so a failed read waits and
  // tries again instead of ending the helper.
  const readCopy = typeof deps.readCopy === 'function' ? deps.readCopy : null;
  // deps.onState({ connected }): told when a session connects and when it closes.
  const onState = typeof deps.onState === 'function' ? deps.onState : () => {};
  let file;
  if (!readCopy) {
    try {
      file = sessionFile || env.KL_SESSION_FILE || defaultSessionFile({ platform, env });
      await checkTrust({ path: file, platform, env });
      readUserCopy({ path: file, ...readOptions });
    } catch (err) {
      log.error(`${err.message}`);
      if (logFile) logFile.close();
      return 1;
    }
  }
  const readOnce = readCopy || (async () => {
    // Again before every connection: the file is re-read each time.
    await checkTrust({ path: file, platform, env });
    return readUserCopy({ path: file, ...readOptions });
  });
  // deps.profileRoot: where launch_browser keeps profiles (the app passes the
  // node's <dataDir>\browser-profiles).
  const profileRoot = deps.profileRoot || null;

  let backend = deps.backend;
  if (backend === undefined) {
    const name = (deps.selectBackend || defaultSelect)({ platform, env });
    backend = name ? loadBackend(name, { env, log, ...(profileRoot ? { profileRoot } : {}) }) : null;
  }
  if (backend && typeof backend.requestPermissions === 'function') {
    await backend.requestPermissions().catch((err) => log.warn(`permission prompt failed: ${err.message}`));
  }
  // The user's ffmpeg, found once, as the user (demo takes §9). It rides in
  // every probe_report and probe_changed as `recorder`.
  let ffmpeg = null;
  try { ffmpeg = (deps.findFfmpeg || findFfmpeg)({ platform, env }) || null; } catch { ffmpeg = null; }
  const recorder = Object.freeze({ ffmpeg });
  const withRecorder = (r) => ({ ...r, recorder });
  let report = withRecorder(backend ? await safeProbe(backend, log) : NO_BACKEND_REPORT('no desktop session was found for this helper (no display, or Wayland without portals)'));
  const baseHandleOp = createOpHandler(backend, { platform, recorder, ...(profileRoot ? { profileRoot } : {}) });
  // deps.wrapOp(handleOp) -> handleOp: the caller watches the ops (the app's
  // tray shows a recording).
  const handleOp = typeof deps.wrapOp === 'function' ? deps.wrapOp(baseHandleOp) : baseHandleOp;
  const recordingGuard = createRecordingGuard({ backend, log, ...(deps.timers ? { timers: deps.timers } : {}) });
  let attempt = 0;
  let exitCode = 0;
  let waitLogged = false;
  let connectFailLogged = false;

  while (!(signal && signal.aborted)) {
    let copy = null;
    try {
      copy = await readOnce();
    } catch (err) {
      if (!readCopy) {
        log.error(err.message);
        exitCode = 1;
        break;
      }
      // Once per run of failures, not on every retry; by code where there is one.
      if (!waitLogged) log.info(`waiting for the node's screen file (${(err && err.code) || (err && err.message) || 'unreadable'})`);
      waitLogged = true;
    }
    if (copy) await serveOnce(copy);
    if (signal && signal.aborted) break;
    await sleep(delays[Math.min(attempt, delays.length - 1)], signal);
    attempt += 1;
  }
  await recordingGuard.stop();
  if (backend && typeof backend.stop === 'function') await backend.stop().catch(() => {});
  if (logFile) logFile.close();
  return exitCode;

  // One connection, from connect to close. Never throws.
  async function serveOnce(copy) {
    try {
      const session = await connect({
        endpoint: copy.endpoint, secret: copy.secret, nodeId: copy.nodeId, user: os.userInfo().username, platform,
        pid: process.pid, helperVersion: HELPER_VERSION, probeReport: report, handleOp, log
      });
      // An abort while connect was pending: its listener would never fire on
      // an already-aborted signal, so close now and wait for nothing.
      if (signal && signal.aborted) {
        session.close('logout');
        return;
      }
      attempt = 0;
      waitLogged = false;
      connectFailLogged = false;
      recordingGuard.connected();
      onState({ connected: true });
      log.info('connected to the King Louie service');
      const watch = startSessionWatch(backend, {
        report, recorder, log, emit: (k, p) => session.sendEvent(k, p), reprobeMs: deps.reprobeMs, lockPollMs: deps.lockPollMs
      });
      await new Promise((resolve) => {
        const onAbort = () => { session.close('logout'); resolve(); };
        session.once('closed', () => {
          // Removed on a normal close, so listeners do not pile up across reconnects.
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        });
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
      watch.stop();
      report = watch.current();
      // A recording outlives a short drop; 30 s without the service ends it.
      recordingGuard.disconnected();
      onState({ connected: false });
      if (!(signal && signal.aborted)) log.warn('the service connection closed; reconnecting');
    } catch (err) {
      // With readCopy (the app waiting for its node) once per run of
      // failures, then debug; the fleet helper warns every time, as before.
      if (readCopy && connectFailLogged) log.debug(`not connected: ${err.message}`);
      else log.warn(`not connected: ${err.message}`);
      connectFailLogged = true;
    }
  }
}

module.exports = { runSessionHelper, defaultSessionFile, helperLogDir, RECONNECT_DELAYS, HELPER_VERSION };

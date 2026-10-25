// src/session/backends/windows.js
// The Windows backend (fleet stage 5 spec §3.3): one persistent PowerShell
// worker running C# through Add-Type, plus Node's own spawn for launches.
//
// Demo takes (spec 2026-10-24 §8, §9) add four ops: launch_browser (the
// take's Chrome, as the user, with a debugging port the service attaches to
// over CDP), record_start / record_stop (ffmpeg's gdigrab, as the user) and
// keep_awake (SetThreadExecutionState in the worker). A failed one answers
// with its error code alone: never the argv, a path or ffmpeg's stderr,
// which is drained and never read.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createLogger } = require('../../logging');
const { windowsPowerShellExe } = require('../../platform/windows-paths');
const { GuiError } = require('../../gui/errors');
const { LineWorker } = require('./line-worker');

const PORT_FILE = 'DevToolsActivePort';
const PORT_POLL_MS = 200;
const PORT_WAIT_MS = 10000;
const STOP_WAIT_MS = 15000;
const KILL_WAIT_MS = 2000;

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

// The service names a profile and a take; the helper, as the user, puts
// them under the user's own %LOCALAPPDATA%\KingLouie (the service, LOCAL
// SERVICE, cannot know where that is). The name rules make an escape
// impossible: no separator, no dot.
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TAKE_ID = /^take-[0-9a-f]{12}$/;

// Switches that would move the profile or the debugging endpoint the
// helper fixed (Chromium keeps the last of a repeated switch).
const RESERVED_SWITCHES = new Set(['user-data-dir', 'profile-directory', 'remote-debugging-port', 'remote-debugging-address', 'remote-debugging-pipe']);
function reservedSwitch(arg) {
  const m = /^-{1,2}([^=]*)/.exec(arg);
  return Boolean(m) && RESERVED_SWITCHES.has(m[1].trim().toLowerCase());
}

function kingLouieDir(env) {
  if (!env || typeof env.LOCALAPPDATA !== 'string' || !DRIVE_PATH.test(env.LOCALAPPDATA)) throw new GuiError('invalid_params');
  return path.win32.join(env.LOCALAPPDATA, 'KingLouie');
}

// Two lines: the port, then /devtools/browser/<id>. Anything else (not yet
// written, half written) is not an answer yet.
function parsePortFile(text) {
  const [portLine, pathLine] = String(text).split(/\r?\n/);
  if (!/^\d{1,5}$/.test(portLine || '')) return null;
  const port = Number(portLine);
  if (port < 1 || port > 65535) return null;
  if (typeof pathLine !== 'string' || !pathLine.startsWith('/devtools/browser/') || pathLine.length <= '/devtools/browser/'.length) return null;
  return { port, path: pathLine };
}

const evenSide = (n) => Number.isInteger(n) && n >= 16 && n <= 16384 && n % 2 === 0;

function createWindowsBackend({
  env = process.env, log = createLogger('session-helper/windows'), spawnImpl = spawn, workerFile = path.join(__dirname, 'windows-worker.ps1'),
  readFile = fs.promises.readFile, unlink = fs.promises.unlink, mkdir = fs.promises.mkdir, statSync = fs.statSync, clock = Date.now,
  timers = { setTimeout, clearTimeout }
} = {}) {
  const worker = new LineWorker({
    file: windowsPowerShellExe(env),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerFile],
    spawnImpl, env, log, name: 'windows-worker'
  });
  // Ref'd timers: a stop or a launch that is waiting keeps the helper alive.
  const sleep = (ms) => new Promise((resolve) => { timers.setTimeout(resolve, ms); });
  const settlesWithin = (promise, ms) => new Promise((resolve) => {
    const h = timers.setTimeout(() => resolve(false), ms);
    promise.then(() => { timers.clearTimeout(h); resolve(true); });
  });
  // Resolves once the child has started; rejects with `code` alone.
  const started = (child, code) => new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new GuiError(code)));
  });

  // pid -> { pid, child, path, startedAt, exited, code, endedAt, done }
  const recordings = new Map();
  // Stops under way, so stopRecordings (the helper ending) waits for them too.
  const stopping = new Set();

  function recordStop({ pid } = {}) {
    const rec = recordings.get(pid);
    if (!rec) return Promise.reject(new GuiError('unknown_recording'));
    recordings.delete(pid);
    const p = finish(rec);
    stopping.add(p);
    const forget = () => stopping.delete(p);
    p.then(forget, forget);
    return p;
  }

  async function finish(rec) {
    const duration = () => Math.round(((rec.endedAt === null ? clock() : rec.endedAt) - rec.startedAt) / 100) / 10;
    const bytes = () => {
      try { return statSync(rec.path).size; } catch { return 0; }
    };
    if (rec.exited) {
      // It ended before it was asked to: the file is whatever it left.
      return { path: rec.path, durationS: duration(), bytes: bytes(), truncated: rec.code !== 0, exited: true, code: rec.code };
    }
    try { rec.child.stdin.write('q\n'); } catch { /* it is going anyway */ }
    let truncated = false;
    if (!(await settlesWithin(rec.done, STOP_WAIT_MS))) {
      truncated = true;
      try { rec.child.kill(); } catch { /* gone */ }
      await settlesWithin(rec.done, KILL_WAIT_MS);
    }
    return { path: rec.path, durationS: duration(), bytes: bytes(), truncated };
  }

  return {
    name: 'windows',
    recordings,
    // The first call compiles the C#: allow it a minute.
    probe: () => worker.call('probe', {}, { timeoutMs: 60000 }),
    async launch({ exe, argv = [], files = [] }) {
      if (!/\.exe$/i.test(String(exe))) throw new GuiError('app_type_not_supported', 'only .exe files can be launched on Windows');
      // Not hidden (Deviation 17): the app's first window must show.
      const child = spawnImpl(exe, [...argv, ...files], { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', (err) => reject(new GuiError('file_not_found', err.message)));
      });
      child.unref();
      return { pid: child.pid };
    },
    async launchBrowser({ exe, profile, args = [] } = {}) {
      if (!/\.exe$/i.test(String(exe))) throw new GuiError('app_type_not_supported');
      if (typeof profile !== 'string' || !PROFILE_NAME.test(profile)) throw new GuiError('invalid_params');
      if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !reservedSwitch(a))) throw new GuiError('invalid_params');
      const profileDir = path.win32.join(kingLouieDir(env), 'browser-profiles', profile);
      try { await mkdir(profileDir, { recursive: true }); } catch { throw new GuiError('browser_launch_failed'); }
      const portFile = path.win32.join(profileDir, PORT_FILE);
      // A file left by an earlier run would hand back a dead port.
      try { await unlink(portFile); } catch { /* none there */ }
      // Like launch: detached and shown, the take's window is the demo.
      const child = spawnImpl(exe, [`--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...args],
        { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
      await started(child, 'browser_launch_failed');
      child.on('error', () => {});
      child.unref();
      const deadline = clock() + PORT_WAIT_MS;
      for (;;) {
        let cdp = null;
        try { cdp = parsePortFile(await readFile(portFile, 'utf8')); } catch { cdp = null; }
        if (cdp) return { pid: child.pid, cdp };
        if (clock() >= deadline) {
          try { child.kill(); } catch { /* gone */ }
          throw new GuiError('browser_launch_failed');
        }
        await sleep(PORT_POLL_MS);
      }
    },
    async recordStart({ ffmpeg = null, takeId, path: given = null, fps = 30, size = null } = {}) {
      if (typeof takeId !== 'string' || !TAKE_ID.test(takeId)) throw new GuiError('invalid_params');
      // Given, the path is the service's, already checked against the
      // session's working directory: used as it is, if absolute.
      if (given !== null && (typeof given !== 'string' || !DRIVE_PATH.test(given))) throw new GuiError('invalid_params');
      if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new GuiError('invalid_params');
      // libx264 with yuv420p needs even sides.
      if (size !== null && !(size && evenSide(size.width) && evenSide(size.height))) throw new GuiError('invalid_params');
      if (!ffmpeg) throw new GuiError('recorder_missing');
      if (!/\.exe$/i.test(String(ffmpeg))) throw new GuiError('app_type_not_supported');
      let out = given;
      if (out === null) {
        const dir = path.win32.join(kingLouieDir(env), 'recordings', takeId);
        try { await mkdir(dir, { recursive: true }); } catch { throw new GuiError('recorder_failed'); }
        out = path.win32.join(dir, 'take.mp4');
      }
      const args = ['-y', '-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop',
        ...(size ? ['-vf', `scale=${size.width}:${size.height}`] : []),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out];
      const child = spawnImpl(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, shell: false });
      const rec = { pid: null, child, path: out, startedAt: null, exited: false, code: null, endedAt: null, done: null };
      rec.done = new Promise((resolve) => {
        child.once('exit', (code) => {
          rec.exited = true;
          rec.code = code;
          rec.endedAt = clock();
          resolve();
        });
      });
      await started(child, 'recorder_failed');
      child.on('error', () => {});
      // ffmpeg writes its progress to stderr all along: drained, never read.
      if (child.stderr && typeof child.stderr.resume === 'function') child.stderr.resume();
      if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
      rec.pid = child.pid;
      rec.startedAt = clock();
      // A pid Windows gave again: the old entry is finalised first (an
      // exited one at once; a live one, which cannot be, stopped and
      // tracked), never overwritten unseen.
      if (recordings.has(rec.pid)) recordStop({ pid: rec.pid }).catch(() => {});
      recordings.set(rec.pid, rec);
      return { pid: rec.pid, startedAt: rec.startedAt, path: out };
    },
    recordStop,
    // Every live recording, at once (the service gone 30 s, the helper
    // stopping), and every stop already under way.
    async stopRecordings() {
      const inFlight = [...stopping];
      const results = await Promise.all([...recordings.keys()].map((pid) => recordStop({ pid }).catch(() => null)));
      await Promise.all(inFlight.map((p) => p.catch(() => null)));
      return results.filter(Boolean);
    },
    keepAwake: ({ on } = {}) => worker.call('keep_awake', { on: on === true }),
    processes: ({ match }) => worker.call('processes', { match }),
    windows: ({ pids }) => worker.call('windows', { pids }),
    foreground: () => worker.call('foreground'),
    focus: ({ handle }) => worker.call('focus', { handle }),
    close: ({ pids, force }) => worker.call('close', { pids, force }),
    screenshot: ({ handle, maxWidth, quality }) => worker.call('screenshot', { handle, maxWidth, quality }, { timeoutMs: 20000 }),
    input: ({ expect, action, yieldMs }) => worker.call('input', { expect, action, yieldMs }),
    releaseAll: () => worker.call('release_all'),
    locked: () => worker.call('locked'),
    hitTest: ({ x, y }) => worker.call('hit_test', { x, y }),
    stop: () => worker.stop()
  };
}

module.exports = { createWindowsBackend, parsePortFile, reservedSwitch, PROFILE_NAME, TAKE_ID };

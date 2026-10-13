# Fleet Stage 5: Session helper — Implementation Plan (Part 4 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

The header — Goal, Architecture, the owner's questions and rulings (2026-10-12), what was checked against main `532efcf`, **Global Constraints**, **Review Focus**, Interfaces from other stages, **Deviations** (1–44) and the task table with review weights — is in Part 1 (`2026-09-23-fleet-stage5-session-helper-part1.md`) and applies to every task here. Part 4 builds on Parts 1–3 (Tasks 1–14) on `feat/fleet-stage5`.

**This part:** the helper process and its OS backends. Task 15 the helper (`runSessionHelper`: file, backend selection, reconnect, re-probe, lock events, log file); Task 16 the Windows backend (PowerShell + C# P/Invoke worker); Task 17 the macOS backend (JXA worker, `open`, `screencapture`, `sips`); Task 18 the Linux backends (X11 through `xdotool`/`import`, Wayland launch-only).

Deviation 27 (listed in Part 1; restated for this part): **macOS typing of non-ASCII text.** §3.3 names `CGEventKeyboardSetUnicodeString` for text; its `const UniChar *` argument needs a buffer the JXA bridge does not document how to build. The macOS worker types ASCII characters with key codes (Accessibility only) and sends any non-ASCII run through `System Events` `keystroke` in the same worker call, which needs the Automation permission for System Events; the probe reports it (`check: 'automation'`), and without it a non-ASCII `Type` is refused `invalid_text: non-ASCII text needs the Automation permission`. The foreground, bounds, lock and human checks still run first in that same call.

Deviation 28 (listed in Part 1; restated for this part): **a read-only `hitTest` on each backend.** The backend tests must exercise the hit test without injecting input into the tester's desktop, so each backend also exposes `hitTest({ x, y }) → { handle, pid, image } | null`. It is not a `kl-session-v1` op; `createOpHandler` never routes to it.

Deviation 44 (listed in Part 1; new on 2026-10-12): **`readline` is not used for worker replies.** `LineWorker` splits its worker's output on `\n` itself (Task 16).

No owner ruling changes this part: the helper holds no policy, so scopes, jobs and case turns are all decided on the service side (Parts 2 and 3). The files this part touches outside `src/session/` (`src/service/log-file.js`, `src/platform/windows-paths.js`, `src/platform/paths.js`) are unchanged on main since the plan was written, except that `paths.js` gained an unrelated export.

---

### Task 15: The session helper process

**Review:** standard (the file checks it relies on are Task 5's; the channel it speaks is Task 7's). **On Windows:** the case "the per-user file is readable by others" is POSIX only and is skipped.

**Files:**
- Create: `src/session/helper.js`
- Create: `src/session/backends/index.js`
- Modify: `src/service/log-file.js` (`attachServiceLogFile(logsDir, { platform, name })`)
- Test: `tests/session-helper.test.js`

**Interfaces:**
- Consumes: `readUserCopy`, `userCopyPath` (Task 5); `connectToService`, `createOpHandler` (Task 7); `adminConfigDir`, `defaultServiceDataDir` (`src/platform/paths.js`); `attachServiceLogFile` (`src/service/log-file.js`).
- Produces:
  - `src/session/backends/index.js`: `selectBackend({ platform, env, xdpyinfoOk }) → 'windows' | 'macos' | 'x11' | 'wayland' | null`; `loadBackend(name, { env, log }) → backend` (lazy `require('./windows')` etc.); `NO_BACKEND_REPORT(reason) → probe report`.
  - `src/session/helper.js`: `runSessionHelper({ env = process.env, platform = process.platform, signal = null, sessionFile = null, deps = {} }) → Promise<exitCode>` (0 on logout/abort, 1 for `session_not_installed`/`session_file_insecure`); `defaultSessionFile({ platform, env, currentSid }) → path`; `helperLogDir({ platform, env }) → { dir, name }`; `HELPER_VERSION`; `RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]`. `deps`: `{ backend, selectBackend, connect, rootUid, getuid, delays, reprobeMs = 60000, lockPollMs = 2000, attachLog = true, log }`.
  - `attachServiceLogFile(logsDir, { platform, name = 'service.log' })`.

- [ ] **Step 1: Write the failing test**

Create `tests/session-helper.test.js`:

```js
// tests/session-helper.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { runSessionHelper, defaultSessionFile, helperLogDir, RECONNECT_DELAYS } = require('../src/session/helper');
const { selectBackend } = require('../src/session/backends');
const { HelperChannel } = require('../src/gui/helper-channel');
const S = require('../src/gui/session-secret');
const { setLogLevel } = require('../src/logging');
const { holdEventLoop } = require('./helpers/hold-event-loop');

setLogLevel('fatal');
const release = holdEventLoop();
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); release(); });

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const GID = POSIX ? process.getgid() : 0;
const NODE_ID = 'kl-hnef32472qzibi5r';
const USER = os.userInfo().username;

function setup() {
  // Native realpath: writeUserCopy requires the config dir to be its own
  // native realpath, and a Windows CI TEMP is an 8.3 short path.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-helper-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  const endpoint = POSIX ? path.join(base, 'h.sock') : `\\\\.\\pipe\\kl-helper-test-${crypto.randomBytes(6).toString('hex')}`;
  return { base, configDir, endpoint };
}

function writeCopy({ configDir, endpoint, secret = crypto.randomBytes(32) }) {
  const sid = POSIX ? null : 'S-1-5-21-1-2-3-1001';
  const file = S.writeUserCopy({
    platform: process.platform, configDir, user: USER, uid: UID, gid: GID, sid,
    content: { v: 1, node_id: NODE_ID, endpoint, secret: secret.toString('hex'), rotated_at: new Date().toISOString() },
    runIcacls: () => {}
  });
  return { file, secret };
}

function fakeBackend(reports) {
  const calls = [];
  let i = 0;
  let locked = false;
  return {
    calls,
    setLocked(v) { locked = v; },
    probe: async () => { const r = reports[Math.min(i, reports.length - 1)]; i += 1; return r; },
    foreground: async () => { calls.push('foreground'); return { handle: '1', pid: 2, image: '/usr/bin/gedit' }; },
    locked: async () => locked,
    stop: async () => { calls.push('stop'); }
  };
}

const REPORT = { capabilities: ['gui.launch', 'gui.input'], probes: [], displays: [], limits: [], locked: false };

async function channelFor(endpoint, secretRef) {
  const channel = new HelperChannel({ endpoint, readSecret: () => ({ secret: secretRef.secret, nodeId: NODE_ID, sessionUser: USER, mtimeMs: 1 }), pingMs: 60000 });
  await channel.start();
  cleanups.push(() => channel.stop());
  return channel;
}

const quick = { delays: [20, 20, 20], rootUid: UID, attachLog: false };

describe('runSessionHelper', () => {
  it('exits 1 when the per-user file is missing', async () => {
    const { base } = setup();
    assert.equal(await runSessionHelper({ sessionFile: path.join(base, 'nope.json'), deps: { ...quick, backend: fakeBackend([REPORT]) } }), 1);
  });

  it('exits 1 when the per-user file is readable by others', { skip: !POSIX }, async () => {
    const { configDir, endpoint } = setup();
    const { file } = writeCopy({ configDir, endpoint });
    fs.chmodSync(file, 0o644);
    assert.equal(await runSessionHelper({ sessionFile: file, deps: { ...quick, backend: fakeBackend([REPORT]) } }), 1);
  });

  it('connects, serves ops through its backend, and exits 0 on logout', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    const backend = fakeBackend([REPORT]);
    const ac = new AbortController();
    const ready = once(channel, 'ready');
    const done = runSessionHelper({ sessionFile: file, signal: ac.signal, deps: { ...quick, backend } });
    const [info] = await ready;
    assert.deepEqual(info.capabilities, REPORT.capabilities);
    assert.equal((await channel.request('foreground', {})).image, '/usr/bin/gedit');
    ac.abort();
    assert.equal(await done, 0);
    assert.ok(backend.calls.includes('stop'));
  });

  it('reconnects after a drop, re-reading its file (a rotated secret)', async () => {
    const { configDir, endpoint } = setup();
    const first = writeCopy({ configDir, endpoint });
    const secretRef = { secret: first.secret };
    const channel = await channelFor(endpoint, secretRef);
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    let ready = once(channel, 'ready');
    runSessionHelper({ sessionFile: first.file, signal: ac.signal, deps: { ...quick, backend: fakeBackend([REPORT]) } });
    await ready;
    const rotated = writeCopy({ configDir, endpoint });
    secretRef.secret = rotated.secret;
    ready = once(channel, 'ready');
    channel.current.socket.destroy();
    await ready;
    assert.equal(channel.connected, true);
  });

  it('re-probes and withdraws a sub-capability that stopped working; reports lock changes', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    const backend = fakeBackend([REPORT, { ...REPORT, capabilities: ['gui.launch'] }]);
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const ready = once(channel, 'ready');
    // Listening before the helper starts: the first re-probe comes 30 ms after it connects.
    const changed = new Promise((resolve) => channel.on('event', (kind) => { if (kind === 'probe_changed') resolve(); }));
    runSessionHelper({ sessionFile: file, signal: ac.signal, deps: { ...quick, backend, reprobeMs: 30, lockPollMs: 20 } });
    await ready;
    await changed;
    assert.deepEqual(channel.info.capabilities, ['gui.launch']);
    const locked = new Promise((resolve) => channel.on('event', (kind) => { if (kind === 'locked') resolve(); }));
    backend.setLocked(true);
    await locked;
    assert.equal(channel.info.locked, true);
  });

  it('with no backend it still connects and reports why', async () => {
    const { configDir, endpoint } = setup();
    const { file, secret } = writeCopy({ configDir, endpoint });
    const channel = await channelFor(endpoint, { secret });
    const ac = new AbortController();
    cleanups.push(() => ac.abort());
    const ready = once(channel, 'ready');
    runSessionHelper({ sessionFile: file, signal: ac.signal, platform: 'linux', env: {}, deps: { ...quick, backend: null } });
    const [info] = await ready;
    assert.deepEqual(info.capabilities, []);
    assert.equal(info.probes[0].ok, false);
    assert.match(info.probes[0].hint, /no desktop session/i);
  });
});

describe('paths and selection', () => {
  it('backoff is 1, 2, 5, 10, 30 s', () => {
    assert.deepEqual(RECONNECT_DELAYS, [1000, 2000, 5000, 10000, 30000]);
  });

  it('the default file is the admin copy for this user; the log dir is per OS', () => {
    assert.equal(defaultSessionFile({ platform: 'linux', env: {}, user: 'alice' }), '/etc/king-louie/session/users/alice.json');
    assert.equal(defaultSessionFile({ platform: 'darwin', env: {}, user: 'alice' }), '/Library/Application Support/KingLouie/config/session/users/alice.json');
    assert.equal(defaultSessionFile({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData' }, currentSid: () => 'S-1-5-21-1-2-3-1001' }),
      'C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json');
    assert.deepEqual(helperLogDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' } }), { dir: 'C:\\Users\\alice\\AppData\\Local\\KingLouie\\session\\logs', name: 'helper.log' });
    assert.deepEqual(helperLogDir({ platform: 'darwin', env: { HOME: '/Users/alice' } }), { dir: '/Users/alice/Library/Logs/KingLouie', name: 'session.log' });
    assert.deepEqual(helperLogDir({ platform: 'linux', env: { HOME: '/home/alice' } }), { dir: '/home/alice/.local/state/king-louie', name: 'session.log' });
  });

  it('selects the backend per OS; Linux prefers Wayland even with DISPLAY set', () => {
    assert.equal(selectBackend({ platform: 'win32', env: {} }), 'windows');
    assert.equal(selectBackend({ platform: 'darwin', env: {} }), 'macos');
    assert.equal(selectBackend({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'wayland');
    assert.equal(selectBackend({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'wayland');
    assert.equal(selectBackend({ platform: 'linux', env: { DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'x11');
    assert.equal(selectBackend({ platform: 'linux', env: { DISPLAY: ':0' }, xdpyinfoOk: () => false }), null);
    assert.equal(selectBackend({ platform: 'linux', env: {} }), null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-helper.test.js`
Expected: FAIL with `Cannot find module '../src/session/helper'`.

- [ ] **Step 3: Add `{ name }` to the log file helper**

In `src/service/log-file.js`, change the signature and the file name:

```js
function attachServiceLogFile(logsDir, { platform = process.platform, name = SERVICE_LOG_NAME } = {}) {
  const file = path.join(logsDir, name);
```

(The rest is unchanged; existing callers pass no `name`.)

- [ ] **Step 4: Write `src/session/backends/index.js`**

```js
// src/session/backends/index.js
// Which OS backend the session helper uses (fleet stage 5 spec §3.3).
// Linux: Wayland first, so XWayland's DISPLAY never selects X11.
const fs = require('fs');
const { execFileSync } = require('child_process');

function defaultXdpyinfoOk(env) {
  if (!fs.existsSync('/usr/bin/xdpyinfo')) return false;
  try {
    execFileSync('/usr/bin/xdpyinfo', [], { stdio: 'ignore', env, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function selectBackend({ platform = process.platform, env = process.env, xdpyinfoOk = defaultXdpyinfoOk } = {}) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform !== 'linux') return null;
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY && xdpyinfoOk(env)) return 'x11';
  return null;
}

function loadBackend(name, { env = process.env, log } = {}) {
  switch (name) {
    case 'windows': return require('./windows').createWindowsBackend({ env, log });
    case 'macos': return require('./macos').createMacosBackend({ env, log });
    case 'x11': return require('./x11').createX11Backend({ env, log });
    case 'wayland': return require('./wayland').createWaylandBackend({ env, log });
    default: return null;
  }
}

function NO_BACKEND_REPORT(reason) {
  return { capabilities: [], probes: [{ check: 'desktop', ok: false, hint: reason }], displays: [], limits: [], locked: false };
}

module.exports = { selectBackend, loadBackend, NO_BACKEND_REPORT };
```

- [ ] **Step 5: Write `src/session/helper.js`**

```js
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
const { readUserCopy, userCopyPath } = require('../gui/session-secret');
const { connectToService, createOpHandler } = require('./connection');
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
  const connect = deps.connect || connectToService;
  const delays = deps.delays || RECONNECT_DELAYS;
  let file;
  try {
    file = sessionFile || env.KL_SESSION_FILE || defaultSessionFile({ platform, env });
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
  let attempt = 0;
  let exitCode = 0;

  while (!(signal && signal.aborted)) {
    let copy;
    try {
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
      if (!(signal && signal.aborted)) log.warn('the service connection closed; reconnecting');
    } catch (err) {
      log.warn(`not connected: ${err.message}`);
    }
    if (signal && signal.aborted) break;
    await sleep(delays[Math.min(attempt, delays.length - 1)], signal);
    attempt += 1;
  }
  if (backend && typeof backend.stop === 'function') await backend.stop().catch(() => {});
  if (logFile) logFile.close();
  return exitCode;
}

module.exports = { runSessionHelper, defaultSessionFile, helperLogDir, RECONNECT_DELAYS, HELPER_VERSION };
```

Notes:
- `hello.user` is `os.userInfo().username`; `session install` stores the same bare name (Task 20), and the channel compares case-insensitively on Windows (Task 7).
- At logout the OS ends the helper's process tree; the CLI (Task 20) wires `SIGTERM`/`SIGINT`/`SIGHUP` to the abort signal so the exit is 0.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/session-helper.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/session/helper.js src/session/backends/index.js src/service/log-file.js tests/session-helper.test.js
git commit -m "feat(session): the session helper process and backend selection

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: The Windows backend

**Review:** trust (the checks and the injection run in one worker call here; a wrong check types into the wrong window). **On Windows:** all of it runs, the real PowerShell/C# worker included. The worker calls no `Microsoft.PowerShell.Security` cmdlet (CLAUDE.md, Testing: those fail to load in a Windows PowerShell child of a pwsh 7 CI step); it uses `Add-Type` and framework types only, and must stay that way.

**Files:**
- Create: `src/session/backends/line-worker.js`
- Create: `src/session/backends/windows.js`
- Create: `src/session/backends/windows-worker.ps1`
- Test: `tests/session-backend-windows.test.js`

**Interfaces:**
- Consumes: `windowsPowerShellExe` (`src/platform/windows-paths.js`); `GuiError`, `fromWire` (Task 1).
- Produces:
  - `src/session/backends/line-worker.js`: `class LineWorker { constructor({ file, args, spawnImpl = spawn, env, log, name }); call(op, params = {}, { timeoutMs = 25000 } = {}) → Promise; stop() → Promise }` — one JSON object per line each way, `{ id, op, params }` → `{ id, ok, result | error }`; a line ends at `\n` and nowhere else (Deviation 44); starts lazily and restarts after a crash; `shell: false`, `windowsHide: true`.
  - `src/session/backends/windows.js`: `createWindowsBackend({ env, log, spawnImpl, workerFile }) → backend` implementing §3.3's interface plus `hitTest({ x, y })` (Deviation 28). `launch` spawns `exe` itself (`detached: true`, `windowsHide: false`, Deviation 17).
  - `windows-worker.ps1`: ops `probe`, `processes`, `windows`, `foreground`, `focus`, `close`, `screenshot`, `input`, `release_all`, `locked`, `hit_test`.

- [ ] **Step 1: Write the failing test**

Create `tests/session-backend-windows.test.js`:

```js
// tests/session-backend-windows.test.js
//
// The real PowerShell/C# worker, on Windows only. Nothing here injects
// input: the input call is made to fail its checks before injection.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { LineWorker } = require('../src/session/backends/line-worker');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const WIN = process.platform === 'win32';

describe('LineWorker (any OS, with a fake child)', () => {
  function fakeSpawn(reply) {
    const calls = [];
    const spawnImpl = (file, args, opts) => {
      calls.push({ file, args, opts });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('exit', 0);
      child.stdin.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          child.stdout.write(`${JSON.stringify(reply(req))}\n`);
        }
      });
      return child;
    };
    return { calls, spawnImpl };
  }

  it('correlates replies by id, maps errors, spawns argv-only and hidden', async () => {
    const { calls, spawnImpl } = fakeSpawn((req) => (req.op === 'boom'
      ? { id: req.id, ok: false, error: { code: 'point_obscured', message: 'x', detail: { pid: 3 } } }
      : { id: req.id, ok: true, result: { op: req.op, params: req.params } }));
    const w = new LineWorker({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-File', 'w.ps1'], spawnImpl });
    assert.deepEqual(await w.call('foreground'), { op: 'foreground', params: {} });
    await assert.rejects(w.call('boom'), (e) => e.code === 'point_obscured' && e.info.pid === 3);
    assert.equal(calls.length, 1, 'one worker for many calls');
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.windowsHide, true);
    await w.stop();
  });

  it('a reply with U+2028 or U+2029 inside a string is still one line', async () => {
    // JSON.stringify leaves both raw; node:readline would end the line at each.
    const { spawnImpl } = fakeSpawn((req) => ({ id: req.id, ok: true, result: { title: 'a b c' } }));
    const w = new LineWorker({ file: 'x', args: [], spawnImpl });
    assert.deepEqual(await w.call('windows', {}, { timeoutMs: 500 }), { title: 'a b c' });
    await w.stop();
  });

  it('a worker that dies fails what is in flight and restarts on the next call', async () => {
    let child;
    const spawnImpl = () => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      return child;
    };
    const w = new LineWorker({ file: 'x', args: [], spawnImpl });
    const pending = w.call('foreground');
    child.emit('exit', 1);
    await assert.rejects(pending, (e) => e.code === 'backend_failed');
    const again = w.call('foreground', {}, { timeoutMs: 50 });
    await assert.rejects(again, (e) => e.code === 'op_timeout');
  });
});

describe('Windows worker', { skip: !WIN }, () => {
  const { createWindowsBackend } = require('../src/session/backends/windows');
  const backend = WIN ? createWindowsBackend({}) : null;
  after(() => backend && backend.stop());

  it('probes itself', async () => {
    const r = await backend.probe();
    assert.ok(Array.isArray(r.capabilities));
    assert.ok(r.capabilities.every((c) => ['gui.launch', 'gui.screenshot', 'gui.input'].includes(c)));
    assert.ok(r.probes.every((p) => typeof p.check === 'string' && typeof p.ok === 'boolean'));
    assert.ok(Array.isArray(r.displays));
    assert.deepEqual(r.limits, []);
    assert.equal(typeof r.locked, 'boolean');
  });

  it('finds this node process by a bare image name', async () => {
    const found = await backend.processes({ match: ['node.exe'] });
    assert.ok(found.some((p) => p.pid === process.pid && /node\.exe$/i.test(p.image)));
  });

  it('reads the foreground window and hit-tests its centre', async () => {
    const fg = await backend.foreground();
    if (!fg || !fg.bounds) return;
    assert.equal(typeof fg.image, 'string');
    const hit = await backend.hitTest({ x: fg.bounds.x + Math.floor(fg.bounds.w / 2), y: fg.bounds.y + Math.floor(fg.bounds.h / 2) });
    assert.ok(hit === null || Number.isInteger(hit.pid));
  });

  it('refuses before injecting when the foreground is not leased', async () => {
    await assert.rejects(
      backend.input({ expect: { match: ['kl-no-such-app.exe'], pids: [0] }, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 }),
      (e) => e.code === 'foreground_mismatch' || e.code === 'screen_locked'
    );
  });

  it('a window that is gone is stale_screenshot', async () => {
    await assert.rejects(backend.screenshot({ handle: '1', maxWidth: 320, quality: 50 }), (e) => e.code === 'stale_screenshot');
  });

  it('launch refuses anything but an .exe', async () => {
    await assert.rejects(backend.launch({ exe: 'C:\\Windows\\System32\\cmd.bat', argv: [], files: [] }), (e) => e.code === 'app_type_not_supported');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-backend-windows.test.js`
Expected: FAIL with `Cannot find module '../src/session/backends/line-worker'`.

- [ ] **Step 3: Write `src/session/backends/line-worker.js`**

```js
// src/session/backends/line-worker.js
// A persistent OS worker spoken to in JSON lines (fleet stage 5 spec §3.3):
// op data travels on stdin, never in argv or script text.
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { createLogger } = require('../../logging');
const { GuiError, fromWire } = require('../../gui/errors');

// A reply is at most one sealed frame's worth (8 MiB); twice that with no
// newline is a worker gone wrong, and its output is dropped.
const MAX_LINE = 16 * 1024 * 1024;

// One callback per '\n'-terminated line. Not node:readline: that also ends a
// line at U+2028 and U+2029, which a worker's JSON may hold raw inside a
// string (a window title), and a reply cut there would be dropped.
function onLines(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line) onLine(line);
      end = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_LINE) buffer = '';
  });
}

class LineWorker {
  constructor({ file, args = [], spawnImpl = spawn, env = process.env, log = createLogger('session-helper/worker'), name = 'worker' } = {}) {
    Object.assign(this, { file, args, spawnImpl, env, log, name });
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  _start() {
    const child = this.spawnImpl(this.file, this.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: this.env });
    this.child = child;
    onLines(child.stdout, (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log.debug(`${this.name}: unparseable line`);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === true) p.resolve(msg.result === undefined ? null : msg.result);
      else p.reject(fromWire(msg.error));
    });
    if (child.stderr) onLines(child.stderr, (line) => this.log.debug(`${this.name}: ${line}`));
    child.on('error', (err) => this._fail(`${this.name} could not start: ${err.message}`));
    child.on('exit', (code) => this._fail(`${this.name} exited (${code})`));
    if (child.stdin) child.stdin.on('error', () => {});
  }

  _fail(why) {
    this.child = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new GuiError('backend_failed', why));
    }
    this.pending.clear();
  }

  call(op, params = {}, { timeoutMs = 25000 } = {}) {
    if (!this.child) this._start();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GuiError('op_timeout', `${this.name} ${op}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch { /* gone */ }
      try { child.kill(); } catch { /* gone */ }
    }
  }
}

module.exports = { LineWorker };
```

- [ ] **Step 4: Write `src/session/backends/windows-worker.ps1`**

```powershell
# src/session/backends/windows-worker.ps1
# The King Louie session helper's Windows worker (fleet stage 5 spec §3.3).
# One JSON op per line on stdin, one JSON reply per line on stdout. Op data is
# parsed by the C# below and never becomes script text. Every input call runs
# its checks and the injection in one call: not locked, the foreground is a
# leased process, every point inside the window and over a leased window, no
# human input within yield_ms, inject, read the foreground again.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -ReferencedAssemblies System.Drawing, System.Web.Extensions, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace KingLouie {
  public class OpError : Exception {
    public string Code;
    public Dictionary<string, object> Detail;
    public OpError(string code, string message) : base(message) { Code = code; Detail = new Dictionary<string, object>(); }
    public OpError(string code, string message, Dictionary<string, object> detail) : base(message) { Code = code; Detail = detail ?? new Dictionary<string, object>(); }
  }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }

  public static class Native {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  }

  public static class Worker {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static uint lastInjection = 0;
    static readonly Dictionary<string, ushort> Vk = new Dictionary<string, ushort> {
      { "enter", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "backspace", 0x08 }, { "delete", 0x2E }, { "insert", 0x2D },
      { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 }, { "up", 0x26 }, { "down", 0x28 },
      { "left", 0x25 }, { "right", 0x27 }, { "space", 0x20 }, { "-", 0xBD }, { "=", 0xBB }, { "[", 0xDB }, { "]", 0xDD },
      { "\\", 0xDC }, { ";", 0xBA }, { "'", 0xDE }, { ",", 0xBC }, { ".", 0xBE }, { "/", 0xBF }, { "`", 0xC0 }
    };

    public static string Handle(string line) {
      object id = null;
      try {
        var req = (Dictionary<string, object>)Json.DeserializeObject(line);
        id = req.ContainsKey("id") ? req["id"] : null;
        var op = (string)req["op"];
        var p = req.ContainsKey("params") && req["params"] is Dictionary<string, object> ? (Dictionary<string, object>)req["params"] : new Dictionary<string, object>();
        return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", Dispatch(op, p) } });
      } catch (OpError e) {
        return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", new Dictionary<string, object> { { "code", e.Code }, { "message", e.Message }, { "detail", e.Detail } } } });
      } catch (Exception e) {
        return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", new Dictionary<string, object> { { "code", "backend_failed" }, { "message", e.Message }, { "detail", new Dictionary<string, object>() } } } });
      }
    }

    static object Dispatch(string op, Dictionary<string, object> p) {
      switch (op) {
        case "probe": return Probe();
        case "processes": return Processes(Strings(p, "match"));
        case "windows": return Windows(Ints(p, "pids"));
        case "foreground": return ForegroundInfo();
        case "focus": return Focus(HandleOf(p, "handle"));
        case "close": return Close(Ints(p, "pids"), Bool(p, "force"));
        case "screenshot": return Screenshot(HandleOf(p, "handle"), Int(p, "maxWidth", 1280), Int(p, "quality", 70));
        case "input": return Input(p);
        case "release_all": ReleaseAll(); return null;
        case "locked": return Locked();
        case "hit_test": return HitTest(new POINT(Int(p, "x", 0), Int(p, "y", 0)));
        default: throw new OpError("unknown_op", op);
      }
    }

    // ── JSON helpers ────────────────────────────────────────────────────────
    static List<string> Strings(Dictionary<string, object> p, string k) {
      var l = new List<string>();
      if (p.ContainsKey(k) && p[k] is object[]) foreach (var o in (object[])p[k]) if (o is string) l.Add((string)o);
      return l;
    }
    static List<int> Ints(Dictionary<string, object> p, string k) {
      var l = new List<int>();
      if (p.ContainsKey(k) && p[k] is object[]) foreach (var o in (object[])p[k]) if (o is int || o is long || o is decimal) l.Add(Convert.ToInt32(o));
      return l;
    }
    static int Int(Dictionary<string, object> p, string k, int def) { return p.ContainsKey(k) && p[k] != null ? Convert.ToInt32(p[k]) : def; }
    static bool Bool(Dictionary<string, object> p, string k) { return p.ContainsKey(k) && p[k] is bool && (bool)p[k]; }
    static int[] Pair(Dictionary<string, object> p, string k) {
      if (!p.ContainsKey(k) || !(p[k] is object[]) || ((object[])p[k]).Length != 2) throw new OpError("invalid_params", k);
      var a = (object[])p[k];
      return new[] { Convert.ToInt32(a[0]), Convert.ToInt32(a[1]) };
    }
    static IntPtr HandleOf(Dictionary<string, object> p, string k) {
      long v;
      if (!p.ContainsKey(k) || !long.TryParse(Convert.ToString(p[k]), out v)) throw new OpError("stale_screenshot", "no window handle");
      return new IntPtr(v);
    }

    // ── processes and windows ───────────────────────────────────────────────
    static string ImageOf(uint pid) {
      IntPtr h = Native.OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return "";
      try { var sb = new StringBuilder(1024); int size = sb.Capacity; return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : ""; }
      finally { Native.CloseHandle(h); }
    }
    static uint PidOf(IntPtr hwnd) { uint pid; Native.GetWindowThreadProcessId(hwnd, out pid); return pid; }
    // UWP apps: the frame belongs to ApplicationFrameHost.exe; the app is the child CoreWindow's process.
    static uint AppPidOf(IntPtr hwnd) {
      uint pid = PidOf(hwnd);
      if (!ImageOf(pid).EndsWith("\\ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return pid;
      uint found = pid;
      Native.EnumChildWindows(hwnd, (child, l) => { uint c = PidOf(child); if (c != pid) { found = c; return false; } return true; }, IntPtr.Zero);
      return found;
    }
    static Dictionary<string, object> Bounds(IntPtr hwnd) {
      RECT r;
      if (Native.DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) throw new OpError("stale_screenshot", "the window is gone");
      return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "w", r.Right - r.Left }, { "h", r.Bottom - r.Top } };
    }
    static double Scale(IntPtr hwnd) { try { uint dpi = Native.GetDpiForWindow(hwnd); return dpi > 0 ? dpi / 96.0 : 1.0; } catch { return 1.0; } }
    static bool Matches(string image, List<string> patterns) {
      if (string.IsNullOrEmpty(image)) return false;
      foreach (var raw in patterns) {
        bool bare = raw.IndexOf('\\') < 0 && raw.IndexOf('/') < 0;
        string target = bare ? Path.GetFileName(image) : image;
        string rx = "^" + Regex.Escape(raw).Replace("\\*", ".*").Replace("\\?", ".") + "$";
        if (Regex.IsMatch(target, rx, RegexOptions.IgnoreCase)) return true;
      }
      return false;
    }
    static List<IntPtr> TopWindows() {
      var l = new List<IntPtr>();
      Native.EnumWindows((h, x) => { if (Native.IsWindowVisible(h) && Native.GetWindow(h, 4) == IntPtr.Zero) l.Add(h); return true; }, IntPtr.Zero);
      return l;
    }
    static object Processes(List<string> match) {
      var list = new List<object>();
      int session = Process.GetCurrentProcess().SessionId;
      foreach (var p in Process.GetProcesses()) {
        try {
          if (p.SessionId != session) continue;
          string image = ImageOf((uint)p.Id);
          if (Matches(image, match)) list.Add(new Dictionary<string, object> { { "pid", p.Id }, { "image", image } });
        } catch { }
      }
      return list;
    }
    static object Windows(List<int> pids) {
      var list = new List<object>();
      foreach (var h in TopWindows()) {
        uint pid = AppPidOf(h);
        if (!pids.Contains((int)pid)) continue;
        Dictionary<string, object> b;
        try { b = Bounds(h); } catch { continue; }
        var sb = new StringBuilder(512);
        Native.GetWindowText(h, sb, 512);
        list.Add(new Dictionary<string, object> { { "handle", h.ToInt64().ToString() }, { "pid", (int)pid }, { "image", ImageOf(pid) }, { "title", sb.ToString() }, { "bounds", b }, { "scale", Scale(h) }, { "minimized", Native.IsIconic(h) } });
      }
      return list;
    }
    static Dictionary<string, object> ForegroundInfo() {
      IntPtr h = Native.GetForegroundWindow();
      if (h == IntPtr.Zero) return null;
      uint pid = AppPidOf(h);
      Dictionary<string, object> b = null;
      try { b = Bounds(h); } catch { }
      return new Dictionary<string, object> { { "handle", h.ToInt64().ToString() }, { "pid", (int)pid }, { "image", ImageOf(pid) }, { "bounds", b }, { "scale", Scale(h) } };
    }
    static Dictionary<string, object> Brief(Dictionary<string, object> w) {
      return w == null ? null : new Dictionary<string, object> { { "image", w["image"] }, { "pid", w["pid"] } };
    }
    static object HitTest(POINT pt) {
      IntPtr under = Native.GetAncestor(Native.WindowFromPoint(pt), 2);
      if (under == IntPtr.Zero) return null;
      uint pid = AppPidOf(under);
      return new Dictionary<string, object> { { "handle", under.ToInt64().ToString() }, { "pid", (int)pid }, { "image", ImageOf(pid) } };
    }
    static object Focus(IntPtr h) {
      if (!Native.IsWindow(h)) throw new OpError("stale_screenshot", "the window is gone");
      if (Native.IsIconic(h)) Native.ShowWindow(h, 9);
      return new Dictionary<string, object> { { "focused", Native.SetForegroundWindow(h) } };
    }
    static object Close(List<int> pids, bool force) {
      var closed = new List<object>();
      foreach (int pid in pids) {
        try {
          if (force) { Process.GetProcessById(pid).Kill(); closed.Add(pid); continue; }
          bool any = false;
          foreach (var h in TopWindows()) if (AppPidOf(h) == (uint)pid) { Native.PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); any = true; }
          if (any) closed.Add(pid);
        } catch { }
      }
      return new Dictionary<string, object> { { "closed", closed } };
    }

    // ── screenshots ─────────────────────────────────────────────────────────
    static object Screenshot(IntPtr h, int maxWidth, int quality) {
      if (!Native.IsWindow(h)) throw new OpError("stale_screenshot", "the window is gone");
      if (Native.IsIconic(h)) throw new OpError("window_minimized", "restore the window first");
      if (Locked()) throw new OpError("screen_locked", "the screen is locked");
      var b = Bounds(h);
      int w = (int)b["w"], ht = (int)b["h"];
      if (w <= 0 || ht <= 0) throw new OpError("window_minimized", "the window has no size");
      using (var full = new Bitmap(w, ht, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(full)) {
          IntPtr hdc = g.GetHdc();
          try { if (!Native.PrintWindow(h, hdc, 2)) throw new OpError("backend_failed", "PrintWindow failed"); }
          finally { g.ReleaseHdc(hdc); }
        }
        int outW = Math.Min(w, Math.Max(1, maxWidth));
        int outH = Math.Max(1, (int)Math.Round(ht * (double)outW / w));
        using (var scaled = new Bitmap(outW, outH)) {
          using (var g2 = Graphics.FromImage(scaled)) { g2.InterpolationMode = InterpolationMode.HighQualityBicubic; g2.DrawImage(full, 0, 0, outW, outH); }
          var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
          var ps = new EncoderParameters(1);
          ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
          using (var ms = new MemoryStream()) {
            scaled.Save(ms, codec, ps);
            return new Dictionary<string, object> {
              { "mime", "image/jpeg" }, { "width", outW }, { "height", outH }, { "data", Convert.ToBase64String(ms.ToArray()) },
              { "transform", new Dictionary<string, object> { { "sx", (double)w / outW }, { "sy", (double)ht / outH }, { "unit", "px" } } }
            };
          }
        }
      }
    }

    // ── lock and input ──────────────────────────────────────────────────────
    public static bool Locked() {
      IntPtr d = Native.OpenInputDesktop(0, false, 0x0100);
      if (d == IntPtr.Zero) return true;
      try {
        var sb = new StringBuilder(256);
        int needed;
        if (!Native.GetUserObjectInformation(d, 2, sb, sb.Capacity * 2, out needed)) return true;
        return !string.Equals(sb.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
      } finally { Native.CloseDesktop(d); }
    }

    static Dictionary<string, object> Detail(Dictionary<string, object> fg) {
      return fg == null ? new Dictionary<string, object>() : new Dictionary<string, object> { { "image", fg["image"] }, { "pid", fg["pid"] } };
    }

    static object Input(Dictionary<string, object> p) {
      var expect = p.ContainsKey("expect") && p["expect"] is Dictionary<string, object> ? (Dictionary<string, object>)p["expect"] : new Dictionary<string, object>();
      var match = Strings(expect, "match");
      var pids = Ints(expect, "pids");
      if (!(p.ContainsKey("action") && p["action"] is Dictionary<string, object>)) throw new OpError("invalid_params", "action");
      var action = (Dictionary<string, object>)p["action"];
      int yieldMs = Int(p, "yieldMs", 2000);
      string kind = Convert.ToString(action["kind"]);

      if (Locked()) throw new OpError("screen_locked", "the screen is locked");
      var fg = ForegroundInfo();
      if (fg == null || !pids.Contains((int)fg["pid"]) || !Matches((string)fg["image"], match)) {
        throw new OpError("foreground_mismatch", "the foreground window is not a leased app", Detail(fg));
      }
      var points = new List<POINT>();
      if (kind == "click" || kind == "scroll" || kind == "drag") {
        IntPtr target = HandleOf(action, "handle");
        if (!Native.IsWindow(target)) throw new OpError("stale_screenshot", "the window is gone");
        if (!pids.Contains((int)AppPidOf(target))) throw new OpError("foreground_mismatch", "the target window is not a leased app", Detail(fg));
        var b = Bounds(target);
        int ox = (int)b["x"], oy = (int)b["y"], bw = (int)b["w"], bh = (int)b["h"];
        var rels = kind == "drag" ? new[] { Pair(action, "from"), Pair(action, "to") } : new[] { Pair(action, "rel") };
        foreach (var r in rels) {
          if (r[0] < 0 || r[1] < 0 || r[0] >= bw || r[1] >= bh) throw new OpError("outside_window", "the point is outside the window");
          points.Add(new POINT(ox + r[0], oy + r[1]));
        }
        foreach (var pt in points) {
          IntPtr under = Native.GetAncestor(Native.WindowFromPoint(pt), 2);
          if (under == IntPtr.Zero || !pids.Contains((int)AppPidOf(under))) throw new OpError("point_obscured", "another window covers that point");
        }
      }
      var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
      if (Native.GetLastInputInfo(ref info)) {
        uint now = (uint)Environment.TickCount;
        bool afterUs = lastInjection == 0 || info.dwTime > lastInjection + 50;
        if (afterUs && unchecked(now - info.dwTime) < (uint)yieldMs) throw new OpError("user_active", "someone is using the keyboard or mouse");
      }
      switch (kind) {
        case "click": Click(points[0], action); break;
        case "type": TypeText(Convert.ToString(action["text"])); break;
        case "key": KeyPress(action); break;
        case "scroll": Scroll(points[0], action); break;
        case "drag": Drag(points[0], points[1], action); break;
        default: throw new OpError("invalid_params", "unknown action");
      }
      lastInjection = (uint)Environment.TickCount;
      System.Threading.Thread.Sleep(60);
      return new Dictionary<string, object> { { "foregroundBefore", Brief(fg) }, { "foregroundAfter", Brief(ForegroundInfo()) } };
    }

    static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }
    static INPUT KeyInput(ushort vk, bool up) {
      uint flags = (up ? 0x0002u : 0u) | (Extended(vk) ? 0x0001u : 0u);
      return new INPUT { type = 1, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = flags } } };
    }
    static INPUT UnicodeInput(char c, bool up) {
      return new INPUT { type = 1, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 0x0004u | (up ? 0x0002u : 0u) } } };
    }
    static INPUT MouseInput(uint flags, uint data) {
      return new INPUT { type = 0, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags, mouseData = data } } };
    }
    static void Send(List<INPUT> inputs) {
      if (inputs.Count == 0) return;
      uint sent = Native.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
      if (sent == 0) throw new OpError("target_elevated", "Windows refused the input (the window may run as administrator)");
    }
    static ushort VkFor(string key) {
      if (Vk.ContainsKey(key)) return Vk[key];
      if (key.Length == 1 && key[0] >= 'a' && key[0] <= 'z') return (ushort)(0x41 + key[0] - 'a');
      if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') return (ushort)(0x30 + key[0] - '0');
      int n;
      if (key.StartsWith("f") && int.TryParse(key.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
      throw new OpError("key_invalid", key);
    }
    static List<ushort> Mods(Dictionary<string, object> a) {
      var l = new List<ushort>();
      foreach (var m in Strings(a, "mods")) l.Add(m == "ctrl" ? (ushort)0x11 : m == "alt" ? (ushort)0x12 : m == "shift" ? (ushort)0x10 : (ushort)0x5B);
      return l;
    }
    static void KeyPress(Dictionary<string, object> a) {
      var mods = Mods(a);
      ushort vk = VkFor(Convert.ToString(a["key"]));
      int repeat = Int(a, "repeat", 1);
      var list = new List<INPUT>();
      foreach (var m in mods) list.Add(KeyInput(m, false));
      for (int i = 0; i < repeat; i++) { list.Add(KeyInput(vk, false)); list.Add(KeyInput(vk, true)); }
      for (int i = mods.Count - 1; i >= 0; i--) list.Add(KeyInput(mods[i], true));
      Send(list);
    }
    static void TypeText(string text) {
      var list = new List<INPUT>();
      foreach (char c in text) {
        if (c == '\n') { list.Add(KeyInput(0x0D, false)); list.Add(KeyInput(0x0D, true)); }
        else if (c == '\t') { list.Add(KeyInput(0x09, false)); list.Add(KeyInput(0x09, true)); }
        else { list.Add(UnicodeInput(c, false)); list.Add(UnicodeInput(c, true)); }
      }
      Send(list);
    }
    static uint[] ButtonFlags(Dictionary<string, object> a) {
      string b = a.ContainsKey("button") ? Convert.ToString(a["button"]) : "left";
      return b == "right" ? new uint[] { 0x0008, 0x0010 } : b == "middle" ? new uint[] { 0x0020, 0x0040 } : new uint[] { 0x0002, 0x0004 };
    }
    static void Click(POINT pt, Dictionary<string, object> a) {
      Native.SetCursorPos(pt.X, pt.Y);
      var mods = Mods(a);
      var f = ButtonFlags(a);
      int count = Int(a, "count", 1);
      var list = new List<INPUT>();
      foreach (var m in mods) list.Add(KeyInput(m, false));
      for (int i = 0; i < count; i++) { list.Add(MouseInput(f[0], 0)); list.Add(MouseInput(f[1], 0)); }
      for (int i = mods.Count - 1; i >= 0; i--) list.Add(KeyInput(mods[i], true));
      Send(list);
    }
    // dy > 0 scrolls down; dx > 0 scrolls right.
    static void Scroll(POINT pt, Dictionary<string, object> a) {
      Native.SetCursorPos(pt.X, pt.Y);
      int dx = Int(a, "dx", 0), dy = Int(a, "dy", 0);
      if (dy != 0) Send(new List<INPUT> { MouseInput(0x0800, unchecked((uint)(-dy * 120))) });
      if (dx != 0) Send(new List<INPUT> { MouseInput(0x1000, unchecked((uint)(dx * 120))) });
    }
    static void Drag(POINT from, POINT to, Dictionary<string, object> a) {
      var f = ButtonFlags(a);
      Native.SetCursorPos(from.X, from.Y);
      Send(new List<INPUT> { MouseInput(f[0], 0) });
      for (int i = 1; i <= 10; i++) { Native.SetCursorPos(from.X + (to.X - from.X) * i / 10, from.Y + (to.Y - from.Y) * i / 10); System.Threading.Thread.Sleep(15); }
      Send(new List<INPUT> { MouseInput(f[1], 0) });
    }
    static void ReleaseAll() {
      var list = new List<INPUT>();
      foreach (ushort m in new ushort[] { 0x11, 0x12, 0x10, 0x5B }) list.Add(KeyInput(m, true));
      foreach (uint up in new uint[] { 0x0004, 0x0010, 0x0040 }) list.Add(MouseInput(up, 0));
      Native.SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }

    // ── probe ───────────────────────────────────────────────────────────────
    static Dictionary<string, object> Check(string name, bool ok, string hint) {
      var d = new Dictionary<string, object> { { "check", name }, { "ok", ok } };
      if (!ok && hint != null) d["hint"] = hint;
      return d;
    }
    static object Probe() {
      var caps = new List<object>();
      var probes = new List<object>();
      bool interactive = Environment.UserInteractive;
      probes.Add(Check("interactive_session", interactive, "the helper is not running in an interactive desktop session"));
      if (interactive) caps.Add("gui.launch");
      bool shot = false;
      try {
        using (var bmp = new Bitmap(8, 8)) using (var g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { IntPtr w = Native.GetForegroundWindow(); shot = Native.PrintWindow(w != IntPtr.Zero ? w : Native.GetDesktopWindow(), hdc, 2); }
          finally { g.ReleaseHdc(hdc); }
        }
      } catch { shot = false; }
      probes.Add(Check("print_window", shot, "PrintWindow failed in this session"));
      if (shot) caps.Add("gui.screenshot");
      uint sent = Native.SendInput(1, new[] { MouseInput(0x0001, 0) }, Marshal.SizeOf(typeof(INPUT)));
      lastInjection = (uint)Environment.TickCount;
      probes.Add(Check("send_input", sent == 1, "SendInput is blocked in this session"));
      if (sent == 1) caps.Add("gui.input");
      var displays = new List<object>();
      foreach (var s in System.Windows.Forms.Screen.AllScreens) {
        displays.Add(new Dictionary<string, object> { { "id", s.DeviceName }, { "bounds", new Dictionary<string, object> { { "x", s.Bounds.X }, { "y", s.Bounds.Y }, { "w", s.Bounds.Width }, { "h", s.Bounds.Height } } }, { "scale", 1.0 } });
      }
      return new Dictionary<string, object> { { "capabilities", caps }, { "probes", probes }, { "displays", displays }, { "limits", new List<object>() }, { "locked", Locked() } };
    }
  }
}
'@

# Physical pixels everywhere (§3.5): before any window call. A host that set
# its awareness already makes this return false; that is not an error.
[KingLouie.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  [Console]::Out.WriteLine([KingLouie.Worker]::Handle($line))
  [Console]::Out.Flush()
}
```

- [ ] **Step 5: Write `src/session/backends/windows.js`**

```js
// src/session/backends/windows.js
// The Windows backend (fleet stage 5 spec §3.3): one persistent PowerShell
// worker running C# through Add-Type, plus Node's own spawn for launches.
const path = require('path');
const { spawn } = require('child_process');
const { createLogger } = require('../../logging');
const { windowsPowerShellExe } = require('../../platform/windows-paths');
const { GuiError } = require('../../gui/errors');
const { LineWorker } = require('./line-worker');

function createWindowsBackend({ env = process.env, log = createLogger('session-helper/windows'), spawnImpl = spawn, workerFile = path.join(__dirname, 'windows-worker.ps1') } = {}) {
  const worker = new LineWorker({
    file: windowsPowerShellExe(env),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerFile],
    spawnImpl, env, log, name: 'windows-worker'
  });
  return {
    name: 'windows',
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

module.exports = { createWindowsBackend };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/session-backend-windows.test.js`
Expected: PASS, `# fail 0` (on Windows the worker suite runs; elsewhere it is skipped and the `LineWorker` suite runs).

- [ ] **Step 7: Commit**

```bash
git add src/session/backends/line-worker.js src/session/backends/windows.js src/session/backends/windows-worker.ps1 tests/session-backend-windows.test.js
git commit -m "feat(session): Windows backend through a PowerShell/C# worker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: The macOS backend

**Review:** trust (the checks and the injection, and three macOS permissions granted to the `node` binary). **On Windows:** only the fake-tool plumbing suite runs. The JXA worker suite, the permission prompts and Deviation 27 (whether non-ASCII text really needs the `System Events` route) can only be checked on a Mac; the implementer says so in the task report and leaves that run to a machine that has one.

**Batchable:** yes — with Task 18 (same backend interface, same skip-when-absent test shape, no shared code beyond `LineWorker`).

**Files:**
- Create: `src/session/backends/macos.js`
- Create: `src/session/backends/macos-worker.js` (JXA, run by `/usr/bin/osascript -l JavaScript`)
- Test: `tests/session-backend-macos.test.js`

**Interfaces:**
- Consumes: `LineWorker` (Task 16); `GuiError` (Task 1).
- Produces: `createMacosBackend({ env, log, spawnImpl, execFileImpl, workerFile, tmpDir, nodeBinary = process.execPath }) → backend` implementing §3.3 plus `hitTest` (Deviation 28) and `requestPermissions()` (the first-start prompts). Screenshots go through `/usr/sbin/screencapture` and `/usr/bin/sips` from Node, into a `0700` temp dir, deleted after reading; `transform.unit` is `'pt'`.

- [ ] **Step 1: Write the failing test**

Create `tests/session-backend-macos.test.js`:

```js
// tests/session-backend-macos.test.js
//
// The launch and screenshot plumbing with fake child processes (any OS),
// and the real JXA worker on macOS only. Nothing injects input.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMacosBackend } = require('../src/session/backends/macos');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const MAC = process.platform === 'darwin';

describe('macOS backend plumbing (fake tools)', () => {
  it('launch uses open -a, and -n with --args when there are args; argv only', async () => {
    const calls = [];
    const execFileImpl = async (file, args) => { calls.push([file, ...args]); return { stdout: '' }; };
    const backend = createMacosBackend({ execFileImpl, worker: { call: async (op) => (op === 'pid_for_app' ? 4242 : null), stop: async () => {} } });
    assert.deepEqual(await backend.launch({ exe: '/System/Applications/TextEdit.app', argv: [], files: ['/tmp/a.txt'] }), { pid: 4242 });
    assert.deepEqual(calls[0], ['/usr/bin/open', '-a', '/System/Applications/TextEdit.app', '/tmp/a.txt']);
    await backend.launch({ exe: '/Applications/Tool.app', argv: ['--x', 'y'], files: [] });
    assert.deepEqual(calls[1], ['/usr/bin/open', '-n', '-a', '/Applications/Tool.app', '--args', '--x', 'y']);
  });

  it('screenshot: screencapture of one window, resized with sips, points transform, temp files removed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mac-shot-'));
    const calls = [];
    const execFileImpl = async (file, args) => {
      calls.push([file, ...args]);
      if (file === '/usr/sbin/screencapture') fs.writeFileSync(args[args.length - 1], Buffer.from('raw-jpeg'));
      if (file === '/usr/bin/sips' && args.includes('--out')) fs.writeFileSync(args[args.indexOf('--out') + 1], Buffer.from('small-jpeg'));
      if (file === '/usr/bin/sips' && args[0] === '-g') return { stdout: 'x\n  pixelWidth: 1280\n  pixelHeight: 960\n' };
      return { stdout: '' };
    };
    const worker = { call: async (op) => (op === 'window_info' ? { windowNumber: 77, bounds: { x: 0, y: 25, w: 800, h: 600 } } : null), stop: async () => {} };
    const backend = createMacosBackend({ execFileImpl, worker, tmpDir });
    const shot = await backend.screenshot({ handle: '77', maxWidth: 1280, quality: 70 });
    assert.deepEqual(calls[0].slice(0, 6), ['/usr/sbin/screencapture', '-x', '-o', '-l', '77', '-t']);
    assert.equal(shot.width, 1280);
    assert.deepEqual(shot.transform, { sx: 800 / 1280, sy: 600 / 960, unit: 'pt' });
    assert.equal(Buffer.from(shot.data, 'base64').toString(), 'small-jpeg');
    assert.deepEqual(fs.readdirSync(tmpDir), [], 'temp files are deleted');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('macOS JXA worker', { skip: !MAC }, () => {
  const backend = MAC ? createMacosBackend({}) : null;
  after(() => backend && backend.stop());

  it('probes itself; launch is always there', async () => {
    const r = await backend.probe();
    assert.ok(r.capabilities.includes('gui.launch'));
    assert.ok(r.probes.some((p) => p.check === 'screen_recording'));
    assert.ok(r.probes.some((p) => p.check === 'accessibility'));
  });

  it('reads the frontmost app and hit-tests its window', async () => {
    const fg = await backend.foreground();
    if (!fg || !fg.bounds) return;
    assert.equal(typeof fg.image, 'string');
    const hit = await backend.hitTest({ x: fg.bounds.x + 10, y: fg.bounds.y + 10 });
    assert.ok(hit === null || Number.isInteger(hit.pid));
  });

  it('refuses before injecting when the foreground is not leased', async () => {
    await assert.rejects(
      backend.input({ expect: { match: ['/nonexistent/Kl.app'], pids: [0] }, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 }),
      (e) => e.code === 'foreground_mismatch' || e.code === 'screen_locked'
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-backend-macos.test.js`
Expected: FAIL with `Cannot find module '../src/session/backends/macos'`.

- [ ] **Step 3: Write `src/session/backends/macos-worker.js`**

```js
// src/session/backends/macos-worker.js
// The macOS GUI worker for the King Louie session helper (fleet stage 5 spec
// §3.3), run as /usr/bin/osascript -l JavaScript <this file>. One JSON op per
// line on stdin, one JSON reply per line on stdout. JXA, not Node: no
// require, no console. Op data never becomes script text.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');

var lastInjection = 0;
var automationOk = null;
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var buffer = '';

function OpError(code, message, detail) { this.code = code; this.message = message || code; this.detail = detail || {}; }
function nowS() { return $.NSDate.date.timeIntervalSince1970; }

function nextLine() {
  for (;;) {
    var i = buffer.indexOf('\n');
    if (i >= 0) { var line = buffer.slice(0, i); buffer = buffer.slice(i + 1); return line; }
    var data = stdin.availableData;
    if (data.length === 0) return null;
    buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  }
}
function write(obj) { stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }

function app(pid) { var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid); return a && !a.isNil() ? a : null; }
function imageOf(pid) { var a = app(pid); if (!a || a.executableURL.isNil()) return ''; return a.executableURL.path.js; }

// Layer-0 windows, front to back. onscreenOnly: 1 | 16 (exclude desktop); all: 16.
function windowList(onscreenOnly) {
  var raw = $.CGWindowListCopyWindowInfo(onscreenOnly ? (1 | 16) : 16, 0);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  return list.filter(function (w) { return w.kCGWindowLayer === 0; });
}
function boundsOf(w) { var b = w.kCGWindowBounds; return { x: b.X, y: b.Y, w: b.Width, h: b.Height }; }
function contains(b, p) { return p.x >= b.x && p.y >= b.y && p.x < b.x + b.w && p.y < b.y + b.h; }
function backingScale() { var s = $.NSScreen.mainScreen; return s && !s.isNil() ? s.backingScaleFactor : 1; }

function globMatch(image, patterns) {
  if (!image) return false;
  var img = image.toLowerCase();
  for (var k = 0; k < patterns.length; k++) {
    var p = String(patterns[k]).toLowerCase();
    var bare = p.indexOf('/') < 0;
    var target = bare ? img.slice(img.lastIndexOf('/') + 1) : img;
    var rx = new RegExp('^' + p.split('').map(function (c) { return c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('') + '$');
    if (rx.test(target)) return true;
    if (/\.app$/.test(p) && p.indexOf('*') < 0 && img.indexOf(p + '/') === 0) return true;
  }
  return false;
}

function foreground() {
  var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!a || a.isNil()) return null;
  var pid = a.processIdentifier;
  var win = windowList(true).filter(function (w) { return w.kCGWindowOwnerPID === pid; })[0];
  return { handle: win ? String(win.kCGWindowNumber) : null, pid: pid, image: imageOf(pid), bounds: win ? boundsOf(win) : null, scale: backingScale() };
}
function brief(f) { return f ? { image: f.image, pid: f.pid } : null; }
function hitTest(p) {
  var under = windowList(true).filter(function (w) { return contains(boundsOf(w), p); })[0];
  return under ? { handle: String(under.kCGWindowNumber), pid: under.kCGWindowOwnerPID, image: imageOf(under.kCGWindowOwnerPID) } : null;
}
function isLocked() {
  var d = ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary()));
  return Boolean(d && d.CGSSessionScreenIsLocked);
}

// ── input ────────────────────────────────────────────────────────────────
var KEYCODES = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32,
  '[': 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47,
  tab: 48, space: 49, '`': 50, backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, insert: 114,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90 };
var SHIFTED = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
var FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 };
var MODKEY = { shift: 56, ctrl: 59, alt: 58, meta: 55 };

function post(e) { $.CGEventPost(0, e); }
function flagsOf(mods) { var f = 0; (mods || []).forEach(function (m) { f |= FLAG[m] || 0; }); return f; }
function keyEvent(code, down, flags) { var e = $.CGEventCreateKeyboardEvent(null, code, down); if (flags) $.CGEventSetFlags(e, flags); post(e); }
function tap(code, flags) { keyEvent(code, true, flags); keyEvent(code, false, flags); }
function mouseEvent(type, p, button, clickState, flags) {
  var e = $.CGEventCreateMouseEvent(null, type, { x: p.x, y: p.y }, button);
  if (clickState) $.CGEventSetIntegerValueField(e, 1, clickState);
  if (flags) $.CGEventSetFlags(e, flags);
  post(e);
}
var BUTTON = { left: [0, 1, 2], right: [1, 3, 4], middle: [2, 25, 26] }; // button, down type, up type

function typeAscii(ch) {
  if (ch === '\n') { tap(36, 0); return; }
  if (ch === '\t') { tap(48, 0); return; }
  if (ch === ' ') { tap(49, 0); return; }
  var lower = ch.toLowerCase();
  if (KEYCODES[lower] !== undefined && lower.length === 1) { tap(KEYCODES[lower], ch !== lower ? FLAG.shift : 0); return; }
  if (SHIFTED[ch] !== undefined) { tap(KEYCODES[SHIFTED[ch]], FLAG.shift); return; }
  throw new OpError('invalid_text', 'a character cannot be typed');
}
// Deviation 27: non-ASCII runs through System Events (Automation permission).
function typeText(text) {
  var run = '';
  var flush = function () {
    if (!run) return;
    if (automationOk === false) throw new OpError('invalid_text', 'non-ASCII text needs the Automation permission for System Events');
    Application('System Events').keystroke(run);
    run = '';
  };
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    var code = c.charCodeAt(0);
    if (code < 128) { flush(); typeAscii(c); } else run += c;
  }
  flush();
}

function input(p) {
  var expect = p.expect || {}; var match = expect.match || []; var pids = expect.pids || [];
  var action = p.action || {}; var yieldMs = p.yieldMs || 0; var kind = action.kind;
  if (isLocked()) throw new OpError('screen_locked', 'the screen is locked');
  var fg = foreground();
  if (!fg || pids.indexOf(fg.pid) < 0 || !globMatch(fg.image, match)) throw new OpError('foreground_mismatch', 'the frontmost app is not a leased app', fg ? brief(fg) : {});
  var points = [];
  if (kind === 'click' || kind === 'scroll' || kind === 'drag') {
    var win = windowList(true).filter(function (w) { return String(w.kCGWindowNumber) === String(action.handle); })[0];
    if (!win) throw new OpError('stale_screenshot', 'the window is gone');
    if (pids.indexOf(win.kCGWindowOwnerPID) < 0) throw new OpError('foreground_mismatch', 'the target window is not a leased app', brief(fg));
    var b = boundsOf(win);
    var rels = kind === 'drag' ? [action.from, action.to] : [action.rel];
    rels.forEach(function (r) {
      if (r[0] < 0 || r[1] < 0 || r[0] >= b.w || r[1] >= b.h) throw new OpError('outside_window', 'the point is outside the window');
      points.push({ x: b.x + r[0], y: b.y + r[1] });
    });
    points.forEach(function (pt) {
      var under = hitTest(pt);
      if (!under || pids.indexOf(under.pid) < 0) throw new OpError('point_obscured', 'another window covers that point');
    });
  }
  var since = $.CGEventSourceSecondsSinceLastEventType(1, 4294967295);
  var lastEvent = nowS() - since;
  if ((lastInjection === 0 || lastEvent > lastInjection + 0.05) && since * 1000 < yieldMs) throw new OpError('user_active', 'someone is using the keyboard or mouse');
  var flags = flagsOf(action.mods);
  if (kind === 'click') {
    var bt = BUTTON[action.button || 'left'];
    mouseEvent(5, points[0], 0, 0, 0);
    for (var n = 1; n <= (action.count || 1); n++) { mouseEvent(bt[1], points[0], bt[0], n, flags); mouseEvent(bt[2], points[0], bt[0], n, flags); }
  } else if (kind === 'type') {
    typeText(String(action.text));
  } else if (kind === 'key') {
    var code = KEYCODES[action.key];
    if (code === undefined) throw new OpError('key_invalid', action.key);
    for (var r = 0; r < (action.repeat || 1); r++) tap(code, flags);
  } else if (kind === 'scroll') {
    mouseEvent(5, points[0], 0, 0, 0);
    post($.CGEventCreateScrollWheelEvent2(null, 1, 2, -(action.dy || 0), -(action.dx || 0), 0));
  } else if (kind === 'drag') {
    var db = BUTTON[action.button || 'left'];
    mouseEvent(5, points[0], 0, 0, 0);
    mouseEvent(db[1], points[0], db[0], 1, 0);
    for (var s = 1; s <= 10; s++) {
      mouseEvent(db[0] === 0 ? 6 : 7, { x: points[0].x + (points[1].x - points[0].x) * s / 10, y: points[0].y + (points[1].y - points[0].y) * s / 10 }, db[0], 0, 0);
      delay(0.015);
    }
    mouseEvent(db[2], points[1], db[0], 1, 0);
  } else {
    throw new OpError('invalid_params', 'unknown action');
  }
  lastInjection = nowS();
  delay(0.06);
  return { foregroundBefore: brief(fg), foregroundAfter: brief(foreground()) };
}

function releaseAll() {
  ['shift', 'ctrl', 'alt', 'meta'].forEach(function (m) { keyEvent(MODKEY[m], false, 0); });
  var loc = $.CGEventGetLocation($.CGEventCreate(null));
  [[0, 2], [1, 4], [2, 26]].forEach(function (pair) { mouseEvent(pair[1], { x: loc.x, y: loc.y }, pair[0], 0, 0); });
  return null;
}

// ── the rest of the ops ──────────────────────────────────────────────────
function running() { return ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications) || []; }
function processes(p) {
  var out = [];
  running().forEach(function (a) {
    var pid = a.processIdentifier;
    var image = imageOf(pid);
    if (globMatch(image, p.match || [])) out.push({ pid: pid, image: image });
  });
  return out;
}
function windows(p) {
  var pids = p.pids || [];
  return windowList(false).filter(function (w) { return pids.indexOf(w.kCGWindowOwnerPID) >= 0; }).map(function (w) {
    return { handle: String(w.kCGWindowNumber), pid: w.kCGWindowOwnerPID, image: imageOf(w.kCGWindowOwnerPID), title: w.kCGWindowName || '', bounds: boundsOf(w), scale: backingScale(), minimized: !w.kCGWindowIsOnscreen };
  });
}
function windowInfo(p) {
  var win = windowList(false).filter(function (w) { return String(w.kCGWindowNumber) === String(p.handle); })[0];
  if (!win) throw new OpError('stale_screenshot', 'the window is gone');
  if (!win.kCGWindowIsOnscreen) throw new OpError('window_minimized', 'restore the window first');
  if (isLocked()) throw new OpError('screen_locked', 'the screen is locked');
  return { windowNumber: win.kCGWindowNumber, bounds: boundsOf(win) };
}
function focus(p) {
  var win = windowList(false).filter(function (w) { return String(w.kCGWindowNumber) === String(p.handle); })[0];
  if (!win) throw new OpError('stale_screenshot', 'the window is gone');
  var a = app(win.kCGWindowOwnerPID);
  return { focused: Boolean(a && a.activateWithOptions(2)) };
}
function close(p) {
  var closed = [];
  (p.pids || []).forEach(function (pid) { var a = app(pid); if (a && (p.force ? a.forceTerminate : a.terminate)) closed.push(pid); });
  return { closed: closed };
}
function pidForApp(p) {
  var best = null;
  running().forEach(function (a) {
    var bundle = a.bundleURL && !a.bundleURL.isNil() ? a.bundleURL.path.js : '';
    var exe = a.executableURL && !a.executableURL.isNil() ? a.executableURL.path.js : '';
    if (bundle === p.path || exe === p.path) {
      var t = a.launchDate && !a.launchDate.isNil() ? a.launchDate.timeIntervalSince1970 : 0;
      if (!best || t >= best.t) best = { pid: a.processIdentifier, t: t };
    }
  });
  return best ? best.pid : null;
}
function check(name, ok, hint) { var d = { check: name, ok: ok }; if (!ok) d.hint = hint; return d; }
function probe(p) {
  var node = p.nodeBinary || 'the node binary';
  var screen = Boolean($.CGPreflightScreenCaptureAccess());
  var ax = Boolean($.AXIsProcessTrusted());
  var caps = ['gui.launch'];
  if (screen) caps.push('gui.screenshot');
  if (ax) caps.push('gui.input');
  var displays = (ObjC.unwrap($.NSScreen.screens) || []).map(function (s, i) {
    var f = s.frame;
    return { id: String(i + 1), bounds: { x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height }, scale: s.backingScaleFactor };
  });
  return {
    capabilities: caps,
    probes: [
      check('screen_recording', screen, 'grant Screen Recording to ' + node + ' in System Settings > Privacy & Security'),
      check('accessibility', ax, 'grant Accessibility to ' + node + ' in System Settings > Privacy & Security'),
      check('automation', automationOk !== false, 'allow ' + node + ' to control System Events to type non-ASCII text')
    ],
    displays: displays, limits: [], locked: isLocked()
  };
}
function requestPermissions() {
  $.CGRequestScreenCaptureAccess();
  $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
  try { Application('System Events').processes.length; automationOk = true; } catch (e) { automationOk = false; }
  return null;
}

var OPS = {
  probe: probe, processes: processes, windows: windows, foreground: foreground, focus: focus, close: close,
  window_info: windowInfo, input: input, release_all: releaseAll, locked: isLocked, pid_for_app: pidForApp,
  hit_test: hitTest, request_permissions: requestPermissions
};

function run() {
  for (;;) {
    var line = nextLine();
    if (line === null) return;
    if (!line.trim()) continue;
    var req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    try {
      if (!Object.prototype.hasOwnProperty.call(OPS, req.op)) throw new OpError('unknown_op', String(req.op));
      var result = OPS[req.op](req.params || {});
      write({ id: req.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof OpError) write({ id: req.id, ok: false, error: { code: e.code, message: e.message, detail: e.detail } });
      else write({ id: req.id, ok: false, error: { code: 'backend_failed', message: String(e), detail: {} } });
    }
  }
}
```

- [ ] **Step 4: Write `src/session/backends/macos.js`**

```js
// src/session/backends/macos.js
// The macOS backend (fleet stage 5 spec §3.3): a persistent JXA worker for
// CoreGraphics and AppKit, and argv-only system tools for launch and
// screenshots: /usr/bin/open, /usr/sbin/screencapture, /usr/bin/sips.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../../logging');
const { GuiError } = require('../../gui/errors');
const { LineWorker } = require('./line-worker');

const execFileP = promisify(execFile);
const LAUNCH_PID_MS = 10000;

function createMacosBackend({ env = process.env, log = createLogger('session-helper/macos'), spawnImpl = spawn, execFileImpl = (f, a) => execFileP(f, a, { env }),
  workerFile = path.join(__dirname, 'macos-worker.js'), tmpDir = null, nodeBinary = process.execPath, worker = null } = {}) {
  const w = worker || new LineWorker({ file: '/usr/bin/osascript', args: ['-l', 'JavaScript', workerFile], spawnImpl, env, log, name: 'macos-worker' });

  function shotDir() {
    // A fresh 0700 dir per capture, inside the helper's own temp area.
    const root = tmpDir || path.join(os.tmpdir(), 'king-louie-session');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(root, 'shot-'));
  }

  return {
    name: 'macos',
    probe: () => w.call('probe', { nodeBinary }),
    requestPermissions: () => w.call('request_permissions', {}, { timeoutMs: 60000 }),
    async launch({ exe, argv = [], files = [] }) {
      // A running app ignores --args unless -n opens a new instance.
      const args = argv.length ? ['-n', '-a', exe, ...files, '--args', ...argv] : ['-a', exe, ...files];
      await execFileImpl('/usr/bin/open', args);
      const deadline = Date.now() + LAUNCH_PID_MS;
      for (;;) {
        const pid = await w.call('pid_for_app', { path: exe });
        if (Number.isInteger(pid)) return { pid };
        if (Date.now() > deadline) throw new GuiError('app_not_running', `${exe} did not start within 10 s`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    processes: ({ match }) => w.call('processes', { match }),
    windows: ({ pids }) => w.call('windows', { pids }),
    foreground: () => w.call('foreground'),
    focus: ({ handle }) => w.call('focus', { handle }),
    close: ({ pids, force }) => w.call('close', { pids, force }),
    async screenshot({ handle, maxWidth, quality }) {
      const info = await w.call('window_info', { handle });
      const dir = shotDir();
      const raw = path.join(dir, 'raw.jpg');
      const out = path.join(dir, 'out.jpg');
      try {
        await execFileImpl('/usr/sbin/screencapture', ['-x', '-o', '-l', String(info.windowNumber), '-t', 'jpg', raw]);
        await execFileImpl('/usr/bin/sips', ['--resampleWidth', String(maxWidth), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), raw, '--out', out]);
        const { stdout } = await execFileImpl('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out]);
        const width = Number((/pixelWidth:\s*(\d+)/.exec(stdout) || [])[1]);
        const height = Number((/pixelHeight:\s*(\d+)/.exec(stdout) || [])[1]);
        if (!width || !height) throw new GuiError('backend_failed', 'sips could not read the capture');
        const data = fs.readFileSync(out).toString('base64');
        // CGEvent takes points, so the Retina scale is absorbed here (§3.5).
        return { mime: 'image/jpeg', width, height, data, transform: { sx: info.bounds.w / width, sy: info.bounds.h / height, unit: 'pt' } };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    input: ({ expect, action, yieldMs }) => w.call('input', { expect, action, yieldMs }),
    releaseAll: () => w.call('release_all'),
    locked: () => w.call('locked'),
    hitTest: ({ x, y }) => w.call('hit_test', { x, y }),
    stop: () => w.stop()
  };
}

module.exports = { createMacosBackend };
```

`sips --resampleWidth` enlarges a narrower window; that is harmless (the transform still maps back to points). The test's temp dir is the `tmpDir` root, and the per-capture dir inside it is removed, so the root is empty afterwards.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/session-backend-macos.test.js`
Expected: PASS, `# fail 0` (the JXA suite runs only on macOS).

- [ ] **Step 6: Commit**

```bash
git add src/session/backends/macos.js src/session/backends/macos-worker.js tests/session-backend-macos.test.js
git commit -m "feat(session): macOS backend through a JXA worker and system tools

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: The Linux backends (X11 and Wayland)

**Review:** trust (the checks and the injection; on X11 they are separate calls, which the spec's §8 already names as a limit). **On Windows:** the scripted-`xdotool` suite and the Wayland suite run; the real-X11 suite needs Linux with `DISPLAY`, no Wayland and `/usr/bin/xdotool`.

**Batchable:** yes — with Task 17.

**Files:**
- Create: `src/session/backends/x11.js`
- Create: `src/session/backends/wayland.js`
- Create: `src/session/backends/linux-common.js`
- Test: `tests/session-backend-linux.test.js`

**Interfaces:**
- Consumes: `imageMatches` (Task 2); `GuiError` (Task 1).
- Produces:
  - `linux-common.js`: `listProcesses({ match, readdir, readlink }) → [{ pid, image }]` (from `/proc/<pid>/exe`); `launchDetached({ exe, argv, files, spawnImpl }) → { pid }`; `jpegSize(buffer) → { width, height } | null`; `XDOTOOL_KEYS` (grammar → keysym).
  - `x11.js`: `createX11Backend({ env, log, execFileImpl, spawnImpl, readlink, readdir, exists }) → backend` implementing §3.3 plus `hitTest`; `limits` always includes `no_human_yield`, plus `no_lock_detect` without `LockedHint`.
  - `wayland.js`: `createWaylandBackend({ env, spawnImpl }) → backend` with `probe() → { capabilities: ['gui.launch'], … }`, `launch`, `processes`; every other op throws `capability_unavailable` (§11.4).

- [ ] **Step 1: Write the failing test**

Create `tests/session-backend-linux.test.js`:

```js
// tests/session-backend-linux.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createX11Backend } = require('../src/session/backends/x11');
const { createWaylandBackend } = require('../src/session/backends/wayland');
const { jpegSize, XDOTOOL_KEYS } = require('../src/session/backends/linux-common');
const { selectBackend } = require('../src/session/backends');

const HAS_X = process.platform === 'linux' && Boolean(process.env.DISPLAY) && !process.env.WAYLAND_DISPLAY && fs.existsSync('/usr/bin/xdotool');

// A scripted xdotool: argv → stdout.
function fakeX(script) {
  const calls = [];
  const execFileImpl = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input });
    const key = [file.split('/').pop(), ...args].join(' ');
    for (const [pattern, out] of script) if (pattern.test(key)) return { stdout: typeof out === 'function' ? out(args) : out };
    return { stdout: '' };
  };
  return { calls, execFileImpl };
}

const GEOM = 'WINDOW=42\nX=100\nY=50\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n';
const baseScript = [
  [/^loginctl/, 'no\n'],
  [/^xdotool getactivewindow$/, '42\n'],
  [/^xdotool getwindowpid 42$/, '4242\n'],
  [/^xdotool getwindowgeometry --shell 42$/, GEOM],
  [/^xdotool getmouselocation --shell$/, 'X=1\nY=1\nSCREEN=0\nWINDOW=42\n'],
  [/^xdotool getmouselocation$/, 'x:1 y:1 screen:0 window:42\n']
];

describe('Linux selection', () => {
  it('prefers Wayland when both WAYLAND_DISPLAY and DISPLAY are set', () => {
    assert.equal(selectBackend({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, xdpyinfoOk: () => true }), 'wayland');
  });
});

describe('X11 backend (scripted xdotool)', () => {
  const readlink = (p) => (p === '/proc/4242/exe' ? '/usr/bin/gnome-calculator' : '/usr/bin/bash');

  it('probes: launch, screenshot, input; limits always say no_human_yield', async () => {
    const { execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
    const r = await b.probe();
    assert.deepEqual(r.capabilities, ['gui.launch', 'gui.screenshot', 'gui.input']);
    assert.deepEqual(r.limits, ['no_human_yield']);
    const noLock = createX11Backend({ env: { DISPLAY: ':0' }, execFileImpl, readlink, exists: () => true });
    assert.deepEqual((await noLock.probe()).limits, ['no_human_yield', 'no_lock_detect']);
  });

  it('foreground reads the image from /proc, not from the window', async () => {
    const { execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0' }, execFileImpl, readlink, exists: () => true });
    assert.deepEqual(await b.foreground(), { handle: '42', pid: 4242, image: '/usr/bin/gnome-calculator', bounds: { x: 100, y: 50, w: 800, h: 600 }, scale: 1 });
  });

  it('input: checks, hit test via the pointer, then xdotool with text on stdin only', async () => {
    const { calls, execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
    const expect = { match: ['/usr/bin/gnome-calculator'], pids: [4242] };
    await b.input({ expect, action: { kind: 'type', text: 'rm -rf / 12+30=' }, yieldMs: 2000 });
    const typeCall = calls.find((c) => c.args[0] === 'type');
    assert.deepEqual(typeCall.args, ['type', '--clearmodifiers', '--file', '-']);
    assert.equal(typeCall.input, 'rm -rf / 12+30=');
    await b.input({ expect, action: { kind: 'click', handle: '42', rel: [10, 20], button: 'left', count: 2, mods: ['ctrl'] }, yieldMs: 0 });
    assert.ok(calls.some((c) => c.args.join(' ') === 'mousemove --sync 110 70'));
    assert.ok(calls.some((c) => c.args.join(' ') === 'keydown ctrl'));
    assert.ok(calls.some((c) => c.args.join(' ') === 'click --repeat 2 1'));
    await b.input({ expect, action: { kind: 'key', mods: ['ctrl'], key: 's', repeat: 1 }, yieldMs: 0 });
    assert.ok(calls.some((c) => c.args.join(' ') === 'key --clearmodifiers --repeat 1 ctrl+s'));
  });

  it('refuses: foreground_mismatch, outside_window, point_obscured, screen_locked', async () => {
    const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
    const { execFileImpl } = fakeX(baseScript);
    const b = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl, readlink, exists: () => true });
    assert.equal(await code(b.input({ expect: { match: ['/usr/bin/xterm'], pids: [1] }, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 })), 'foreground_mismatch');
    const expect = { match: ['/usr/bin/gnome-calculator'], pids: [4242] };
    assert.equal(await code(b.input({ expect, action: { kind: 'click', handle: '42', rel: [800, 1], button: 'left', count: 1, mods: [] }, yieldMs: 0 })), 'outside_window');
    const covered = fakeX([[/^xdotool getmouselocation --shell$/, 'X=1\nY=1\nSCREEN=0\nWINDOW=99\n'], [/^xdotool getwindowpid 99$/, '1\n'], ...baseScript]);
    const b2 = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl: covered.execFileImpl, readlink, exists: () => true });
    assert.equal(await code(b2.input({ expect, action: { kind: 'click', handle: '42', rel: [10, 10], button: 'left', count: 1, mods: [] }, yieldMs: 0 })), 'point_obscured');
    const locked = fakeX([[/^loginctl/, 'yes\n'], ...baseScript]);
    const b3 = createX11Backend({ env: { DISPLAY: ':0', XDG_SESSION_ID: '3' }, execFileImpl: locked.execFileImpl, readlink, exists: () => true });
    assert.equal(await code(b3.input({ expect, action: { kind: 'key', mods: [], key: 'a', repeat: 1 }, yieldMs: 0 })), 'screen_locked');
  });

  it('screenshot: import of one window, the size read from the JPEG itself', async () => {
    // A minimal JPEG header with an SOF0 of 640x480.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
    assert.deepEqual(jpegSize(jpeg), { width: 640, height: 480 });
    const { calls, execFileImpl } = fakeX([[/^import/, jpeg], ...baseScript]);
    const b = createX11Backend({ env: { DISPLAY: ':0' }, execFileImpl, readlink, exists: () => true });
    const shot = await b.screenshot({ handle: '42', maxWidth: 640, quality: 60 });
    assert.deepEqual(calls.find((c) => c.file.endsWith('/import')).args, ['-window', '42', '-resize', '640x>', '-quality', '60', 'jpg:-']);
    assert.deepEqual(shot.transform, { sx: 800 / 640, sy: 600 / 480, unit: 'px' });
  });

  it('maps the key grammar to X keysyms', () => {
    assert.equal(XDOTOOL_KEYS.enter, 'Return');
    assert.equal(XDOTOOL_KEYS.pageup, 'Prior');
    assert.equal(XDOTOOL_KEYS['/'], 'slash');
  });
});

describe('Wayland backend', () => {
  it('advertises gui.launch only and refuses the rest', async () => {
    const b = createWaylandBackend({ env: { WAYLAND_DISPLAY: 'wayland-0' } });
    const r = await b.probe();
    assert.deepEqual(r.capabilities, ['gui.launch']);
    assert.match(r.probes[0].hint, /Wayland/);
    await assert.rejects(b.screenshot({ handle: '1', maxWidth: 320, quality: 50 }), (e) => e.code === 'capability_unavailable');
    await assert.rejects(b.input({}), (e) => e.code === 'capability_unavailable');
    assert.equal(await b.foreground(), null);
  });
});

describe('real X11', { skip: !HAS_X }, () => {
  it('probes and reads the foreground', async () => {
    const b = createX11Backend({});
    const r = await b.probe();
    assert.ok(r.capabilities.includes('gui.launch'));
    const fg = await b.foreground();
    assert.ok(fg === null || typeof fg.image === 'string');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/session-backend-linux.test.js`
Expected: FAIL with `Cannot find module '../src/session/backends/x11'`.

- [ ] **Step 3: Write `src/session/backends/linux-common.js`**

```js
// src/session/backends/linux-common.js
// Shared pieces of the Linux backends (fleet stage 5 spec §3.3).
const fs = require('fs');
const { spawn } = require('child_process');
const { imageMatches } = require('../../gui/apps');
const { GuiError } = require('../../gui/errors');

function listProcesses({ match, readdir = fs.readdirSync, readlink = fs.readlinkSync }) {
  const out = [];
  for (const name of readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let image;
    try {
      image = readlink(`/proc/${name}/exe`);
    } catch {
      continue;
    }
    if (imageMatches(image, match, 'linux')) out.push({ pid: Number(name), image });
  }
  return out;
}

async function launchDetached({ exe, argv = [], files = [], spawnImpl = spawn }) {
  const child = spawnImpl(exe, [...argv, ...files], { detached: true, stdio: 'ignore', shell: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err) => reject(new GuiError('file_not_found', err.message)));
  });
  child.unref();
  return { pid: child.pid };
}

// Width and height from a JPEG's first SOFn segment.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const XDOTOOL_KEYS = Object.freeze({
  enter: 'Return', tab: 'Tab', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  space: 'space', '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash',
  ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '`': 'grave'
});
const XDOTOOL_MODS = Object.freeze({ ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' });

function keysym(key) {
  if (XDOTOOL_KEYS[key]) return XDOTOOL_KEYS[key];
  if (/^f\d+$/.test(key)) return key.toUpperCase();
  return key;
}

module.exports = { listProcesses, launchDetached, jpegSize, XDOTOOL_KEYS, XDOTOOL_MODS, keysym };
```

- [ ] **Step 4: Write `src/session/backends/x11.js`**

```js
// src/session/backends/x11.js
// The Linux X11 backend (fleet stage 5 spec §3.3): xdotool and ImageMagick
// `import` per op, from fixed system paths. The checks run in sequence in
// Node (X11 has no single call that checks and injects); _NET_WM_PID is set
// by the client itself and `import -window` can include overlapping pixels
// (§8); there is no human-activity signal, so `limits` says so.
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../../logging');
const { GuiError } = require('../../gui/errors');
const { imageMatches } = require('../../gui/apps');
const { listProcesses, launchDetached, jpegSize, XDOTOOL_MODS, keysym } = require('./linux-common');

const execFileP = promisify(execFile);
const XDOTOOL = '/usr/bin/xdotool';
const IMPORT = '/usr/bin/import';
const LOGINCTL = '/usr/bin/loginctl';

function parseShell(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function createX11Backend({ env = process.env, log = createLogger('session-helper/x11'), spawnImpl, readlink = fs.readlinkSync, readdir = fs.readdirSync, exists = fs.existsSync,
  execFileImpl = (file, args, opts = {}) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, encoding: opts.encoding || 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve({ stdout })));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  }) } = {}) {
  const x = async (args, opts) => (await execFileImpl(XDOTOOL, args, opts)).stdout;
  const pidOf = async (win) => Number(String(await x(['getwindowpid', String(win)])).trim());
  const geometry = async (win) => {
    const g = parseShell(await x(['getwindowgeometry', '--shell', String(win)]));
    return { x: g.X, y: g.Y, w: g.WIDTH, h: g.HEIGHT };
  };
  const imageOf = (pid) => { try { return readlink(`/proc/${pid}/exe`); } catch { return ''; } };

  async function lockedHint() {
    if (!env.XDG_SESSION_ID || !exists(LOGINCTL)) return null;
    try {
      const v = String((await execFileImpl(LOGINCTL, ['show-session', env.XDG_SESSION_ID, '-p', 'LockedHint', '--value'])).stdout).trim();
      return v === 'yes' ? true : v === 'no' ? false : null;
    } catch {
      return null;
    }
  }

  async function foreground() {
    let win;
    try {
      win = String(await x(['getactivewindow'])).trim();
    } catch {
      return null;
    }
    if (!win) return null;
    const pid = await pidOf(win);
    return { handle: win, pid, image: imageOf(pid), bounds: await geometry(win), scale: 1 };
  }

  async function hitTest({ x: px, y: py }) {
    await x(['mousemove', '--sync', String(px), String(py)]);
    const loc = parseShell(await x(['getmouselocation', '--shell']));
    if (!loc.WINDOW) return null;
    const pid = await pidOf(loc.WINDOW);
    return { handle: String(loc.WINDOW), pid, image: imageOf(pid) };
  }

  const mods = (list) => (list || []).map((m) => XDOTOOL_MODS[m]).filter(Boolean);
  const button = (b) => (b === 'right' ? '3' : b === 'middle' ? '2' : '1');

  async function input({ expect = {}, action = {} }) {
    const match = expect.match || [];
    const pids = expect.pids || [];
    if ((await lockedHint()) === true) throw new GuiError('screen_locked', 'the screen is locked');
    const fg = await foreground();
    if (!fg || !pids.includes(fg.pid) || !imageMatches(fg.image, match, 'linux')) {
      throw new GuiError('foreground_mismatch', 'the active window is not a leased app', { info: fg ? { image: fg.image, pid: fg.pid } : {} });
    }
    const points = [];
    if (['click', 'scroll', 'drag'].includes(action.kind)) {
      let b;
      try {
        b = await geometry(action.handle);
      } catch {
        throw new GuiError('stale_screenshot', 'the window is gone');
      }
      for (const [rx, ry] of action.kind === 'drag' ? [action.from, action.to] : [action.rel]) {
        if (rx < 0 || ry < 0 || rx >= b.w || ry >= b.h) throw new GuiError('outside_window', 'the point is outside the window');
        points.push([b.x + rx, b.y + ry]);
      }
      for (const [px, py] of points) {
        const under = await hitTest({ x: px, y: py });
        if (!under || !pids.includes(under.pid)) throw new GuiError('point_obscured', 'another window covers that point');
      }
    }
    const m = mods(action.mods);
    const withMods = async (fn) => {
      for (const k of m) await x(['keydown', k]);
      try { await fn(); } finally { for (const k of [...m].reverse()) await x(['keyup', k]); }
    };
    switch (action.kind) {
      case 'type':
        await x(['type', '--clearmodifiers', '--file', '-'], { input: String(action.text) });
        break;
      case 'key':
        await x(['key', '--clearmodifiers', '--repeat', String(action.repeat || 1), [...m, keysym(action.key)].join('+')]);
        break;
      case 'click':
        await withMods(() => x(['click', '--repeat', String(action.count || 1), button(action.button)]));
        break;
      case 'scroll': {
        const dy = action.dy || 0;
        const dx = action.dx || 0;
        if (dy) await x(['click', '--repeat', String(Math.abs(dy)), dy > 0 ? '5' : '4']);
        if (dx) await x(['click', '--repeat', String(Math.abs(dx)), dx > 0 ? '7' : '6']);
        break;
      }
      case 'drag': {
        const [[fx, fy], [tx, ty]] = points;
        await x(['mousemove', '--sync', String(fx), String(fy)]);
        await x(['mousedown', button(action.button)]);
        await x(['mousemove', '--sync', String(tx), String(ty)]);
        await x(['mouseup', button(action.button)]);
        break;
      }
      default:
        throw new GuiError('invalid_params', 'unknown action');
    }
    const after = await foreground();
    return { foregroundBefore: { image: fg.image, pid: fg.pid }, foregroundAfter: after ? { image: after.image, pid: after.pid } : null };
  }

  return {
    name: 'x11',
    async probe() {
      const probes = [];
      const caps = [];
      const xOk = Boolean(env.DISPLAY);
      probes.push({ check: 'display', ok: xOk, ...(xOk ? {} : { hint: 'no X display in this session' }) });
      if (xOk) caps.push('gui.launch');
      const importOk = exists(IMPORT);
      probes.push({ check: 'imagemagick_import', ok: importOk, ...(importOk ? {} : { hint: 'install ImageMagick (/usr/bin/import)' }) });
      if (xOk && importOk) caps.push('gui.screenshot');
      let xdoOk = false;
      if (exists(XDOTOOL)) {
        try { await x(['getmouselocation']); xdoOk = true; } catch { xdoOk = false; }
      }
      probes.push({ check: 'xdotool', ok: xdoOk, ...(xdoOk ? {} : { hint: 'install xdotool (/usr/bin/xdotool)' }) });
      if (xOk && xdoOk) caps.push('gui.input');
      const locked = await lockedHint();
      const limits = ['no_human_yield', ...(locked === null ? ['no_lock_detect'] : [])];
      return { capabilities: caps, probes, displays: [], limits, locked: locked === true };
    },
    launch: ({ exe, argv, files }) => launchDetached({ exe, argv, files, ...(spawnImpl ? { spawnImpl } : {}) }),
    processes: async ({ match }) => listProcesses({ match, readdir, readlink }),
    async windows({ pids }) {
      const out = [];
      for (const pid of pids || []) {
        let ids = [];
        try { ids = String(await x(['search', '--onlyvisible', '--pid', String(pid)])).split('\n').filter(Boolean); } catch { ids = []; }
        for (const id of ids) {
          let title = '';
          try { title = String(await x(['getwindowname', id])).trim(); } catch { title = ''; }
          out.push({ handle: id, pid, image: imageOf(pid), title, bounds: await geometry(id), scale: 1, minimized: false });
        }
      }
      return out;
    },
    foreground,
    async focus({ handle }) {
      await x(['windowactivate', '--sync', String(handle)]);
      return { focused: true };
    },
    async close({ pids, force }) {
      const closed = [];
      for (const pid of pids || []) {
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); closed.push(pid); } catch { /* gone */ }
      }
      return { closed };
    },
    async screenshot({ handle, maxWidth, quality }) {
      if ((await lockedHint()) === true) throw new GuiError('screen_locked', 'the screen is locked');
      let bounds;
      try {
        bounds = await geometry(handle);
      } catch {
        throw new GuiError('stale_screenshot', 'the window is gone');
      }
      const { stdout } = await execFileImpl(IMPORT, ['-window', String(handle), '-resize', `${maxWidth}x>`, '-quality', String(quality), 'jpg:-'], { encoding: 'buffer' });
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      const size = jpegSize(buf);
      if (!size) throw new GuiError('backend_failed', 'import returned no JPEG');
      return { mime: 'image/jpeg', width: size.width, height: size.height, data: buf.toString('base64'), transform: { sx: bounds.w / size.width, sy: bounds.h / size.height, unit: 'px' } };
    },
    input,
    async releaseAll() {
      try { await x(['keyup', 'ctrl', 'alt', 'shift', 'super']); } catch { /* nothing held */ }
      for (const b of ['1', '2', '3']) {
        try { await x(['mouseup', b]); } catch { /* nothing held */ }
      }
      return null;
    },
    locked: lockedHint,
    hitTest,
    stop: async () => {}
  };
}

module.exports = { createX11Backend };
```

- [ ] **Step 5: Write `src/session/backends/wayland.js`**

```js
// src/session/backends/wayland.js
// Wayland (fleet stage 5 spec §3.3, §11.4): no portal exposes the focused
// window's process, and the Screenshot portal returns full-screen or
// interactive captures, so only gui.launch is offered.
const fs = require('fs');
const { GuiError } = require('../../gui/errors');
const { listProcesses, launchDetached } = require('./linux-common');

function createWaylandBackend({ spawnImpl, readdir = fs.readdirSync, readlink = fs.readlinkSync } = {}) {
  const none = async () => { throw new GuiError('capability_unavailable', 'gui.input'); };
  return {
    name: 'wayland',
    probe: async () => ({
      capabilities: ['gui.launch'],
      probes: [{ check: 'wayland', ok: false, hint: 'Wayland session: apps can be launched, but screenshots and input are not available' }],
      displays: [], limits: [], locked: false
    }),
    launch: ({ exe, argv, files }) => launchDetached({ exe, argv, files, ...(spawnImpl ? { spawnImpl } : {}) }),
    processes: async ({ match }) => listProcesses({ match, readdir, readlink }),
    windows: async () => [],
    foreground: async () => null,
    focus: async () => ({ focused: false }),
    close: async ({ pids, force }) => {
      const closed = [];
      for (const pid of pids || []) {
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); closed.push(pid); } catch { /* gone */ }
      }
      return { closed };
    },
    screenshot: async () => { throw new GuiError('capability_unavailable', 'gui.screenshot'); },
    input: none,
    releaseAll: async () => null,
    locked: async () => null,
    hitTest: async () => null,
    stop: async () => {}
  };
}

module.exports = { createWaylandBackend };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/session-backend-linux.test.js`
Expected: PASS, `# fail 0` (the real-X11 suite runs only on Linux with an X display and xdotool).

- [ ] **Step 7: Commit**

```bash
git add src/session/backends/x11.js src/session/backends/wayland.js src/session/backends/linux-common.js tests/session-backend-linux.test.js
git commit -m "feat(session): Linux X11 and Wayland backends

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After Part 4

Every test file Tasks 15–18 name shows `# fail 0` (the full suite runs once, in Task 21). Part 5 (`2026-09-23-fleet-stage5-session-helper-part5.md`) starts at Task 19 on these commits.

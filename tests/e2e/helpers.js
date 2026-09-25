/**
 * E2E harness for King Louie (fleet stage 7, program ruling 9).
 *
 * Every launch gets its own --user-data-dir, so no test touches the real
 * profile, chats, settings or vault. The app is driven through Playwright's
 * _electron. ELECTRON_RUN_AS_NODE is deleted from the child's environment
 * (an empty value still makes Electron run as plain Node).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { _electron } = require('playwright');

const APP_PATH = path.resolve(__dirname, '..', '..');
const DEFAULT_SEED = Object.freeze({ 'chat-data.json': { onboardingComplete: true } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra, KL_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * The extra env launchApp gives the child, layered under childEnv. KL_CASES_ROOT
 * is always pinned under the launch's own temp profile — never left to inherit
 * whatever the parent shell (an agent's own dev environment, CI, ...) happens to
 * have set (fix round 1, I2) — and a launch that isn't given a real bridge file
 * (i.e. every launchApp call except launchAttached's) points KL_DESKTOP_BRIDGE_FILE
 * at a path that can't exist, so it can never read a real administrator-owned
 * bridge file on the host. `extra` (opts.env) overrides both.
 */
function launchEnv(userDataDir, extra = {}) {
  return {
    KL_CASES_ROOT: path.join(userDataDir, 'cases'),
    KL_DESKTOP_BRIDGE_FILE: path.join(userDataDir, 'no-such-desktop-bridge.json'),
    ...extra
  };
}

function writeSeed(dir, seed) {
  for (const [rel, content] of Object.entries(seed || {})) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

const realpath = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};

/**
 * Launch King Louie on an isolated profile. `seed` (default: onboarding
 * complete) is written into the profile first; `seed: null` writes nothing.
 * On any failure to reach a usable window (isolation mismatch, no window, no
 * #user-input), the app is closed and, if this call created the profile dir
 * itself, that dir is removed before rethrowing (fix round 1, I1).
 */
async function launchApp(opts = {}) {
  const ownsDir = !opts.userDataDir;
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-'));
  if (opts.seed !== null) writeSeed(userDataDir, opts.seed === undefined ? DEFAULT_SEED : opts.seed);
  const electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [APP_PATH, `--user-data-dir=${userDataDir}`, ...(opts.args || [])],
    env: childEnv(launchEnv(userDataDir, opts.env))
  });
  const ctx = { electronApp, userDataDir, ownsDir, extraDirs: [], service: null, closed: false, stdout: '', relaunchRequested: false, exited: false, launchOpts: opts };
  const proc = electronApp.process();
  if (proc.stdout) {
    proc.stdout.on('data', (d) => {
      ctx.stdout += d.toString();
      if (ctx.stdout.includes('KL_RELAUNCH_REQUESTED')) ctx.relaunchRequested = true;
    });
  }
  // Tracked with our own flag, not proc.exitCode: Node leaves exitCode null
  // for a process that ends via a signal, so a later check of exitCode alone
  // can't tell "already exited" from "still running" (fix round 1 carry —
  // the same class of bug fixed on the test-service child in stop()/kill()).
  proc.once('exit', () => { ctx.exited = true; });
  try {
    const actual = await electronApp.evaluate(({ app }) => app.getPath('userData'));
    if (realpath(actual) !== realpath(userDataDir)) {
      throw new Error(`userData isolation failed: the app uses ${actual}, not ${userDataDir}`);
    }
    await electronApp.firstWindow();
    await waitFor(ctx, `!!document.getElementById('user-input')`, 20000);
    return ctx;
  } catch (err) {
    await Promise.race([electronApp.close().catch(() => {}), delay(5000)]);
    try { proc.kill(); } catch { /* already gone */ }
    if (ownsDir) {
      try { await removeDir(userDataDir); } catch { /* best effort; the original error is what matters */ }
    }
    throw err;
  }
}

/** After the app printed KL_RELAUNCH_REQUESTED and quit, start it again on the same profile. */
async function relaunchApp(ctx, { args } = {}) {
  const start = Date.now();
  while (!ctx.relaunchRequested) {
    if (Date.now() - start > 20000) throw new Error('the app never asked to relaunch');
    await delay(100);
  }
  const proc = ctx.electronApp.process();
  if (!ctx.exited) await Promise.race([new Promise((r) => proc.once('exit', r)), delay(10000)]);
  if (!ctx.exited) { try { proc.kill(); } catch { /* already gone */ } }
  const next = await launchApp({ ...ctx.launchOpts, userDataDir: ctx.userDataDir, seed: null, args: args || ctx.launchOpts.args });
  next.ownsDir = ctx.ownsDir;
  next.extraDirs = ctx.extraDirs;
  next.service = ctx.service;
  // Only set once the new launch has actually succeeded — if launchApp threw,
  // ctx (the still-live-in-spirit old context) must stay closable so a
  // caller's cleanup (e.g. a test's after()) still tries to close/remove it.
  ctx.closed = true;
  return next;
}

async function removeDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code) || attempt === 4) throw err;
      await delay(200);
    }
  }
}

/** Close the app, stop any test service, remove the temp dirs. */
async function closeApp(ctx) {
  if (!ctx || ctx.closed) return;
  ctx.closed = true;
  await Promise.race([ctx.electronApp.close().catch(() => {}), delay(5000)]);
  try { ctx.electronApp.process().kill(); } catch { /* already gone */ }
  if (ctx.service) await ctx.service.stop().catch(() => {});
  for (const dir of [ctx.ownsDir ? ctx.userDataDir : null, ...ctx.extraDirs].filter(Boolean)) await removeDir(dir);
}

/** Evaluate JavaScript in the renderer (user-gesture semantics kept) and return the result. */
async function evaluate(ctx, code) {
  return ctx.electronApp.evaluate(async ({ BrowserWindow }, source) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no window');
    return win.webContents.executeJavaScript(source, true);
  }, code);
}

async function waitFor(ctx, code, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await evaluate(ctx, code);
      if (result) return result;
    } catch { /* may fail during load */ }
    await delay(300);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${code}`);
}

async function click(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()
  `);
}

async function fill(ctx, selector, value) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
}

async function getText(ctx, selector) {
  return evaluate(ctx, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; })()`);
}

async function getValue(ctx, selector) {
  return evaluate(ctx, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.value : null; })()`);
}

async function isVisible(ctx, selector) {
  return evaluate(ctx, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      return !el.hidden && style.display !== 'none' && style.visibility !== 'hidden';
    })()
  `);
}

async function count(ctx, selector) {
  return evaluate(ctx, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

/**
 * A real king-louie-service (agent profile) in a child process, with a stub
 * provider and a gated probe tool, on a temporary data dir and config dir.
 * `features.desktopBridge: true`, `ports.desktopBridge: 0`; the bound port is
 * written into the temp desktop-bridge.json (tests only).
 */
async function startTestService({ root }) {
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o755 });
  const serviceJson = path.join(configDir, 'service.json');
  if (!fs.existsSync(serviceJson)) {
    fs.writeFileSync(serviceJson, JSON.stringify({ features: { desktopBridge: true }, ports: { desktopBridge: 0 } }, null, 2), { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(serviceJson, 0o644);
  }
  const bridgeFile = path.join(configDir, 'desktop-bridge.json');
  // KL_CASES_ROOT is pinned under this service's own temp data dir — never
  // left to inherit whatever the host process's environment happens to have
  // set (fix round 1, I2) — a real value there would otherwise point a case
  // write at a directory this harness doesn't own or clean up.
  const child = fork(path.join(__dirname, '_attach-service.js'), ['--data-dir', dataDir], {
    silent: true,
    env: { ...process.env, KL_TEST_MODE: '1', KL_CASES_ROOT: path.join(dataDir, 'cases') }
  });
  // `child.exitCode` stays null for a process killed by a signal (only
  // `signalCode` is set then), so it can't tell "already exited" from
  // "still running" after kill('SIGKILL'). Track exit with our own flag.
  let hasExited = false;
  child.once('exit', () => { hasExited = true; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      // A child that never reports readiness must not be left running (fix
      // round 1, I1) — nothing else in this harness will ever call stop()
      // on it, since startTestService itself is about to throw.
      child.kill('SIGKILL');
      reject(new Error(`the test service did not start. stderr: ${stderr.slice(0, 800)}`));
    }, 60000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.startsWith('KL_ATTACH_SERVICE '));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('KL_ATTACH_SERVICE '.length))); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the test service exited with ${code}. stderr: ${stderr.slice(0, 800)}`)); });
  });
  const writePort = () => {
    const record = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
    fs.writeFileSync(bridgeFile, JSON.stringify({ ...record, port: info.port }, null, 2), { mode: 0o644 });
  };
  const service = {
    root, dataDir, configDir, bridgeFile, port: info.port, child,
    // What an administrator runs; then the test port goes back into the file.
    // `yes: true` stands in for the admin's interactive confirmation — the
    // real CLI refuses to pair without a TTY or --yes (runDesktopCommand),
    // and this harness's io object has no stdin for defaultIsTTY to read.
    async pair(request) {
      const { runDesktopCommand } = require('../../src/service/commands/desktop');
      const out = { stdout: '', stderr: '' };
      const code = await runDesktopCommand({
        sub: 'pair', arg: request, dataDir, yes: true,
        io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } },
        deps: { isAdmin: () => true, configDir, runningServicePid: () => child.pid, withServiceCore: () => { throw new Error('the service is running'); }, applyWindowsAcls: () => {} }
      });
      if (code !== 0) throw new Error(`desktop pair failed (${code}): ${out.stderr}`);
      writePort();
      return out.stdout;
    },
    async stop() {
      if (hasExited) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      // The IPC channel can already be gone (e.g. the child hit its own
      // 'disconnect' exit) even though the 'exit' event hasn't fired yet;
      // child.send() on a disconnected channel throws.
      if (child.connected) child.send({ type: 'shutdown' });
      await Promise.race([exited, delay(10000)]);
      if (!hasExited) {
        child.kill('SIGKILL');
        // restart() forks a new child into the same dataDir/configDir right
        // after stop() resolves — it must not race the old process's file
        // handles, so wait for the actual exit rather than just requesting it.
        await exited;
      }
    },
    kill() {
      if (hasExited) return Promise.resolve();
      child.kill('SIGKILL');
      return new Promise((resolve) => child.once('exit', resolve));
    },
    async restart() {
      await service.stop();
      return startTestService({ root });
    }
  };
  return service;
}

/**
 * Launch the app attached to a temporary service: pair through the UI, run
 * the admin command in-process, confirm, attach, relaunch. On any failure
 * after the service has started, the app (if launched) is closed and the
 * service stopped, and both temp roots are removed before rethrowing (fix
 * round 1, I1) — a partial pairing attempt must not leave the service child
 * or either temp dir behind.
 */
async function launchAttached(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-svc-'));
  const service = await startTestService({ root });
  let ctx = null;
  try {
    ctx = await launchApp({ ...opts, env: { ...(opts.env || {}), KL_DESKTOP_BRIDGE_FILE: service.bridgeFile } });
    ctx.extraDirs.push(root);
    ctx.service = service;
    await click(ctx, '#open-settings-btn');
    await evaluate(ctx, `switchSettingsTab('service'); true`);
    await waitFor(ctx, `!!document.getElementById('service-action-pair')`, 15000);
    await click(ctx, '#service-action-pair');
    const request = await waitFor(ctx, `document.getElementById('service-pair-request')?.textContent || ''`, 15000);
    await service.pair(request);
    await waitFor(ctx, `(() => { const b = document.getElementById('service-action-pairConfirm'); return b && !b.disabled; })()`, 15000);
    await click(ctx, '#service-action-pairConfirm');
    await waitFor(ctx, `!!document.getElementById('service-action-attach')`, 20000);
    await click(ctx, '#service-action-attach');
    ctx = await relaunchApp(ctx);
    await waitFor(ctx, `window.electron.desktop.status().then((s) => s.view === 'attached-connected')`, 30000);
    return ctx;
  } catch (err) {
    if (ctx) {
      // ctx already carries the service and root (pushed onto extraDirs)
      // above, so closeApp alone stops the service and removes both roots.
      await closeApp(ctx).catch(() => {});
    } else {
      await service.stop().catch(() => {});
      await removeDir(root).catch(() => {});
    }
    throw err;
  }
}

module.exports = {
  launchApp,
  relaunchApp,
  launchAttached,
  startTestService,
  closeApp,
  evaluate,
  waitFor,
  click,
  fill,
  getText,
  getValue,
  isVisible,
  count,
  childEnv,
  launchEnv,
  writeSeed,
  APP_PATH
};

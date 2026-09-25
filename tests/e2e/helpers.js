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
 */
async function launchApp(opts = {}) {
  const ownsDir = !opts.userDataDir;
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-'));
  if (opts.seed !== null) writeSeed(userDataDir, opts.seed === undefined ? DEFAULT_SEED : opts.seed);
  const electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [APP_PATH, `--user-data-dir=${userDataDir}`, ...(opts.args || [])],
    env: childEnv(opts.env)
  });
  const ctx = { electronApp, userDataDir, ownsDir, extraDirs: [], service: null, closed: false, stdout: '', relaunchRequested: false, launchOpts: opts };
  const proc = electronApp.process();
  if (proc.stdout) {
    proc.stdout.on('data', (d) => {
      ctx.stdout += d.toString();
      if (ctx.stdout.includes('KL_RELAUNCH_REQUESTED')) ctx.relaunchRequested = true;
    });
  }
  const actual = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  if (realpath(actual) !== realpath(userDataDir)) {
    await electronApp.close().catch(() => {});
    throw new Error(`userData isolation failed: the app uses ${actual}, not ${userDataDir}`);
  }
  await electronApp.firstWindow();
  await waitFor(ctx, `!!document.getElementById('user-input')`, 20000);
  return ctx;
}

/** After the app printed KL_RELAUNCH_REQUESTED and quit, start it again on the same profile. */
async function relaunchApp(ctx, { args } = {}) {
  const start = Date.now();
  while (!ctx.relaunchRequested) {
    if (Date.now() - start > 20000) throw new Error('the app never asked to relaunch');
    await delay(100);
  }
  const proc = ctx.electronApp.process();
  if (proc.exitCode === null) await Promise.race([new Promise((r) => proc.once('exit', r)), delay(10000)]);
  ctx.closed = true;
  const next = await launchApp({ ...ctx.launchOpts, userDataDir: ctx.userDataDir, seed: null, args: args || ctx.launchOpts.args });
  next.ownsDir = ctx.ownsDir;
  next.extraDirs = ctx.extraDirs;
  next.service = ctx.service;
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
  const child = fork(path.join(__dirname, '_attach-service.js'), ['--data-dir', dataDir], { silent: true, env: { ...process.env, KL_TEST_MODE: '1' } });
  // `child.exitCode` stays null for a process killed by a signal (only
  // `signalCode` is set then), so it can't tell "already exited" from
  // "still running" after kill('SIGKILL'). Track exit with our own flag.
  let hasExited = false;
  child.once('exit', () => { hasExited = true; });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`the test service did not start. stderr: ${stderr.slice(0, 800)}`)), 60000);
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
      child.send({ type: 'shutdown' });
      await Promise.race([exited, delay(10000)]);
      if (!hasExited) child.kill('SIGKILL');
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
 * the admin command in-process, confirm, attach, relaunch.
 */
async function launchAttached(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-svc-'));
  const service = await startTestService({ root });
  let ctx = await launchApp({ ...opts, env: { ...(opts.env || {}), KL_DESKTOP_BRIDGE_FILE: service.bridgeFile } });
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
  writeSeed,
  APP_PATH
};

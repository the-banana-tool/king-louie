// tests/standalone-host.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createCore } = require('../src/core');
const { isLocalDesktopEvent } = require('../src/core/origin');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { startStandaloneHost, markingIpcMain } = require('../src/ipc/standalone-host');
const CronScheduler = require('../src/cron/cron-scheduler');
const CronExecutor = require('../src/cron/cron-executor');
const SkillLoader = require('../src/skills/skill-loader');

const dirs = [];
const hosts = [];
after(async () => {
  for (const h of hosts) await h.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-standalone-')); dirs.push(d); return d; };

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return { handlers, listeners, handle: (ch, fn) => { assert.ok(!handlers.has(ch), `duplicate ${ch}`); handlers.set(ch, fn); }, on: (ch, fn) => listeners.set(ch, fn), removeHandler: (ch) => handlers.delete(ch) };
}

function startHost({ standaloneOnce }) {
  const userData = tmp();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`sealed:${s}`), decryptString: (b) => Buffer.from(b).toString().replace(/^sealed:/, '') };
  class StoreClass extends JsonFileStore {
    constructor({ name = 'config', defaults = {} } = {}) { super({ dir: userData, name, defaults }); }
  }
  const ipc = fakeIpcMain();
  let captured = null;
  const host = startStandaloneHost({
    app: { getPath: () => userData, relaunch() {}, exit() {}, quit() {} },
    ipcMain: ipc,
    safeStorage,
    shell: { openExternal: async () => {} },
    Notification: class { show() {} },
    getWindow: () => null,
    state: openDesktopState(userData, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) }),
    appDir: path.join(__dirname, '..'),
    standaloneOnce,
    StoreClass,
    // Webhooks and app discovery off only to keep the test quick and port-free.
    createCoreFn: (deps) => { captured = deps; return createCore({ ...deps, features: { ...(deps.features || {}), webhooks: false, appDiscovery: false, ...(standaloneOnce ? {} : { gateway: false, mesh: false, channels: false }) } }); }
  });
  hosts.push(host);
  return { host, ipc, captured: () => captured };
}

describe('markingIpcMain', () => {
  it('hands every handler and listener a marked event', async () => {
    const ipc = fakeIpcMain();
    const wrapped = markingIpcMain(ipc);
    let seenHandle = null;
    let seenOn = null;
    wrapped.handle('chat:load', async (event, arg) => { seenHandle = [event, arg]; return 1; });
    wrapped.on('tool:approvalResponse', (event, arg) => { seenOn = [event, arg]; });
    const e1 = { sender: {} };
    const e2 = { sender: {} };
    assert.strictEqual(await ipc.handlers.get('chat:load')(e1, 'x'), 1);
    ipc.listeners.get('tool:approvalResponse')(e2, 'y');
    assert.strictEqual(seenHandle[0], e1);
    assert.strictEqual(isLocalDesktopEvent(seenHandle[0]), true);
    assert.strictEqual(seenHandle[1], 'x');
    assert.strictEqual(isLocalDesktopEvent(seenOn[0]), true);
  });

  it('removeHandler removes the handler from the underlying ipcMain', () => {
    const ipc = fakeIpcMain();
    const wrapped = markingIpcMain(ipc);
    wrapped.handle('chat:load', async () => 1);
    assert.ok(ipc.handlers.has('chat:load'));
    wrapped.removeHandler('chat:load');
    assert.ok(!ipc.handlers.has('chat:load'));
  });
});

describe('CronScheduler.pause', () => {
  it('stops ticks from running due jobs', async () => {
    let runs = 0;
    const store = { list: () => [{ id: 'j1', enabled: true, schedule: { kind: 'every', everyMs: 1 }, state: { lastRunAtMs: 0 } }], update: async () => {} };
    const scheduler = new CronScheduler(store, { execute: async () => { runs += 1; return { ok: true }; } });
    scheduler.pause();
    await scheduler.tick();
    assert.strictEqual(runs, 0);
    assert.strictEqual(scheduler.paused, true);
  });

  it('clears a running timer', () => {
    const store = { list: () => [], update: async () => {} };
    const scheduler = new CronScheduler(store, { execute: async () => ({ ok: true }) });
    scheduler.start();
    assert.ok(scheduler.timer, 'start() set a timer');
    scheduler.pause();
    assert.strictEqual(scheduler.timer, null, 'pause() cleared the running timer');
  });

  it('start() after pause() starts nothing', () => {
    const store = { list: () => [], update: async () => {} };
    const scheduler = new CronScheduler(store, { execute: async () => ({ ok: true }) });
    scheduler.pause();
    scheduler.start();
    assert.strictEqual(scheduler.timer, null);
  });

  it('stop() still works after pause()', () => {
    const store = { list: () => [], update: async () => {} };
    const scheduler = new CronScheduler(store, { execute: async () => ({ ok: true }) });
    scheduler.start();
    scheduler.pause();
    assert.doesNotThrow(() => scheduler.stop());
    assert.strictEqual(scheduler.timer, null);
  });
});

describe('startStandaloneHost', () => {
  it('registers every channel through the marking wrapper, desktop:* included', async () => {
    const { host, ipc } = startHost({ standaloneOnce: false });
    const event = { sender: { send() {}, isDestroyed: () => false } };
    const loaded = await ipc.handlers.get('chat:load')(event);
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(isLocalDesktopEvent(event), true);
    const status = await ipc.handlers.get('desktop:status')(event);
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.mode, 'standalone');
    assert.ok(ipc.listeners.has('canvas:executeJsResult'));
    await host.start();
    assert.notStrictEqual(host.core.context.getCronScheduler().paused, true);
  });

  it('--kl-standalone-once starts with channels, gateway and mesh off and cron paused', async () => {
    const { host, captured } = startHost({ standaloneOnce: true });
    assert.deepStrictEqual(captured().features, { channels: false, gateway: false, mesh: false, webhooks: false });
    assert.strictEqual(captured().cronStartPaused, true);
    await host.start();
    assert.strictEqual(host.core.context.getCronScheduler().paused, true);
  });

  // Final review I1: the scheduler used to be started inside core.start()
  // (first tick at 100 ms) and paused only after start() returned, so a job
  // due at launch ran whenever skills took longer than that to load. Built
  // paused, it never ticks. The control run (a normal standalone launch)
  // proves the same setup does run the job, so the test can tell.
  async function runWithDueJobAndSlowSkills(standaloneOnce) {
    const realLoadAll = SkillLoader.prototype.loadAll;
    const realExecute = CronExecutor.prototype.execute;
    let executed = 0;
    let loadingDone = false;
    let executedWhileLoading = 0;
    SkillLoader.prototype.loadAll = async function slowLoadAll(...args) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const n = await realLoadAll.apply(this, args);
      loadingDone = true;
      return n;
    };
    CronExecutor.prototype.execute = async function countingExecute() {
      executed += 1;
      if (!loadingDone) executedWhileLoading += 1;
      return { ok: true };
    };
    try {
      const { host, captured } = startHost({ standaloneOnce });
      const cronDir = path.join(captured().paths.dataDir, 'cron');
      fs.mkdirSync(cronDir, { recursive: true });
      const job = { id: 'due-at-launch', name: 'due', enabled: true, schedule: { kind: 'every', everyMs: 60000 }, payload: { message: 'hi' }, state: { lastRunAtMs: 0 } };
      fs.writeFileSync(path.join(cronDir, 'jobs.json'), JSON.stringify({ [job.id]: job }));
      await host.start();
      // Give an already-scheduled tick time to land after start() returns.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const scheduler = host.core.context.getCronScheduler();
      scheduler.stop();
      return { executed, executedWhileLoading, scheduler };
    } finally {
      SkillLoader.prototype.loadAll = realLoadAll;
      CronExecutor.prototype.execute = realExecute;
    }
  }

  it('--kl-standalone-once never runs a job due at launch, even with slow skill loading', async () => {
    const control = await runWithDueJobAndSlowSkills(false);
    assert.ok(control.executedWhileLoading >= 1, 'control: a normal launch runs the due job while skills load');
    const once = await runWithDueJobAndSlowSkills(true);
    assert.strictEqual(once.executed, 0, 'the standalone-once session ran no cron job');
    assert.strictEqual(once.scheduler.paused, true);
    assert.strictEqual(once.scheduler.timer, null, 'the scheduler was never started');
  });

  // Fix round 1, I1: a --kl-standalone-once session runs next to a live
  // service and must never restart a channel through /llm — startDiscordBridge
  // et al. must refuse rather than actually connect.
  it('--kl-standalone-once refuses to start a channel through runLlmCommand', async () => {
    const { host } = startHost({ standaloneOnce: true });
    await host.start();
    const result = await host.core.context.runLlmCommand('/llm discord add faketoken');
    assert.deepStrictEqual(result, { ok: false, error: 'Channels are off in this session.' });
  });

  // Fix round 1, I2: a core that fails to start must not keep acting — cron
  // is paused and the core is given a chance to shut down before the
  // failure reaches the caller (main.js shows it and quits).
  it('a failing core.start() pauses cron, shuts the core down, and rethrows', async () => {
    const userData = tmp();
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`sealed:${s}`), decryptString: (b) => Buffer.from(b).toString().replace(/^sealed:/, '') };
    class StoreClass extends JsonFileStore {
      constructor({ name = 'config', defaults = {} } = {}) { super({ dir: userData, name, defaults }); }
    }
    let shutdownCalled = false;
    const host = startStandaloneHost({
      app: { getPath: () => userData, relaunch() {}, exit() {}, quit() {} },
      ipcMain: fakeIpcMain(),
      safeStorage,
      shell: { openExternal: async () => {} },
      Notification: class { show() {} },
      getWindow: () => null,
      state: openDesktopState(userData, safeStorage, { storeFactory: ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults }) }),
      appDir: path.join(__dirname, '..'),
      standaloneOnce: false,
      StoreClass,
      // A real core (so context/getCronScheduler and shutdown() are the
      // genuine article, cron scheduler included) whose start() fails right
      // after the real initialization — including cron construction — runs.
      createCoreFn: (deps) => {
        const core = createCore({ ...deps, features: { ...(deps.features || {}), webhooks: false, appDiscovery: false, gateway: false, mesh: false, channels: false } });
        const realStart = core.start.bind(core);
        core.start = async () => { await realStart(); throw new Error('boom'); };
        const realShutdown = core.shutdown.bind(core);
        core.shutdown = async (...args) => { shutdownCalled = true; return realShutdown(...args); };
        return core;
      }
    });
    await assert.rejects(() => host.start(), /boom/);
    assert.strictEqual(host.core.context.getCronScheduler().paused, true, 'cron was paused on failure');
    assert.strictEqual(shutdownCalled, true, 'core.shutdown() was awaited on failure');
  });
});

describe('main.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  it('is wiring only: no core of its own, a host chosen from the desktop state', () => {
    assert.ok(!/createCore/.test(main), 'main.js builds no core');
    assert.match(main, /openDesktopState\(/);
    assert.match(main, /startAttachedHost/);
    assert.match(main, /startStandaloneHost/);
    assert.match(main, /--kl-standalone-once/);
    assert.ok(main.split('\n').length < 130, `main.js has ${main.split('\n').length} lines`);
  });
});

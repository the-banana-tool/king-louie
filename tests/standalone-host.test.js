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
    assert.strictEqual(host.core.context.getCronScheduler().paused, undefined);
  });

  it('--kl-standalone-once starts with channels, gateway and mesh off and cron paused', async () => {
    const { host, captured } = startHost({ standaloneOnce: true });
    assert.deepStrictEqual(captured().features, { channels: false, gateway: false, mesh: false });
    await host.start();
    assert.strictEqual(host.core.context.getCronScheduler().paused, true);
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

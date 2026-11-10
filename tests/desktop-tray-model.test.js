// tests/desktop-tray-model.test.js
// The tray (boot-node-tray spec §5.4, C-6, C-9, C-10): the Electron-free model,
// the tray-mode rule, and src/ipc/tray.js over fake Tray, Menu and dialog.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const { trayModel } = require('../src/desktop-bridge/tray-model');
const { trayModeOn, localPersonalDataDir } = require('../src/desktop-bridge/local-personal');
const { createTray, QUIT_WHILE_RECORDING } = require('../src/ipc/tray');
const { createTrayHost } = require('../src/ipc/tray-host');

const DATA_DIR = 'C:\\Users\\example\\AppData\\Local\\KingLouie\\node\\data';
const node = (extra = {}) => ({ hosting: 'personal', name: 'Example', dataDir: DATA_DIR, task: 'registered', running: false, pid: null, starting: false, startError: null, ...extra });
const ids = (model) => model.items.map((i) => i.id);
const item = (model, id) => model.items.find((i) => i.id === id);

describe('trayModel', () => {
  it('connected: icon up, tooltip "King Louie: node running", items open, state, restart, quit', () => {
    const m = trayModel({ view: 'attached-connected', node: node({ running: true }) }, { recording: false });
    assert.strictEqual(m.icon, 'up');
    assert.strictEqual(m.tooltip, 'King Louie: node running');
    assert.deepStrictEqual(ids(m), ['open', 'state', 'restart', 'quit']);
    assert.strictEqual(item(m, 'state').enabled, false);
    assert.strictEqual(item(m, 'state').label, 'King Louie Node: running');
    assert.strictEqual(item(m, 'open').label, 'Open King Louie');
    assert.strictEqual(item(m, 'restart').label, 'Restart King Louie Node');
    assert.strictEqual(item(m, 'quit').label, 'Quit King Louie');
    for (const id of ['open', 'restart', 'quit']) assert.strictEqual(item(m, id).enabled, true, id);
  });

  it('starting: icon starting, "King Louie Node is starting…", no start/restart', () => {
    const m = trayModel({ view: 'attached-starting', node: node({ starting: true }) });
    assert.strictEqual(m.icon, 'starting');
    assert.strictEqual(m.tooltip, 'King Louie Node is starting…');
    assert.deepStrictEqual(ids(m), ['open', 'state', 'quit']);
  });

  it('down with a registered task: icon down, a Start item', () => {
    const m = trayModel({ view: 'attached-disconnected', node: node() });
    assert.strictEqual(m.icon, 'down');
    assert.strictEqual(m.tooltip, 'King Louie: node stopped');
    assert.deepStrictEqual(ids(m), ['open', 'state', 'start', 'quit']);
    assert.strictEqual(item(m, 'start').label, 'Start King Louie Node');
    assert.strictEqual(item(m, 'state').label, 'King Louie Node: stopped');
  });

  it('down and running with no bridge: Restart; no task: not installed, nothing to press', () => {
    const running = trayModel({ view: 'attached-disconnected', node: node({ running: true, pid: 4242 }) });
    assert.deepStrictEqual(ids(running), ['open', 'state', 'restart', 'quit']);
    assert.strictEqual(running.tooltip, 'King Louie: node not reachable');
    const missing = trayModel({ view: 'attached-disconnected', node: node({ task: 'missing' }) });
    assert.strictEqual(missing.icon, 'down');
    assert.strictEqual(missing.tooltip, 'King Louie: node not installed');
    assert.deepStrictEqual(ids(missing), ['open', 'state', 'quit']);
  });

  it('a live recording adds a disabled "A take is recording" line', () => {
    const m = trayModel({ view: 'attached-connected', node: node({ running: true }) }, { recording: true });
    assert.deepStrictEqual(ids(m), ['open', 'state', 'restart', 'take', 'quit']);
    assert.deepStrictEqual(item(m, 'take'), { id: 'take', label: 'A take is recording', enabled: false });
  });

  it('no status at all is down and offers only open and quit', () => {
    const m = trayModel(null);
    assert.strictEqual(m.icon, 'down');
    assert.deepStrictEqual(ids(m), ['open', 'state', 'quit']);
  });
});

describe('tray mode', () => {
  const personal = { deviceId: 'd', service: { hosting: 'personal', dataDir: DATA_DIR } };
  const attached = { host: 'attached', why: 'attached', degraded: false };

  it('on: attached, Windows, a local personal record with its data dir', () => {
    assert.strictEqual(trayModeOn({ launch: attached, platform: 'win32', pairing: personal, stateMode: 'attached' }), true);
    assert.strictEqual(localPersonalDataDir(personal, 'win32'), DATA_DIR);
  });

  it('off: standalone, development, another platform, a fleet or remote record, no data dir', () => {
    const off = [
      { launch: { host: 'standalone', why: 'dev' }, platform: 'win32', pairing: personal, stateMode: 'attached' },
      { launch: { host: 'standalone', why: 'once' }, platform: 'win32', pairing: personal, stateMode: 'attached' },
      { launch: attached, platform: 'darwin', pairing: personal, stateMode: 'attached' },
      { launch: attached, platform: 'win32', pairing: { service: { hosting: 'service', dataDir: DATA_DIR } }, stateMode: 'attached' },
      { launch: attached, platform: 'win32', pairing: { service: { dataDir: DATA_DIR } }, stateMode: 'attached' },
      { launch: attached, platform: 'win32', pairing: { ...personal, kind: 'remote' }, stateMode: 'attached' },
      { launch: attached, platform: 'win32', pairing: { service: { hosting: 'personal' } }, stateMode: 'attached' },
      { launch: attached, platform: 'win32', pairing: null, stateMode: 'attached' },
      // The setup view with a kept pairing that is not attached (Detach).
      { launch: { host: 'attached', why: 'needs-node' }, platform: 'win32', pairing: personal, stateMode: 'standalone' }
    ];
    for (const input of off) assert.strictEqual(trayModeOn(input), false, JSON.stringify(input));
  });
});

// Fakes for Electron's Tray, Menu and dialog.
function fakes({ status, recording = false, choice = 1 } = {}) {
  const made = { trays: [], menus: [], dialogs: [], opened: 0, quits: 0, presses: [] };
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; this.tooltip = null; this.menu = null; this.destroyed = false; made.trays.push(this); }
    setToolTip(t) { this.tooltip = t; }
    setContextMenu(m) { this.menu = m; }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: (template) => { made.menus.push(template); return { template }; } };
  const dialog = { showMessageBoxSync: (opts) => { made.dialogs.push(opts); return choice; } };
  const controller = new EventEmitter();
  controller.current = status || { view: 'attached-connected', node: node({ running: true }) };
  controller.status = async () => controller.current;
  controller.nodeStart = async (opts) => { made.presses.push(opts); return { ok: true }; };
  const screen = new EventEmitter();
  screen.live = recording;
  screen.recording = () => screen.live;
  return { made, Tray, Menu, dialog, controller, screen };
}

function build(f) {
  return createTray({
    Tray: f.Tray, Menu: f.Menu, dialog: f.dialog, iconPath: 'icons/icon.ico',
    controller: f.controller, screenHost: () => f.screen,
    openWindow: () => { f.made.opened += 1; }, quit: () => { f.made.quits += 1; },
    log: { warn() {}, info() {}, error() {}, debug() {} }
  });
}

describe('createTray', () => {
  it('draws the model: the icon, the tooltip and the menu, and a click opens the window', async () => {
    const f = fakes();
    const t = build(f);
    await t.refresh();
    const tray = f.made.trays[0];
    assert.strictEqual(tray.icon, 'icons/icon.ico');
    assert.strictEqual(tray.tooltip, 'King Louie: node running');
    assert.deepStrictEqual(tray.menu.template.map((i) => i.label), ['Open King Louie', 'King Louie Node: running', 'Restart King Louie Node', 'Quit King Louie']);
    assert.strictEqual(typeof tray.menu.template[1].click, 'undefined', 'the state line does nothing');
    tray.emit('click');
    assert.strictEqual(f.made.opened, 1);
    t.destroy();
    assert.strictEqual(tray.destroyed, true);
    assert.strictEqual(t.exists(), false);
  });

  it('redraws on the controller\'s change and the screen host\'s', async () => {
    const f = fakes();
    const t = build(f);
    await t.refresh();
    f.controller.current = { view: 'attached-disconnected', node: node() };
    f.controller.emit('changed');
    await t.refresh();
    assert.strictEqual(f.made.trays[0].tooltip, 'King Louie: node stopped');
    f.screen.live = true;
    f.screen.emit('change', { connected: true, recording: true });
    await t.refresh();
    assert.ok(t.model().items.some((i) => i.id === 'take'));
    t.destroy();
  });

  it('Start and Restart press the controller\'s nodeStart', async () => {
    const f = fakes({ status: { view: 'attached-disconnected', node: node() } });
    const t = build(f);
    await t.invoke('start');
    await t.invoke('restart');
    assert.deepStrictEqual(f.made.presses, [{ restart: false }, { restart: true }]);
    t.destroy();
  });

  it('Quit with no take quits without asking', async () => {
    const f = fakes();
    const t = build(f);
    assert.deepStrictEqual(await t.invoke('quit'), { ok: true });
    assert.strictEqual(f.made.quits, 1);
    assert.strictEqual(f.made.dialogs.length, 0);
    t.destroy();
  });

  it('Quit while a take records asks first; Cancel keeps the app, Quit quits', async () => {
    const cancel = fakes({ recording: true, choice: 1 });
    const t1 = build(cancel);
    assert.strictEqual((await t1.invoke('quit')).code, 'CANCELLED');
    assert.strictEqual(cancel.made.quits, 0);
    const asked = cancel.made.dialogs[0];
    assert.strictEqual(asked.message, 'A take is recording. Quit and end it?');
    assert.strictEqual(QUIT_WHILE_RECORDING, asked.message);
    assert.deepStrictEqual(asked.buttons, ['Quit', 'Cancel']);
    assert.strictEqual(asked.cancelId, 1);
    t1.destroy();

    const go = fakes({ recording: true, choice: 0 });
    const t2 = build(go);
    assert.deepStrictEqual(await t2.invoke('quit'), { ok: true });
    assert.strictEqual(go.made.quits, 1);
    t2.destroy();
  });

  it('a status read that fails still draws a tray, down', async () => {
    const f = fakes();
    f.controller.status = async () => { throw new Error('boom'); };
    const t = build(f);
    await t.refresh();
    assert.strictEqual(t.model().icon, 'down');
    t.destroy();
  });
});

// main.js's window rules, over a fake app, window and tray.
const APP_DIR = path.join(os.tmpdir(), 'kl-tray-app');
function hostFakes({ pairing, launch = { host: 'attached', why: 'attached', degraded: false }, argv = ['electron', '.'], trayThrows = false } = {}) {
  const made = { shutdowns: 0, quits: 0, created: 0, trays: [] };
  const app = new EventEmitter();
  app.quit = () => { made.quits += 1; app.emit('before-quit'); };
  const host = { controller: new EventEmitter(), screenHost: () => null, shutdown: async () => { made.shutdowns += 1; } };
  let win = null;
  const newWindow = () => {
    const w = new EventEmitter();
    w.visible = true; w.destroyed = false;
    w.isDestroyed = () => w.destroyed; w.isMinimized = () => false; w.restore = () => {};
    w.show = () => { w.visible = true; }; w.hide = () => { w.visible = false; }; w.focus = () => {};
    w.close = () => { const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; w.emit('close', e); if (!e.defaultPrevented) w.destroyed = true; };
    return w;
  };
  const trayHost = createTrayHost({
    app, Tray: null, Menu: null, dialog: null, host, launch,
    state: { pairing: pairing === undefined ? { service: { hosting: 'personal', dataDir: DATA_DIR } } : pairing, mode: 'attached' },
    getWindow: () => win, createWindow: () => { made.created += 1; win = newWindow(); trayHost.watchWindow(win); },
    argv, platform: 'win32', env: {}, appDir: APP_DIR,
    log: { error() {}, warn() {}, info() {}, debug() {} },
    trayFactory: (opts) => {
      if (trayThrows) throw new Error('no tray here');
      const t = { opts, gone: false, exists: () => !t.gone, destroy: () => { t.gone = true; }, model: () => null, invoke: () => ({ ok: true }) };
      made.trays.push(t);
      return t;
    }
  });
  const makeWindow = () => { win = newWindow(); trayHost.watchWindow(win); return win; };
  return { made, app, trayHost, makeWindow, window: () => win };
}

describe('createTrayHost', () => {
  it('--kl-tray starts hidden only in tray mode', () => {
    assert.strictEqual(hostFakes({ argv: ['electron', '.', '--kl-tray'] }).trayHost.startHidden, true);
    assert.strictEqual(hostFakes().trayHost.startHidden, false);
    assert.strictEqual(hostFakes({ argv: ['electron', '.', '--kl-tray'], launch: { host: 'standalone', why: 'dev' } }).trayHost.startHidden, false);
    assert.strictEqual(hostFakes({ argv: ['electron', '.', '--kl-tray'], pairing: { service: { hosting: 'service' } } }).trayHost.startHidden, false);
  });

  it('with the tray up, closing hides the window and the app stays; Quit shuts down once and quits', async () => {
    const f = hostFakes();
    const win = f.makeWindow();
    f.trayHost.start();
    assert.strictEqual(f.made.trays.length, 1);
    assert.strictEqual(f.made.trays[0].opts.iconPath, path.join(APP_DIR, 'icons', 'icon.ico'));
    win.close();
    assert.strictEqual(win.destroyed, false);
    assert.strictEqual(win.visible, false);
    f.trayHost.allWindowsClosed();
    assert.strictEqual(f.made.shutdowns, 0);
    f.made.trays[0].opts.openWindow();
    assert.strictEqual(win.visible, true);
    f.made.trays[0].opts.quit();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(f.made.trays[0].gone, true);
    assert.strictEqual(f.made.shutdowns, 1);
    assert.strictEqual(f.made.quits, 1);
    win.close();
    assert.strictEqual(win.destroyed, true, 'a quitting app closes its window');
    f.trayHost.allWindowsClosed();
    assert.strictEqual(f.made.shutdowns, 1, 'shut down once');
  });

  it('an app quit from elsewhere (a relaunch, the OS) is not held by the tray', () => {
    const f = hostFakes();
    const win = f.makeWindow();
    f.trayHost.start();
    f.app.emit('before-quit');
    win.close();
    assert.strictEqual(win.destroyed, true);
    const g = hostFakes();
    const w2 = g.makeWindow();
    g.trayHost.start();
    w2.emit('session-end');
    w2.close();
    assert.strictEqual(w2.destroyed, true);
  });

  it('off tray mode: no tray, closing closes, the last window quits', async () => {
    const f = hostFakes({ launch: { host: 'standalone', why: 'dev' } });
    const win = f.makeWindow();
    f.trayHost.start();
    assert.strictEqual(f.made.trays.length, 0);
    win.close();
    assert.strictEqual(win.destroyed, true);
    f.trayHost.allWindowsClosed();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(f.made.shutdowns, 1);
    assert.strictEqual(f.made.quits, 1);
  });

  it('a tray that fails to start puts the window on screen', () => {
    const f = hostFakes({ trayThrows: true, argv: ['electron', '.', '--kl-tray'] });
    const win = f.makeWindow();
    win.hide();
    f.trayHost.start();
    assert.strictEqual(win.visible, true);
    win.close();
    assert.strictEqual(win.destroyed, true, 'with no tray a close closes');
  });
});

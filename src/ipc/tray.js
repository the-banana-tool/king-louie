// src/ipc/tray.js
// King Louie in the tray (boot-node-tray spec §5.4, C-6, C-9), when attached
// to this machine's personal node. The Electron Tray and its menu over
// tray-model.js: a click opens the window; the menu opens it, names the
// node's state, starts or restarts the node (the controller's nodeStart),
// says whether a take is recording and quits. Quitting never stops the node,
// and asks first while a take is recording. Electron comes in through deps
// (`Tray`, `Menu`, `dialog`), so this is tested without it.
const { createLogger } = require('../logging');
const { trayModel } = require('../desktop-bridge/tray-model');

const QUIT_WHILE_RECORDING = 'A take is recording. Quit and end it?';
const REFRESH_MS = 15000;

function createTray({
  Tray, Menu, dialog, iconPath, controller, screenHost = () => null,
  openWindow, quit, log = createLogger('tray'), refreshMs = REFRESH_MS
}) {
  const tray = new Tray(iconPath);
  let destroyed = false;
  let model = trayModel({}, { recording: false });
  let running = null;
  let again = false;

  const recording = () => {
    const sh = screenHost();
    return Boolean(sh && sh.recording());
  };

  function apply(next) {
    model = next;
    tray.setToolTip(next.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate(next.items.map((item) => ({
      label: item.label,
      enabled: item.enabled,
      ...(item.enabled ? { click: () => { invoke(item.id); } } : {})
    }))));
  }

  // One status read at a time; a change during one reads once more after it.
  function refresh() {
    if (destroyed) return Promise.resolve(model);
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        let status = null;
        try {
          status = await controller.status();
        } catch (err) {
          log.warn(`the tray could not read the node's status: ${err.message}`);
        }
        if (destroyed) return model;
        apply(trayModel(status, { recording: recording() }));
      } while (again && !destroyed);
      return model;
    })().finally(() => { running = null; });
    return running;
  }

  // C-6: Cancel keeps the app; Quit (or no take) quits. True when quitting.
  function confirmQuit() {
    if (!recording()) return true;
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'King Louie',
      message: QUIT_WHILE_RECORDING,
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    return choice === 0;
  }

  async function invoke(id) {
    if (destroyed) return { ok: false, code: 'TRAY_GONE' };
    switch (id) {
      case 'open':
        openWindow();
        return { ok: true };
      case 'start':
      case 'restart':
        try {
          return await controller.nodeStart({ restart: id === 'restart' });
        } catch (err) {
          log.warn(`the tray's ${id} failed: ${err.message}`);
          return { ok: false, error: err.message };
        }
      case 'quit':
        if (!confirmQuit()) return { ok: false, code: 'CANCELLED' };
        quit();
        return { ok: true };
      default:
        return { ok: false, code: 'UNKNOWN_ITEM' };
    }
  }

  tray.on('click', () => { if (!destroyed) openWindow(); });
  apply(model);

  const onChanged = () => { refresh(); };
  if (controller && typeof controller.on === 'function') controller.on('changed', onChanged);
  const sh = screenHost();
  if (sh && typeof sh.on === 'function') sh.on('change', onChanged);
  // A down node's task and pid change with nothing to say so.
  const timer = setInterval(onChanged, refreshMs);
  if (typeof timer.unref === 'function') timer.unref();
  refresh();

  return {
    refresh,
    invoke,
    model: () => model,
    exists: () => !destroyed,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      if (sh && typeof sh.off === 'function') sh.off('change', onChanged);
      try { tray.destroy(); } catch { /* already gone */ }
    }
  };
}

module.exports = { createTray, QUIT_WHILE_RECORDING };

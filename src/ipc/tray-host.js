// src/ipc/tray-host.js
// Tray mode's window rules for main.js (boot-node-tray spec §5.4, C-6, C-8,
// C-10). Attached to this machine's personal node (local-personal.js), King
// Louie lives in the tray: under --kl-tray (the login start) the window is
// made hidden; closing it hides it; the app does not quit when it is hidden;
// only the tray's Quit (asking first while a take records) or the OS ending
// the session quits. Quitting never stops the node. Off tray mode nothing
// here changes how the app behaves. Electron comes in through deps.
const path = require('path');
const { createLogger } = require('../logging');
const { startsInTray } = require('../desktop-bridge/launch-mode');
const { trayModeOn } = require('../desktop-bridge/local-personal');
const { createTray } = require('./tray');

function createTrayHost({
  app, Tray, Menu, dialog, host, launch, state, getWindow, createWindow,
  argv = process.argv, platform = process.platform, env = process.env, appDir,
  log = createLogger('tray-host'), trayFactory = createTray
}) {
  const on = trayModeOn({ launch, platform, pairing: state.pairing, stateMode: state.mode });
  let tray = null;
  let quitting = false;
  let shutdownStarted = false;

  function shutdownAndQuit() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    host.shutdown().finally(() => app.quit());
  }

  // The tray's Quit, after it asked.
  function quitApp() {
    quitting = true;
    if (tray) { tray.destroy(); tray = null; }
    shutdownAndQuit();
  }

  function openWindow() {
    let win = getWindow();
    if (!win || win.isDestroyed()) { createWindow(); win = getWindow(); }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  app.on('before-quit', () => { quitting = true; });

  return {
    on,
    // The window is still made at ready, hidden, so the renderer exists before the first open.
    startHidden: on && startsInTray(argv),
    watchWindow(win) {
      win.on('close', (event) => {
        if (tray && !quitting) {
          event.preventDefault();
          win.hide();
        }
      });
      // Windows logging off or shutting down: let the window close.
      win.on('session-end', () => { quitting = true; });
    },
    // After the host started: the tray, and the e2e hook (main process only,
    // never reachable from a renderer, only under KL_TEST_MODE).
    start() {
      if (on) {
        try {
          tray = trayFactory({
            Tray, Menu, dialog,
            iconPath: path.join(appDir, 'icons', 'icon.ico'),
            controller: host.controller,
            screenHost: () => (typeof host.screenHost === 'function' ? host.screenHost() : null),
            openWindow,
            quit: quitApp
          });
        } catch (err) {
          // No tray: the window is the app again, so it must be on screen.
          log.error(`the tray did not start: ${err.message}`);
          tray = null;
          openWindow();
        }
      }
      if (env.KL_TEST_MODE === '1') {
        globalThis.__klTestTray = {
          exists: () => Boolean(tray && tray.exists()),
          model: () => (tray ? tray.model() : null),
          invoke: (id) => (tray ? tray.invoke(id) : { ok: false, code: 'NO_TRAY' })
        };
      }
    },
    // `window-all-closed` off macOS: stay while the tray is up, else quit.
    allWindowsClosed() {
      if (tray && !quitting) return;
      shutdownAndQuit();
    }
  };
}

module.exports = { createTrayHost };

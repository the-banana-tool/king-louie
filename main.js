const { app, BrowserWindow, ipcMain, safeStorage, shell, protocol, net, Notification, dialog } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'king-louie-screenshots');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kl-screenshot', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// An explicit --user-data-dir wins before anything reads the profile (the
// e2e harness gives every launch its own). This runs before app.whenReady()
// and before openDesktopState/any store below reads app.getPath('userData'),
// so the harness's own isolation check — asserting app.getPath('userData')
// equals the temp dir it asked for — actually proves every store in this
// process opened that dir too, not just that the argv switch was accepted.
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', path.resolve(userDataArg.slice('--user-data-dir='.length)));

const { createLogger } = require('./src/logging');
const { openDesktopState } = require('./src/ipc/desktop-state');
const { startStandaloneHost } = require('./src/ipc/standalone-host');
const { startAttachedHost } = require('./src/ipc/attached-host');

const log = createLogger('main');

let mainWindow = null;
const getWindow = () => mainWindow;

// Attached or standalone is decided here, before any core exists (fleet stage 7 §3.7).
const state = openDesktopState(app.getPath('userData'), safeStorage);
const standaloneOnce = process.argv.includes('--kl-standalone-once');
const attached = state.mode === 'attached' && !standaloneOnce;
const deps = { app, ipcMain, safeStorage, shell, dialog, Notification, getWindow, state, appDir: __dirname, standaloneOnce };
const host = attached ? startAttachedHost(deps) : startStandaloneHost(deps);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload requires bundled Node modules (logging, marked, dompurify,
      // highlight.js). Electron 20+ defaults sandbox to true, which blocks those
      // requires and aborts the preload before it can expose `window.electron`,
      // breaking every IPC call. The renderer stays isolated via
      // contextIsolation + nodeIntegration:false.
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  protocol.handle('kl-screenshot', (request) => {
    try {
      const url = new URL(request.url);
      const fileName = path.basename(decodeURIComponent(url.pathname));
      const resolved = path.resolve(SCREENSHOT_DIR, fileName);
      if (path.dirname(resolved) !== path.resolve(SCREENSHOT_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // Show the window immediately — don't block on infrastructure.
  createWindow();
  try {
    await host.start();
  } catch (err) {
    log.error(`host failed to start: ${err.message}`);
    dialog.showErrorBox('King Louie failed to start', err.message || String(err));
    app.quit();
    return;
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    host.shutdown().finally(() => app.quit());
  }
});

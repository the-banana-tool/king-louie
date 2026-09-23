const { app, BrowserWindow, ipcMain, safeStorage, shell, protocol, net, Notification } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SCREENSHOT_DIR = path.join(os.tmpdir(), 'king-louie-screenshots');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kl-screenshot', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const { default: Store } = require('electron-store');
const { registerHandlers } = require('./src/ipc/register');
const { createCore } = require('./src/core');
const { CHAT_DATA_DEFAULTS } = require('./src/core/settings');
const { createSafeStorageCipher } = require('./src/platform/cipher');
const { createElectronPrompter } = require('./src/platform/electron-prompter');
const UiToastChannel = require('./src/notifications/channels/ui-toast');

let mainWindow;
const pendingAskUserResolvers = new Map();
const pendingDirectoryAccessResolvers = new Map();
const electronPrompter = createElectronPrompter({
  getWindow: () => mainWindow,
  pendingAskUserResolvers,
  pendingDirectoryAccessResolvers
});

const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

const core = createCore({
  paths: { dataDir: app.getPath('userData') },
  store: new Store({ name: 'chat-data', defaults: CHAT_DATA_DEFAULTS }),
  vaultStore: new Store(),
  cipher: createSafeStorageCipher(safeStorage),
  prompter: electronPrompter,
  ui: {
    send: sendToWindow,
    reportError: (message, stack) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(
          `console.error('[main→renderer] Mesh initialization failed:', ${JSON.stringify(message)}, ${JSON.stringify(stack)})`
        ).catch(() => {});
      }
    }
  },
  openExternal: (url) => shell.openExternal(url),
  uiToastChannel: new UiToastChannel({ Notification }),
  builtinSkillsDir: path.join(__dirname, 'skills')
});

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

  // Open DevTools in development mode
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

registerHandlers(ipcMain, {
  ...core.context,
  safeStorage,
  getMainWindow: () => mainWindow,
  getShell: () => shell,
  pendingAskUserResolvers,
  pendingDirectoryAccessResolvers,
  prompter: electronPrompter
});

ipcMain.on('canvas:executeJsResult', (_event, { requestId, result, error }) => {
  const pending = core.pendingCanvasJsResolvers.get(requestId);
  if (!pending) return;
  core.pendingCanvasJsResolvers.delete(requestId);
  clearTimeout(pending.timeout);
  if (error) {
    pending.resolve({ action: 'execute_js', error });
  } else {
    pending.resolve({ action: 'execute_js', result });
  }
});

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

  // E2E test bridge — starts an HTTP server for test automation
  if (process.env.KL_TEST_BRIDGE_PORT) {
    require(process.env.KL_TEST_BRIDGE_SCRIPT || path.join(__dirname, 'tests', 'e2e', '_bridge.js'));
  }

  // Show the window immediately — don't block on infrastructure
  createWindow();

  await core.start();

  // Notify renderer that mesh is ready so it can refresh status
  const meshContext = core.getMeshContext();
  if (meshContext && mainWindow && !mainWindow.isDestroyed()) {
    const sendReady = () => mainWindow.webContents.send('mesh:ready');
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', sendReady);
    } else {
      sendReady();
    }
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    core.shutdown().finally(() => app.quit());
  }
});

// Standalone mode (fleet stage 7 §3.7): what main.js did before, moved here
// unchanged, plus two things: every IPC event is marked as local-desktop
// before any handler sees it (program §4.21), and the desktop controller is in
// the handler context so Settings > Local service works in both modes.
const path = require('path');
const { registerHandlers } = require('./register');
const { createCore } = require('../core');
const { CHAT_DATA_DEFAULTS } = require('../core/settings');
const { createSafeStorageCipher } = require('../platform/cipher');
const { createElectronPrompter } = require('../platform/electron-prompter');
const { markLocalDesktopEvent } = require('../core/origin');
const UiToastChannel = require('../notifications/channels/ui-toast');
const { createDesktopController } = require('./desktop-controller');

function markingIpcMain(ipcMain) {
  return {
    handle: (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(markLocalDesktopEvent(event), ...args)),
    on: (channel, fn) => ipcMain.on(channel, (event, ...args) => fn(markLocalDesktopEvent(event), ...args)),
    removeHandler: (channel) => ipcMain.removeHandler(channel)
  };
}

function startStandaloneHost(deps) {
  const {
    app, ipcMain, safeStorage, shell, Notification, getWindow, state, appDir,
    standaloneOnce = false, StoreClass = null, createCoreFn = createCore
  } = deps;
  const Store = StoreClass || require('electron-store').default;
  const pendingAskUserResolvers = new Map();
  const pendingDirectoryAccessResolvers = new Map();
  const prompter = createElectronPrompter({ getWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers });
  const liveWindow = () => {
    const win = getWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  const core = createCoreFn({
    paths: { dataDir: app.getPath('userData') },
    store: new Store({ name: 'chat-data', defaults: CHAT_DATA_DEFAULTS }),
    vaultStore: new Store(),
    cipher: createSafeStorageCipher(safeStorage),
    prompter,
    ui: {
      send: (channel, payload) => {
        const win = liveWindow();
        if (win) win.webContents.send(channel, payload);
      },
      reportError: (message, stack) => {
        const win = liveWindow();
        if (win) {
          win.webContents.executeJavaScript(
            `console.error('[main→renderer] Mesh initialization failed:', ${JSON.stringify(message)}, ${JSON.stringify(stack)})`
          ).catch(() => {});
        }
      }
    },
    openExternal: (url) => shell.openExternal(url),
    uiToastChannel: new UiToastChannel({ Notification }),
    builtinSkillsDir: path.join(appDir, 'skills'),
    // One session next to a running service: nothing here may act for it.
    ...(standaloneOnce ? { features: { channels: false, gateway: false, mesh: false } } : {})
  });

  const controller = createDesktopController({
    state, mode: 'standalone', app, getWindow, userDataDir: app.getPath('userData'), safeStorage
  });

  registerHandlers(markingIpcMain(ipcMain), {
    ...core.context,
    safeStorage,
    getMainWindow: getWindow,
    getShell: () => shell,
    pendingAskUserResolvers,
    pendingDirectoryAccessResolvers,
    prompter,
    desktopBridge: controller
  });

  ipcMain.on('canvas:executeJsResult', (_event, { requestId, result, error } = {}) => {
    const pending = core.pendingCanvasJsResolvers.get(requestId);
    if (!pending) return;
    core.pendingCanvasJsResolvers.delete(requestId);
    clearTimeout(pending.timeout);
    if (error) pending.resolve({ action: 'execute_js', error });
    else pending.resolve({ action: 'execute_js', result });
  });

  const pauseCron = () => {
    const cron = core.context.getCronScheduler();
    if (cron) cron.pause();
  };

  return {
    core,
    controller,
    async start() {
      try {
        await core.start();
        // Pause as early as possible: core.start() is what constructs the
        // cron scheduler, so this is the first moment it can be paused. A
        // --kl-standalone-once session must not act as a second consumer of
        // cron next to the live service.
        if (standaloneOnce) pauseCron();
        // Notify the renderer that mesh is ready so it can refresh status.
        const meshContext = core.getMeshContext();
        const win = liveWindow();
        if (meshContext && win) {
          const sendReady = () => win.webContents.send('mesh:ready');
          if (win.webContents.isLoading()) win.webContents.once('did-finish-load', sendReady);
          else sendReady();
        }
      } catch (err) {
        // A core that failed to start must never keep acting: pause cron and
        // give it a chance to shut down cleanly before the caller decides
        // what to do about the failure (main.js shows it and quits).
        pauseCron();
        await core.shutdown().catch(() => {});
        throw err;
      }
    },
    async shutdown() {
      try {
        controller.dispose();
      } finally {
        await core.shutdown();
      }
    }
  };
}

module.exports = { startStandaloneHost, markingIpcMain };

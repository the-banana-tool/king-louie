// Settings › Node & connection (fleet stage 7 §3.7). Always registered, so no host
// ever registers these channels twice; without a desktop controller in the
// context (the service's bridge dispatcher, the contract test) they refuse.
const IPC = require('./constants');

const DESKTOP_METHODS = Object.freeze({
  [IPC.DESKTOP_STATUS]: 'status',
  [IPC.DESKTOP_PAIR_START]: 'pairStart',
  [IPC.DESKTOP_PAIR_CONFIRM]: 'pairConfirm',
  [IPC.DESKTOP_PAIR_CANCEL]: 'pairCancel',
  [IPC.DESKTOP_ATTACH]: 'attach',
  [IPC.DESKTOP_DETACH]: 'detach',
  [IPC.DESKTOP_STANDALONE_ONCE]: 'standaloneOnce',
  // Settings redesign §8.2, §8.3: local by LOCAL_PREFIXES.
  [IPC.DESKTOP_LEAVE_STANDALONE]: 'leaveStandalone',
  [IPC.DESKTOP_OPEN_DATA_FOLDER]: 'openDataFolder',
  [IPC.DESKTOP_UNPAIR]: 'unpair',
  [IPC.DESKTOP_IMPORT_PLAN]: 'importPlan',
  [IPC.DESKTOP_IMPORT_APPLY]: 'importApply',
  [IPC.DESKTOP_RETRY]: 'retry',
  [IPC.DESKTOP_DISMISS_SERVICE_COMMAND]: 'dismissServiceCommand',
  // The personal node (spec 2026-10-28 §11): local by LOCAL_PREFIXES.
  [IPC.DESKTOP_NODE_START]: 'nodeStart',
  [IPC.DESKTOP_NODE_INSTALL_PREVIEW]: 'nodeInstallPreview',
  [IPC.DESKTOP_NODE_INSTALL]: 'nodeInstall',
  [IPC.DESKTOP_LOGIN_START]: 'loginStart',
  [IPC.DESKTOP_SET_LOGIN_START]: 'setLoginStart',
  [IPC.DESKTOP_PAIR_RESTART_CONFIRM]: 'pairRestartConfirm',
  // The one-time move (spec 2026-11-03 §6.5, §8).
  [IPC.DESKTOP_MIGRATION_PLAN]: 'migrationPlan',
  [IPC.DESKTOP_MIGRATION_APPLY]: 'migrationApply',
  // The setup flow (spec 2026-11-03 §6.3, §8).
  [IPC.DESKTOP_SETUP_STEP]: 'setupStep',
  [IPC.DESKTOP_SETUP_LATER]: 'setupLater',
  [IPC.DESKTOP_SETUP_FINISH]: 'setupFinish',
  [IPC.DESKTOP_SETUP_WINDOW_ONLY]: 'setupWindowOnly',
  [IPC.DESKTOP_NODE_RESTART]: 'nodeRestart',
  [IPC.DESKTOP_RESTART_LATER]: 'restartLater',
  // Task 11: node management for the remote window (attach stage 3 part B)
  [IPC.DESKTOP_NODE_ADD]: 'addNode',
  [IPC.DESKTOP_NODE_UPDATE]: 'updateNode',
  [IPC.DESKTOP_NODE_REMOVE]: 'removeNode',
  [IPC.DESKTOP_NODE_SET_ORDER]: 'setNodeOrder',
  [IPC.DESKTOP_NODE_SET_PAIRING]: 'setPairing',
  [IPC.DESKTOP_NODE_CLEAR_PAIRING]: 'clearPairing',
  [IPC.DESKTOP_NODE_SET_SETUP]: 'setSetup',
  [IPC.DESKTOP_NODE_NOTE_SETUP]: 'noteSetup'
});

const unavailable = () => ({ ok: false, code: 'ATTACHED_UNAVAILABLE', error: 'Not available here.' });

function createDesktopHandler(channel, getController) {
  const method = DESKTOP_METHODS[channel];
  return async (_event, payload = {}) => {
    const controller = getController();
    if (!controller || typeof controller[method] !== 'function') return unavailable();
    try {
      const result = await controller[method](payload || {});
      return result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')
        ? result
        : { ok: true, data: result };
    } catch (err) {
      return { ok: false, code: err?.code || 'DESKTOP_ERROR', error: err?.message || String(err) };
    }
  };
}

function registerDesktopHandlers(ipcMain, context = {}) {
  for (const channel of Object.keys(DESKTOP_METHODS)) {
    ipcMain.handle(channel, createDesktopHandler(channel, () => {
      const bridge = context.desktopBridge;
      return bridge && typeof bridge === 'object' ? bridge : null;
    }));
  }
}

module.exports = { DESKTOP_METHODS, createDesktopHandler, registerDesktopHandlers };

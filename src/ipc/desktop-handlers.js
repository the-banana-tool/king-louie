// Settings > Local service (fleet stage 7 §3.7). Always registered, so no host
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
  [IPC.DESKTOP_UNPAIR]: 'unpair',
  [IPC.DESKTOP_IMPORT_PLAN]: 'importPlan',
  [IPC.DESKTOP_IMPORT_APPLY]: 'importApply',
  [IPC.DESKTOP_RETRY]: 'retry'
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

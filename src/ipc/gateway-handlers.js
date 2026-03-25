const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerGatewayHandlers(ipcMain, context = {}) {
  const getRemoteControl = () => (
    typeof context.getRemoteControl === 'function' ? context.getRemoteControl() : context.remoteControl
  );

  const getSessionManager = () => (
    typeof context.getSessionManager === 'function' ? context.getSessionManager() : context.sessionManager
  );

  ipcMain.handle(IPC.GATEWAY_STATUS, wrapHandler(IPC.GATEWAY_STATUS, async () => {
    const remoteControl = getRemoteControl();
    if (!remoteControl) {
      return {
        status: 'uninitialized'
      };
    }

    return remoteControl.getStatus();
  }));

  ipcMain.handle(IPC.SESSIONS_LIST, wrapHandler(IPC.SESSIONS_LIST, async (_event, filter = {}) => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return sessionManager.listSessions(filter);
  }));

  ipcMain.handle(IPC.SESSIONS_HISTORY, wrapHandler(IPC.SESSIONS_HISTORY, async (_event, { sessionKey, limit = 50 }) => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      throw new Error('Session manager is not initialized');
    }

    return sessionManager.getHistory(sessionKey, limit);
  }));
}

module.exports = {
  registerGatewayHandlers
};
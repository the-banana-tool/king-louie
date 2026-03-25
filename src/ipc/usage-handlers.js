const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerUsageHandlers(ipcMain, context = {}) {
  const getUsageTracker = () => (
    typeof context.getUsageTracker === 'function'
      ? context.getUsageTracker()
      : context.usageTracker
  );

  ipcMain.handle(IPC.USAGE_GET_SESSION, wrapHandler(IPC.USAGE_GET_SESSION, async () => {
    const usageTracker = getUsageTracker();
    if (!usageTracker) {
      return null;
    }

    return usageTracker.getSessionUsage();
  }));

  ipcMain.handle(IPC.USAGE_GET_DAILY, wrapHandler(IPC.USAGE_GET_DAILY, async (_event, payload = {}) => {
    const usageTracker = getUsageTracker();
    if (!usageTracker) {
      return null;
    }

    const date = payload && typeof payload === 'object' ? payload.date : undefined;
    return usageTracker.getDailyUsage(date);
  }));
}

module.exports = {
  registerUsageHandlers
};
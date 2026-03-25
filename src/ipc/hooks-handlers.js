const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerHooksHandlers(ipcMain, context = {}) {
  const {
    getHookSettings,
    listHookDefinitions,
    reloadHooksFromSettings,
    setHookEnabled,
    setHookSettings
  } = context;

  ipcMain.handle(IPC.HOOKS_LIST, wrapHandler(IPC.HOOKS_LIST, async () => {
    return {
      enabled: getHookSettings().enabled,
      hooks: listHookDefinitions()
    };
  }));

  ipcMain.handle(IPC.HOOKS_RELOAD, wrapHandler(IPC.HOOKS_RELOAD, async () => {
    return {
      enabled: getHookSettings().enabled,
      hooks: reloadHooksFromSettings()
    };
  }));

  ipcMain.handle(IPC.HOOKS_SET_ENABLED, wrapHandler(IPC.HOOKS_SET_ENABLED, async (_event, { name, enabled }) => {
    const hook = setHookEnabled(name, enabled);
    return {
      ok: true,
      hook,
      hooks: listHookDefinitions()
    };
  }));

  ipcMain.handle(IPC.HOOKS_SET_GLOBAL_ENABLED, wrapHandler(IPC.HOOKS_SET_GLOBAL_ENABLED, async (_event, { enabled }) => {
    const settings = getHookSettings();
    const normalized = Boolean(enabled);
    setHookSettings({
      ...settings,
      enabled: normalized
    });

    return {
      ok: true,
      enabled: normalized,
      hooks: listHookDefinitions()
    };
  }));
}

module.exports = {
  registerHooksHandlers
};
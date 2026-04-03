const { wrapHandler } = require('./wrap-handler');
const constants = require('./constants');

function registerAppsHandlers(ipcMain, context) {
  ipcMain.handle(
    constants.APPS_LIST,
    wrapHandler('apps:list', async () => {
      const getDiscoveredApps = context.getDiscoveredApps;
      if (typeof getDiscoveredApps !== 'function') {
        return { ok: true, apps: [] };
      }
      return { ok: true, apps: getDiscoveredApps() };
    })
  );

  ipcMain.handle(
    constants.APPS_RESCAN,
    wrapHandler('apps:rescan', async () => {
      const rescanApps = context.rescanApps;
      if (typeof rescanApps !== 'function') {
        throw new Error('App discovery not available');
      }
      const apps = await rescanApps();
      return { ok: true, apps };
    })
  );

  ipcMain.handle(
    constants.APPS_ADD,
    wrapHandler('apps:add', async (event, payload) => {
      const { addCustomApp: addApp } = context;
      if (typeof addApp !== 'function') {
        throw new Error('App management not available');
      }
      const app = addApp(payload);
      // Re-discover to merge
      if (typeof context.rescanApps === 'function') {
        await context.rescanApps();
      }
      return { ok: true, app };
    })
  );

  ipcMain.handle(
    constants.APPS_REMOVE,
    wrapHandler('apps:remove', async (event, payload) => {
      const { removeCustomApp: removeApp } = context;
      if (typeof removeApp !== 'function') {
        throw new Error('App management not available');
      }
      removeApp(payload.id);
      // Re-discover to merge
      if (typeof context.rescanApps === 'function') {
        await context.rescanApps();
      }
      return { ok: true };
    })
  );
}

module.exports = {
  registerAppsHandlers
};

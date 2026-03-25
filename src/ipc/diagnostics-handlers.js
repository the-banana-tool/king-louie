const { wrapHandler } = require('./wrap-handler');
const constants = require('./constants');
const Fixit = require('../diagnostics/fixit');

function registerDiagnosticsHandlers(ipcMain, context) {
  ipcMain.handle(
    constants.DIAGNOSTICS_RUN,
    wrapHandler('diagnostics:run', async () => {
      const diagnosticContext = {
        providerFactory: context.getProviderFactory?.(),
        channelRegistry: context.getChannelRegistry?.(),
        memoryManager: context.getMemoryManager?.(),
        hookRegistry: context.getHookRegistry?.(),
        skillRegistry: context.skillRegistry || null,
        gateway: context.getGatewayServer?.(),
        cronScheduler: context.getCronScheduler?.(),
        browserService: context.getBrowserService?.(),
        sandboxExecutor: context.getSandboxExecutor?.(),
        store: context.getStore?.()
      };

      const fixit = new Fixit(diagnosticContext);
      const results = await fixit.runAll();
      const formatted = fixit.formatResults(results);

      return { ok: true, results, formatted };
    })
  );
}

module.exports = { registerDiagnosticsHandlers };

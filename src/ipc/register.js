const { registerChatHandlers } = require('./chat-handlers');
const { registerToolHandlers } = require('./tool-handlers');
const { registerHooksHandlers } = require('./hooks-handlers');
const { registerMemoryHandlers } = require('./memory-handlers');
const { registerSettingsHandlers } = require('./settings-handlers');
const { registerTaskHandlers } = require('./task-handlers');
const { registerAgentHandlers } = require('./agent-handlers');
const { registerGatewayHandlers } = require('./gateway-handlers');
const { registerSkillHandlers } = require('./skill-handlers');
const { registerUsageHandlers } = require('./usage-handlers');
const { registerCronHandlers } = require('./cron-handlers');
const { registerWebhookHandlers } = require('./webhook-handlers');
const { registerWizardHandlers } = require('./wizard-handlers');
const { registerDiagnosticsHandlers } = require('./diagnostics-handlers');
const { registerMeshHandlers } = require('./mesh-handlers');
const { registerWorkflowHandlers } = require('./workflow-handlers');
const { wrapHandler } = require('./wrap-handler');

function registerHandlers(ipcMain, context = {}) {
  registerChatHandlers(ipcMain, context);
  registerToolHandlers(ipcMain, context);
  registerHooksHandlers(ipcMain, context);
  registerMemoryHandlers(ipcMain, context);
  registerSettingsHandlers(ipcMain, context);
  registerTaskHandlers(ipcMain, context);
  registerAgentHandlers(ipcMain, context);
  registerGatewayHandlers(ipcMain, context);
  registerSkillHandlers(ipcMain, context);
  registerUsageHandlers(ipcMain, context);
  registerCronHandlers(ipcMain, context);
  registerWebhookHandlers(ipcMain, context);
  registerWizardHandlers(ipcMain, context);
  registerDiagnosticsHandlers(ipcMain, context);
  registerMeshHandlers(ipcMain, context);
  registerWorkflowHandlers(ipcMain, context);
}

module.exports = {
  registerHandlers,
  wrapHandler
};
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
}

module.exports = {
  registerHandlers
};
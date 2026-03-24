const { wrapHandler } = require('./wrap-handler');

function registerTaskHandlers(ipcMain, context = {}) {
  const getTaskManager = () => {
    if (typeof context.getTaskManager === 'function') {
      return context.getTaskManager();
    }

    return context.taskManager;
  };

  ipcMain.handle('task:create', wrapHandler('task:create', async (_event, config) => {
    const taskManager = getTaskManager();
    if (!taskManager) {
      throw new Error('Task manager is not initialized');
    }

    return taskManager.create(config || {});
  }));

  ipcMain.handle('task:list', wrapHandler('task:list', async () => {
    const taskManager = getTaskManager();
    if (!taskManager) {
      throw new Error('Task manager is not initialized');
    }

    return taskManager.list();
  }));

  ipcMain.handle('task:update', wrapHandler('task:update', async (_event, { taskId, updates }) => {
    const taskManager = getTaskManager();
    if (!taskManager) {
      throw new Error('Task manager is not initialized');
    }

    return taskManager.update(taskId, updates || {});
  }));
}

module.exports = {
  registerTaskHandlers
};
const { wrapHandler } = require('./wrap-handler');

function registerMemoryHandlers(ipcMain, context = {}) {
  const getMemoryManager = () => (
    typeof context.getMemoryManager === 'function'
      ? context.getMemoryManager()
      : context.memoryManager
  );

  ipcMain.handle('memory:capture', wrapHandler('memory:capture', async (_event, { type, content, source, metadata } = {}) => {
    const memoryManager = getMemoryManager();
    if (!memoryManager) {
      return { ok: false, error: 'Memory manager is not initialized.' };
    }

    const entry = memoryManager.capture(type, content, { source, metadata });
    return { ok: true, entry };
  }));

  ipcMain.handle('memory:recall', wrapHandler('memory:recall', async (_event, { query = '', options = {} } = {}) => {
    const memoryManager = getMemoryManager();
    if (!memoryManager) {
      return { ok: false, error: 'Memory manager is not initialized.', entries: [] };
    }

    const entries = await memoryManager.recall(query, options || {});
    return { ok: true, entries };
  }));

  ipcMain.handle('memory:list', wrapHandler('memory:list', async (_event, options = {}) => {
    const memoryManager = getMemoryManager();
    if (!memoryManager) {
      return { ok: false, error: 'Memory manager is not initialized.', entries: [] };
    }

    const entries = memoryManager.list(options || {});
    return { ok: true, entries };
  }));

  ipcMain.handle('memory:delete', wrapHandler('memory:delete', async (_event, { id } = {}) => {
    const memoryManager = getMemoryManager();
    if (!memoryManager) {
      return { ok: false, error: 'Memory manager is not initialized.' };
    }

    const deleted = memoryManager.delete(id);
    return { ok: true, deleted };
  }));

  ipcMain.handle('memory:clear', wrapHandler('memory:clear', async () => {
    const memoryManager = getMemoryManager();
    if (!memoryManager) {
      return { ok: false, error: 'Memory manager is not initialized.' };
    }

    memoryManager.clear();
    return { ok: true };
  }));
}

module.exports = {
  registerMemoryHandlers
};
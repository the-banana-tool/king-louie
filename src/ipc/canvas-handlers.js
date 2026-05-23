const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerCanvasHandlers(ipcMain, context = {}) {
  const { getChats, setChats } = context;

  ipcMain.handle(IPC.CANVAS_GET_STATE, wrapHandler(IPC.CANVAS_GET_STATE, async (_event, { chatId }) => {
    if (!chatId) return { ok: false, error: 'chatId required' };
    const chats = getChats();
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return { ok: false, error: 'Chat not found' };
    return { ok: true, canvasState: chat.canvasState || null };
  }));

  ipcMain.handle(IPC.CANVAS_SET_STATE, wrapHandler(IPC.CANVAS_SET_STATE, async (_event, { chatId, canvasState }) => {
    if (!chatId) return { ok: false, error: 'chatId required' };
    const chats = getChats();
    const updated = chats.map(chat => {
      if (chat.id !== chatId) return chat;
      return { ...chat, canvasState, updatedAt: new Date().toISOString() };
    });
    setChats(updated);
    return { ok: true };
  }));
}

module.exports = { registerCanvasHandlers };

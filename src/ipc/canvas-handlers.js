const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerCanvasHandlers(ipcMain, context = {}) {
  const { getChats, setChats } = context;

  const findChat = (chatId) => {
    if (typeof context.getChat === 'function') {
      const chat = context.getChat(chatId, { messages: true });
      if (chat && typeof chat === 'object') return chat;
    }
    const chats = getChats();
    return chats.find(c => c.id === chatId) || null;
  };

  const patchChat = (chatId, patch = {}) => {
    if (typeof context.updateChat === 'function') {
      const updated = context.updateChat(chatId, patch);
      if (updated && typeof updated === 'object') return updated;
    }
    if (typeof context.updateChatsWhere === 'function') {
      return context.updateChatsWhere((chat) => chat.id === chatId, () => patch)[0] || null;
    }
    const chats = getChats();
    const updated = chats.map(chat => {
      if (chat.id !== chatId) return chat;
      return { ...chat, ...(patch || {}) };
    });
    setChats(updated);
    return updated.find((chat) => chat.id === chatId) || null;
  };

  ipcMain.handle(IPC.CANVAS_GET_STATE, wrapHandler(IPC.CANVAS_GET_STATE, async (_event, { chatId }) => {
    if (!chatId) return { ok: false, error: 'chatId required' };
    const chat = findChat(chatId);
    if (!chat) return { ok: false, error: 'Chat not found' };
    return { ok: true, canvasState: chat.canvasState || null };
  }));

  ipcMain.handle(IPC.CANVAS_SET_STATE, wrapHandler(IPC.CANVAS_SET_STATE, async (_event, { chatId, canvasState }) => {
    if (!chatId) return { ok: false, error: 'chatId required' };
    patchChat(chatId, { canvasState, updatedAt: new Date().toISOString() });
    return { ok: true };
  }));

  // User dismissed the canvas panel — clear the persisted state so it does not
  // reappear when the chat is reloaded. Mirrors the agent-driven `close` action.
  ipcMain.handle(IPC.CANVAS_CLOSE, wrapHandler(IPC.CANVAS_CLOSE, async (_event, { chatId } = {}) => {
    if (!chatId) return { ok: false, error: 'chatId required' };
    patchChat(chatId, { canvasState: null, updatedAt: new Date().toISOString() });
    return { ok: true };
  }));
}

module.exports = { registerCanvasHandlers };

const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerCanvasHandlers(ipcMain, context = {}) {
  // Canvas state is a chat field; none of these calls needs the messages.
  const findChat = (chatId) => context.getChat(chatId, { messages: false });
  const patchChat = (chatId, patch = {}) => context.updateChat(chatId, patch, { messages: false });

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

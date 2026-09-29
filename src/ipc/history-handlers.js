// src/ipc/history-handlers.js
// The recall line's excerpt drawer and an owner-side search (history spec
// 2026-09-25 §7, §12). Excerpt text is untrusted: the renderer sets it with
// textContent only.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { mergeHistorySettings } = require('../history/settings');
const { searchHistoryExcerpts, excerptsForMessage } = require('../history/search');

const view = (e) => ({ seq: e.seq, header: e.header, text: e.text });

function registerHistoryHandlers(ipcMain, context = {}) {
  const store = () => {
    const s = typeof context.getHistoryStore === 'function' ? context.getHistoryStore() : null;
    if (!s) throw new Error('Chat history is not available in this host.');
    return s;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => (
    fn(payload && typeof payload === 'object' ? payload : {})
  )));

  handle(IPC.HISTORY_EXCERPTS, async ({ chatId, seq }) => {
    if (typeof chatId !== 'string' || !chatId || !Number.isInteger(seq) || seq < 1) {
      return { ok: false, error: 'chatId and a message number are required.' };
    }
    return { ok: true, untrustedText: true, excerpts: excerptsForMessage({ store: store(), chatId, seq }).map(view) };
  });

  handle(IPC.HISTORY_SEARCH, async ({ chatId, query, limit }) => {
    if (typeof chatId !== 'string' || !chatId || typeof query !== 'string' || !query.trim()) {
      return { ok: false, error: 'chatId and a query are required.' };
    }
    const retriever = typeof context.getHistoryRetriever === 'function' ? context.getHistoryRetriever() : null;
    if (!retriever) throw new Error('History search is not available in this host.');
    const settings = mergeHistorySettings(((typeof context.getSettings === 'function' && context.getSettings()) || {}).history);
    const excerpts = await searchHistoryExcerpts({
      store: store(),
      retriever,
      chatId,
      query,
      limit: Math.min(50, Math.max(1, Math.floor(Number(limit) || 10))),
      settings: settings.recall
    });
    return { ok: true, untrustedText: true, excerpts: excerpts.map(view) };
  });
}

module.exports = { registerHistoryHandlers };

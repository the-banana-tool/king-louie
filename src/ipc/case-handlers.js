// src/ipc/case-handlers.js
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

const summarize = (c) => ({
  id: c.id, slug: c.slug, title: c.title, type: c.type, status: c.status, created: c.created, dir: c.dir
});

function registerCaseHandlers(ipcMain, context = {}) {
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  const attach = (chatId, caseId) => {
    const chats = context.getChats();
    if (!chats.some((c) => c.id === chatId)) throw new Error('Chat not found.');
    const now = new Date().toISOString();
    const updated = chats.map((c) => (c.id === chatId ? { ...c, caseId: caseId || null, updatedAt: now } : c));
    context.setChats(updated);
    return updated.find((c) => c.id === chatId);
  };

  ipcMain.handle(IPC.CASE_LIST, wrapHandler(IPC.CASE_LIST, async () => (
    { ok: true, cases: runtime().listCases().map(summarize) }
  )));

  ipcMain.handle(IPC.CASE_CREATE, wrapHandler(IPC.CASE_CREATE, async (_event, { title, type, objective, chatId } = {}) => {
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'A case needs a title.' };
    const info = await runtime().createCase({ title: title.trim(), type: type || 'general', objective: objective || '' });
    return { ok: true, case: summarize(info), chat: chatId ? attach(chatId, info.id) : null };
  }));

  ipcMain.handle(IPC.CASE_ATTACH, wrapHandler(IPC.CASE_ATTACH, async (_event, { chatId, caseId } = {}) => {
    if (caseId) runtime().getCase(caseId);
    return { ok: true, chat: attach(chatId, caseId) };
  }));

  ipcMain.handle(IPC.CASE_ORIENTATION, wrapHandler(IPC.CASE_ORIENTATION, async (_event, { caseId } = {}) => (
    { ok: true, text: runtime().orientation(caseId) }
  )));

  ipcMain.handle(IPC.CASE_SET_DISCLOSABLE, wrapHandler(IPC.CASE_SET_DISCLOSABLE, async (_event, { caseId, factId, disclosable } = {}) => {
    if (typeof disclosable !== 'boolean') return { ok: false, error: 'disclosable must be true or false.' };
    return { ok: true, fact: runtime().ledger(caseId).setDisclosable(factId, disclosable) };
  }));
}

module.exports = { registerCaseHandlers };

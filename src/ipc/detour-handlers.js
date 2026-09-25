// src/ipc/detour-handlers.js
// Cases stage 5 IPC (docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §7):
// the case panel's detours and related cases, the owner's routing choice,
// and a rebuild of the cross-case index. Case-file writes go through
// CaseRuntime.answerQuestion and the router, which take the case locks.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required.`);
  return value;
}

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  return value.trim() || null;
}

function registerDetourHandlers(ipcMain, context = {}) {
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => {
    try {
      return await fn(payload && typeof payload === 'object' ? payload : {});
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return { ok: false, error: err.message, code: 'CASE_BUSY' };
      if (err && err.name === 'QuestionError') return { ok: false, error: err.message, code: err.code };
      throw err;
    }
  }));

  // Reconciles answered routing questions first; `busy` when another
  // process holds the case (the list is still returned).
  handle(IPC.CASE_DETOURS, async ({ caseId }) => {
    const rt = runtime();
    const id = rt.getCase(required(caseId, 'caseId')).id;
    const reconciled = await rt.detours.reconcile(id);
    return { ok: true, ...rt.detours.list(id), ...(reconciled.busy ? { busy: true } : {}) };
  });

  // The owner's pick in the panel: answers the routing question in-app if
  // it is still open, then resolves, then reconciles.
  handle(IPC.CASE_RESOLVE_DETOUR, async ({ caseId, detourId, optionId, title, objective, force }) => {
    const rt = runtime();
    const id = rt.getCase(required(caseId, 'caseId')).id;
    required(detourId, 'detourId');
    required(optionId, 'optionId');
    if (force !== undefined && typeof force !== 'boolean') return { ok: false, error: 'force must be true or false.' };
    const newTitle = optionalText(title, 'title');
    const newObjective = optionalText(objective, 'objective');
    const view = rt.detours.list(id).detours.find((d) => d.id === detourId);
    if (!view) return { ok: false, error: `There is no detour ${detourId} in this case.` };
    if (view.questionId) {
      const q = rt.questions(id).get(view.questionId);
      if (q && !q.answer && !q.closed) await rt.answerQuestion(id, view.questionId, { channel: 'in-app', optionId });
    }
    const r = await rt.detours.resolve(id, detourId, { optionId, by: 'in-app', title: newTitle, objective: newObjective, force: force === true });
    await rt.detours.reconcile(id);
    if (!r.ok) return { ok: false, error: r.error, ...(r.retry?.questionId ? { retryQuestionId: r.retry.questionId } : {}) };
    return { ok: true, detour: r.detour, linkedCaseId: r.linkedCaseId, ...(r.existing ? { existing: true } : {}) };
  });

  handle(IPC.CASE_REINDEX, async () => ({ ok: true, ...runtime().index.rebuild() }));
}

module.exports = { registerDetourHandlers };

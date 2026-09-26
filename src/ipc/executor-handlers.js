// src/ipc/executor-handlers.js
// Cases stage 3 IPC: the executor list (with pins and warnings), a case's
// envelopes, and the owner's cancel and revoke.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { EnvelopeStore } = require('../cases/executors');

const text = (v) => typeof v === 'string' && v.trim().length > 0;

function registerExecutorHandlers(ipcMain, context = {}) {
  const registry = () => {
    const r = typeof context.getExecutorRegistry === 'function' ? context.getExecutorRegistry() : null;
    if (!r) throw new Error('Executors are not available in this host.');
    return r;
  };
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  ipcMain.handle(IPC.EXECUTORS_LIST, wrapHandler(IPC.EXECUTORS_LIST, async (_event, { caseId } = {}) => (
    { ok: true, executors: registry().list({ caseId: text(caseId) ? caseId : null }) }
  )));

  ipcMain.handle(IPC.CASE_ENVELOPES, wrapHandler(IPC.CASE_ENVELOPES, async (_event, { caseId } = {}) => {
    if (!text(caseId)) return { ok: false, error: 'caseId is required.' };
    return { ok: true, envelopes: new EnvelopeStore(runtime().getCase(caseId).dir).list() };
  }));

  ipcMain.handle(IPC.CASE_CANCEL_JOB, wrapHandler(IPC.CASE_CANCEL_JOB, async (_event, { caseId, jobId } = {}) => {
    if (!text(caseId) || !text(jobId)) return { ok: false, error: 'caseId and jobId are required.' };
    const r = await registry().cancelJob(caseId, jobId, 'cancelled by the owner');
    return r.ok ? { ok: true, jobId, state: r.job.state } : r;
  }));

  ipcMain.handle(IPC.CASE_REVOKE_ENVELOPE, wrapHandler(IPC.CASE_REVOKE_ENVELOPE, async (_event, { caseId, envelopeId } = {}) => {
    if (!text(caseId) || !text(envelopeId)) return { ok: false, error: 'caseId and envelopeId are required.' };
    return registry().revokeEnvelope(caseId, envelopeId, 'revoked by the owner');
  }));
}

module.exports = { registerExecutorHandlers };

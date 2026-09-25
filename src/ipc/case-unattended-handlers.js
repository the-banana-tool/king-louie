// src/ipc/case-unattended-handlers.js
// Cases stage 2 IPC (spec §7): questions, status, budget and grants. Every
// write goes through CaseRuntime.answerQuestion, acknowledgeBriefing,
// grantBudget or systemAction, never straight to the case files.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { CATEGORIES } = require('../cases/budget');
const { STATUSES } = require('../cases/status');

const BUSY = 'Case is busy with a wake-up; try again in a minute.';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const caseSummary = (c) => ({ id: c.id, title: c.title, status: c.status, statusReason: c.statusReason || null, budget: c.budget || null });

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required.`);
  return value;
}

function registerCaseUnattendedHandlers(ipcMain, context = {}) {
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => {
    try {
      return await fn(payload && typeof payload === 'object' ? payload : {});
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return { ok: false, error: BUSY };
      if (err && (err.name === 'QuestionError' || err.name === 'StatusError')) {
        return { ok: false, error: err.message, code: err.code, ...(err.record ? { question: err.record } : {}) };
      }
      throw err;
    }
  }));

  handle(IPC.CASE_QUESTIONS, async ({ caseId }) => {
    const rt = runtime();
    const cases = caseId ? [rt.getCase(caseId)] : rt.listCases();
    const questions = cases
      .filter((c) => c.status !== 'done' && c.status !== 'abandoned')
      .flatMap((c) => rt.questions(c.id).open().map((q) => ({ ...q, caseId: c.id, caseTitle: c.title, caseStatus: c.status })));
    return { ok: true, questions };
  });

  handle(IPC.CASE_ANSWER_QUESTION, async ({ caseId, questionId, text, optionId }) => {
    if (text !== undefined && text !== null && typeof text !== 'string') return { ok: false, error: 'text must be text.' };
    if (optionId !== undefined && optionId !== null && typeof optionId !== 'string') return { ok: false, error: 'optionId must be text.' };
    const out = await runtime().answerQuestion(required(caseId, 'caseId'), required(questionId, 'questionId'), {
      channel: 'in-app', text: text ?? null, optionId: optionId ?? null
    });
    return { ok: true, question: out.question, factId: out.fact?.id || null, effect: out.effect };
  });

  handle(IPC.CASE_ACKNOWLEDGE_BRIEFING, async ({ caseId, questionId }) => ({
    ok: true,
    question: await runtime().acknowledgeBriefing(required(caseId, 'caseId'), required(questionId, 'questionId'), { channel: 'in-app' })
  }));

  handle(IPC.CASE_SET_STATUS, async ({ caseId, status, note }) => {
    if (!STATUSES.includes(status)) return { ok: false, error: `Unknown status "${status}". Statuses: ${STATUSES.join(', ')}.` };
    if (note !== undefined && typeof note !== 'string') return { ok: false, error: 'note must be text.' };
    const rt = runtime();
    const id = required(caseId, 'caseId');
    const meta = await rt.systemAction(id, `status ${status}`, () => rt.setStatus(id, status, { kind: 'owner', by: 'owner', note: note || '' }));
    return { ok: true, case: caseSummary(meta) };
  });

  handle(IPC.CASE_BUDGET, async ({ caseId }) => {
    const rt = runtime();
    const meta = rt.getCase(required(caseId, 'caseId'));
    return { ok: true, budget: rt.budget(meta.id).status(), case: caseSummary(meta) };
  });

  handle(IPC.CASE_GRANT_BUDGET, async ({ caseId, category, limit }) => {
    const rt = runtime();
    const meta = rt.getCase(required(caseId, 'caseId'));
    if (!CATEGORIES.includes(category)) {
      return { ok: false, error: `Unknown budget category "${category}". Categories: ${CATEGORIES.join(', ')}.` };
    }
    if (category === 'deadline') {
      if (typeof limit !== 'string' || !DAY.test(limit) || !Number.isFinite(Date.parse(`${limit}T00:00:00Z`))) {
        return { ok: false, error: 'A deadline must be a YYYY-MM-DD date.' };
      }
    } else {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        return { ok: false, error: 'A limit must be a number above 0.' };
      }
      if (category === 'usd') {
        const spent = rt.budget(meta.id).status().usd.spent;
        if (limit <= spent) return { ok: false, error: `A usd limit must be above what the case has spent (${spent}).` };
      }
    }
    const out = await rt.grantBudget(meta.id, category, limit, { channel: 'in-app' });
    return { ok: true, factId: out.fact.id, effect: out.effect, case: caseSummary(out.case), budget: rt.budget(meta.id).status() };
  });
}

module.exports = { registerCaseUnattendedHandlers };

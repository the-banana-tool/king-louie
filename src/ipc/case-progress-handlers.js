// src/ipc/case-progress-handlers.js
// Cases stage 8 IPC (spec §6.1 to §6.4, §11): a case's progress as the
// record says it now, and the owner's own scope actions (the buttons of the
// case panel and of the scope card). A read takes no lock and writes
// nothing. A scope action goes through CaseRuntime.applyScopeAction as an
// owner action in the app; nothing the renderer sends says who confirmed,
// on which channel, or what a criterion's state is.
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { isLocalDesktopEvent } = require('../core/origin');

const BUSY = 'Case is busy with a wake-up; try again in a minute.';
const NOT_LOCAL = 'This is done only from the King Louie window.';
const CHECK_BUSY = 'A turn is running in this case; check again when it ends.';
const ACTIONS = Object.freeze(['confirm', 'drop', 'edit', 'add']);
const CRITERION_ID = /^sc-\d{3,}$/;
const HASH_MAX_CHARS = 200;
// A criterion is at most 300 characters (ScopeStore checks it); this bound
// only keeps a huge payload away from the runtime.
const TEXT_MAX_CHARS = 4000;
// An objective is text in brief.md with no rule of its own; what the owner
// types is held to the limit create_case gives it (mcp-tool-definitions.js).
const OBJECTIVE_MAX_CHARS = 2000;
// What applyScopeAction refuses with (ScopeError), by code.
const SCOPE_CODES = Object.freeze([
  'SCOPE_STALE', 'SCOPE_INVALID', 'CRITERION_NOT_FOUND', 'CRITERION_INVALID', 'CRITERION_DUPLICATE', 'CRITERION_LIMIT', 'CASE_CLOSED'
]);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
const refuse = (error, code = null) => ({ ok: false, ...(code ? { code } : {}), error });

// → the trimmed objective, or a { problem } saying why it is refused.
function ownerObjective(text) {
  if (typeof text !== 'string' || !text.trim()) return { problem: 'An objective is text.' };
  const value = text.trim();
  if (value.length > OBJECTIVE_MAX_CHARS) return { problem: `An objective is at most ${OBJECTIVE_MAX_CHARS} characters; this one is ${value.length}.` };
  return { value };
}

// R-C8-5: every evidence entry carries its provenance.
const evidenceOut = (e) => ({
  id: String(e.id), holds: e.holds === true, provenance: strOrNull(e.provenance), sourceKind: strOrNull(e.sourceKind), label: strOrNull(e.label)
});
const criterionOut = (c) => ({
  id: c.id,
  text: c.text,
  hash: strOrNull(c.hash),
  scope: c.scope === 'confirmed' ? 'confirmed' : 'proposed',
  origin: strOrNull(c.origin),
  state: c.scope === 'confirmed' ? strOrNull(c.state) : null,
  evidence: (Array.isArray(c.evidence) ? c.evidence : []).filter(isObject).map(evidenceOut),
  reasons: strings(c.reasons),
  note: strOrNull(c.note),
  opinion: isObject(c.opinion) ? c.opinion : null
});
const itemOut = (i) => ({
  id: i.id, state: i.state, by: i.by, count: Number.isInteger(i.count) ? i.count : 0, refs: strings(i.refs), fix: strOrNull(i.fix), note: strOrNull(i.note)
});
const readinessOut = (r) => (isObject(r) ? { ready: r.ready === true, items: (Array.isArray(r.items) ? r.items : []).filter(isObject).map(itemOut) } : null);
const abandonedOut = (a) => ({
  id: a.id, approach: a.approach, why: a.why, tried: strings(a.tried), factIds: strings(a.factIds), decisionIds: strings(a.decisionIds), at: strOrNull(a.at)
});

// What case:progress answers, and what case:confirmScope and case:setStatus
// carry as `progress`. Every string in it but the ids, states and the
// summary is case text: the renderer sets it with textContent.
function progressReply(rt, caseId) {
  const meta = rt.getCase(caseId);
  const p = rt.progress(meta.id);
  const records = (Array.isArray(p.abandoned) ? p.abandoned : []).filter(isObject).map(abandonedOut);
  const base = { ok: true, untrustedText: true, caseStatus: meta.status };
  const tail = { abandoned: { count: records.length, records }, check: null };
  if (p.closed) {
    // A closed case: the record it closed with, as it is (R-C8-7).
    return {
      ...base,
      frozen: true,
      at: strOrNull(p.closed.at),
      objective: null,
      criteria: (Array.isArray(p.closed.criteria) ? p.closed.criteria : []).filter(isObject).map(criterionOut),
      summary: p.summary,
      readiness: readinessOut(p.closed.readiness),
      ...tail
    };
  }
  const o = isObject(p.view?.objective) ? p.view.objective : null;
  return {
    ...base,
    frozen: false,
    at: null,
    objective: o ? { text: o.text, hash: strOrNull(o.hash), state: o.state === 'confirmed' ? 'confirmed' : 'proposed', origin: strOrNull(o.origin) } : null,
    criteria: (Array.isArray(p.view?.criteria) ? p.view.criteria : []).filter(isObject).map(criterionOut),
    summary: p.summary,
    readiness: readinessOut(p.readiness),
    ...tail,
    ...(p.scope && p.scope.error ? { warning: p.scope.error } : {})
  };
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What "Check now" found, in one line of counts and fixed words. A pass's
// `error` is fixed words too (verify/judge.js), never a provider's message.
function checkNote(pass) {
  if (pass.error) return `The check did not finish: ${pass.error}.`;
  if (pass.skipped) return 'No check ran; the log says why.';
  const accepted = pass.accepted.length;
  const refused = pass.opinions.filter((o) => o && o.status === 'met').length;
  const disagreed = pass.disagreed.length;
  const parts = [];
  if (accepted) parts.push(`${count(accepted, 'criterion', 'criteria')} accepted as met.`);
  if (refused) parts.push(`${count(refused, 'criterion', 'criteria')} not accepted as met; ${refused === 1 ? 'its' : 'their'} evidence does not hold.`);
  if (disagreed) parts.push(`${count(disagreed, 'criterion is', 'criteria are')} no longer agreed to be met.`);
  return `Checked: ${parts.length ? parts.join(' ') : 'nothing new is met.'}`;
}

// The four actions' arguments, checked before the runtime is called.
// → { args } or { problem }.
function scopeArgs({ action, target, hash, text }) {
  if (!ACTIONS.includes(action)) return { problem: `action must be one of ${ACTIONS.join(', ')}.` };
  const shortText = (v) => typeof v === 'string' && v.length > 0 && v.length <= HASH_MAX_CHARS;
  if (action === 'add') {
    if (typeof text !== 'string' || text.length > TEXT_MAX_CHARS) return { problem: 'text must be the criterion\'s words.' };
    return { args: { action, target: null, hash: null, text } };
  }
  const isId = typeof target === 'string' && CRITERION_ID.test(target);
  if (!isId && target !== 'objective' && target !== 'all-proposed') return { problem: 'target must be "objective", "all-proposed" or a criterion id.' };
  if (action === 'edit') {
    if (target === 'all-proposed') return { problem: 'One criterion or the objective is edited at a time.' };
    if (typeof text !== 'string' || text.length > TEXT_MAX_CHARS) return { problem: 'text must be the new words.' };
    if (hash !== undefined && hash !== null && !shortText(hash)) return { problem: 'hash must be the hash the row was shown with.' };
    return { args: { action, target, hash: hash ?? null, text } };
  }
  // confirm and drop: the hash of every row the owner was shown.
  if (action === 'drop' && target === 'objective') return { problem: 'The objective is rewritten, never dropped.' };
  if (target === 'all-proposed') {
    if (!isObject(hash)) return { problem: 'hash must give the hash of every proposed row that was shown.' };
    const shown = {};
    for (const [key, value] of Object.entries(hash)) {
      if ((key !== 'objective' && !CRITERION_ID.test(key)) || !shortText(value)) return { problem: 'hash must give the hash of every proposed row that was shown.' };
      shown[key] = value;
    }
    return { args: { action, target, hash: shown, text: null } };
  }
  if (!shortText(hash)) return { problem: 'hash must be the hash the row was shown with.' };
  return { args: { action, target, hash, text: null } };
}

function registerCaseProgressHandlers(ipcMain, context = {}) {
  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (event, payload) => {
    try {
      return await fn(isObject(payload) ? payload : {}, event);
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return refuse(channel === IPC.CASE_VERIFY_NOW ? CHECK_BUSY : BUSY, 'CASE_BUSY');
      if (err && err.name === 'VerifyRefusedError') return refuse(err.message, err.code);
      if (err && err.name === 'ScopeError' && SCOPE_CODES.includes(err.code)) return refuse(err.message, err.code);
      throw err;
    }
  }));

  // No lock, no write.
  handle(IPC.CASE_PROGRESS, async ({ caseId }) => {
    if (typeof caseId !== 'string' || !caseId) return refuse('caseId is required.');
    return progressReply(runtime(), caseId);
  });

  // The owner's press. Only an event the host itself marked (the app's own
  // window, or a paired desktop over the bridge) is one.
  handle(IPC.CASE_CONFIRM_SCOPE, async (payload, event) => {
    if (!isLocalDesktopEvent(event)) return refuse(NOT_LOCAL, 'NOT_LOCAL_DESKTOP');
    if (typeof payload.caseId !== 'string' || !payload.caseId) return refuse('caseId is required.');
    const checked = scopeArgs(payload);
    if (checked.problem) return refuse(checked.problem);
    const { args } = checked;
    if (args.action === 'edit' && args.target === 'objective') {
      const objective = ownerObjective(args.text);
      if (objective.problem) return refuse(objective.problem, 'CRITERION_INVALID');
      args.text = objective.value;
    }
    const rt = runtime();
    await rt.applyScopeAction(payload.caseId, { ...args, by: 'owner-action', channel: 'in-app' });
    return { ok: true, progress: progressReply(rt, payload.caseId) };
  });

  // "Check now" (owner ruling 2026-10-13): the owner's press runs one
  // verify pass. No tool and no MCP surface has this path; the runtime
  // counts it and refuses it like any pass. `note` is the result line.
  handle(IPC.CASE_VERIFY_NOW, async (payload, event) => {
    if (!isLocalDesktopEvent(event)) return refuse(NOT_LOCAL, 'NOT_LOCAL_DESKTOP');
    if (typeof payload.caseId !== 'string' || !payload.caseId) return refuse('caseId is required.');
    const rt = runtime();
    const pass = await rt.verifyNow(payload.caseId);
    const list = (v) => (Array.isArray(v) ? v : []);
    const out = { ...pass, accepted: list(pass?.accepted), opinions: list(pass?.opinions), disagreed: list(pass?.disagreed) };
    return {
      ok: true,
      untrustedText: true,
      ran: out.ran === true,
      accepted: out.accepted.length,
      notAccepted: out.opinions.filter((o) => o && o.status === 'met').length,
      disagreed: out.disagreed.length,
      note: checkNote(out),
      progress: progressReply(rt, payload.caseId)
    };
  });
}

module.exports = { registerCaseProgressHandlers, progressReply, ownerObjective, OBJECTIVE_MAX_CHARS };

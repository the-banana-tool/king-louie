// src/ipc/playbook-handlers.js
// Playbook IPC (cases stage 6 spec §7): the owner's actions from the case
// panel. This is the owner-trust boundary for attach, update, confirmSource,
// apply and reject; no model tool reaches any of these. The manager's
// change acknowledgement and the question store's payload rewrite are
// never exposed here.
//
// Every argument is checked before use and a bad one gets a fixed error
// that does not echo it. Replies carry only panel-safe fields, capped, and
// always untrustedText: true: their strings (validator and loader messages,
// warnings, rationales, titles) can quote package or case text, so the
// renderer shows them with textContent only, never as HTML or markdown.
//
// Attached (ruling M14), every case:* channel is proxied to the service,
// whose bridge dispatcher registers these same handlers, so the same checks
// run there; path: sources and a proposal's repoPath resolve on the service
// host.
const path = require('path');
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { NAME_RE, formatErrors } = require('../cases/playbooks/format');
const { REF_RE } = require('../cases/playbooks/vendor');
const { MAX_CREATE_PLAYBOOKS } = require('../cases/playbooks/manager');

// A case id (base-36 time, "-", hex) or a slug; both are [a-z0-9-].
const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PROPOSAL_ID_RE = /^pp-\d{3,4}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// C0/C1 controls, bidi overrides and isolates, zero-width and BOM.
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const MAX_SOURCE = 2048;
const MAX_REPO_PATH = 1024;
const MAX_ERROR = 8000;
const MAX_LINE = 1000;
const MAX_ITEMS = 64;

class BadArgument extends Error {}

// ---- Argument checks (each throws BadArgument with a fixed message) ----

const bad = (message) => { throw new BadArgument(message); };

function needCase(p) {
  if (typeof p.caseId !== 'string' || !p.caseId) bad('caseId is required.');
  if (!CASE_ID_RE.test(p.caseId)) bad('caseId is not a valid case id.');
  return p.caseId;
}

function checkPlaybookName(value, field) {
  if (typeof value !== 'string' || !value) bad(`${field} is required.`);
  if (!NAME_RE.test(value)) bad(`${field} is not a valid playbook name.`);
  return value;
}

function checkSource(value, field = 'source') {
  const ok = typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SOURCE && !UNSAFE_CHARS_RE.test(value);
  if (!ok) bad(`${field} is not a valid playbook source.`);
  return value.trim();
}

function checkRef(value, field = 'ref') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !REF_RE.test(value)) bad(`${field} is not a valid git ref.`);
  return value;
}

// undefined is false; anything but a boolean is refused, so only === true
// ever counts.
function checkFlag(value, field) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') bad(`${field} must be true or false.`);
  return value === true;
}

function checkProposalId(value) {
  if (typeof value !== 'string' || !value) bad('proposalId is required.');
  if (!PROPOSAL_ID_RE.test(value)) bad('proposalId is not a valid proposal id.');
  return value;
}

// An absolute local folder: no UNC or device path (a file system call on
// one can open an SMB connection), no control characters.
function checkRepoPath(value) {
  if (typeof value !== 'string' || !value.trim()) bad('repoPath is required.');
  const p = value.trim();
  const ok = p.length <= MAX_REPO_PATH && !UNSAFE_CHARS_RE.test(p) && !/^[\\/]{2}/.test(p) && path.isAbsolute(p);
  if (!ok) bad('repoPath must be an absolute folder path.');
  return p;
}

// ---- Reply shaping ----

const cap = (s, max = MAX_LINE) => {
  if (typeof s !== 'string') return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const textList = (list, max = MAX_LINE) => (Array.isArray(list)
  ? list.slice(0, MAX_ITEMS).map((x) => cap(typeof x === 'string' ? x : formatErrors([x]), max)).filter((x) => x !== null)
  : []);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const budgetRow = (r) => ({ key: cap(r.key, 64), from: num(r.from), to: num(r.to) });

function failure(r) {
  const out = { ok: false, error: cap(r && typeof r.error === 'string' ? r.error : 'The playbook action failed.', MAX_ERROR) };
  if (r && typeof r.code === 'string' && CODE_RE.test(r.code)) out.code = r.code;
  if (r && Array.isArray(r.errors)) out.errors = textList(r.errors);
  if (r && Array.isArray(r.editedFiles)) out.editedFiles = textList(r.editedFiles, 256);
  return out;
}

// A thrown error becomes a result that keeps its code and per-file errors.
function fromError(err) {
  if (err instanceof BadArgument) return { ok: false, error: err.message };
  return failure({ error: err?.message || String(err), code: err?.code, errors: err?.errors });
}

const marked = (r) => ({ ...r, untrustedText: true });

async function asResult(fn) {
  try {
    const r = await fn();
    return marked(r && r.ok === false ? failure(r) : r);
  } catch (err) {
    return marked(fromError(err));
  }
}

function shapeSummary(e) {
  return {
    name: cap(e.name, 256),
    mode: cap(e.mode, 32),
    state: cap(e.state, 32),
    version: cap(e.version, 64),
    pinnedVersion: cap(e.pinnedVersion, 64),
    source: cap(e.source, MAX_SOURCE),
    steps: Number.isInteger(e.steps) ? e.steps : 0,
    warnings: textList(e.warnings),
    errors: textList(e.errors),
    reason: cap(e.reason),
    submodule: e.submodule && typeof e.submodule === 'object' ? { url: cap(e.submodule.url, MAX_SOURCE), commit: cap(e.submodule.commit, 64) } : null
  };
}

// Pending gating without the question text (the owner answers in the
// questions panel; the text is package text).
const shapePending = (g) => ({
  key: cap(g.key, 256),
  recordId: cap(g.recordId, 64),
  origins: textList(g.origins, 256),
  required: g.required === true
});

function shapeAttach(r) {
  return {
    ok: true,
    playbook: { name: cap(r.playbook?.name, 64), version: cap(r.playbook?.version, 64) },
    warnings: textList(r.warnings),
    budgetRaises: (r.budgetRaises || []).map(budgetRow),
    questionIds: textList(r.questionIds, 64),
    unknownIds: textList(r.unknownIds, 64)
  };
}

function shapeUpdateRow(u) {
  const row = {
    name: cap(u.name, 256),
    pinned: cap(u.pinned, 64),
    upstream: cap(u.upstream, 64),
    updateAvailable: u.updateAvailable === true,
    sameMajor: u.sameMajor === true
  };
  if (typeof u.error === 'string') row.error = cap(u.error, MAX_ERROR);
  if (typeof u.code === 'string' && CODE_RE.test(u.code)) row.code = u.code;
  if (typeof u.applied === 'string') row.applied = cap(u.applied, 64);
  if (typeof u.applyError === 'string') row.applyError = cap(u.applyError, MAX_ERROR);
  return row;
}

function shapeProposal(r) {
  return {
    id: cap(r.id, 16),
    playbook: cap(r.playbook, 64),
    newPlaybook: r.newPlaybook === true,
    baseVersion: cap(r.baseVersion, 64),
    files: textList(r.files, 256),
    rationale: cap(r.rationale, 2000),
    factIds: textList(r.factIds, 64),
    createdAt: cap(r.createdAt, 64),
    status: cap(r.status, 32),
    statusAt: cap(r.statusAt, 64),
    appliedTo: cap(r.appliedTo, MAX_REPO_PATH),
    appliedOver: cap(r.appliedOver, 64),
    stale: r.stale === true,
    hint: cap(r.hint)
  };
}

function getManager(context) {
  const m = typeof context.getPlaybookManager === 'function' ? context.getPlaybookManager() : null;
  if (!m) throw new Error('Playbooks are not available in this host.');
  return m;
}

// ---- case:create ----

// Checks the owner's form (fixed errors), then resolves, allow-checks,
// fetches and validates every source before the case exists (no lock,
// nothing written) and infers the type.
async function preparePlaybooksForCreate(context, { playbooks, type, acceptBudgetRaises } = {}) {
  let list;
  try {
    checkFlag(acceptBudgetRaises, 'acceptBudgetRaises');
    if (playbooks === undefined || playbooks === null) return { ok: true, prepared: [], type: null };
    if (!Array.isArray(playbooks)) bad('playbooks must be a list of { source, ref? }.');
    if (playbooks.length > MAX_CREATE_PLAYBOOKS) bad(`playbooks must be a list of at most ${MAX_CREATE_PLAYBOOKS} { source, ref? }.`);
    list = playbooks.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) bad(`playbooks[${i}] must be { source, ref? }.`);
      return { source: checkSource(item.source, `playbooks[${i}].source`), ref: checkRef(item.ref, `playbooks[${i}].ref`) };
    });
  } catch (err) {
    return marked(fromError(err));
  }
  if (!list.length) return { ok: true, prepared: [], type: null };
  const r = await asResult(() => getManager(context).prepareForCreate(list, { type: type || null }));
  // The fetched snapshots stay server-side; only ok and the type go on.
  return r.ok ? { ok: true, prepared: r.prepared, type: r.type || null } : r;
}

// After the case exists: attach from the fetched snapshots. Each failure is
// reported per playbook; the case stays.
async function attachPlaybooksAfterCreate(context, caseId, prepared, { acceptBudgetRaises = false } = {}) {
  if (!prepared || !Array.isArray(prepared.prepared) || !prepared.prepared.length) return {};
  const playbooks = [];
  const budgetRaises = [];
  for (const p of prepared.prepared) {
    try {
      const r = await getManager(context).attachPrepared(caseId, p, { acceptBudgetRaises: acceptBudgetRaises === true });
      playbooks.push({ name: cap(r.playbook.name, 64), version: cap(r.playbook.version, 64), questionIds: textList(r.questionIds, 64), warnings: textList(r.warnings) });
      for (const b of r.budgetRaises || []) budgetRaises.push({ playbook: cap(r.playbook.name, 64), ...budgetRow(b) });
    } catch (err) {
      playbooks.push({ name: cap(p.playbook?.name, 64), error: cap(err?.message || String(err), MAX_ERROR) });
    }
  }
  return { playbooks, budgetRaises, untrustedText: true };
}

// ---- Channels ----

function registerPlaybookHandlers(ipcMain, context = {}) {
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, async (_event, payload) => {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    return asResult(() => fn(p));
  }));

  handle(IPC.CASE_PLAYBOOKS, async (p) => {
    const caseId = needCase(p);
    const m = getManager(context);
    return {
      ok: true,
      playbooks: m.summary(caseId).map(shapeSummary),
      pendingGating: m.pendingGating(caseId).map(shapePending),
      budgetRaises: m.offeredBudgetRaises(caseId).map((b) => ({ playbook: cap(b.playbook, 64), ...budgetRow(b) }))
    };
  });

  handle(IPC.CASE_ADD_PLAYBOOK, async (p) => {
    const caseId = needCase(p);
    const hasSource = p.source !== undefined && p.source !== null;
    const hasAdopt = p.adopt !== undefined && p.adopt !== null;
    if (hasSource === hasAdopt) return { ok: false, error: 'Give exactly one of source or adopt.' };
    const acceptBudgetRaises = checkFlag(p.acceptBudgetRaises, 'acceptBudgetRaises');
    const m = getManager(context);
    if (hasAdopt) {
      const name = checkPlaybookName(p.adopt, 'adopt');
      if (p.ref !== undefined) bad('ref is only for a source.');
      return shapeAttach(await m.adopt(caseId, name, { acceptBudgetRaises }));
    }
    const source = checkSource(p.source);
    const ref = checkRef(p.ref);
    return shapeAttach(await m.attach(caseId, { source, ref, acceptBudgetRaises }));
  });

  handle(IPC.CASE_REMOVE_PLAYBOOK, async (p) => {
    const caseId = needCase(p);
    const name = checkPlaybookName(p.name, 'name');
    await getManager(context).remove(caseId, name);
    return { ok: true };
  });

  // Panel-triggered: with settings.playbooks.autoUpdate, same-major updates
  // apply. confirmSource === true re-confirms recorded local folders for
  // this call (ruling T5-recorded).
  handle(IPC.CASE_CHECK_PLAYBOOK_UPDATES, async (p) => {
    const caseId = needCase(p);
    const name = p.name === undefined || p.name === null ? null : checkPlaybookName(p.name, 'name');
    const confirmSource = checkFlag(p.confirmSource, 'confirmSource');
    const updates = await getManager(context).checkUpdates(caseId, name, { apply: true, confirmSource });
    return { ok: true, updates: updates.map(shapeUpdateRow) };
  });

  handle(IPC.CASE_UPDATE_PLAYBOOK, async (p) => {
    const caseId = needCase(p);
    const name = checkPlaybookName(p.name, 'name');
    const force = checkFlag(p.force, 'force');
    const confirmSource = checkFlag(p.confirmSource, 'confirmSource');
    const r = await getManager(context).update(caseId, name, { force, confirmSource });
    if (!r || r.ok !== true) return failure(r);
    return { ok: true, from: cap(r.from, 64), to: cap(r.to, 64), budgetRaises: (r.budgetRaises || []).map(budgetRow) };
  });

  handle(IPC.CASE_LIST_EXAMPLE_PLAYBOOKS, async () => ({
    ok: true,
    examples: getManager(context).listExamples().map((e) => ({ name: cap(e.name, 64), version: cap(e.version, 64), title: cap(e.title, 200), caseType: cap(e.caseType, 64) }))
  }));

  handle(IPC.CASE_PLAYBOOK_PROPOSALS, async (p) => {
    const caseId = needCase(p);
    const proposalId = p.proposalId === undefined || p.proposalId === null ? null : checkProposalId(p.proposalId);
    const m = getManager(context);
    return {
      ok: true,
      proposals: m.proposals(caseId).map(shapeProposal),
      ...(proposalId ? { patch: m.patchText(caseId, proposalId) } : {})
    };
  });

  // The owner's explicit actions; the model's Playbook tool has no path here.
  handle(IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, async (p) => {
    const caseId = needCase(p);
    const proposalId = checkProposalId(p.proposalId);
    const repoPath = checkRepoPath(p.repoPath);
    const r = await getManager(context).applyProposal(caseId, proposalId, repoPath);
    if (!r || r.ok !== true) return failure(r);
    return { ok: true, appliedTo: cap(r.appliedTo, MAX_REPO_PATH), appliedOver: cap(r.appliedOver, 64) };
  });

  handle(IPC.CASE_REJECT_PLAYBOOK_PROPOSAL, async (p) => {
    const caseId = needCase(p);
    const proposalId = checkProposalId(p.proposalId);
    const r = await getManager(context).rejectProposal(caseId, proposalId);
    if (!r || r.ok !== true) return failure(r);
    return { ok: true };
  });

  handle(IPC.CASE_ACCEPT_PLAYBOOK_BUDGET, async (p) => {
    const caseId = needCase(p);
    const name = checkPlaybookName(p.name, 'name');
    const r = await getManager(context).applyBudgetRaises(caseId, name);
    return { ok: true, applied: (r.applied || []).map(budgetRow) };
  });
}

module.exports = { registerPlaybookHandlers, preparePlaybooksForCreate, attachPlaybooksAfterCreate };

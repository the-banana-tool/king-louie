// src/cases/case-runtime.js
// The one object core holds for cases: turn lifecycle, lock and commits
// (stage 1), plus the stage-2 machinery for unattended work: status,
// re-orientation triggers, turn hooks, budgets, questions and wake-ups
// (docs/superpowers/specs/2026-09-23-cases-stage2-unattended.md §3.10).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('./git');
const { CaseStore } = require('./case-store');
const { FactLedger } = require('./ledger');
const { Brief, BriefError } = require('./brief');
const { ScopeStore, ScopeError, textHash, validateCriterionText, ORIGINS, CONFIRMING_ORIGINS } = require('./scope');
const { CaseRecords } = require('./records');
const { AbandonedStore } = require('./abandoned');
const { VerificationStore } = require('./verify/store');
const { progressView, summaryLine } = require('./verify/status');
const { resolveEvidence, turnMarks, collectTurnEvidence, statesOf } = require('./verify/evidence');
const { prepareVerifyPass, callVerifyModel, applyVerifyReply, verificationBlock, verifyModelRefusal } = require('./verify/judge');
const { registerVerificationHook, freezeProgress, REGRESSED: REGRESSED_STATES } = require('./verify/hook');
const { closeReadiness } = require('./verify/readiness');
const { CheckStore, CheckError, CHECK_TYPE, currentCheck, closeCheck } = require('./verify/check');
const { checkQuestionText, createdObjectiveQuestion, CREATED_OBJECTIVE_KEY } = require('./verify/questions');
const { buildOrientation, DEFAULT_MAX_CHARS } = require('./orientation');
const { canTransition, check: checkStatus, StatusError, AUTONOMY_KEY, REASON_KINDS } = require('./status');
const { Budget, CATEGORIES, PER_DAY } = require('./budget');
const { WakeupStore } = require('./wakeups');
const { QuestionStore } = require('./questions');
const { detectTriggers, emptyBaseline } = require('./triggers');
const { localDay, isRealCalendarDate } = require('./clock');
const { readJson, writeJsonIfChanged } = require('./jsonfile');
const { resolveCaseSettings } = require('./defaults');
const { resolveCaseRole, caseRoleSpec } = require('./roles');
const { snapshotFromSettings } = require('../models/profiles');
const { egressPolicy } = require('../models/egress');
const { CrossCaseIndex } = require('./index-store');
const { findSimilarCases } = require('./gates');
const { assertKnownType, resolveCaseType, briefFieldsFor, gatingQuestionsFor } = require('./case-types');
const { DetourClassifier } = require('./detours/classifier');
const { DetourRouter } = require('./detours/router');
const { postQuestionToChat } = require('./question-chat');
const { registerDetourHooks } = require('./detours/hooks');
// Registers the direction and budget-grant answer handlers.
require('./answer-handlers');
const { createLogger } = require('../logging');

const log = createLogger('cases/runtime');

const BUDGET_FACT_NOTE = "Budget limits change only through the owner's answer or the Grant button.";

// F6 re-review: "quit it or delete the lock" is advice for a *different*
// process (a real one, possibly stuck, possibly not even King Louie) —
// it never makes sense when this same process holds the lock, whatever
// called _acquire (an in-process systemAction, a second owner turn while
// one is running, or a wake-up's own beginTurn finding another wake-up
// still in flight). `sameProcess` routes to one of two fixed messages
// instead, and never builds the quit/delete sentence at all.
// Cases stage 8: the owner's scope actions (applyScopeAction).
const SCOPE_ACTIONS = Object.freeze(['confirm', 'drop', 'edit', 'add']);
// Cases stage 8: a failure report's journal name without its extension
// (what CaseRecords.writeJournal('failure', …) names it).
const FAILURE_REPORT_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}-failure(?:-\d+)?$/;

// What writeScope is told of a new string, checked before brief.md is
// touched (ScopeStore checks it again when it writes): an origin it knows,
// and a confirmation only with an origin that may be born confirmed and a
// `by` naming who confirmed.
function assertBirth({ origin, confirmed }) {
  if (!ORIGINS.includes(origin)) throw new ScopeError('SCOPE_INVALID', `A scope origin is one of ${ORIGINS.join(', ')}.`);
  if (confirmed === null || confirmed === undefined) return;
  if (!CONFIRMING_ORIGINS.includes(origin)) throw new ScopeError('SCOPE_INVALID', `An entry of origin ${origin} is proposed until the owner confirms it.`);
  if (typeof confirmed !== 'object' || typeof confirmed.by !== 'string' || !confirmed.by) {
    throw new ScopeError('SCOPE_INVALID', 'A confirmation names who confirmed ("by").');
  }
}

class CaseBusyError extends Error {
  constructor(title, { pid, lockPath, sameProcess = false, holderIsWakeup = false, verifying = false } = {}) {
    let message;
    if (sameProcess) {
      message = holderIsWakeup
        ? 'Case is busy with a wake-up; try again in a minute.'
        : 'Case is busy with another turn in this app; try again in a moment.';
    } else {
      const holder = pid ? ` in process ${pid}` : '';
      const recover = lockPath
        ? ` If that process is stuck or is not King Louie, quit it or delete ${lockPath}.`
        : '';
      message = `Case "${title}" is busy with another turn${holder}. Try again when it finishes.${recover}`;
    }
    super(message);
    this.name = 'CaseBusyError';
    this.code = 'CASE_BUSY';
    // A verify pass of this process is out, not a turn (verifyNow).
    this.verifying = verifying === true;
  }
}

// F6: an owner message arriving while an in-process wake-up holds the lock
// is not the same situation as another process (or a stuck one) holding
// it — the owner outranks unattended work, so beginTurn aborts the
// wake-up and waits (bounded) for it to release. If that does not clear
// the lock in time, this is thrown instead of CaseBusyError: never tell
// the owner to quit the app or delete the lock over the runtime's own
// in-process turn (spec §9 text).
class WakeupBusyError extends Error {
  constructor() {
    super('Case is busy with a wake-up; try again in a minute.');
    this.name = 'WakeupBusyError';
    this.code = 'CASE_BUSY';
  }
}

// Case creation found an open case with the same or a close title or
// objective (cases stage 5 spec §3.2). The owner may retry with force.
class SimilarCaseError extends Error {
  constructor(similar) {
    const first = similar[0];
    super(`A similar case exists: "${first.title}" (${first.status}). Attach this work to it, or create the new case anyway with force.`);
    this.name = 'SimilarCaseError';
    this.code = 'SIMILAR_CASES';
    this.similar = similar;
  }
}

const RELATIONS = Object.freeze(['spawned', 'blocked-by', 'blocks', 'related']);
const RELATED_ID = /^(?:[A-Za-z0-9-]{1,64}|pending:d-\d{4,})$/;
const DETOUR_ID = /^d-\d{4,}$/;

class CaseNotFoundError extends Error {
  constructor(id) {
    super(`Case not found: ${id}`);
    this.name = 'CaseNotFoundError';
    this.code = 'CASE_NOT_FOUND';
  }
}

// Thrown by beginTurn for a wake-up turn started (or still starting) after
// beginShutdown(): the process is on its way out, and nothing unattended
// may pick up a fresh lock once it can no longer be trusted to finish and
// release it cleanly.
class RuntimeClosingError extends Error {
  constructor() {
    super('King Louie is shutting down; no new wake-up turn can start.');
    this.name = 'RuntimeClosingError';
    this.code = 'RUNTIME_CLOSING';
  }
}

// The owner's "Check now" was refused (verifyNow): the case is closed or not
// running, nothing is confirmed, the pass is off, or the day's passes or the
// budget are used. `code` says which.
class VerifyRefusedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerifyRefusedError';
    this.code = code;
  }
}

const expandHome = (p) => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

// settings.cases.root: `~` is the home dir and a relative path is under the
// data dir. KL_CASES_ROOT: `~` expanded; a relative path is left for the
// process cwd to resolve, as before.
function resolveCasesRoot({ settings, env = process.env, dataDir }) {
  const configured = settings?.cases?.root;
  if (typeof configured === 'string' && configured.trim()) {
    const root = expandHome(configured.trim());
    return path.isAbsolute(root) ? root : path.resolve(dataDir, root);
  }
  if (env && env.KL_CASES_ROOT) return expandHome(env.KL_CASES_ROOT);
  return path.join(dataDir, 'cases');
}

const oneLine = (s, max = 72) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock(lock) {
  try {
    const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
    return held && typeof held === 'object' ? held : null;
  } catch {
    return null;
  }
}

const HOOK_PHASES = Object.freeze(['turn-start', 'owner-message']);
// The journal entry a verify pass writes when it lands after the turn
// (cases stage 8, R-C8-11). The orientation's "last journal entry" skips it:
// that is the turn's own entry, and what the pass found is in the Progress
// section and the turn-start notes.
const VERIFY_JOURNAL_KIND = 'verification';
// What the owner's check (verifyNow) reports when a turn took the case first.
const CHECK_SUPERSEDED = 'a turn started in this case';
const STOPS_WORK = new Set(['paused', 'done', 'abandoned']);

class CaseRuntime {
  constructor({
    root, staleLockMs = 30 * 60 * 1000, wakeupPreemptTimeoutMs = 10000, orientationMaxChars = DEFAULT_MAX_CHARS,
    getSettings = null, now = null, host = null
  } = {}) {
    this.store = new CaseStore({ root });
    this.staleLockMs = staleLockMs;
    // F6: how long an owner turn waits for an in-process wake-up it just
    // aborted to actually release the lock, before giving up.
    this.wakeupPreemptTimeoutMs = wakeupPreemptTimeoutMs;
    this.orientationMaxChars = orientationMaxChars;
    // turnId -> { dir, timer }: the locks this runtime holds right now.
    this.held = new Map();
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this._clock = typeof now === 'function' ? now : () => new Date();
    // Host services, all optional (spec §3.10): inferenceRouter,
    // snapshotModels, createToolExecutor, toolRegistry, AgentLoop,
    // getUsageTracker, hasProviderToken, notify, uiToast, interactive,
    // getExecutorRegistry. Without them wake-ups and routed providers are off.
    this.host = host || null;
    // caseId -> the turn this process is running on that case.
    this.turns = new Map();
    this.hooks = [];
    // Cases currently mid-`createCase`: the wake-up sweep (Task 13) skips a
    // tick while this is non-zero, since a case with no first commit yet
    // cannot be swept.
    this.creating = 0;
    // Set by beginShutdown(): no new wake-up turn may start once true.
    this.closing = false;
    // Cases stage 8 (R-C8-11): the verify passes that run after a turn's
    // reply. caseId -> the pass whose result may still land; every pass
    // whose call has not ended (a dropped one too) is in verifyJobs; a case
    // in verifyOwed had a pass dropped before it landed, so its next
    // verified close runs one even when that turn wrote nothing. All three
    // are this process's memory only.
    this.verifying = new Map();
    this.verifyJobs = new Set();
    this.verifyOwed = new Set();
    // caseId -> the system action in which a pass is writing right now (its
    // result, or a late charge): an owner turn waits for it (_acquireForTurn).
    this.verifyWrites = new Map();
    // How long a pass that is ready to land waits for a system action of
    // this process to release the case, and an owner turn for a landing.
    this.verifyLandWaitMs = 5000;
    // Cases stage 5: detour routing and the case-type refresh (spec §3.6).
    // Registered last, once every field above exists (controller ruling M3).
    registerDetourHooks(this);
    // Cases stage 8 (spec §6.3): after the detour hooks, so it runs after
    // the case-type refresh and sees the repository as it is now.
    registerVerificationHook(this);
  }

  // Called once shutdown begins (create-core, right after the scheduler
  // stops): refuses every wake-up turn from here on, so a turn straddling
  // the shutdown never runs, writes or commits without a lock this process
  // still recognizes as held.
  beginShutdown() {
    this.closing = true;
    // A verify pass still out (cases stage 8): its call is stopped and its
    // result will not be written. The host awaits verifyIdle() before it
    // releases the locks.
    this.abortVerifyPasses('shutdown');
    // A check command that is running is killed with everything it started.
    this.abortChecks('shutdown');
  }

  // Stops every run of a check command this runtime started (spec §6.6):
  // the process tree is killed and nothing of the run is recorded.
  abortChecks(reason = 'stopped') {
    for (const controller of this._checkRuns instanceof Set ? this._checkRuns : []) controller.abort(reason);
  }

  get root() {
    return this.store.root;
  }

  now() {
    return this._clock();
  }

  settings() {
    let raw = {};
    try {
      raw = this.getSettings()?.cases || {};
    } catch (err) {
      log.warn(`Reading case settings failed: ${err.message}`);
    }
    return resolveCaseSettings(raw);
  }

  // The cross-case index at <root>/.index/ (cases stage 5 spec §3.1).
  get index() {
    if (!this._index) this._index = new CrossCaseIndex(this.root, { store: this.store, isPrivateCase: (id) => this.isPrivate(id) });
    return this._index;
  }

  // Never fails the caller: a stale index is refreshed by the next search.
  _reindex(id) {
    try {
      this.index.upsertCase(id);
    } catch (err) {
      log.warn(`Updating the case index for ${id} failed: ${err.message}`);
    }
  }

  // The wake-up sweep lists cases; a case still being created has no first commit yet,
  // so a sweep that commits it would make `create` fail with "nothing to commit".
  // `runDueWakeups` skips the whole tick while any creation is in flight.
  // A same or close title/objective of an open case refuses creation with
  // SimilarCaseError unless opts.force === true (the owner confirmed).
  async createCase(opts = {}) {
    assertKnownType(opts.type || 'general');
    if (opts.force !== true) {
      // Advisory only, so it fails open: when the index errors,
      // openCaseHeads() logs a warning and returns [], and creation goes ahead.
      const { exact, similar } = findSimilarCases({
        title: opts.title,
        objective: opts.objective || '',
        candidates: this.index.openCaseHeads(),
        threshold: this.settings().duplicates.createSimilarity
      });
      const found = [...exact, ...similar].map(({ caseId, title, status, match }) => ({ caseId, title, status, match }));
      if (found.length) throw new SimilarCaseError(found);
    }
    this.creating = (this.creating || 0) + 1;
    try {
      const info = await this.store.create({ title: opts.title, type: opts.type, objective: opts.objective, private: opts.private === true });
      await this._recordCreatedObjective(info, opts.objective, opts.objectiveBy);
      this._reindex(info.id);
      return info;
    } finally {
      this.creating -= 1;
    }
  }

  // Cases stage 8 (spec §6.1): who gave the objective a case was created
  // with. `objectiveBy` is the host's to pass, like `force`: 'owner' (IPC
  // case:create with the form's objective; create_case in the chat, which
  // checked the quote in the owner's turn) is the only value that confirms;
  // 'mcp' is create_case over MCP, whose quote nobody checked (R-C8-N3:
  // proposed, origin mcp-create); 'detour' is the router's prefill; anything
  // else is the model's. Never fails the create: without the record the
  // objective reads `legacy` and proposed.
  async _recordCreatedObjective(info, objective, objectiveBy) {
    if (typeof objective !== 'string' || !objective.trim()) return;
    const PROPOSED_BY = { detour: 'detour', mcp: 'mcp-create' };
    const born = objectiveBy === 'owner'
      ? { origin: 'owner-create', confirmed: { by: 'owner-create', at: this.now().toISOString() } }
      : { origin: Object.prototype.hasOwnProperty.call(PROPOSED_BY, objectiveBy) ? PROPOSED_BY[objectiveBy] : 'model', confirmed: null };
    try {
      await this.systemAction(info.id, 'scope', async (meta) => {
        this.scope(meta.id).reconcile(this.brief(meta.id).read().data, { origins: { objective: born }, addedBy: born.origin });
        // R-C8-N7: an objective set over MCP is asked about at once, pressed.
        if (objectiveBy === 'mcp') this._askCreatedObjective(meta, this.scopeView(meta.id));
      }, { commitMessage: 'case created: who gave the objective' });
    } catch (err) {
      log.warn(`Case ${info.slug}: recording who gave the objective failed: ${err.message}`);
    }
  }

  // The pressed scope question about an objective create_case set over MCP
  // (R-C8-N7): host-made, so never charged to questionsPerDay; it goes up
  // the contact ladder like any question. Never fails the create.
  _askCreatedObjective(meta, view) {
    try {
      const record = createdObjectiveQuestion(meta, view);
      if (record) this.createQuestion(meta.id, record, { charge: false });
    } catch (err) {
      log.warn(`Case ${meta.slug}: asking the owner to confirm the objective failed: ${err.message}`);
    }
  }

  // Once the objective is confirmed, the question create_case asked about it
  // has nothing left to ask: it is closed, not left on the ladder.
  _closeCreatedObjectiveQuestion(meta) {
    try {
      if (this.scopeView(meta.id).objective?.state !== 'confirmed') return;
      const store = this.questions(meta.id);
      for (const q of store.open().filter((r) => r.payload?.key === CREATED_OBJECTIVE_KEY)) {
        store.close(q.id, { reason: 'the objective was confirmed', by: 'system' });
      }
    } catch (err) {
      log.warn(`Case ${meta.slug}: closing the objective question failed: ${err.message}`);
    }
  }

  listCases() {
    return this.store.list();
  }

  getCase(idOrSlug) {
    const c = this.store.get(idOrSlug);
    if (!c) throw new CaseNotFoundError(idOrSlug);
    return c;
  }

  ledger(id) { return new FactLedger(this.getCase(id).dir); }

  // The brief with the case type's fields and required field-backed gating
  // questions (cases stage 5 spec §3.7).
  brief(id) {
    const meta = this.getCase(id);
    return new Brief(meta.dir, { extraFields: briefFieldsFor(meta.type), gatingFields: this._gatingFields(meta) });
  }

  _gatingFields(meta) {
    try {
      return gatingQuestionsFor(this, meta.id).filter((q) => q.required && typeof q.field === 'string').map((q) => q.field);
    } catch (err) {
      log.warn(`Gating questions for ${meta.slug} unavailable: ${err.message}`);
      return [];
    }
  }

  records(id) { return new CaseRecords(this.getCase(id).dir); }

  // ---- Scope (cases stage 8 spec §6.1): who wrote each criterion ----

  scope(id) {
    return new ScopeStore(this.getCase(id).dir, { now: () => this.now() });
  }

  // brief.md joined with .kl/scope.json, in memory. Never writes, so it is
  // safe outside the lock (the panel, open_case, a closed case). A brief
  // that cannot be read gives { error } (and so no confirmed criterion).
  scopeView(id) {
    const meta = this.getCase(id);
    let data;
    try {
      // Reading needs no case-type fields, so no playbook package is loaded.
      data = new Brief(meta.dir).read().data;
    } catch (err) {
      if (err instanceof BriefError) return { error: err.message };
      log.warn(`Scope of ${meta.slug}: brief.md unreadable: ${err.message}`);
      return { error: 'brief.md is missing or unreadable' };
    }
    return this.scope(meta.id).view(data);
  }

  // The one path that writes a criterion list or the objective AND who
  // wrote it. Call it with the case lock held (a turn or a systemAction).
  // `field` is 'successCriteria' (value: the new full list) or 'objective'
  // (value: the text). Every string that is new gets `origin`, and is born
  // confirmed only when `confirmed` ({ by, channel, quote, factId }) is
  // given with a confirming origin (ScopeStore refuses the rest). Strings
  // that were already there keep their entry, except those whose hash is in
  // `alsoConfirm`, which `confirmed` confirms too (a gating answer that
  // repeats a proposal). Nothing here decides that the owner said it: the
  // caller did, and no tool parameter reaches `confirmed`.
  // → { view, added: [rows], removed: [rows] }. Throws ScopeError.
  writeScope(id, { field, value, origin, confirmed = null, addedBy = null, removedBy = null, alsoConfirm = [] } = {}) {
    const meta = this.getCase(id);
    if (meta.status === 'done' || meta.status === 'abandoned') {
      throw new ScopeError('CASE_CLOSED', `Case is ${meta.status}. Its scope is read-only.`);
    }
    if (field !== 'successCriteria' && field !== 'objective') {
      throw new ScopeError('SCOPE_INVALID', 'writeScope writes "successCriteria" or "objective".');
    }
    const brief = this.brief(meta.id);
    const store = this.scope(meta.id);
    // Strings that are in brief.md with no entry yet (first contact, a file
    // edit) get their own origin first, so `origin` below marks only what
    // this call adds.
    const before = store.reconcile(brief.read().data);
    const born = { origin, confirmed: confirmed || null };
    const confirming = confirmed ? { by: confirmed.by, channel: confirmed.channel ?? null, quote: confirmed.quote ?? null, factId: confirmed.factId ?? null } : null;

    if (field === 'objective') {
      if (typeof value !== 'string') throw new ScopeError('SCOPE_INVALID', 'The objective is text.');
      const hash = value.trim() ? textHash(value) : null;
      const isNew = hash !== null && before.objective?.hash !== hash;
      const origins = isNew ? { objective: born } : {};
      // Checked before brief.md is touched: a refused origin writes nothing.
      if (isNew) assertBirth(born);
      brief.update('objective', value, { provenance: confirmed ? 'user' : 'model' });
      let view = store.reconcile(brief.read().data, { origins, addedBy });
      if (!isNew && confirming && view.objective && view.objective.state !== 'confirmed') {
        assertBirth(born);
        store.confirm(['objective'], { hashes: { objective: view.objective.hash }, ...confirming });
        view = store.view(brief.read().data);
      }
      return { view, added: isNew ? [view.objective] : [], removed: [] };
    }

    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
      throw new ScopeError('SCOPE_INVALID', 'successCriteria is a list of non-empty strings.');
    }
    const hashes = value.map(textHash);
    if (new Set(hashes).size !== hashes.length) {
      throw new ScopeError('CRITERION_DUPLICATE', 'The same words are already a success criterion.');
    }
    const known = new Map(before.criteria.map((row) => [row.hash, row]));
    const added = hashes.filter((h) => !known.has(h));
    const kept = before.criteria.filter((row) => hashes.includes(row.hash));
    const removed = before.criteria.filter((row) => !hashes.includes(row.hash));
    if (added.length) {
      assertBirth(born);
      const problem = store.limitsProblem({ criteria: kept }, { adding: added.length, addingProposed: confirmed ? 0 : added.length });
      if (problem) throw problem;
    }
    const again = (Array.isArray(alsoConfirm) ? alsoConfirm : []).map((h) => known.get(h)).filter((row) => row && row.state !== 'confirmed' && hashes.includes(row.hash));
    if (again.length) {
      if (!confirming) throw new ScopeError('SCOPE_INVALID', 'A confirmation names who confirmed ("by").');
      assertBirth(born);
    }
    brief.update('successCriteria', value, { provenance: confirmed ? 'user' : 'model' });
    const origins = Object.fromEntries(added.map((h) => [h, born]));
    let view = store.reconcile(brief.read().data, { origins, addedBy, removedTexts: before, removedBy: removedBy || addedBy });
    if (again.length) {
      store.confirm(again.map((row) => row.id), { hashes: Object.fromEntries(again.map((row) => [row.id, row.hash])), ...confirming });
      view = store.view(brief.read().data);
    }
    return { view, added: view.criteria.filter((row) => added.includes(row.hash)), removed };
  }

  // The owner's own scope actions (the panel and the card's buttons through
  // IPC case:confirmScope, and the answer to a scope question). No case tool
  // reaches this. `target` is 'objective', an `sc-` id or 'all-proposed';
  // `confirm` and `drop` need the hash the owner was shown (for
  // 'all-proposed' an object { [id]: hash }, with `objective` when the
  // objective is meant too) and refuse SCOPE_STALE when the words changed;
  // `edit` and `add` take the owner's typed `text` and record it confirmed,
  // origin owner-action. → the new view.
  async applyScopeAction(id, { action, target = null, hash = null, text = null, by = null, channel = null, quote = null, factId = null } = {}) {
    const meta = this.getCase(id);
    if (!SCOPE_ACTIONS.includes(action)) throw new ScopeError('SCOPE_INVALID', `A scope action is one of ${SCOPE_ACTIONS.join(', ')}.`);
    if (typeof by !== 'string' || !by) throw new ScopeError('SCOPE_INVALID', 'A scope action names who made it ("by").');
    if (meta.status === 'done' || meta.status === 'abandoned') {
      throw new ScopeError('CASE_CLOSED', `Case is ${meta.status}. Its scope is read-only.`);
    }
    const act = () => {
      const brief = this.brief(meta.id);
      const store = this.scope(meta.id);
      const before = store.reconcile(brief.read().data);
      const stamp = { by, channel, quote, factId };
      const rowOf = (ref) => {
        const row = before.criteria.find((r) => r.id === ref);
        if (!row) throw new ScopeError('CRITERION_NOT_FOUND', `No success criterion ${String(ref)} in this case.`);
        return row;
      };
      const shown = (row, seen, name) => {
        if (typeof seen !== 'string' || seen !== row.hash) throw new ScopeError('SCOPE_STALE', `${name} changed since it was shown; read it again.`);
      };
      const list = () => before.criteria.map((r) => r.text);

      if (action === 'add') {
        const clean = validateCriterionText(text);
        if (before.criteria.some((r) => r.hash === textHash(clean))) throw new ScopeError('CRITERION_DUPLICATE', 'The same words are already a success criterion.');
        const w = this.writeScope(meta.id, { field: 'successCriteria', value: [...list(), clean], origin: 'owner-action', confirmed: stamp, addedBy: by });
        return { changed: true, line: `added ${w.added.map((r) => r.id).join(', ')}` };
      }

      if (action === 'edit') {
        if (target === 'objective') {
          if (typeof text !== 'string' || !text.trim()) throw new ScopeError('CRITERION_INVALID', 'An objective is text.');
          if (before.objective && typeof hash === 'string') shown(before.objective, hash, 'The objective');
          this.writeScope(meta.id, { field: 'objective', value: text.trim(), origin: 'owner-action', confirmed: stamp, addedBy: by });
          return { changed: true, line: 'the objective was rewritten' };
        }
        const row = rowOf(target);
        if (typeof hash === 'string') shown(row, hash, row.id);
        const clean = validateCriterionText(text);
        const newHash = textHash(clean);
        if (before.criteria.some((r) => r.hash === newHash && r.id !== row.id)) throw new ScopeError('CRITERION_DUPLICATE', 'The same words are already a success criterion.');
        const value = before.criteria.map((r) => (r.id === row.id ? clean : r.text));
        const w = this.writeScope(meta.id, {
          field: 'successCriteria', value, origin: 'owner-action', confirmed: stamp, addedBy: by, alsoConfirm: [newHash]
        });
        return { changed: true, line: newHash === row.hash ? `confirmed ${row.id}` : `${row.id} was rewritten as ${w.added.map((r) => r.id).join(', ')}` };
      }

      // confirm and drop: the rows the owner was shown.
      let rows;
      let objective = false;
      if (target === 'all-proposed') {
        const seen = hash && typeof hash === 'object' && !Array.isArray(hash) ? hash : {};
        rows = before.criteria.filter((r) => r.state !== 'confirmed');
        for (const row of rows) shown(row, seen[row.id], row.id);
        if (action === 'confirm' && before.objective && before.objective.state !== 'confirmed' && seen.objective !== undefined) {
          shown(before.objective, seen.objective, 'The objective');
          objective = true;
        }
      } else if (target === 'objective') {
        if (action === 'drop') throw new ScopeError('SCOPE_INVALID', 'The objective is rewritten, never dropped.');
        if (!before.objective) throw new ScopeError('CRITERION_NOT_FOUND', 'This case has no objective to confirm.');
        shown(before.objective, hash, 'The objective');
        rows = [];
        objective = before.objective.state !== 'confirmed';
      } else {
        const row = rowOf(target);
        shown(row, hash, row.id);
        rows = action === 'confirm' && row.state === 'confirmed' ? [] : [row];
      }
      if (!rows.length && !objective) return { changed: false };

      if (action === 'confirm') {
        const targets = [...rows.map((r) => r.id), ...(objective ? ['objective'] : [])];
        const hashes = Object.fromEntries(rows.map((r) => [r.id, r.hash]));
        if (objective) hashes.objective = before.objective.hash;
        store.confirm(targets, { hashes, ...stamp });
        return { changed: true, line: `confirmed ${targets.join(', ')}` };
      }
      const gone = new Set(rows.map((r) => r.id));
      this.writeScope(meta.id, { field: 'successCriteria', value: before.criteria.filter((r) => !gone.has(r.id)).map((r) => r.text), origin: 'owner-action', addedBy: by, removedBy: by });
      return { changed: true, line: `dropped ${[...gone].join(', ')}` };
    };
    // One journal entry per action that changed something: ids only, so it
    // can be shown wherever the last journal entry is.
    const result = await this.systemAction(meta.id, `scope ${action}`, async () => {
      const r = act();
      if (r.changed) {
        this.records(meta.id).writeJournal('scope', `Scope: ${r.line} (by ${oneLine(by, 40)}${channel ? `, ${oneLine(channel, 40)}` : ''}).`, this.now());
        this._closeCreatedObjectiveQuestion(meta);
      }
      return r;
    });
    if (result.changed) {
      this._reindex(meta.id);
      this._notify('case:changed', { caseId: meta.id, what: 'progress' });
    }
    return this.scopeView(meta.id);
  }

  // ---- Progress (cases stage 8 spec §6.2 to §6.4) ----

  abandoned(id) {
    return new AbandonedStore(this.getCase(id).dir, { now: () => this.now() });
  }

  verification(id) {
    return new VerificationStore(this.getCase(id).dir, { now: () => this.now() });
  }

  // The check command's approvals and runs (.kl/checks.json; spec §6.6).
  checks(id) {
    return new CheckStore(this.getCase(id).dir, { now: () => this.now() });
  }

  // Asks the owner to approve the check command the brief names now (spec
  // §6.6): a pressed question, never charged. An open one about an earlier
  // command is closed first. Called under the case lock (a turn, or a
  // system action). → the question. Throws CheckError when there is no
  // command, or no repository on this machine to run it in.
  requestCheckApproval(id) {
    const meta = this.getCase(id);
    const current = currentCheck(this, meta.id);
    if (!current) throw new CheckError('CHECK_INVALID', 'This case has no check command.');
    const store = this.questions(meta.id);
    for (const q of store.open().filter((r) => r.payload?.type === CHECK_TYPE)) {
      try {
        store.close(q.id, { reason: 'superseded', by: 'system' });
      } catch (err) {
        log.warn(`Could not close superseded check question ${q.id}: ${err.message}`);
      }
    }
    return this.createQuestion(meta.id, {
      kind: 'question',
      urgency: 'normal',
      text: checkQuestionText(meta, current),
      options: [{ id: 'approve', label: 'Approve' }, { id: 'refuse', label: 'Do not run' }],
      defaultOnSilence: 'hold',
      // Pressed: answered only by the buttons on its card or the phone.
      payload: { type: CHECK_TYPE, key: CHECK_TYPE, mcpAnswerable: false, disclosable: false, hash: current.hash }
    }, { charge: false });
  }

  // Each criterion with its state as the record says it now (spec §6.3):
  // recomputed on every call from the verification records, the ledger and
  // the case-type snapshot. Nothing stored is taken as a state. Reads only.
  progressView(id, { scope = null, file = null } = {}) {
    const meta = this.getCase(id);
    const { facts } = this.ledger(meta.id).view();
    let snapshot = null;
    try {
      snapshot = this.caseTypeSnapshot(meta.id);
    } catch (err) {
      log.warn(`Progress of ${meta.slug}: the case-type snapshot is unavailable: ${err.message}`);
    }
    // The runs of the check command (spec §6.6): a `chk-` id is resolved
    // against them, and a failed newest run makes a criterion that cites
    // a check `failing`.
    let runs = [];
    try {
      runs = this.checks(meta.id).read().runs;
    } catch (err) {
      log.warn(`Progress of ${meta.slug}: the check runs are unavailable: ${err.message}`);
    }
    const ctx = { facts, checks: runs, snapshot };
    return progressView({
      scopeView: scope || this.scopeView(meta.id),
      file: file || this.verification(meta.id).read(),
      resolve: (evidenceId) => resolveEvidence(evidenceId, ctx),
      newestCheck: runs.length ? runs[runs.length - 1] : null
    });
  }

  // The ready-to-close list (spec §6.4). Reads only.
  closeReadiness(id, { view = null } = {}) {
    return closeReadiness(this, id, { view });
  }

  // What the panel, the Progress tool and MCP all read:
  // { scope, view, readiness, summary, abandoned, closed }. Never writes.
  // A done or abandoned case that was frozen at its close gets that record
  // back as `closed` ({ frozen: true, at, status, summary, criteria,
  // readiness }) and nothing is computed; a case closed before progress was
  // tracked has `closed: null`.
  progress(id) {
    const meta = this.getCase(id);
    const file = this.verification(meta.id).read();
    let abandoned = [];
    try {
      abandoned = this.abandoned(meta.id).active();
    } catch (err) {
      log.warn(`Progress of ${meta.slug}: the abandoned approaches are unavailable: ${err.message}`);
    }
    if ((meta.status === 'done' || meta.status === 'abandoned') && file.closed) {
      const closed = { ...file.closed, frozen: true };
      return { scope: null, view: null, readiness: null, summary: typeof closed.summary === 'string' ? closed.summary : null, abandoned, closed };
    }
    const scope = this.scopeView(meta.id);
    const view = this.progressView(meta.id, { scope, file });
    const readiness = this.closeReadiness(meta.id, { view });
    return { scope, view, readiness, summary: summaryLine(view, readiness), abandoned, closed: null };
  }

  // The owner's "Check now" (IPC case:verifyNow; owner ruling 2026-10-13):
  // one verify pass over the whole record, asked for by the owner's press.
  // No tool and no MCP surface calls this. It is the pass of a turn's close
  // (R-C8-11) started by a press instead: prepared and counted under the
  // case lock in a commit of its own, then run by _startVerifyPass with no
  // lock held, and landed, charged, dropped and stopped as that one is. So
  // an owner turn that starts meanwhile drops it (the case is owed a pass),
  // and a wake-up waits for it. What differs: every reason to skip is
  // checked here first and refused, so a refused press makes no call and
  // writes nothing; it never starts while a turn, a system action or
  // another pass has the case (CASE_BUSY); and Stop, a pause or a close
  // ends it with nothing recorded (_stopCheck). It is not a turn: nothing
  // is charged to turnsPerDay and no turn-start hook runs. → the pass's
  // result. Throws VerifyRefusedError, CaseBusyError or RuntimeClosingError.
  async verifyNow(id) {
    if (this.closing) throw new RuntimeClosingError();
    const meta = this.getCase(id);
    const cfg = this.settings().verify;
    if (meta.status === 'done' || meta.status === 'abandoned') {
      throw new VerifyRefusedError('CASE_CLOSED', `Case is ${meta.status}. It is read-only; what it closed with is kept as it was.`);
    }
    if (cfg.when === 'off') throw new VerifyRefusedError('VERIFY_OFF', 'The verify pass is turned off for cases (cases.verify.when).');
    if (meta.status !== 'active' && meta.status !== 'needs-direction') {
      throw new VerifyRefusedError('VERIFY_NOT_OPEN', `Case is ${meta.status}. A check runs while a case is active or waiting for direction.`);
    }
    if (!this.progressView(meta.id).criteria.some((r) => r.scope === 'confirmed')) {
      throw new VerifyRefusedError('VERIFY_NO_CRITERIA', 'No success criterion is confirmed, so there is nothing to check. Confirm one first.');
    }
    const day = localDay(this.now(), this.settings().timeZone);
    if (this.verification(meta.id).passesOn(day) >= cfg.maxPassesPerDay) {
      throw new VerifyRefusedError('VERIFY_DAILY_CAP', `The limit of ${cfg.maxPassesPerDay} verify ${cfg.maxPassesPerDay === 1 ? 'pass' : 'passes'} a day is used for this case. It is free again tomorrow.`);
    }
    const ratio = this.budget(meta.id).status().usd.ratio;
    if (ratio !== null && ratio * 100 >= cfg.skipAboveUsdPercent) {
      throw new VerifyRefusedError('VERIFY_USD_BUDGET', `This case has used ${cfg.skipAboveUsdPercent} % of its usd budget or more, so no verify pass runs. Raise the budget to check.`);
    }
    if (this.verifyRunning(meta.id)) throw new CaseBusyError(meta.title, { sameProcess: true, verifying: true });
    if (this._holdsLock(meta.dir)) throw new CaseBusyError(meta.title, { sameProcess: true });
    const turnId = `check-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    // What the pass needs of a turn: the case, an id for its records and
    // its usage, and the models.
    const turn = { caseId: meta.id, dir: meta.dir, turnId, title: meta.title, source: 'check', signal: null };
    turn.models = this._turnModels(meta.id, null);
    // The owner asked for this pass by name, so it is vital (local inference
    // spec 2026-10-13 §7.3, "skip optional, refuse vital"): with no local
    // model under a private case's policy it is refused, before anything is
    // counted or written, with the resolver's words.
    const refusal = verifyModelRefusal(this, turn);
    if (refusal) throw new VerifyRefusedError(refusal.code, refusal.message);
    let out = null;
    let plan = null;
    await this.systemAction(meta.id, 'check', () => {
      ({ out, plan } = prepareVerifyPass(this, turn, { mode: 'request' }));
      if (!plan) return;
      plan.out = out;
      // What the pass's entry is compared with: the states as they are now.
      plan.before = statesOf(this.progressView(meta.id));
    }, { commitMessage: `${turnId}: verify pass asked for by the owner` });
    if (!plan) return out;
    // The commit above was awaited: a turn may have taken the case since.
    // The pass was counted and is owed to that turn's close.
    if (this.closing || this._holdsLock(meta.dir) || this.verifyRunning(meta.id)) {
      this.verifyOwed.add(meta.id);
      out.error = this.closing ? 'dropped (shutdown)' : CHECK_SUPERSEDED;
      out.dropped = true;
      return out;
    }
    const job = this._startVerifyPass(turn, plan, { check: true });
    this._notify('case:changed', { caseId: meta.id, what: 'turn', running: true, source: 'check' });
    try {
      return (await job.promise) || out;
    } finally {
      this._notify('case:changed', { caseId: meta.id, what: 'turn', running: false, source: 'check' });
      this._notify('case:changed', { caseId: meta.id, what: 'progress' });
    }
  }

  // beginTurn's step (spec §6.9, §10): the scope record is written from
  // brief.md as it is now. The first run on a case is its migration (every
  // string `legacy`); later a string with no entry is a file edit. Never
  // for a closed case, and never fails the turn.
  _reconcileScope(meta) {
    if (meta.status === 'done' || meta.status === 'abandoned') return;
    try {
      this.scope(meta.id).reconcile(new Brief(meta.dir).read().data);
    } catch (err) {
      log.warn(`Case ${meta.slug}: the scope record was not reconciled: ${err.message}`);
    }
  }

  // The cross-case entity index (cases stage 7 spec §3.6, R46): attached to
  // C5's CrossCaseIndex (which then keeps it current through rebuild,
  // upsertCase and removeCase), or a standalone instance at the same file
  // (<root>/.index/entities.json) when no index can take it.
  entityIndex() {
    const { EntityIndex } = require('./entities');
    const make = () => new EntityIndex(this.root, { store: this.store, getSettings: this.getSettings });
    if (typeof this.index?.attachEntities === 'function') {
      if (!this.index.entities) this.index.attachEntities(make());
      return this.index.entities;
    }
    if (!this._entities) this._entities = make();
    return this._entities;
  }

  budget(id) {
    const meta = this.getCase(id);
    const cfg = this.settings();
    return new Budget(meta.dir, {
      defaults: cfg.budgets,
      overrides: meta.budget && typeof meta.budget === 'object' ? meta.budget : {},
      createdAt: meta.created,
      now: () => this.now(),
      timeZone: cfg.timeZone
    });
  }

  wakeups(id) {
    const meta = this.getCase(id);
    const cfg = this.settings();
    return new WakeupStore(meta.dir, {
      now: () => this.now(),
      timeZone: cfg.timeZone,
      dailyAt: cfg.wakeups.dailyAt,
      backoffMinutes: cfg.wakeups.retryBackoffMinutes
    });
  }

  questions(id) {
    const meta = this.getCase(id);
    return new QuestionStore(meta.dir, {
      now: () => this.now(),
      caseId: meta.id,
      // A close or an expiry settles a question no answer path notified
      // about; the window refreshes its card (management surfaces §3.4).
      onSettled: (rec) => this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId: rec.id })
    });
  }

  orientation(id, { triggers = [], hookNotes = [] } = {}) {
    const meta = this.getCase(id);
    const { facts, errors } = new FactLedger(meta.dir).view();
    let brief;
    try {
      brief = { data: new Brief(meta.dir).read().data };
    } catch (err) {
      // The orientation leaves the node (MCP, the front door): a BriefError
      // describes the file's content; any other error (ENOENT, EACCES) names
      // the node's absolute path, so it is logged and replaced.
      if (err instanceof BriefError) {
        brief = { error: err.message };
      } else {
        log.warn(`Orientation for ${meta.slug}: brief.md unreadable: ${err.message}`);
        brief = { error: 'brief.md is missing or unreadable' };
      }
    }
    const records = new CaseRecords(meta.dir);
    const safely = (label, fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        log.warn(`Orientation for ${meta.slug}: ${label} unavailable: ${err.message}`);
        return fallback;
      }
    };
    const budget = safely('budget', () => this.budget(meta.id).status(), null);
    const questions = safely('questions', () => this.questions(meta.id).open(), []);
    const nextWakeup = safely('wake-ups', () => this.wakeups(meta.id).list()
      .slice()
      .sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))[0] || null, null);
    // Cases stage 8 (spec §6.8): each read costs one line when it fails,
    // never the orientation. All three only read.
    const progress = safely('progress', () => this.progress(meta.id), { error: true });
    const abandoned = safely('abandoned approaches', () => this.abandoned(meta.id).list(), { records: [], unavailable: true });
    const lastFailure = safely('last failure report', () => this._lastFailure(meta, facts), null);
    return buildOrientation({
      meta,
      brief,
      facts,
      decisions: records.decisions(),
      lastJournal: records.lastJournal({ skipKinds: [VERIFY_JOURNAL_KIND] }),
      ledgerErrors: errors,
      maxChars: this.orientationMaxChars,
      triggers,
      hookNotes,
      statusReason: meta.statusReason || null,
      failure: this._failureReport(meta),
      questions,
      budget,
      nextWakeup,
      now: this.now(),
      detours: safely('detours', () => this._detourLines(meta), []),
      extras: this._extras(meta),
      progress,
      abandoned,
      lastFailure
    });
  }

  // The failure report a case was resumed from (R-C8-10): while the status
  // reason is the owner's direction, the direction fact's `attr` is the
  // report's name when the answer came through the direction question. A
  // direction recorded from chat has an attr the model chose, so the name is
  // used only when it is a failure report's and that file is in the case.
  _lastFailure(meta, facts) {
    if (meta.statusReason?.kind !== 'direction') return null;
    const fact = facts.get(meta.statusReason.ref);
    if (!fact || fact.subject !== 'direction' || typeof fact.attr !== 'string') return null;
    if (!FAILURE_REPORT_NAME.test(fact.attr)) return null;
    if (!fs.existsSync(path.join(meta.dir, 'journal', `${fact.attr}.md`))) return null;
    return { file: `journal/${fact.attr}.md` };
  }

  // `## Case type: <type>`: the type's extras from the cached snapshot.
  _extras(meta) {
    const t = resolveCaseType(meta.type);
    const lines = [];
    if (meta.type && t.type !== meta.type) lines.push(`Unknown case type "${meta.type}"; treated as general.`);
    try {
      const text = t.orientationExtras(this, meta.id);
      if (text) lines.push(text);
    } catch (err) {
      log.warn(`Case-type extras for ${meta.slug} failed: ${err.message}`);
      lines.push(`Case-type details are unavailable: ${err.message}`);
    }
    return { type: t.type, text: lines.join('\n') };
  }

  // `## Detours and related cases`: open proposals, answers waiting to be
  // mapped, incoming detours, then related cases.
  _detourLines(meta) {
    return [...this.detours.orientationLines(meta.id), ...this._relatedLines(meta)];
  }

  // ---- Detours (cases stage 5 spec §3.3–§3.5) ----

  get classifier() {
    if (!this._classifier) this._classifier = new DetourClassifier({ runtime: this });
    return this._classifier;
  }

  get detours() {
    if (!this._detours) this._detours = new DetourRouter({ runtime: this, classifier: this.classifier });
    return this._detours;
  }

  // C3 calls this once per plan and once per new job. A detour is refused
  // with the instruction to propose it; an unsure or failed classification
  // lets the work through, and so does any error here (logged): the gate
  // fails open like the classifier. Only a wrong `source` throws, since that
  // is a caller bug rather than a runtime failure.
  async detourGate(id, { source, serves = null, text, turnId = null } = {}) {
    if (!['plan', 'executor'].includes(source)) throw new Error(`detourGate source must be plan or executor, not "${source}".`);
    try {
      const meta = this.getCase(id);
      const turn = this.turns.get(meta.id) || { caseId: meta.id, turnId, signal: null };
      const classification = await this.classifier.classify(meta.id, { source, serves, text, turn });
      if (classification.detour) {
        let objective = '';
        try {
          objective = this.brief(meta.id).read().data?.objective || '';
        } catch {
          objective = '';
        }
        const reason = classification.reason.replace(/[.\s]+$/, '');
        return {
          ok: false,
          error: `This work looks like a detour from the case objective ("${objective || meta.title}"): ${reason}. Do not do it in this case. Call Detour with action "propose" (blocks: true if this case cannot proceed without it), then continue with on-case work.`,
          classification
        };
      }
      if (!classification.failed && classification.onCase === false) {
        return { ok: true, note: `The classifier was unsure this serves the objective: ${classification.reason.replace(/[.\s]+$/, '')}.` };
      }
      return { ok: true };
    } catch (err) {
      log.warn(`detourGate (${source}) on case ${id} failed; letting the work through: ${err && err.message ? err.message : String(err)}`);
      return { ok: true };
    }
  }

  _relatedLines(meta) {
    return (Array.isArray(meta.related) ? meta.related : []).map((r) => {
      if (!r || typeof r.id !== 'string') return null;
      const note = r.note ? ` — ${oneLine(r.note, 200)}` : '';
      if (r.id.startsWith('pending:')) return `${r.relation}: routing ${r.id.slice(8)} is waiting for the owner${note}`;
      const other = this.store.get(r.id);
      if (!other) return `${r.relation}: (case ${r.id} no longer exists)${note}`;
      const done = r.relation === 'blocked-by' && other.status === 'done' ? ' (done — check whether it still blocks)' : '';
      return `${r.relation}: "${other.title}" (${other.status})${done}${note}`;
    }).filter(Boolean);
  }

  // blocked-by entries for open-items.md.
  _blockers(caseId) {
    const meta = this.getCase(caseId);
    return (Array.isArray(meta.related) ? meta.related : [])
      .filter((r) => r && r.relation === 'blocked-by' && typeof r.id === 'string')
      .map((r) => {
        const other = r.id.startsWith('pending:') ? null : this.store.get(r.id);
        return {
          id: r.id,
          title: other ? other.title : (r.id.startsWith('pending:') ? `routing ${r.id.slice(8)} (not decided yet)` : `case ${r.id} (no longer exists)`),
          status: other ? other.status : 'pending',
          note: r.note || ''
        };
      });
  }

  // ---- Related cases (cases stage 5 spec §3.8): the only writers of case.yaml related ----

  // The caller holds the case lock (a turn or systemAction). Deduped on (id, relation).
  addRelation(id, entry = {}) {
    const meta = this.getCase(id);
    if (typeof entry.id !== 'string' || !RELATED_ID.test(entry.id)) throw new Error(`A related entry needs a case id or pending:<detourId>, not ${JSON.stringify(entry.id)}.`);
    if (!RELATIONS.includes(entry.relation)) throw new Error(`relation must be one of ${RELATIONS.join(', ')}.`);
    if (entry.detour !== undefined && entry.detour !== null && !DETOUR_ID.test(String(entry.detour))) throw new Error(`detour must look like d-0001, not ${JSON.stringify(entry.detour)}.`);
    if (entry.id === meta.id) throw new Error('A case cannot be related to itself.');
    if (!entry.id.startsWith('pending:') && !this.store.get(entry.id)) throw new Error(`No case with id ${entry.id} exists to relate to.`);
    const row = {
      id: entry.id,
      relation: entry.relation,
      ...(entry.note ? { note: oneLine(entry.note, 300) } : {}),
      ...(entry.detour ? { detour: String(entry.detour) } : {}),
      at: this.now().toISOString()
    };
    const related = (Array.isArray(meta.related) ? meta.related : []).filter((r) => !(r && r.id === row.id && r.relation === row.relation));
    related.push(row);
    this.store.updateMeta(meta.id, { related });
    this._reindex(meta.id);
    return row;
  }

  // Removes every entry matching all given keys of { id, relation, detour }.
  removeRelation(id, match = {}) {
    const meta = this.getCase(id);
    const keys = Object.entries(match || {}).filter(([k, v]) => ['id', 'relation', 'detour'].includes(k) && v !== undefined);
    if (!keys.length) throw new Error('removeRelation needs id, relation or detour to match.');
    const before = Array.isArray(meta.related) ? meta.related : [];
    const kept = before.filter((r) => !(r && keys.every(([k, v]) => r[k] === v)));
    if (kept.length !== before.length) {
      this.store.updateMeta(meta.id, { related: kept });
      this._reindex(meta.id);
    }
    return before.length - kept.length;
  }

  // ---- Case types (cases stage 5 spec §3.7) ----

  // The newest snapshot: a background refresh kept in memory, else .kl/case-type.json.
  caseTypeSnapshot(id) {
    const meta = this.getCase(id);
    const mem = this._typeSnapshots instanceof Map ? this._typeSnapshots.get(meta.id) || null : null;
    let disk = null;
    try {
      disk = readJson(path.join(meta.dir, '.kl', 'case-type.json'), null);
    } catch (err) {
      log.warn(`Reading the case-type snapshot of ${meta.slug} failed: ${err.message}`);
    }
    if (disk && (typeof disk !== 'object' || Array.isArray(disk))) disk = null;
    // A snapshot with no string fetchedAt counts as the oldest.
    const fetched = (s) => (typeof s?.fetchedAt === 'string' ? s.fetchedAt : '');
    if (mem && (!disk || fetched(mem) >= fetched(disk))) return mem;
    return disk;
  }

  // { [field]: value } for C2's .kl/triggers.json baseline; null when the
  // type has no material fields or nothing has been fetched.
  caseTypeMaterial(id) {
    const meta = this.getCase(id);
    const t = resolveCaseType(meta.type);
    const fields = t.materialFields();
    if (!fields.length) return null;
    const snapshot = this.caseTypeSnapshot(meta.id);
    if (!snapshot) return null;
    const all = typeof t.materialOf === 'function' ? t.materialOf(snapshot) : (snapshot.state || {});
    const out = {};
    for (const f of fields) out[f] = all[f] ?? null;
    return out;
  }

  _failureReport(meta) {
    const ref = meta.status === 'needs-direction' ? meta.statusReason?.ref : null;
    if (typeof ref !== 'string' || !ref) return null;
    const base = path.resolve(meta.dir);
    const file = path.resolve(base, ref);
    if (!file.startsWith(base + path.sep)) return null;
    try {
      return { file: ref, text: fs.readFileSync(file, 'utf8') };
    } catch {
      return null;
    }
  }

  completeGating(id) {
    const meta = this.getCase(id);
    // Cases stage 6: required playbook gating questions come first.
    if (this.playbooks) this.playbooks.assertGatingComplete(meta.id);
    // Cases stage 8 (R-C8-2): one criterion the owner confirmed.
    this.brief(meta.id).completeGating({ scopeView: this.scopeView(meta.id) });
    if (meta.status === 'draft') this.setStatus(meta.id, 'active', { kind: 'gating' });
    this._reindex(meta.id);
    return this.getCase(meta.id);
  }

  // ---- Status (spec §3.1) ----

  setStatus(id, status, { kind, by = 'runtime', ref = null, note = '', failureClass = null, resumeTo = null } = {}) {
    if (!REASON_KINDS.includes(kind)) {
      throw new StatusError('BAD_KIND', `setStatus needs a "kind" naming why (one of ${REASON_KINDS.join(', ')}); got ${kind === undefined ? 'nothing' : JSON.stringify(kind)}.`);
    }
    const meta = this.getCase(id);
    if (!canTransition(meta.status, status, by, kind)) {
      throw new StatusError('BAD_TRANSITION', `A case cannot go from ${meta.status} to ${status} (${by}, ${kind || 'no reason'}).`);
    }
    if ((status === 'active' || status === 'needs-direction') && kind === 'budget-grant' && meta.statusReason?.kind !== 'budget') {
      throw new StatusError('BAD_TRANSITION', 'A budget grant lifts only a budget pause.');
    }
    if (status === 'active') {
      const exhausted = this.budget(meta.id).exhausted();
      if (exhausted.length) throw new StatusError('BUDGET_EXHAUSTED', `Raise the ${exhausted[0]} budget first.`);
    }
    const statusReason = {
      kind,
      by,
      ref: ref ?? null,
      note: String(note || ''),
      failureClass: failureClass ?? null,
      resumeTo: (status === 'paused' && (resumeTo === 'active' || resumeTo === 'needs-direction')) ? resumeTo : null,
      at: this.now().toISOString()
    };
    // Cases stage 8 (R-C8-7): what the case closes with is read while it is
    // still open and written once the status has changed. Neither step may
    // stop the status change.
    const closes = (status === 'done' || status === 'abandoned') && meta.status !== 'done' && meta.status !== 'abandoned';
    let closingProgress = null;
    if (closes) {
      try {
        closingProgress = this.progress(meta.id);
      } catch (err) {
        log.warn(`Case ${meta.slug}: its progress could not be read for the close: ${err.message}`);
      }
    }
    const updated = this.store.updateMeta(meta.id, { status, statusReason });
    if (closes && closingProgress) {
      try {
        freezeProgress(this, meta.id, { status, progress: closingProgress });
      } catch (err) {
        log.warn(`Case ${meta.slug}: its progress was not frozen at the close: ${err.message}`);
      }
    }
    this._notify('case:changed', { caseId: meta.id, what: 'status' });
    if (STOPS_WORK.has(status)) {
      this._abortTurn(meta.id, `case ${status}`);
      this._cancelExecutorJobs(meta.id, `case ${status}`);
    }
    if (status === 'done' || status === 'abandoned') this.wakeups(meta.id).cancelAll();
    if (status === 'active') this.ensureDefaultWakeups(meta.id);
    return updated;
  }

  assertWritable(id, op) {
    const meta = this.getCase(id);
    return checkStatus(meta.status, op, {
      autonomyAllows: this.autonomyAllows(meta.id, 'retry-within-envelope'),
      reason: meta.statusReason || null
    });
  }

  autonomyAllows(id, action) {
    const meta = this.getCase(id);
    if (meta.status !== 'needs-direction') return false;
    const key = AUTONOMY_KEY[meta.statusReason?.failureClass];
    return Boolean(key) && meta.autonomy?.[key] === action;
  }

  requireReoriented(id) {
    const meta = this.getCase(id);
    const turn = this.turns.get(meta.id);
    if (!turn) {
      return { ok: false, error: 'No case turn is running for this case, so re-orientation cannot be checked. Run this inside a case turn.' };
    }
    if (turn.reorientPending) {
      const pending = (turn.triggers || []).filter((t) => t.blocking).map((t) => t.detail).join(' ');
      return { ok: false, error: `Re-orientation is required first: ${pending} Call Reorient before Recommend, Decide or Fail.` };
    }
    return null;
  }

  ensureDefaultWakeups(id) {
    const meta = this.getCase(id);
    const store = this.wakeups(meta.id);
    store.ensure('daily-orientation', { every: 86400000, payload: { key: 'daily' } });
    if (this.budget(meta.id).limitFor('deadline')) {
      store.ensure('deadline-check', { every: 86400000, payload: { key: 'deadline' } });
    }
  }

  _notify(event, payload) {
    try {
      if (typeof this.host?.notify === 'function') this.host.notify(event, payload);
    } catch (err) {
      log.warn(`Notifying ${event} failed: ${err.message}`);
    }
  }

  _abortTurn(caseId, reason) {
    const turn = this.turns.get(caseId);
    if (turn && turn.source === 'wakeup' && typeof turn.abort === 'function') turn.abort(reason);
    // The owner's check (verifyNow) has no turn: it is a pass that is out.
    this._stopCheck(caseId, reason);
  }

  _cancelExecutorJobs(caseId, reason) {
    try {
      const registry = typeof this.host?.getExecutorRegistry === 'function' ? this.host.getExecutorRegistry() : null;
      if (registry && typeof registry.cancelOpenJobs === 'function') {
        Promise.resolve(registry.cancelOpenJobs(caseId, reason))
          .catch((err) => log.warn(`Cancelling executor jobs for ${caseId} failed: ${err.message}`));
      }
    } catch (err) {
      log.warn(`Cancelling executor jobs for ${caseId} failed: ${err.message}`);
    }
  }

  // ---- Lock ----

  _lockPath(dir) {
    return path.join(dir, '.kl', 'lock');
  }

  // beginTurn's entry point (F6): an owner (or system) turn that finds the
  // lock held by a wake-up this same process is running preempts it —
  // aborts it and waits, bounded, for the release — rather than failing
  // with CaseBusyError's "quit it or delete the lock" message, which is
  // meant for a different process, not this runtime's own turn. A wake-up
  // turn never preempts anything: it just takes the normal busy error.
  async _acquireForTurn(meta, turnId, source) {
    // Cases stage 8: the pass of the turn before is dropped the moment a
    // turn takes the case, with no await between (see _supersedeVerify).
    const take = () => {
      this._acquire(meta, turnId);
      this._supersedeVerify(meta.id, 'a newer turn started');
    };
    try {
      take();
      return;
    } catch (err) {
      if (err.code !== 'CASE_BUSY' || source === 'wakeup') throw err;
      // A verify pass of this process is writing (its result or a late
      // charge; a commit's length): the owner's turn waits for it instead
      // of being refused.
      const writing = this.verifyWrites.get(meta.id);
      if (writing) {
        await this._waitFor(writing, this.verifyLandWaitMs);
        try {
          take();
          return;
        } catch (again) {
          if (again.code !== 'CASE_BUSY') throw again;
        }
      }
      const holder = readLock(this._lockPath(meta.dir));
      const held = holder && Number.isInteger(holder.pid) ? this.turns.get(meta.id) : null;
      const inProcessWakeup = Boolean(
        holder && holder.pid === process.pid && held && held.source === 'wakeup' && held.turnId === holder.turnId
      );
      if (!inProcessWakeup) throw err;
      log.info(`Case ${meta.slug}: an owner turn is preempting the in-process wake-up ${held.turnId}.`);
      if (typeof held.abort === 'function') held.abort('preempted by an owner message');
      const released = await this._waitForLockRelease(meta.dir, held.turnId, this.wakeupPreemptTimeoutMs);
      if (!released) throw new WakeupBusyError();
      try {
        take();
      } catch {
        throw new WakeupBusyError();
      }
    }
  }

  // Polls (bounded) for the lock in `dir` to stop being held by `turnId` —
  // used only to wait out an aborted in-process wake-up (F6), never a
  // remote process, which cannot be waited on this way.
  async _waitForLockRelease(dir, turnId, timeoutMs) {
    const lock = this._lockPath(dir);
    const stillHeld = () => {
      const holder = readLock(lock);
      return Boolean(holder && holder.turnId === turnId);
    };
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // Deliberately not unref()'d: this is an active wait for work this
    // process itself is doing, not a background timer, and must keep the
    // process alive until it resolves one way or the other.
    while (stillHeld() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !stillHeld();
  }

  _acquire(meta, turnId) {
    const lock = this._lockPath(meta.dir);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ turnId, pid: process.pid, at: new Date().toISOString() }));
        } finally {
          fs.closeSync(fd);
        }
        this._hold(meta.dir, turnId);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const holder = readLock(lock);
        const stale = this._staleReason(lock, holder);
        if (attempt === 0 && stale) {
          log.warn(`Reclaiming stale lock on case ${meta.slug} (${stale})`);
          fs.rmSync(lock, { force: true });
          continue;
        }
        {
          const sameProcess = Boolean(holder && Number.isInteger(holder.pid) && holder.pid === process.pid);
          const heldTurn = sameProcess ? this.turns.get(meta.id) : null;
          const holderIsWakeup = Boolean(heldTurn && heldTurn.source === 'wakeup' && heldTurn.turnId === holder.turnId);
          throw new CaseBusyError(meta.title, { pid: holder?.pid, lockPath: lock, sameProcess, holderIsWakeup });
        }
      }
    }
  }

  // Why an existing lock can be taken over, or null while its holder is live.
  _staleReason(lock, holder) {
    if (holder && Number.isInteger(holder.pid)) {
      if (holder.pid === process.pid) {
        if (!this.held.has(holder.turnId)) return 'left by an earlier turn in this process';
      } else if (!pidAlive(holder.pid)) {
        return `process ${holder.pid} is gone`;
      }
    }
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > this.staleLockMs) return `${Math.round(age / 60000)} min old`;
    return null;
  }

  // Keep the held lock's mtime fresh so a long turn never looks stale.
  _hold(dir, turnId) {
    const lock = this._lockPath(dir);
    const timer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(lock, now, now);
      } catch (err) {
        log.warn(`Could not refresh lock in ${dir}: ${err.message}`);
      }
    }, Math.max(10, Math.floor(this.staleLockMs / 3)));
    timer.unref?.();
    this.held.set(turnId, { dir, timer });
  }

  _holdsLock(dir) {
    for (const h of this.held.values()) if (h.dir === dir) return true;
    return false;
  }

  releaseAll() {
    for (const [turnId, { dir }] of [...this.held]) this._release(dir, turnId);
    this.turns.clear();
  }

  _release(dir, turnId) {
    const entry = this.held.get(turnId);
    if (entry && entry.dir === dir) {
      clearInterval(entry.timer);
      this.held.delete(turnId);
    }
    const lock = this._lockPath(dir);
    try {
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (held.turnId === turnId) fs.rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not release lock in ${dir}: ${err.message}`);
    }
  }

  // ---- Turn hooks (spec §3.3, program §4.20) ----

  addTurnStartHook(name, fn, { phase = 'turn-start' } = {}) {
    if (typeof name !== 'string' || !name) throw new Error('addTurnStartHook needs a name.');
    if (typeof fn !== 'function') throw new Error('addTurnStartHook needs a function.');
    if (!HOOK_PHASES.includes(phase)) throw new Error(`Unknown hook phase "${phase}". Phases: ${HOOK_PHASES.join(', ')}.`);
    this.hooks = this.hooks.filter((h) => h.name !== name);
    this.hooks.push({ name, fn, phase });
  }

  async _runHooks(phase, { caseId, dir, turnId, source, ownerMessage }) {
    const notes = [];
    const triggers = [];
    for (const hook of this.hooks.filter((h) => h.phase === phase)) {
      try {
        const out = await hook.fn({
          runtime: this, caseId, dir, meta: this.getCase(caseId), turnId, source, ownerMessage, now: this.now()
        });
        if (Array.isArray(out?.notes)) notes.push(...out.notes.map(String));
        if (Array.isArray(out?.triggers)) {
          triggers.push(...out.triggers.filter((t) => t && typeof t.kind === 'string' && typeof t.key === 'string'));
        }
      } catch (err) {
        log.warn(`Turn-start hook ${hook.name} failed on case ${caseId}: ${err.message}`);
        notes.push(`Turn-start hook ${hook.name} failed: ${err.message}`);
      }
    }
    return { notes, triggers };
  }

  async runOwnerMessageHooks(turn) {
    const hook = await this._runHooks('owner-message', {
      caseId: turn.caseId, dir: turn.dir, turnId: turn.turnId, source: turn.source, ownerMessage: turn.ownerMessage
    });
    if (!hook.notes.length && !hook.triggers.length) return { notes: [], triggers: [], orientation: turn.orientation };
    const baseline = this._baseline(turn.dir);
    const fresh = hook.triggers
      .filter((t) => !baseline.acknowledgedKeys.includes(t.key))
      .map((t) => ({ ...t, blocking: t.blocking !== false, detail: String(t.detail || t.kind) }));
    turn.hookTriggers = [...(turn.hookTriggers || []), ...hook.triggers];
    turn.hookNotes = [...(turn.hookNotes || []), ...hook.notes];
    turn.triggers = [...(turn.triggers || []), ...fresh];
    if (fresh.some((t) => t.blocking)) turn.reorientPending = true;
    // A failed rebuild must not fail the owner's send: keep the orientation
    // the turn already has (its triggers and notes are still recorded above).
    try {
      turn.orientation = this.orientation(turn.caseId, { triggers: turn.triggers, hookNotes: turn.hookNotes });
    } catch (err) {
      log.warn(`Rebuilding the orientation of case ${turn.caseId} after owner-message hooks failed: ${err.message}`);
    }
    return { notes: hook.notes, triggers: fresh, orientation: turn.orientation };
  }

  // ---- Triggers and the baseline (.kl/triggers.json) ----

  _baselinePath(dir) {
    return path.join(dir, '.kl', 'triggers.json');
  }

  _baseline(dir) {
    const stored = readJson(this._baselinePath(dir), null);
    return { ...emptyBaseline(), ...(stored && typeof stored === 'object' ? stored : {}) };
  }

  _materialSnapshot(meta) {
    const executors = readJson(path.join(meta.dir, '.kl', 'executors.json'), null);
    const executorsMaterial = {};
    if (executors && typeof executors === 'object') {
      for (const [eid, entry] of Object.entries(executors)) {
        if (entry && !entry.stale) executorsMaterial[eid] = entry.material ?? null;
      }
    }
    const budget = this.budget(meta.id).status();
    const budgetCrossed = {};
    for (const c of CATEGORIES) budgetCrossed[c] = [...(budget[c]?.crossed || [])];
    let caseTypeMaterial = null;
    if (typeof this.caseTypeMaterial === 'function') {
      try {
        caseTypeMaterial = this.caseTypeMaterial(meta.id) || null;
      } catch (err) {
        log.warn(`caseTypeMaterial failed for ${meta.slug}: ${err.message}`);
      }
    }
    return { executors, executorsMaterial, budget, budgetCrossed, caseTypeMaterial };
  }

  _detect(meta, { source, hookTriggers = [] }) {
    const baseline = this._baseline(meta.dir);
    const snap = this._materialSnapshot(meta);
    // A threshold that a grant, a raised limit or a new day removed can fire
    // again later: prune it from the baseline (spec §3.3).
    let pruned = false;
    for (const c of Object.keys(baseline.budgetCrossed || {})) {
      const was = Array.isArray(baseline.budgetCrossed[c]) ? baseline.budgetCrossed[c] : [];
      const keep = was.filter((t) => (snap.budgetCrossed[c] || []).includes(t));
      if (keep.length !== was.length) {
        baseline.budgetCrossed[c] = keep;
        pruned = true;
      }
    }
    if (pruned) writeJsonIfChanged(this._baselinePath(meta.dir), baseline);
    let playbookChanges = [];
    if (typeof this.playbookChanges === 'function') {
      try {
        playbookChanges = this.playbookChanges(meta.id) || [];
      } catch (err) {
        log.warn(`playbookChanges failed for ${meta.slug}: ${err.message}`);
      }
    }
    const triggers = detectTriggers({
      source,
      now: this.now(),
      meta,
      facts: new FactLedger(meta.dir).view().facts,
      decisions: new CaseRecords(meta.dir).decisions(),
      budget: snap.budget,
      executors: snap.executors,
      plan: readJson(path.join(meta.dir, '.kl', 'plan.json'), null),
      playbookChanges,
      hookTriggers,
      baseline,
      reorientAfterHours: this.settings().reorientAfterHours
    });
    return {
      triggers,
      snapshot: { executorsMaterial: snap.executorsMaterial, budgetCrossed: snap.budgetCrossed, caseTypeMaterial: snap.caseTypeMaterial }
    };
  }

  // What the Reorient tool records: a journal entry, and a baseline that
  // acknowledges everything pending now.
  recordReorientation(id, turn, { changed, affects = [], action, note }) {
    const meta = this.getCase(id);
    const pending = (turn.triggers || []).filter((t) => t.blocking);
    const body = [
      '# Re-orientation',
      '',
      'Triggers:',
      ...(pending.length ? pending.map((t) => `- ${t.detail}`) : ['- none']),
      '',
      `Changed: ${changed}`,
      `Affects: ${affects.length ? affects.join(', ') : 'none'}`,
      `Action: ${action}`,
      `Note: ${note}`
    ].join('\n');
    const journal = new CaseRecords(meta.dir).writeJournal('reorient', body, this.now());
    const b = this._baseline(meta.dir);
    b.acknowledgedAt = this.now().toISOString();
    // Only acknowledge what this turn actually showed the model (its
    // decision-undermined triggers), plus whatever the baseline already had.
    // A decision undermined mid-turn, never shown, must still fire next time
    // (controller ruling, Task 12 review I2).
    const shown = (turn.triggers || []).filter((t) => t.kind === 'decision-undermined').map((t) => t.key);
    b.undermined = [...new Set([...(b.undermined || []), ...shown])];
    // Likewise, material and budget crossings acknowledge the turn-start
    // snapshot the model was oriented from, not whatever is current now —
    // otherwise a crossing that happens mid-turn, before Reorient runs,
    // would be silently acknowledged without ever being shown.
    if (turn.snapshot) {
      b.executorsMaterial = { ...(b.executorsMaterial || {}), ...turn.snapshot.executorsMaterial };
      b.budgetCrossed = turn.snapshot.budgetCrossed;
      if (turn.snapshot.caseTypeMaterial) b.caseTypeMaterial = turn.snapshot.caseTypeMaterial;
    }
    b.acknowledgedKeys = [...new Set([...(b.acknowledgedKeys || []), ...(turn.hookTriggers || []).map((t) => t.key)])];
    writeJsonIfChanged(this._baselinePath(meta.dir), b);
    if (typeof this.acknowledgePlaybooks === 'function') {
      try {
        this.acknowledgePlaybooks(meta.id, turn);
      } catch (err) {
        log.warn(`acknowledgePlaybooks failed for ${meta.slug}: ${err.message}`);
      }
    }
    turn.reorientPending = false;
    return journal;
  }

  // ---- Turns (spec §3.10) ----

  async beginTurn(id, { turnId, source = 'owner', ownerMessage = null, chatId = null } = {}) {
    // Shutting down: refuse before even taking the lock.
    if (source === 'wakeup' && this.closing) throw new RuntimeClosingError();
    const meta = this.getCase(id);
    // Cases stage 8 (R-C8-11): a wake-up waits its turn behind a verify
    // pass that is still out (it runs again within the minute); an owner
    // turn takes the case and the pass is dropped (_acquireForTurn).
    if (source === 'wakeup' && this.verifyRunning(meta.id)) {
      throw new CaseBusyError(meta.title, { pid: process.pid, lockPath: this._lockPath(meta.dir), sameProcess: true });
    }
    await this._acquireForTurn(meta, turnId, source);
    try {
      if (await git.isDirty(meta.dir)) await this._commit(meta.dir, 'owner edits', meta.id);
      const budget = this.budget(meta.id);
      for (const [category, crossed] of Object.entries(budget.reconcile())) this.onCrossings(meta.id, category, crossed);
      // A wake-up is refused before charging once the day's turns are spent;
      // owner turns are always charged and never refused.
      let dailyTurnsSpent = false;
      if (source === 'wakeup' && budget.atLimit('turnsPerDay')) {
        dailyTurnsSpent = true;
      } else {
        const r = budget.charge('turnsPerDay', 1, { turnId });
        if (r.crossedNow.length) this.onCrossings(meta.id, 'turnsPerDay', r.crossedNow);
      }
      // Cases stage 8: after the owner-edits commit, before the hooks.
      this._reconcileScope(meta);
      // Cases stage 6 (final review M-6): the playbook packages load once for
      // the hooks, the triggers and the orientation below.
      const closeEntriesScope = this.playbooks && typeof this.playbooks.beginEntriesScope === 'function'
        ? this.playbooks.beginEntriesScope(meta.id)
        : () => {};
      try {
        const hook = await this._runHooks('turn-start', { caseId: meta.id, dir: meta.dir, turnId, source, ownerMessage });
        const fresh = this.getCase(meta.id);
        const { triggers, snapshot } = this._detect(fresh, { source, hookTriggers: hook.triggers });
        // Re-check after the awaits above: shutdown may have begun while this
        // call was in flight. Caught below, which releases the lock this
        // attempt just took — the turn is never registered in `this.turns`.
        if (source === 'wakeup' && this.closing) throw new RuntimeClosingError();
        const controller = new AbortController();
        const turn = {
          caseId: fresh.id,
          dir: fresh.dir,
          turnId,
          title: fresh.title,
          orientation: '',
          source,
          ownerMessage,
          triggers,
          reorientPending: triggers.some((t) => t.blocking),
          hookTriggers: hook.triggers,
          hookNotes: hook.notes,
          snapshot,
          dailyTurnsSpent,
          signal: controller.signal,
          abort: (reason) => controller.abort(reason)
        };
        turn.orientation = this.orientation(fresh.id, { triggers, hookNotes: hook.notes });
        // A private case's chats carry the mark in the history store too
        // (local inference spec 2026-10-13 §8.2, R-LI-23): one made since the
        // case was marked (a question's card, an attach) is marked now.
        this._markCaseChats(fresh.id);
        // The models this turn uses, frozen at launch (models spec
        // 2026-09-27 §6.6): a switch during the turn applies to the next one.
        // A private case's snapshot carries its egress policy.
        turn.models = this._turnModels(fresh.id, chatId);
        // Cases stage 8 (spec §6.9): where the record stood when the turn
        // began, so its close can tell what the turn wrote. Taken last.
        turn.marks = this._turnMarks(fresh);
        this.turns.set(fresh.id, turn);
        this._notify('case:changed', { caseId: fresh.id, what: 'turn', running: true, source });
        return turn;
      } finally {
        closeEntriesScope();
      }
    } catch (err) {
      this._release(meta.dir, turnId);
      throw err;
    }
  }

  caseContext(turn, { ownerMessages = [], ownerMessageTimes = [] } = {}) {
    return {
      caseId: turn.caseId,
      dir: turn.dir,
      turnId: turn.turnId,
      title: turn.title,
      orientation: turn.orientation,
      source: turn.source || 'owner',
      runtime: this,
      ownerMessages,
      ownerMessageTimes
    };
  }

  // Never fails the turn: a turn with no marks finds only what carries its id.
  _turnMarks(meta) {
    try {
      return turnMarks(this, meta.id);
    } catch (err) {
      log.warn(`Case ${meta.slug}: the turn's marks could not be taken: ${err.message}`);
      return null;
    }
  }

  // The guarded steps of a turn's close (cases stage 8 spec §6.9), before
  // the render, the journal and the commit: → { block, plan }. `block` is
  // host-written text that goes first in the turn's journal entry, or null.
  // `plan` is the verify pass this close prepared, or null; endTurn starts
  // it once the turn has committed and released the case (R-C8-11).
  // `evidence` is { toolResults } from the caller, this turn's case-tool
  // calls only; it is filtered and capped again here and its ids are never
  // trusted. Only the normal exit of an owner turn and a wake-up that acted
  // pass `verify`.
  //
  // Nothing here calls a model. What needs none is done now, under the
  // turn's lock and in its commit: the check command's close run (first, so
  // the pass can cite it), what the turn wrote, every reason to skip the
  // pass, the count of the pass against the day's limit, and the block's
  // lines about what the turn itself changed (a check that went from pass
  // to fail, then a criterion whose fact the turn superseded, are said
  // here, first).
  async _closeProgress(turn, { evidence = null, verify = false } = {}) {
    if (!verify) return { block: null, plan: null };
    const closed = (status) => status === 'done' || status === 'abandoned';
    if (closed(this.getCase(turn.caseId).status)) return { block: null, plan: null };
    // Step 1 (spec §6.6, §6.9): the check command, only in an owner turn
    // and only when everything in closeCheck holds. It can take up to its
    // time limit; the owner's Stop (the turn's signal) and shutdown end it.
    // Nothing in it can fail the close.
    let check = null;
    try {
      check = await closeCheck(this, turn, typeof this.host?.runCheck === 'function' ? { run: this.host.runCheck } : {});
    } catch (err) {
      log.warn(`Case ${turn.caseId}: the check command's close run failed: ${err.message}`);
    }
    const turnEvidence = collectTurnEvidence(this, turn, evidence || {});
    // As the turn began, so a criterion that left `met` during the turn is
    // named; as it is now when no marks were taken.
    const before = turn.marks && turn.marks.states ? turn.marks.states : statesOf(this.progressView(turn.caseId));
    // A run that was just recorded is something new for the pass to read,
    // whether or not the turn wrote a fact.
    const { out, plan } = prepareVerifyPass(this, turn, { turnEvidence, owed: this.verifyOwed.has(turn.caseId) || Boolean(check) });
    const after = this.progressView(turn.caseId);
    // A pass that will run says its part when it lands; one that will not
    // says why here (the day's limit, the budget), once a day.
    const block = verificationBlock({ pass: plan ? null : out, before, after, check });
    // The cache follows what the entry just said. A close that is not
    // verified (stopped, blocked, failed) leaves it, so the next turn's
    // `verification` hook still sees a criterion that left `met`.
    const states = statesOf(after);
    // A criterion that left `met` during this turn (the turn superseded the
    // fact behind it, or the close run failed) stays `met` here, so the next
    // turn's hook raises it exactly as a change made between turns (a note
    // and a blocking trigger; owner ruling R-C8-N9): the journal line alone
    // is not read until then.
    const cached = { ...states };
    for (const [id, was] of Object.entries(before)) {
      if (was === 'met' && REGRESSED_STATES.includes(cached[id])) cached[id] = 'met';
    }
    this.verification(turn.caseId).setCache(cached);
    if (plan) {
      plan.out = out;
      // What the pass's own entry is compared with: the states this close left.
      plan.before = states;
    }
    return { block, plan };
  }

  // ---- The verify pass after the reply (cases stage 8, R-C8-11) ----
  //
  // endTurn commits and releases the case, then the pass makes its model
  // call with no lock held and nobody waiting. Its result is written in one
  // system action (the verdicts, a journal entry of its own, the cache, one
  // commit), and only while it is still the newest thing known about the
  // case: a turn that takes the case first drops it.

  // Whether a pass of this case may still land.
  verifyRunning(caseId) {
    const job = this.verifying.get(caseId);
    return Boolean(job && !job.done && !job.superseded);
  }

  // Resolves when no pass is out: for one case or, with no id, for all. With
  // `settled`, also when every provider call a pass made has ended and its
  // usage is written (a call can outlive the pass that stopped waiting for
  // it). Never rejects.
  async verifyIdle(caseId = null, { settled = false } = {}) {
    for (;;) {
      const jobs = [...this.verifyJobs].filter((j) => (caseId === null || j.caseId === caseId) && (settled || !j.done));
      if (!jobs.length) return;
      await Promise.allSettled(jobs.map((j) => (settled ? Promise.allSettled([j.promise, j.settled]) : j.promise)));
    }
  }

  // Stops every pass that is out: its call is aborted and its result is not
  // written. Called by beginShutdown.
  abortVerifyPasses(reason = 'stopped') {
    for (const job of this.verifyJobs) {
      if (job.done) continue;
      job.superseded = true;
      job.why = reason;
      job.controller.abort(reason);
    }
  }

  // A turn has taken the case: the pass that was out is no longer the
  // newest thing known about it. Synchronous, and called with no await
  // after the lock is taken, so a pass can never see "not superseded" and
  // the newer turn's lock at once.
  _supersedeVerify(caseId, reason) {
    const job = this.verifying.get(caseId);
    if (!job || job.done || job.superseded) return;
    job.superseded = true;
    job.why = reason;
    if (job.check) job.error = CHECK_SUPERSEDED;
    this.verifyOwed.add(caseId);
    job.controller.abort(reason);
    log.info(`Case ${caseId}: the verify pass of ${job.turnId} was dropped (${reason}).`);
  }

  // Stop from the chat, a pause or a close reaches one pass only: the one
  // the owner asked for (verifyNow). It ends with nothing recorded, and is
  // not owed: the owner stopped it. A pass that followed a turn is never
  // stopped this way (the turn it belonged to is over). → whether one was.
  _stopCheck(caseId, reason) {
    const job = this.verifying.get(caseId);
    if (!job || !job.check || job.done || job.superseded) return false;
    job.superseded = true;
    job.why = reason;
    job.error = 'the turn was stopped';
    job.owed = false;
    job.controller.abort(reason);
    log.info(`Case ${caseId}: the check ${job.turnId} was stopped (${reason}).`);
    return true;
  }

  // A promise, or a time limit. The timer is ref'd: this is a wait for work
  // this process itself is doing.
  _waitFor(promise, ms) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); })
    ]).finally(() => clearTimeout(timer));
  }

  // A system action made by a verify pass (its result, a late charge).
  // Listed in verifyWrites while it holds the case, so a turn that arrives
  // then waits the length of its commit instead of reading "busy".
  verifySystemAction(caseId, label, fn, options = {}) {
    const action = this.systemAction(caseId, label, fn, options);
    const tracked = Promise.resolve(action).catch(() => {}).finally(() => {
      if (this.verifyWrites.get(caseId) === tracked) this.verifyWrites.delete(caseId);
    });
    this.verifyWrites.set(caseId, tracked);
    return action;
  }

  // Starts the pass a close, or the owner's check (`check`), prepared.
  // → the job ({ promise, settled, ... }).
  _startVerifyPass(turn, plan, { check = false } = {}) {
    const caseId = turn.caseId;
    const controller = new AbortController();
    const job = {
      caseId, turnId: turn.turnId, controller, check, superseded: false, why: null, error: null, owed: true,
      done: false, promise: null, settled: Promise.resolve(), result: null
    };
    this._supersedeVerify(caseId, 'a newer pass started');
    this.verifyOwed.delete(caseId);
    this.verifying.set(caseId, job);
    this.verifyJobs.add(job);
    job.promise = this._runVerifyJob(turn, plan, job)
      .catch((err) => {
        log.warn(`Case ${caseId}: the verify pass of ${turn.turnId} failed: ${err?.message || err}`);
        return null;
      })
      .then((result) => {
        job.result = result;
        job.done = true;
        if (this.verifying.get(caseId) === job) this.verifying.delete(caseId);
        // The job stays listed until its provider call has ended too.
        Promise.resolve(job.settled).catch(() => {}).then(() => this.verifyJobs.delete(job));
        return result;
      });
    return job;
  }

  async _runVerifyJob(turn, plan, job) {
    const caseId = turn.caseId;
    const pass = plan.out;
    const dropped = () => {
      const why = job.superseded ? (job.why || 'superseded') : (this.closing ? 'shutdown' : null);
      if (!why) return false;
      pass.error = job.error || `dropped (${why})`;
      pass.dropped = true;
      // A pass that did not land is owed to the case's next verified close;
      // a check the owner stopped is not.
      if (job.owed) this.verifyOwed.add(caseId);
      return true;
    };
    if (dropped()) return pass;
    // The turn's own signal is spent (the reply is over): the pass has its own.
    const called = await callVerifyModel(this, turn, plan.input, plan.timeoutMs, { signal: job.controller.signal });
    job.settled = called.settled || Promise.resolve();
    if (dropped()) return pass;
    // A system action of this process holds the case (an answer, a panel
    // action): running inside it could miss its commit, so wait it out. A
    // turn that takes the case meanwhile drops this pass.
    const dir = this.getCase(caseId).dir;
    const deadline = Date.now() + this.verifyLandWaitMs;
    while (this._holdsLock(dir) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (dropped()) return pass;
    }
    if (this._holdsLock(dir)) {
      job.superseded = true;
      job.why = 'the case stayed busy';
      dropped();
      return pass;
    }
    let landed = false;
    try {
      // No await between the checks above and the lock: systemAction takes
      // it synchronously, and `land` is synchronous, so the result is
      // applied whole or not at all.
      await this.verifySystemAction(caseId, 'verify pass', (meta) => {
        if (dropped()) return;
        // Closed while the model was thinking: the case keeps the progress
        // it closed with (R-C8-7).
        if (meta.status === 'done' || meta.status === 'abandoned') {
          pass.error = 'the case closed during the pass';
          pass.dropped = true;
          return;
        }
        if (called.reply) applyVerifyReply(this, plan, called, pass);
        else pass.error = called.error || 'the model call failed';
        const after = this.progressView(caseId);
        const block = verificationBlock({ pass, before: plan.before, after });
        if (block) new CaseRecords(meta.dir).writeJournal(VERIFY_JOURNAL_KIND, block, this.now());
        // A criterion this pass took out of `met` stays `met` in the cache,
        // so the next turn's `verification` hook raises it (a note and a
        // blocking trigger): that turn's orientation is where the model
        // reads it, since this entry is not the turn's own.
        // Read from the cache as it is, not from what the pass began with: a
        // check starts from the record as the owner sees it, which may
        // already have left what the last turn saw.
        const states = statesOf(after);
        const store = this.verification(caseId);
        const cached = store.read().cache;
        for (const [id, was] of Object.entries(cached ? cached.states : {})) {
          if (was === 'met' && id in states && states[id] !== 'met') states[id] = 'met';
        }
        store.setCache(states);
        landed = true;
      }, { commitMessage: `${turn.turnId}: verify pass` });
    } catch (err) {
      // Another process holds the case, or the write failed.
      log.warn(`Case ${caseId}: the verify pass of ${turn.turnId} could not be written: ${err?.message || err}`);
      pass.error = 'the result could not be written';
      this.verifyOwed.add(caseId);
    }
    if (landed) {
      this._reindex(caseId);
      this._notify('case:changed', { caseId, what: 'progress' });
    }
    return pass;
  }

  async endTurn(turn, { summary = '', journal = null, journalKind = 'turn', evidence = null, verify = false } = {}) {
    // The verify pass this close prepared (cases stage 8, R-C8-11). It is
    // started below, after the commit and the release: the caller gets its
    // commit back at once and the pass runs with no lock held.
    let plan = null;
    let committedOk = false;
    try {
      // Nothing in the close steps may keep the turn from committing and
      // releasing its lock (spec §6.9).
      let block = null;
      try {
        const closed = await this._closeProgress(turn, { evidence, verify });
        if (closed && typeof closed.block === 'string' && closed.block.trim()) block = closed.block.trim();
        if (closed && closed.plan) plan = closed.plan;
      } catch (err) {
        log.warn(`Case ${turn.caseId}: the progress steps of the turn's close failed: ${err.message}`);
      }
      const records = new CaseRecords(turn.dir);
      let blockers = [];
      try {
        blockers = this._blockers(turn.caseId);
      } catch (err) {
        log.warn(`Blockers for ${turn.caseId} unavailable: ${err.message}`);
      }
      records.renderOpenItems(new FactLedger(turn.dir).view().facts, { blockers });
      // The host-written block goes first; it is written with no other text too.
      const text = journal && String(journal).trim() ? String(journal) : '';
      const entry = block ? (text ? `${block}\n\n${text}` : block) : text;
      if (entry) records.writeJournal(journalKind, entry, this.now());
      this._closeTurnMeta(turn);
      const committed = await this._commit(turn.dir, `${turn.turnId}: ${oneLine(summary) || 'turn'}`, turn.caseId);
      this._reindex(turn.caseId);
      committedOk = true;
      return committed;
    } finally {
      const owned = this.turns.get(turn.caseId) === turn;
      if (owned) this.turns.delete(turn.caseId);
      this._release(turn.dir, turn.turnId);
      this._notify('case:changed', { caseId: turn.caseId, what: 'turn', running: false, source: turn.source || 'owner' });
      if (plan) {
        // Started with no await after the release. A turn that did not
        // commit, or that no longer owned the case (shutdown released it),
        // starts none; the pass was counted and is owed to the next close.
        if (committedOk && owned && !this.closing) {
          try {
            this._startVerifyPass(turn, plan);
          } catch (err) {
            log.warn(`Case ${turn.caseId}: the verify pass could not be started: ${err.message}`);
            this.verifyOwed.add(turn.caseId);
          }
        } else {
          this.verifyOwed.add(turn.caseId);
        }
      }
    }
  }

  _closeTurnMeta(turn) {
    let meta;
    try {
      meta = this.getCase(turn.caseId);
    } catch {
      return;
    }
    const at = this.now().toISOString();
    const gapPending = Boolean(turn.reorientPending) && (turn.triggers || []).some((t) => t.kind === 'time-gap');
    const patch = { lastTurnAt: at };
    if ((turn.source || 'owner') === 'owner' && !gapPending) patch.lastOwnerTurnAt = at;
    this.store.updateMeta(meta.id, patch);
    // A turn that ended with nothing pending acknowledges the state it
    // started from (spec §3.3); what changed during the turn fires next time.
    if (!turn.reorientPending && turn.snapshot) {
      const b = this._baseline(meta.dir);
      b.executorsMaterial = { ...(b.executorsMaterial || {}), ...turn.snapshot.executorsMaterial };
      b.budgetCrossed = turn.snapshot.budgetCrossed;
      const raised = new Set((turn.hookTriggers || []).map((t) => t.key));
      b.acknowledgedKeys = (b.acknowledgedKeys || []).filter((k) => raised.has(k));
      if (turn.snapshot.caseTypeMaterial) b.caseTypeMaterial = turn.snapshot.caseTypeMaterial;
      writeJsonIfChanged(this._baselinePath(meta.dir), b);
    }
  }

  // commitAll with the consecutive-failure count of spec §3.4. A non-zero
  // count is reset before committing so a success commits the reset too.
  async _commit(dir, message, caseId) {
    const file = this._baselinePath(dir);
    const before = this._baseline(dir);
    const prior = Number(before.commitFailures) || 0;
    if (prior) {
      before.commitFailures = 0;
      writeJsonIfChanged(file, before);
    }
    try {
      return await git.commitAll(dir, message);
    } catch (err) {
      const b = this._baseline(dir);
      b.commitFailures = prior + 1;
      writeJsonIfChanged(file, b);
      if (b.commitFailures >= 2) this._onCommitFailures(caseId, err);
      throw err;
    }
  }

  _onCommitFailures(caseId, err) {
    let meta;
    try {
      meta = this.getCase(caseId);
    } catch {
      return;
    }
    if (meta.status === 'active') {
      try {
        this.setStatus(meta.id, 'paused', { kind: 'commit', note: err.message });
      } catch (e) {
        log.warn(`Case ${meta.slug}: could not pause after commit failures: ${e.message}`);
      }
    }
    try {
      this.createQuestion(meta.id, {
        kind: 'question',
        urgency: 'high',
        text: `${meta.title}: the case repository could not be committed twice (${oneLine(err.message, 200)}). Fix the repository, then resume.`,
        payload: { type: 'commit-failed', mcpAnswerable: false, key: 'commit-failed' }
      }, { charge: false });
    } catch (e) {
      log.warn(`Case ${meta.slug}: could not ask about commit failures: ${e.message}`);
    }
  }

  // The only case-lock helper outside turns (R37). Inside a turn this
  // process holds, it runs inline and the turn commits the writes.
  async systemAction(id, label, fn, { commitMessage = null } = {}) {
    const meta = this.getCase(id);
    if (this._holdsLock(meta.dir)) return fn(meta);
    const turnId = `system-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    this._acquire(meta, turnId);
    try {
      const result = await fn(meta);
      await this._commit(meta.dir, commitMessage || `system: ${label}`, meta.id)
        .catch((err) => log.warn(`Case ${meta.slug}: commit after "${label}" failed: ${err.message}`));
      return result;
    } finally {
      this._release(meta.dir, turnId);
    }
  }

  // ---- Budgets and questions (spec §3.5, §3.9) ----

  onCrossings(id, category, crossedNow = []) {
    if (!Array.isArray(crossedNow) || !crossedNow.includes(100)) return null;
    const meta = this.getCase(id);
    if (meta.status === 'done' || meta.status === 'abandoned') return null;
    if (category === 'usd' || category === 'deadline') {
      if (meta.status === 'active' || meta.status === 'needs-direction') {
        try {
          this.setStatus(meta.id, 'paused', { kind: 'budget', ref: category, resumeTo: meta.status });
        } catch (err) {
          log.warn(`Case ${meta.slug}: could not pause at the ${category} limit: ${err.message}`);
        }
      }
      return this._askBudgetGrant(this.getCase(meta.id), category);
    }
    const entry = this.budget(meta.id).status()[category] || {};
    return this.createQuestion(meta.id, {
      kind: 'briefing',
      urgency: 'low',
      text: `${meta.title} used its ${category} allowance for ${entry.day} (${entry.spent} of ${entry.limit}). It resumes when the day rolls over.`,
      payload: { type: 'budget-daily', budget: category, key: `budget-daily:${category}:${entry.day}`, mcpAnswerable: false }
    }, { charge: false });
  }

  // Creates (or returns the existing open) budget-grant question for
  // `category`, reading budget numbers live at call time so the payload
  // never goes stale (controller ruling I3 on Task 11 review).
  _askBudgetGrant(meta, category) {
    const entry = this.budget(meta.id).status()[category] || {};
    const text = category === 'deadline'
      ? `${meta.title} reached its deadline (${entry.at}) and is paused. Reply with a new deadline (YYYY-MM-DD) to continue.`
      : `${meta.title} spent ${entry.spent} of its ${entry.limit} ${category} budget and is paused. Reply with a new limit to continue.`;
    return this.createQuestion(meta.id, {
      kind: 'question',
      urgency: 'normal',
      text,
      payload: {
        type: 'budget-grant',
        budget: category,
        spent: category === 'deadline' ? null : entry.spent,
        limit: category === 'deadline' ? entry.at : entry.limit,
        mcpAnswerable: false,
        key: `budget-grant:${category}`
      }
    }, { charge: false });
  }

  // Public entry point for answer-handlers.js (outside the class) to raise
  // a fresh budget-grant question, e.g. after a reply that named no usable
  // amount, without reaching into the runtime's private helpers.
  askBudgetGrant(id, category) {
    return this._askBudgetGrant(this.getCase(id), category);
  }

  // Closes every other open budget-grant question for `category`: once a
  // grant is applied, a stale question carrying old numbers must not still
  // be answerable (controller ruling I3 on Task 11 review).
  _closeSupersededBudgetQuestions(id, category) {
    const store = this.questions(id);
    for (const q of store.open()) {
      if (q.kind === 'question' && q.payload?.type === 'budget-grant' && q.payload?.budget === category) {
        try {
          store.close(q.id, { reason: 'superseded', by: 'system' });
        } catch (err) {
          log.warn(`Could not close superseded budget question ${q.id}: ${err.message}`);
        }
      }
    }
  }

  usageHook(turn) {
    return (ev) => {
      if (!ev || typeof ev !== 'object') return;
      try {
        const totalTokens = Number(ev.totalTokens) || 0;
        const rawCost = Number(ev.cost);
        // A call to a local server (local inference spec 2026-10-13 §9.1,
        // §9.2; R-LI-13): its `local` names the server (only the local
        // provider sets it). It is free: usd is charged nothing, its tokens
        // are recorded as local, and none of them counts as unpriced.
        const local = Boolean(ev.local && typeof ev.local === 'object' && typeof ev.local.server === 'string' && ev.local.server);
        // Otherwise a cost of zero with tokens is unpriced, as a null or
        // missing cost is. A non-finite cost (NaN, Infinity) is unusable
        // data, treated the same way rather than charged or silently
        // dropped (spec §3.5, F4).
        const unpriced = !local && (ev.cost === null || ev.cost === undefined || !Number.isFinite(rawCost)
          || (rawCost === 0 && totalTokens > 0));
        let cost = unpriced || local ? 0 : rawCost;
        if (cost < 0) {
          log.warn(`Case ${turn.caseId}: usage event reported a negative cost (${cost}); clamped to 0.`);
          cost = 0;
        }
        const r = this.budget(turn.caseId).charge('usd', cost, {
          turnId: turn.turnId,
          provider: ev.provider,
          model: ev.model,
          unpricedTokens: unpriced ? totalTokens : 0,
          ...(local ? { localTokens: totalTokens } : {})
        });
        if (r.crossedNow.length) this.onCrossings(turn.caseId, 'usd', r.crossedNow);
      } catch (err) {
        log.warn(`Charging usage to case ${turn.caseId} failed: ${err.message}`);
      }
    };
  }

  // The charged, delivered creation path every stage uses (C5 §3.9).
  createQuestion(id, record, { charge = record?.kind === 'question' } = {}) {
    const meta = this.getCase(id);
    const store = this.questions(meta.id);
    const existing = store.findDuplicate(record);
    if (existing) {
      // Its message may be gone (a resend or an edit truncated the chat past
      // it): post it again, so the question the turn re-asked has a card.
      this._repostIfMissing(meta, existing);
      return existing;
    }
    const budget = charge ? this.budget(meta.id) : null;
    if (budget && budget.atLimit('questionsPerDay')) return { held: true };
    const rec = store.create(record);
    if (budget) {
      const r = budget.charge('questionsPerDay', 1, { questionId: rec.id });
      if (r.crossedNow.length) this.onCrossings(meta.id, 'questionsPerDay', r.crossedNow);
    }
    this._deliver(meta, store, rec);
    return store.get(rec.id) || rec;
  }

  // The chat is the first rung for everyone (management surfaces spec
  // §3.4): each new question is posted once, at creation, to the case's
  // newest chat, whatever the ladder does next. Never throws: a host with no
  // history store (tests, a bare host) or a store failure only logs.
  _postToChat(meta, rec, { onlyIfMissing = false } = {}) {
    const chats = this.host?.chats;
    if (!chats || typeof chats.appendMessageToChat !== 'function') {
      // Once per runtime: every question after the first would say the same.
      if (!this._warnedNoChats) log.warn(`Case ${meta.slug} asks ${rec.id}: this host has no history store, so questions are not posted to a chat.`);
      this._warnedNoChats = true;
      return null;
    }
    try {
      return postQuestionToChat({ chats, meta, rec, now: () => this.now(), onlyIfMissing, asPrivate: this.isPrivate(meta.id) });
    } catch (err) {
      log.warn(`Posting ${rec.id} of case ${meta.slug} to its chat failed: ${err.message}`);
      return null;
    }
  }

  _repostIfMissing(meta, rec) {
    // Without findQuestionMessage there is no telling whether the card is
    // there; posting blindly would repeat it on every duplicate.
    if (typeof this.host?.chats?.findQuestionMessage !== 'function') return null;
    const posted = this._postToChat(meta, rec, { onlyIfMissing: true });
    if (posted) this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId: rec.id, chatId: posted.chatId, message: posted.message });
    return posted;
  }

  // For a question record created outside createQuestion (C4's conflict
  // follow-up): posts it and tells the window, as createQuestion does.
  postQuestion(id, rec) {
    const meta = this.getCase(id);
    const posted = this._postToChat(meta, rec);
    if (posted) this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId: rec.id, chatId: posted.chatId, message: posted.message });
    return posted;
  }

  _deliver(meta, store, rec) {
    const attention = rec.urgency === 'low' ? 'panel' : 'banner';
    const posted = this._postToChat(meta, rec);
    this._notify('case:changed', {
      caseId: meta.id, what: 'questions', questionId: rec.id, attention,
      ...(posted ? { chatId: posted.chatId, message: posted.message } : {})
    });
    if (rec.urgency === 'high' && typeof this.host?.uiToast?.send === 'function') {
      Promise.resolve()
        .then(() => this.host.uiToast.send({ title: meta.title, body: rec.text }))
        .catch((err) => log.warn(`Toast for ${rec.id} failed: ${err.message}`));
    }
    let interactive = false;
    try {
      interactive = typeof this.host?.interactive === 'function' && this.host.interactive() === true;
    } catch {
      interactive = false;
    }
    if (interactive) {
      store.recordDelivery(rec.id, { channel: 'in-app', at: this.now().toISOString(), deliveryId: `in-app-${rec.id}` });
    } else {
      log.warn(`Case ${meta.slug} asks ${rec.id} (${rec.urgency}): ${rec.text}. No channel can deliver it until stage 4; it waits.`);
    }
  }

  // ---- Playbooks (cases stage 6, program §4.11). installPlaybooks sets
  // this.playbooks; without it every accessor is empty. ----

  playbookSteps(id) {
    return this.playbooks ? this.playbooks.steps(id) : [];
  }

  playbookBriefRules(id, executorId) {
    return this.playbooks ? this.playbooks.briefRules(id, executorId) : [];
  }

  playbookSources(id, name = null) {
    return this.playbooks ? this.playbooks.sources(id, name) : '';
  }

  playbookChanges(id) {
    return this.playbooks ? this.playbooks.changes(id) : [];
  }

  // Called only by recordReorientation (the Reorient tool) with the running
  // turn: the manager's acknowledge takes no lock and does not commit; the
  // turn holds the lock and endTurn commits. Refused anywhere else. Only the
  // playbook-update keys this turn showed are acknowledged (ruling T12-ack,
  // as C2's I2): a change made mid-turn fires next turn.
  acknowledgePlaybooks(id, turn = null) {
    if (!this.playbooks) return { acknowledged: [], questionIds: [] };
    const meta = this.getCase(id);
    if (!turn || this.turns.get(meta.id) !== turn) {
      throw new Error('acknowledgePlaybooks runs only inside a case turn (the Reorient tool).');
    }
    const shownKeys = (turn.triggers || [])
      .filter((t) => t && t.kind === 'playbook-update' && typeof t.key === 'string')
      .map((t) => t.key);
    return this.playbooks.acknowledge(meta.id, { shownKeys });
  }

  // C6's package format has no safe defaults; C2's Ask reads this.
  playbookSafeDefaults() {
    return [];
  }

  syncGating(id) {
    return this.playbooks ? this.playbooks.syncGating(id) : { created: [], unknowns: [], briefApplied: [] };
  }

  pendingGating(id) {
    return this.playbooks ? this.playbooks.pendingGating(id) : [];
  }

  abortUnattended(reason = 'shutdown') {
    for (const turn of this.turns.values()) {
      if (turn.source === 'wakeup' && typeof turn.abort === 'function') turn.abort(reason);
    }
  }

  // The turn running on a case right now: { turnId, source }, or null.
  runningTurn(caseId) {
    let id;
    try {
      id = this.getCase(caseId).id;
    } catch {
      return null;
    }
    const turn = this.turns.get(id);
    if (turn) return { turnId: turn.turnId, source: turn.source || 'owner' };
    // The owner's check (verifyNow) holds no lock and is no turn, but it is
    // what Stop reaches, so it is reported here. A caller that asks whether
    // the owner can send reads `source`: a check never keeps a message out.
    const job = this.verifying.get(id);
    return job && job.check && !job.done && !job.superseded ? { turnId: job.turnId, source: 'check' } : null;
  }

  // Stop from the case's chat (spec 2026-09-27 §9): aborts the running turn,
  // an owner turn or a wake-up, or the owner's check when no turn runs.
  // False when there is nothing to stop.
  abortTurn(caseId, reason = 'stopped by owner') {
    let id;
    try {
      id = this.getCase(caseId).id;
    } catch {
      return false;
    }
    const turn = this.turns.get(id);
    if (!turn) return this._stopCheck(id, reason);
    if (typeof turn.abort !== 'function') return false;
    turn.abort(reason);
    return true;
  }

  // ---- Owner facts, answers and failure reports (spec §3.4, §3.9) ----

  // Runs after every successful `user` fact. Only host-written sources
  // (question, owner-action) can change a budget limit.
  applyOwnerFact(id, fact, { questionId = null } = {}) {
    if (!fact || fact.provenance !== 'user' || (fact.status && fact.status !== 'active')) return { applied: false };
    const meta = this.getCase(id);
    // A fact sourced from a question can grant or resume only when that
    // question was actually of the matching type — otherwise a plain 'ask'
    // question, whose fact happens to share subject/attr with a budget or
    // direction fact, could be answered into a grant or a resume it never
    // asked for (controller ruling I1 on Task 11 review).
    const sourceQuestion = fact.source?.kind === 'question' ? this.questions(meta.id).get(fact.source.ref) : null;
    if (fact.subject === 'direction' && meta.status === 'needs-direction') {
      if (fact.source?.kind === 'question' && sourceQuestion?.payload?.type !== 'direction') return { applied: false };
      try {
        this.setStatus(meta.id, 'active', { kind: 'direction', ref: fact.id });
        return { applied: 'direction' };
      } catch (err) {
        if (err.code !== 'BUDGET_EXHAUSTED') throw err;
        const category = this.budget(meta.id).exhausted()[0];
        // The direction fact is already applied to the ledger by the time
        // setStatus above throws; only the budget stands in the way, so a
        // grant must resume straight to active. resumeTo: meta.status
        // (still 'needs-direction' here) would strand the case there with
        // the direction already consumed and no question left open (F1).
        this.setStatus(meta.id, 'paused', { kind: 'budget', ref: category, note: err.message, resumeTo: 'active' });
        const qid = questionId || (fact.source?.kind === 'question' ? fact.source.ref : null);
        if (qid) {
          try {
            this.questions(meta.id).note(qid, err.message);
          } catch (e) {
            log.warn(`Could not note the budget refusal on ${qid}: ${e.message}`);
          }
        }
        this.onCrossings(meta.id, category, [100]);
        return { applied: false, error: err.message };
      }
    }
    if (fact.subject === 'budget' && CATEGORIES.includes(fact.attr)) {
      if (!['question', 'owner-action'].includes(fact.source?.kind)) return { applied: false, note: BUDGET_FACT_NOTE };
      if (fact.source?.kind === 'question' && sourceQuestion?.payload?.type !== 'budget-grant') return { applied: false };
      // Validate against the budget's CURRENT numbers, never numbers a
      // question captured when it was asked — those can be stale by the
      // time the owner answers (controller ruling I3 on Task 11 review).
      const before = this.budget(meta.id).status()[fact.attr] || {};
      let value = null;
      if (fact.attr === 'deadline') {
        const today = localDay(this.now(), this.settings().timeZone);
        if (
          typeof fact.value === 'string' && isRealCalendarDate(fact.value)
          && (!before.at || fact.value > before.at)
          && fact.value >= today
        ) {
          value = fact.value;
        }
      } else {
        const n = Number(fact.value);
        const spent = Number(before.spent) || 0;
        value = Number.isFinite(n) && n > spent ? n : null;
      }
      if (value === null) {
        const hint = fact.attr === 'deadline'
          ? 'a real calendar date, later than the current deadline and not in the past'
          : 'a number above the current spend';
        const note = `A ${fact.attr} limit must be ${hint}.`;
        // A question-sourced reply that named a number but not one that
        // clears the budget must not be swallowed: note it on the question
        // and open a fresh budget-grant question with current numbers, the
        // same as a reply with no usable amount at all (F2) — otherwise the
        // owner is left paused with nothing open to answer.
        const qid = questionId || (fact.source?.kind === 'question' ? fact.source.ref : null);
        if (qid) {
          try {
            this.questions(meta.id).note(qid, note);
          } catch (err) {
            log.warn(`Could not note the rejected ${fact.attr} grant on ${qid}: ${err.message}`);
          }
          this._askBudgetGrant(meta, fact.attr);
        }
        return { applied: false, note };
      }
      const current = meta.budget && typeof meta.budget === 'object' ? meta.budget : {};
      this.store.updateMeta(meta.id, { budget: { ...current, [fact.attr]: value } });
      const budget = this.budget(meta.id);
      budget.recordGrant(fact.attr, fact.id);
      for (const [category, crossed] of Object.entries(budget.reconcile())) this.onCrossings(meta.id, category, crossed);
      if (fact.attr === 'deadline') this.wakeups(meta.id).ensure('deadline-check', { every: 86400000, payload: { key: 'deadline' } });
      // A grant supersedes every other open budget-grant question for this
      // category: a stale one must not still be answerable.
      this._closeSupersededBudgetQuestions(meta.id, fact.attr);
      this._notify('case:changed', { caseId: meta.id, what: 'budget' });
      const after = this.getCase(meta.id);
      let resumed = false;
      if (after.status === 'paused' && after.statusReason?.kind === 'budget' && !budget.exhausted().length) {
        const resumeTo = after.statusReason.resumeTo === 'needs-direction' ? 'needs-direction' : 'active';
        this.setStatus(meta.id, resumeTo, { kind: 'budget-grant', ref: fact.id });
        resumed = true;
      }
      // Defensive: if the category is still exhausted after applying the
      // grant, the stale question was just closed above, so ask again with
      // current numbers rather than leaving the owner with nothing open.
      if (budget.exhausted().includes(fact.attr)) this._askBudgetGrant(this.getCase(meta.id), fact.attr);
      return { applied: 'budget', resumed };
    }
    return { applied: false };
  }

  // Every host path that answers a question comes through here (program §4.3).
  // `quote`: the owner's verbatim words (management surfaces spec §3.2),
  // kept on the answer and its fact's source.
  async answerQuestion(caseId, questionId, { channel = 'in-app', text = null, optionId = null, quote = null } = {}) {
    return this.systemAction(caseId, `answer ${questionId}`, async (meta) => {
      const store = this.questions(meta.id);
      const question = store.answer(questionId, { channel, text, optionId, quote });
      const fact = question.answer?.factId ? new FactLedger(meta.dir).view().facts.get(question.answer.factId) || null : null;
      const handler = QuestionStore.answerHandler(question.payload?.type);
      let effect = null;
      if (handler?.onAnswered) effect = await handler.onAnswered(question, fact, { runtime: this, caseId: meta.id });
      else if (fact) effect = this.applyOwnerFact(meta.id, fact, { questionId });
      if (question.kind !== 'briefing') {
        this.wakeups(meta.id).ensure('retry', {
          at: this.now().toISOString(),
          payload: { key: `answered:${questionId}`, questionId }
        });
      }
      this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId });
      this._reindex(meta.id);
      return { question: store.get(questionId) || question, fact, effect };
    });
  }

  async acknowledgeBriefing(caseId, questionId, { channel = 'in-app', quote = null } = {}) {
    return this.systemAction(caseId, `acknowledge ${questionId}`, async (meta) => {
      const question = this.questions(meta.id).acknowledge(questionId, { channel, quote });
      this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId });
      return question;
    });
  }

  // What the Fail tool records (spec §3.4): the report, the one allowed
  // recommendation, needs-direction, and a high direction question.
  recordFailure(id, { failureClass, what, tried = [], why, unknowns = [], recommendation = null, turnId = null }) {
    const meta = this.getCase(id);
    // Check the transition before writing anything: a refused transition
    // (e.g. the case isn't `active`) must leave no partial journal,
    // recommendation or load-bearing marks (Task 11 review, minor fix).
    if (!canTransition(meta.status, 'needs-direction', 'runtime', 'failure')) {
      throw new StatusError('BAD_TRANSITION', `A case cannot go from ${meta.status} to needs-direction (runtime, failure).`);
    }
    const { facts } = new FactLedger(meta.dir).view();
    const claims = Array.isArray(recommendation?.claims) ? recommendation.claims : [];
    const body = [
      `# Failure report — ${oneLine(what, 120)}`,
      '',
      `Class: ${failureClass}`,
      '',
      'Tried:',
      ...tried.map((t) => `- ${oneLine(t, 300)}`),
      '',
      `Why: ${oneLine(why, 500)}`,
      '',
      'Unknowns:',
      ...(unknowns.length ? unknowns.map((fid) => `- ${fid}${facts.get(fid) ? ` ${oneLine(facts.get(fid).stmt, 300)}` : ''}`) : ['- none']),
      '',
      'Recommendation:',
      ...(claims.length ? claims.map((c) => `- ${oneLine(c.text, 300)}${c.factIds?.length ? ` [${oneLine(c.factIds.join(', '), 300)}]` : ''}`) : ['none']),
      '',
      "Waiting for the owner's direction."
    ].join('\n');
    const records = new CaseRecords(meta.dir);
    const journal = records.writeJournal('failure', body, this.now());
    if (claims.length) {
      new FactLedger(meta.dir).markLoadBearing([...new Set(claims.flatMap((c) => c.factIds || []))]);
      records.recordRecommendation({ turnId, claims, unknowns, failure: journal });
    }
    this.setStatus(meta.id, 'needs-direction', { kind: 'failure', ref: journal, failureClass });
    const question = this.createQuestion(meta.id, {
      kind: 'question',
      urgency: 'high',
      text: `${meta.title}: "${oneLine(what, 200)}" did not work (${journal}). How should the case proceed?`,
      payload: {
        type: 'direction',
        failure: journal,
        about: { subject: 'direction', attr: path.basename(journal, '.md') },
        mcpAnswerable: false
      }
    }, { charge: false });
    return { journal, rendered: body, questionId: question.id };
  }

  // Every grant path (the Grant button today, others later) goes through
  // this before a fact is ever written: a refused grant must leave no
  // permanent trace in the append-only ledger (F3). The IPC handler's own
  // checks only cover the shape of the payload (a number, a YYYY-MM-DD
  // string); this is the one place that knows the case's current numbers.
  _validateGrant(meta, category, limit) {
    if (!CATEGORIES.includes(category)) {
      throw new StatusError('BAD_GRANT', `Unknown budget category "${category}". Categories: ${CATEGORIES.join(', ')}.`);
    }
    const entry = this.budget(meta.id).status()[category] || {};
    if (category === 'deadline') {
      if (typeof limit !== 'string' || !isRealCalendarDate(limit)) {
        throw new StatusError('BAD_GRANT', 'A deadline must be a real calendar date (YYYY-MM-DD).');
      }
      const today = localDay(this.now(), this.settings().timeZone);
      if (limit < today) {
        throw new StatusError('BAD_GRANT', 'A deadline cannot be in the past.');
      }
      if (entry.at && limit <= entry.at) {
        throw new StatusError('BAD_GRANT', `A deadline must be later than the current deadline (${entry.at}).`);
      }
      return;
    }
    const n = Number(limit);
    if (!Number.isFinite(n)) {
      throw new StatusError('BAD_GRANT', `A ${category} limit must be a number.`);
    }
    if (PER_DAY.includes(category)) {
      if (!Number.isInteger(n)) {
        throw new StatusError('BAD_GRANT', `A ${category} limit must be a whole number.`);
      }
      const used = Number(entry.spent) || 0;
      if (n <= used) {
        throw new StatusError('BAD_GRANT', `A ${category} limit must be above today's use (${used}).`);
      }
      return;
    }
    const spent = Number(entry.spent) || 0;
    if (n <= spent) {
      throw new StatusError('BAD_GRANT', `A ${category} limit must be above what the case has spent (${spent}).`);
    }
  }

  // The Grant button (IPC case:grantBudget). Validated by _validateGrant
  // before anything is written (F3).
  async grantBudget(id, category, limit, { channel = 'in-app' } = {}) {
    this._validateGrant(this.getCase(id), category, limit);
    return this.systemAction(id, `grant ${category}`, async (meta) => {
      const at = this.now().toISOString();
      const fact = new FactLedger(meta.dir).assert({
        stmt: `Owner set the ${category} budget to ${limit} from the case panel.`,
        subject: 'budget',
        attr: category,
        value: limit,
        provenance: 'user',
        source: { kind: 'owner-action', ref: 'grant-budget', channel, at },
        addedBy: 'owner-action'
      });
      const effect = this.applyOwnerFact(meta.id, fact);
      return { fact, effect, case: this.getCase(meta.id) };
    });
  }

  // create_case (management surfaces spec §3.1-3.2): the objective the owner
  // gave in their own words, recorded as theirs (provenance user, an
  // owner-action source with the channel and the quote). brief.md holds the
  // objective the way the app's create writes it; this fact is what says
  // the owner said it. Private at birth (the owner can make it disclosable).
  async recordOwnerObjective(id, { objective, quote, channel }) {
    return this.systemAction(id, 'owner objective', async (meta) => new FactLedger(meta.dir).assert({
      stmt: `The owner's objective for this case: ${objective}`,
      subject: 'brief',
      attr: 'objective',
      value: objective,
      disclosable: false,
      provenance: 'user',
      source: { kind: 'owner-action', ref: 'create-case', channel, at: this.now().toISOString(), quote },
      addedBy: 'owner-action'
    }));
  }

  // ---- The private mark (local inference spec 2026-10-13 §8.1, §8.2) ----

  // Whether a case is private: `private: true` in case.yaml. A missing key
  // is not, unless any chat of the case carries the history store's private
  // mark (the host's caseChatsPrivate; review fix, item 8: a Bash edit or a
  // git restore can take the key out of case.yaml, never a chat's mark);
  // any other value, and a case that cannot be read, is (fail closed), with
  // one warning per case that names no value from the file.
  isPrivate(id) {
    let meta;
    try {
      meta = this.getCase(id);
    } catch {
      return true;
    }
    if (!Object.prototype.hasOwnProperty.call(meta, 'private')) return this._chatsMarkedPrivate(meta.id);
    if (meta.private === true) return true;
    if (!this._privateWarned) this._privateWarned = new Set();
    if (!this._privateWarned.has(meta.id)) {
      this._privateWarned.add(meta.id);
      log.warn(`Case ${meta.slug}: case.yaml's private is not true or false as written by King Louie; the case is treated as private.`);
    }
    return true;
  }

  // Whether any chat of the case carries the private mark. A host that
  // cannot say (it throws) says yes; a host with no history store (tests, a
  // bare host) has no chat to ask.
  _chatsMarkedPrivate(id) {
    const ask = this.host?.caseChatsPrivate;
    if (typeof ask !== 'function') return false;
    try {
      return ask(id) !== false;
    } catch {
      return true;
    }
  }

  // The owner's mark (Task 14 adds the press; no tool calls this): sets
  // `private: true` through a system action, committed, and marks every
  // chat of the case in the history store (R-LI-23: one mark, on the case).
  // There is no inverse. Marking a private case again writes nothing.
  async markPrivate(id) {
    const meta = this.getCase(id);
    if (meta.private !== true) {
      await this.systemAction(meta.id, 'private', async (m) => {
        if (m.private !== true) this.store.updateMeta(m.id, { private: true });
      }, { commitMessage: 'case marked private' });
    }
    this._markCaseChats(meta.id, { throwOnFailure: true });
    return this.getCase(meta.id);
  }

  // Marks the case's chats in the history store when the case is private
  // (the host's markChatsPrivate). Never fails a turn: a failure is logged,
  // and the case's own mark still puts every chat of it under the policy.
  _markCaseChats(id, { throwOnFailure = false } = {}) {
    const mark = this.host?.markChatsPrivate;
    if (typeof mark !== 'function' || !this.isPrivate(id)) return;
    try {
      mark(id);
    } catch (err) {
      if (throwOnFailure) throw err;
      log.warn(`Marking the chats of private case ${id} failed: ${err.message}`);
    }
  }

  // The egress policy of a turn whose models could not be snapshotted: the
  // host's reading of the case's mark, else a private-case policy when the
  // case is private (fail closed). → policy | null.
  _egressOf(turn) {
    if (turn && turn.models) return null;
    try {
      if (typeof this.host?.egressFor === 'function') return this.host.egressFor({ caseId: turn.caseId });
    } catch { /* below */ }
    return this.isPrivate(turn.caseId) ? egressPolicy({ reason: 'private-case', caseId: String(turn.caseId) }) : null;
  }

  // ---- Model roles (spec §3.8; models spec 2026-09-27 §6, §8) ----

  _settingsSafe() {
    try {
      return this.getSettings() || {};
    } catch (err) {
      log.warn(`Reading settings for the model roles failed: ${err.message}`);
      return {};
    }
  }

  // The models for a case (models spec §6.3): the host's snapshot when it
  // has one (the core: case.yaml's profile and main override, else the
  // chat's, else the default), else one built from settings here, usable
  // when the host says the provider has a token.
  modelsFor(id, { chatId = null } = {}) {
    if (typeof this.host?.snapshotModels === 'function') return this.host.snapshotModels({ caseId: id, chatId });
    const meta = this.getCase(id);
    const hasToken = this.host?.hasProviderToken;
    const explain = (provider) => {
      if (typeof hasToken !== 'function') return { usable: true, reasons: [], notes: [] };
      let ok = false;
      try {
        ok = Boolean(hasToken(provider));
      } catch {
        ok = false;
      }
      return ok ? { usable: true, reasons: [], notes: [] } : { usable: false, reasons: [`No token saved for ${provider}.`], notes: [] };
    };
    return snapshotFromSettings(this._settingsSafe(), { profileId: meta.profile || null, mainOverride: meta.mainOverride || null, explain });
  }

  _turnModels(id, chatId) {
    try {
      return this.modelsFor(id, { chatId });
    } catch (err) {
      log.warn(`Building the models for a turn of case ${id} failed: ${err.message}`);
      return null;
    }
  }

  roleModel(id, role, { turn = null, needs = {} } = {}) {
    const meta = this.getCase(id);
    const turnModels = (turn && turn.models) || this.modelsFor(id);
    return resolveCaseRole(role, { settings: { ...this._settingsSafe(), cases: this.settings() }, caseMeta: meta, turnModels, needs });
  }

  // Before a case role's call (models spec §5.2), as the core's resolveRole
  // does: every provider the role could use that was never tested is tested
  // now, and a non-auth failure older than 60 s is retested once
  // (availability.refreshForUse, which shares a test already in flight).
  // Without it one failed start test would block unattended turns until a
  // restart. Never throws: the resolve that follows reports what is unusable.
  async ensureRoleTested(id, role, { turn = null } = {}) {
    const ensure = this.host?.ensureTargetsTested;
    if (typeof ensure !== 'function') return;
    try {
      const meta = this.getCase(id);
      const turnModels = (turn && turn.models) || this.modelsFor(id);
      const settings = { ...this._settingsSafe(), cases: this.settings() };
      // verify also leans on judge's resolution (roles.js).
      const targets = (role === 'verify' ? ['judge', 'verify'] : [role]).flatMap((r) => {
        const spec = caseRoleSpec(r, { settings, caseMeta: meta });
        return spec.explicit ? [spec.explicit] : turnModels.candidatesFor(spec.modelRole);
      });
      await ensure(targets);
    } catch (err) {
      log.warn(`Testing the providers of case role ${role} for case ${id} failed: ${err.message}`);
    }
  }

  // Before case ingest reads a page on the vision role (models spec §8): the
  // role's providers are tested now if they never were, or retested once
  // after a stale non-auth failure, as ensureRoleTested does for the case
  // roles (M2 final-fix ruling). Never throws: the pick reports what is
  // still unusable.
  async ensureVisionTested(id) {
    const ensure = this.host?.ensureTargetsTested;
    if (typeof ensure !== 'function') return;
    try {
      await ensure(this.modelsFor(id).candidatesFor('vision'));
    } catch (err) {
      log.warn(`Testing the vision providers for case ${id} failed: ${err.message}`);
    }
  }

  // The profile's vision role for case ingest OCR (models spec §8): every
  // usable target in order, and every skipped one with its reason — so a
  // profile with only text-only models can say why, not just that nothing
  // was found (fix round 1).
  visionTarget(id) {
    try {
      const r = this.modelsFor(id).resolve('vision');
      return { targets: r.targets.map((x) => ({ provider: x.provider, model: x.model, effort: x.effort || null })), skipped: r.skipped };
    } catch (err) {
      log.warn(`Resolving the vision role for case ${id} failed: ${err.message}`);
      return { targets: [], skipped: [] };
    }
  }

  // The header's profile picker and main switcher write here (models spec
  // §6.5): only these two keys, under the case lock, committed.
  async setModelChoice(id, patch = {}) {
    const choice = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'profile')) choice.profile = patch.profile || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'mainOverride')) choice.mainOverride = patch.mainOverride || null;
    if (!Object.keys(choice).length) throw new Error('setModelChoice needs profile or mainOverride.');
    return this.systemAction(id, 'model choice', async (meta) => {
      this.store.updateMeta(meta.id, choice);
      return this.getCase(meta.id);
    });
  }

  // A provider-shaped object whose every call goes through the router's
  // routeTargets over a resolved list (a case role's, or the owner turn's
  // main targets), so case calls fail over like any other (models spec
  // §6.7). One route state per object. Charging happens in the caller's
  // onUsageRecorded hook (usageHook(turn)).
  routedProvider(turn, spec = {}) {
    const router = this.host?.inferenceRouter;
    if (!router || typeof router.routeTargets !== 'function') {
      throw new Error('Routed providers need a host with an inference router.');
    }
    // Cost records (models spec §10): a case role's calls carry its model
    // role and case role; the owner turn's main list carries main.
    let targets;
    let tags = null;
    if (Array.isArray(spec.targets) && spec.targets.length) {
      targets = spec.targets;
      tags = { role: 'main', borrowedFrom: null, ...(spec.meta && typeof spec.meta === 'object' ? spec.meta : {}) };
    } else if (spec.target && spec.target.provider) {
      targets = [spec.target];
    } else if (spec.role) {
      const pick = this.roleModel(turn.caseId, spec.role, { turn });
      targets = pick.targets;
      tags = { role: pick.modelRole, caseRole: spec.role, borrowedFrom: pick.borrowedFrom || null };
    } else {
      throw new Error('A routed provider needs a role or targets.');
    }
    if (tags) tags.profileId = turn.models?.profileId || null;
    const list = targets.map((x) => {
      const provider = String(x.provider).toLowerCase();
      const kept = { provider, model: String(x.model || ''), effort: x.effort || null };
      // A local target's adapter goes with it, as in the router's own
      // routedProvider (local inference spec 2026-10-13 §12.2).
      if (provider === 'local' && typeof x.adapter === 'string' && x.adapter) kept.adapter = x.adapter;
      return kept;
    });
    // The egress policy of this call's model role (local inference spec
    // 2026-10-13 §7.2): the turn's (a private case's, or a local-only
    // role's), on the route state, so the router refuses a hosted target
    // whatever list it is handed. A turn with no snapshot reads the mark.
    const modelRole = (tags && tags.role) || 'main';
    const models = turn.models || null;
    const egress = models
      ? ((typeof models.egressFor === 'function' ? models.egressFor(modelRole) : models.egress) ?? null)
      : this._egressOf(turn);
    const state = typeof router.newRouteState === 'function' ? router.newRouteState(tags, egress) : undefined;
    const call = (messages, opts = {}, tools = null, onChunk = null) => router.routeTargets(list, messages, {
      ...(opts || {}),
      ...(Array.isArray(tools) ? { tools } : {}),
      ...(typeof onChunk === 'function' ? { onChunk } : {}),
      ...(!opts?.abortSignal && turn.signal ? { abortSignal: turn.signal } : {})
    }, state);
    const current = () => ({ ...list[Math.min(state?.index || 0, list.length - 1)] });
    return {
      getProviderName: () => current().provider,
      getDefaultModel: () => current().model,
      current,
      callTags: () => (typeof router.callTags === 'function' ? router.callTags(state) : {}),
      sendMessage: (messages, opts) => call(messages, opts),
      streamMessage: (messages, opts, onChunk) => call(messages, opts, null, onChunk),
      sendMessageWithTools: (messages, tools, opts) => call(messages, opts, tools),
      streamMessageWithTools: (messages, tools, opts, onChunk) => call(messages, opts, tools, onChunk)
    };
  }

  // ---- Wake-ups (spec §3.6); required lazily, turn-runner needs this module's exports ----

  sweep(id, now = this.now()) {
    return require('./turn-runner').sweepCase(this, id, now);
  }

  runDueWakeups(now = this.now()) {
    return require('./turn-runner').runDueWakeups(this, now);
  }
}

module.exports = {
  CaseRuntime, CaseBusyError, WakeupBusyError, CaseNotFoundError, RuntimeClosingError, SimilarCaseError, VerifyRefusedError, resolveCasesRoot,
  BUDGET_FACT_NOTE, RELATIONS
};

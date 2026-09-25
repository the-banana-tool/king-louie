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
const { Brief } = require('./brief');
const { CaseRecords } = require('./records');
const { buildOrientation, DEFAULT_MAX_CHARS } = require('./orientation');
const { canTransition, check: checkStatus, StatusError, AUTONOMY_KEY, REASON_KINDS } = require('./status');
const { Budget, CATEGORIES, PER_DAY } = require('./budget');
const { WakeupStore } = require('./wakeups');
const { QuestionStore } = require('./questions');
const { detectTriggers, emptyBaseline } = require('./triggers');
const { localDay, isRealCalendarDate } = require('./clock');
const { readJson, writeJsonIfChanged } = require('./jsonfile');
const { resolveCaseSettings } = require('./defaults');
const { resolveRole } = require('./roles');
// Registers the direction and budget-grant answer handlers.
require('./answer-handlers');
const { createLogger } = require('../logging');

const log = createLogger('cases/runtime');

const BUDGET_FACT_NOTE = "Budget limits change only through the owner's answer or the Grant button.";

class CaseBusyError extends Error {
  constructor(title, { pid, lockPath } = {}) {
    const holder = pid ? ` in process ${pid}` : '';
    const recover = lockPath
      ? ` If that process is stuck or is not King Louie, quit it or delete ${lockPath}.`
      : '';
    super(`Case "${title}" is busy with another turn${holder}. Try again when it finishes.${recover}`);
    this.name = 'CaseBusyError';
    this.code = 'CASE_BUSY';
  }
}

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
const STOPS_WORK = new Set(['paused', 'done', 'abandoned']);

class CaseRuntime {
  constructor({
    root, staleLockMs = 30 * 60 * 1000, orientationMaxChars = DEFAULT_MAX_CHARS, getSettings = null, now = null, host = null
  } = {}) {
    this.store = new CaseStore({ root });
    this.staleLockMs = staleLockMs;
    this.orientationMaxChars = orientationMaxChars;
    // turnId -> { dir, timer }: the locks this runtime holds right now.
    this.held = new Map();
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this._clock = typeof now === 'function' ? now : () => new Date();
    // Host services, all optional (spec §3.10): inferenceRouter,
    // resolveInference, createToolExecutor, toolRegistry, AgentLoop,
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
  }

  // Called once shutdown begins (create-core, right after the scheduler
  // stops): refuses every wake-up turn from here on, so a turn straddling
  // the shutdown never runs, writes or commits without a lock this process
  // still recognizes as held.
  beginShutdown() {
    this.closing = true;
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

  // The wake-up sweep lists cases; a case still being created has no first commit yet,
  // so a sweep that commits it would make `create` fail with "nothing to commit".
  // `runDueWakeups` skips the whole tick while any creation is in flight.
  async createCase(opts) {
    this.creating = (this.creating || 0) + 1;
    try {
      return await this.store.create(opts);
    } finally {
      this.creating -= 1;
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

  brief(id) { return new Brief(this.getCase(id).dir); }

  records(id) { return new CaseRecords(this.getCase(id).dir); }

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
    return new QuestionStore(meta.dir, { now: () => this.now(), caseId: meta.id });
  }

  orientation(id, { triggers = [], hookNotes = [] } = {}) {
    const meta = this.getCase(id);
    const { facts, errors } = new FactLedger(meta.dir).view();
    let brief;
    try {
      brief = { data: new Brief(meta.dir).read().data };
    } catch (err) {
      brief = { error: err.message };
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
    return buildOrientation({
      meta,
      brief,
      facts,
      decisions: records.decisions(),
      lastJournal: records.lastJournal(),
      ledgerErrors: errors,
      maxChars: this.orientationMaxChars,
      triggers,
      hookNotes,
      statusReason: meta.statusReason || null,
      failure: this._failureReport(meta),
      questions,
      budget,
      nextWakeup,
      now: this.now()
    });
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

  otherCaseFacts(id) {
    const self = this.getCase(id);
    return this.listCases()
      .filter((c) => c.id !== self.id)
      .map((c) => ({ caseId: c.id, title: c.title, facts: new FactLedger(c.dir).view().facts }));
  }

  completeGating(id) {
    const meta = this.getCase(id);
    new Brief(meta.dir).completeGating();
    if (meta.status === 'draft') this.setStatus(meta.id, 'active', { kind: 'gating' });
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
    const updated = this.store.updateMeta(meta.id, { status, statusReason });
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
        throw new CaseBusyError(meta.title, { pid: holder?.pid, lockPath: lock });
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
    turn.orientation = this.orientation(turn.caseId, { triggers: turn.triggers, hookNotes: turn.hookNotes });
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
        this.acknowledgePlaybooks(meta.id);
      } catch (err) {
        log.warn(`acknowledgePlaybooks failed for ${meta.slug}: ${err.message}`);
      }
    }
    turn.reorientPending = false;
    return journal;
  }

  // ---- Turns (spec §3.10) ----

  async beginTurn(id, { turnId, source = 'owner', ownerMessage = null } = {}) {
    // Shutting down: refuse before even taking the lock.
    if (source === 'wakeup' && this.closing) throw new RuntimeClosingError();
    const meta = this.getCase(id);
    this._acquire(meta, turnId);
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
      this.turns.set(fresh.id, turn);
      return turn;
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

  async endTurn(turn, { summary = '', journal = null, journalKind = 'turn' } = {}) {
    try {
      const records = new CaseRecords(turn.dir);
      records.renderOpenItems(new FactLedger(turn.dir).view().facts);
      if (journal && String(journal).trim()) records.writeJournal(journalKind, journal, this.now());
      this._closeTurnMeta(turn);
      return await this._commit(turn.dir, `${turn.turnId}: ${oneLine(summary) || 'turn'}`, turn.caseId);
    } finally {
      if (this.turns.get(turn.caseId) === turn) this.turns.delete(turn.caseId);
      this._release(turn.dir, turn.turnId);
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
        // Real providers report costUsd: 0 for a model with no price table
        // (base-provider.js), not cost: null — both must count as unpriced.
        // A non-finite cost (NaN, Infinity) is unusable data, treated the
        // same way rather than charged or silently dropped (spec §3.5, F4).
        const unpriced = ev.cost === null || ev.cost === undefined || !Number.isFinite(rawCost)
          || (rawCost === 0 && totalTokens > 0);
        let cost = unpriced ? 0 : rawCost;
        if (cost < 0) {
          log.warn(`Case ${turn.caseId}: usage event reported a negative cost (${cost}); clamped to 0.`);
          cost = 0;
        }
        const r = this.budget(turn.caseId).charge('usd', cost, {
          turnId: turn.turnId,
          provider: ev.provider,
          model: ev.model,
          unpricedTokens: unpriced ? totalTokens : 0
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
    if (existing) return existing;
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

  _deliver(meta, store, rec) {
    const attention = rec.urgency === 'low' ? 'panel' : 'banner';
    this._notify('case:changed', { caseId: meta.id, what: 'questions', questionId: rec.id, attention });
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

  abortUnattended(reason = 'shutdown') {
    for (const turn of this.turns.values()) {
      if (turn.source === 'wakeup' && typeof turn.abort === 'function') turn.abort(reason);
    }
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
  async answerQuestion(caseId, questionId, { channel = 'in-app', text = null, optionId = null } = {}) {
    return this.systemAction(caseId, `answer ${questionId}`, async (meta) => {
      const store = this.questions(meta.id);
      const question = store.answer(questionId, { channel, text, optionId });
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
      return { question: store.get(questionId) || question, fact, effect };
    });
  }

  async acknowledgeBriefing(caseId, questionId, { channel = 'in-app' } = {}) {
    return this.systemAction(caseId, `acknowledge ${questionId}`, async (meta) => {
      const question = this.questions(meta.id).acknowledge(questionId, { channel });
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

  // ---- Model roles (spec §3.8) ----

  roleModel(id, role) {
    const meta = this.getCase(id);
    let settings = {};
    try {
      settings = this.getSettings() || {};
    } catch (err) {
      log.warn(`Reading settings for role ${role} failed: ${err.message}`);
    }
    const hasToken = (provider) => {
      if (typeof this.host?.hasProviderToken !== 'function') return true;
      try {
        return Boolean(this.host.hasProviderToken(provider));
      } catch {
        return false;
      }
    };
    return resolveRole(role, { settings: { ...settings, cases: this.settings() }, caseMeta: meta, hasToken });
  }

  // A provider-shaped object whose every call goes through
  // routeWithFallback with an explicit target, so case calls fail over and
  // are charged like any other (spec §3.8).
  routedProvider(turn, spec = {}) {
    const router = this.host?.inferenceRouter;
    if (!router || typeof router.routeWithFallback !== 'function') {
      throw new Error('Routed providers need a host with an inference router.');
    }
    const resolved = spec.role
      ? this.roleModel(turn.caseId, spec.role)
      : { provider: spec.target?.provider, model: spec.target?.model || '', tier: spec.tier || 'standard' };
    if (!resolved.provider) throw new Error('A routed provider needs a role or a target provider.');
    const tier = resolved.tier || 'standard';
    const target = { provider: String(resolved.provider).toLowerCase(), model: resolved.model || '' };
    let refreshed = null;
    // Once per provider object: resolveInference refreshes an OAuth token.
    const refresh = () => {
      if (!refreshed) {
        refreshed = Promise.resolve()
          .then(() => (typeof this.host.resolveInference === 'function'
            ? this.host.resolveInference({ provider: target.provider, model: target.model || undefined, tier })
            : null))
          .catch((err) => log.warn(`Refreshing ${target.provider} before a case call failed: ${err.message}`));
      }
      return refreshed;
    };
    const call = async (messages, opts = {}, tools = null, onChunk = null) => {
      await refresh();
      return router.routeWithFallback(tier, messages, {
        ...(opts || {}),
        ...(Array.isArray(tools) ? { tools } : {}),
        ...(typeof onChunk === 'function' ? { onChunk } : {}),
        ...(!opts?.abortSignal && turn.signal ? { abortSignal: turn.signal } : {}),
        target
      });
    };
    return {
      getProviderName: () => target.provider,
      getDefaultModel: () => target.model,
      sendMessage: (messages, opts) => call(messages, opts),
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

module.exports = { CaseRuntime, CaseBusyError, CaseNotFoundError, RuntimeClosingError, resolveCasesRoot, BUDGET_FACT_NOTE };

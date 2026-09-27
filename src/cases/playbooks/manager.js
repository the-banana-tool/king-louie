// src/cases/playbooks/manager.js
// PlaybookManager (cases stage 6 spec §3.5): the one object the runtime, the
// Playbook tool and IPC call. Network and temp-dir work happen first with no
// lock; every case write then goes through runtime.systemAction (R37) and is
// synchronous inside it. Playbooks are data: nothing here requires a path
// derived from a case or a package.
//
// Owner-only operations. attach, adopt, applyBudgetRaises, remove,
// checkUpdates, update, applyProposal and rejectProposal are the owner's
// (IPC, the case panel); the model's Playbook tool reaches only the reads
// and propose. Nothing here applies a proposal on its own.
//
// Recorded sources (ruling T5-recorded). .kl/playbooks.json is case data: it
// can arrive with an imported case or be rewritten through Bash. A local
// folder recorded there is read on update only when a path: allowlist entry
// covers it or the owner re-confirms it (confirmSource === true); its path
// is checked for links without following any.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureGitattributes } = require('../git');
const { createLogger } = require('../../logging');
const {
  NAME_RE, compareVersions, majorOf, parsePlaybookYaml, validatePackage, formatErrors,
  hashPackage, fileHashes, sha256, normalizeText
} = require('./format');
const { PlaybookLoader } = require('./loader');
const vendor = require('./vendor');
const gating = require('./gating');
const changes = require('./changes');
const proposals = require('./proposals');
const views = require('./views');
const { oneLine, neutralize } = require('./frame');
const { caseTypes: defaultCaseTypes } = require('./case-types-bridge');

const log = createLogger('cases/playbooks');

const MAX_CREATE_PLAYBOOKS = 5;
const MAX_FACT_IDS = 100;
const CLOSED = Object.freeze(['done', 'abandoned']);
const PROPOSAL_ID_RE = /^pp-\d{3,4}$/;
// Fixed turn-start notes (no error text: see turnStartHook).
const GATING_SYNC_FAILED_NOTE = 'Playbook gating could not be synced this turn (details in the log); pending playbook questions may be missing.';
const HOOK_FAILED_NOTE = 'Playbooks could not be read this turn (details in the log); playbook steps, rules and gating may be missing from this orientation.';

class PlaybookError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'PlaybookError';
    this.code = extra.code || 'PLAYBOOK';
    Object.assign(this, extra);
  }
}

function resolvePlaybookSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    sources: Array.isArray(s.sources) ? s.sources.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [],
    autoUpdate: s.autoUpdate === true
  };
}

function snapshotFileHashes(snapshot) {
  const out = {};
  for (const f of snapshot.files) out[f.rel] = sha256(normalizeText(f.data.toString('utf8')));
  return out;
}

// R30, in one place (parked P9): a playbook budget value is a raise when
// the settings default is a positive limit and the value is above it. 0 or
// null is unlimited in C2, so nothing can raise it. A raise is written only
// with the owner's confirm; every other value applies.
function isRaise(value, from) {
  return from !== null && from !== undefined && from !== 0 && value > from;
}

function editedFiles(before, now) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(now || {})]);
  return [...names].filter((n) => (before || {})[n] !== (now || {})[n]).sort();
}

function checkName(name) {
  if (typeof name !== 'string') throw new PlaybookError('A playbook name must be a string.', { code: 'INVALID_NAME' });
  if (!NAME_RE.test(name)) throw new PlaybookError(`"${oneLine(name, 60)}" is not a valid playbook name.`, { code: 'INVALID_NAME' });
  return name;
}

const showProposalId = (id) => (typeof id === 'string' && PROPOSAL_ID_RE.test(id) ? id : '(invalid id)');

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

// Same text rules as vendor.resolveSource: UNC and device paths are refused
// on their text alone (any file system call on one can open an SMB
// connection).
const isUncLike = (p) => typeof p === 'string' && /^[\\/]{2}/.test(p);
const expandHome = (p) => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

// The local folder a recorded source names, or null when the source is an
// example or a URL. A local source that is not an absolute path, or is a
// UNC path, is refused here.
function recordedLocalPath(source) {
  const raw = source.trim();
  if (raw.startsWith('example:')) return null;
  const local = expandHome(raw.startsWith('path:') ? raw.slice('path:'.length) : raw);
  if (!raw.startsWith('path:') && !isUncLike(local) && !path.isAbsolute(local)) return null;
  const refuse = () => new vendor.PlaybookSourceError(
    `Unsupported playbook source "${oneLine(raw, 200)}". Use example:<name>, an absolute folder path, or an https/ssh git URL.`,
    'UNSUPPORTED_SOURCE'
  );
  if (isUncLike(local) || !path.isAbsolute(local)) throw refuse();
  const abs = path.resolve(local);
  if (isUncLike(abs)) throw refuse();
  return abs;
}

// Whether a path: allowlist entry covers `abs` on its text alone: both sides
// normalised absolute paths (path.resolve, no file system call), compared by
// whole segments, case-folded on Windows. A UNC entry covers nothing.
function lexicallyCovered(abs, settings) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(path.resolve(abs));
  return (settings.sources || [])
    .filter((e) => typeof e === 'string' && e.startsWith('path:'))
    .map((e) => expandHome(e.slice('path:'.length).trim()))
    .filter((root) => root && !isUncLike(root) && path.isAbsolute(root))
    .some((root) => {
      const rel = path.relative(fold(path.resolve(root)), target);
      return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
    });
}

// Walks `abs` from its root with lstat only, so no link on the way is ever
// followed (a link can lead to a UNC share). Stops at the first missing
// component; resolveSource then reports the folder as missing.
function assertNoLinks(abs, name) {
  const { root } = path.parse(abs);
  let cur = root;
  for (const seg of abs.slice(root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    const st = lstatOrNull(cur);
    if (!st) return;
    if (st.isSymbolicLink()) {
      throw new PlaybookError(`The recorded source of "${name}" goes through a link (${oneLine(cur, 200)}); King Louie does not follow links in a recorded source. Remove the playbook and add it again from its real folder.`, { code: 'SOURCE_IS_LINK' });
    }
    if (!st.isDirectory()) return;
  }
}

class PlaybookManager {
  constructor({
    runtime, getSettings = () => ({}), examplesDir = null, getExecutorRegistry = () => null,
    now = null, caseTypes = defaultCaseTypes(), fetchTimeoutMs = 60000, tmpRoot = null, adminPolicy = false
  } = {}) {
    if (!runtime) throw new Error('PlaybookManager needs a runtime.');
    this.runtime = runtime;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    // true in service mode, where the allowlist comes from the admin
    // service.json (ruling T14-admin); it only words the refusals.
    this.adminPolicy = adminPolicy === true;
    this._examplesDir = examplesDir || null;
    this.getExecutorRegistry = typeof getExecutorRegistry === 'function' ? getExecutorRegistry : () => null;
    this._now = typeof now === 'function' ? now : null;
    this.caseTypes = caseTypes;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.tmpRoot = tmpRoot || undefined;
    // runtime.systemAction runs inline when this process already holds the
    // case lock, so it does not serialise two calls from this process. Every
    // check-then-write here runs in this per-case chain as well.
    this._chains = new Map();
    // caseId -> { depth, entries }: see beginEntriesScope.
    this._entriesScopes = new Map();
    gating.ensurePlaybookGatingSource(this.caseTypes);
  }

  // One package load per turn start (final review M-6). CaseRuntime.beginTurn
  // opens a scope around its hooks, trigger detection and orientation; there
  // the gating source, pendingGating, orientationSection, changes and every
  // executor's briefRules share one loaded list. Nothing in that window
  // writes playbooks/, the pins or .gitmodules: the case lock is held and no
  // tool runs yet. Outside a scope every call loads fresh from disk. Returns
  // the function that closes the scope.
  beginEntriesScope(caseId) {
    const id = this.runtime.getCase(caseId).id;
    const scope = this._entriesScopes.get(id) || { depth: 0, entries: null };
    scope.depth += 1;
    this._entriesScopes.set(id, scope);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      scope.depth -= 1;
      if (scope.depth <= 0) this._entriesScopes.delete(id);
    };
  }

  now() {
    if (this._now) return this._now();
    return typeof this.runtime.now === 'function' ? this.runtime.now() : new Date();
  }

  settings() {
    let raw = {};
    try {
      raw = this.getSettings()?.playbooks;
    } catch (err) {
      log.warn(`Reading playbook settings failed: ${err.message}`);
    }
    return resolvePlaybookSettings(raw);
  }

  get examplesDir() {
    return this._examplesDir && fs.existsSync(this._examplesDir) ? this._examplesDir : null;
  }

  // Runs fn after every earlier exclusive call on this case has settled.
  async _exclusive(caseId, fn) {
    const key = this.runtime.getCase(caseId).id;
    const prev = this._chains.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const tail = prev.then(() => mine);
    this._chains.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this._chains.get(key) === tail) this._chains.delete(key);
    }
  }

  // One systemAction inside the per-case chain.
  // A mutation drops any turn-start memo of the case's entries, before it
  // runs (its own reads see disk) and after (later reads see its writes):
  // systemAction runs inline while this process holds the case lock, so an
  // owner action can land inside a turn start's scope.
  _action(caseId, label, fn) {
    return this._exclusive(caseId, () => this.runtime.systemAction(caseId, label, async (meta) => {
      this._dropEntriesMemo(meta.id);
      try {
        return await fn(meta);
      } finally {
        this._dropEntriesMemo(meta.id);
      }
    }));
  }

  _dropEntriesMemo(id) {
    const scope = this._entriesScopes.get(id);
    if (scope) scope.entries = null;
  }

  _registry() {
    try {
      return this.getExecutorRegistry() || null;
    } catch {
      return null;
    }
  }

  _knownExecutors() {
    const reg = this._registry();
    if (!reg || typeof reg.ids !== 'function') return null;
    try {
      return reg.ids();
    } catch {
      return null;
    }
  }

  _loader(meta) {
    return new PlaybookLoader(meta.dir, { knownExecutors: this._knownExecutors(), knownCaseTypes: this.caseTypes.knownCaseTypes(), meta });
  }

  _entries(caseId) {
    const meta = this.runtime.getCase(caseId);
    const scope = this._entriesScopes.get(meta.id);
    if (!scope) return this._loader(meta).list();
    if (!scope.entries) scope.entries = this._loader(meta).list();
    return scope.entries;
  }

  _journal(meta, text) {
    return this.runtime.records(meta.id).writeJournal('playbook', text, this.now());
  }

  _assertOpen(meta) {
    if (CLOSED.includes(meta.status)) throw new PlaybookError(`Case is ${meta.status}; its playbooks cannot change.`, { code: 'CASE_CLOSED' });
  }

  // ---- Reading ----

  list(caseId) {
    return this._entries(caseId);
  }

  // Entries without the parsed package, for IPC (the owner's panel). The
  // warnings, errors, reason and source quote package and case text as is.
  summary(caseId) {
    return this._entries(caseId).map((e) => ({
      name: e.name,
      mode: e.mode,
      state: e.state,
      version: e.onDisk?.version ?? e.pinned?.version ?? null,
      pinnedVersion: e.pinned?.version ?? null,
      source: e.pinned?.source ?? null,
      steps: e.package?.steps?.steps?.length ?? 0,
      warnings: e.warnings,
      errors: e.errors.map((x) => formatErrors([x])),
      reason: e.reason,
      submodule: e.submodule
    }));
  }

  gatingQuestions(caseId) {
    return gating.playbookGatingQuestions(this._entries(caseId));
  }

  steps(caseId) {
    return views.stepsOf(this._entries(caseId), { registry: this._registry() });
  }

  briefRules(caseId, executorId) {
    return views.briefRulesOf(this._entries(caseId), executorId);
  }

  sources(caseId, name = null) {
    return views.sourcesOf(this._entries(caseId), name || null);
  }

  read(caseId, { playbook = null, section = 'steps' } = {}) {
    return views.readSection(this._entries(caseId), { playbook, section });
  }

  changes(caseId) {
    const meta = this.runtime.getCase(caseId);
    return changes.computeChanges(this._entries(meta.id), changes.readState(meta.dir).acknowledged);
  }

  orientationSection(caseId) {
    const meta = this.runtime.getCase(caseId);
    const entries = this._entries(meta.id);
    let pending = [];
    if (meta.status === 'draft' || meta.status === 'active') {
      try {
        pending = this.pendingGating(meta.id);
      } catch (err) {
        log.warn(`Pending gating for ${meta.slug} unavailable: ${err.message}`);
      }
    }
    return views.orientationSection({
      entries,
      changes: changes.computeChanges(entries, changes.readState(meta.dir).acknowledged),
      pending,
      status: meta.status
    });
  }

  listExamples() {
    const dir = this.examplesDir;
    if (!dir) return [];
    const out = [];
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'playbook.yaml');
      if (!NAME_RE.test(name) || !fs.existsSync(file)) continue;
      const { value } = parsePlaybookYaml(fs.readFileSync(file, 'utf8'), { dirName: name });
      if (value && typeof value.version === 'string') out.push({ name, version: value.version, title: value.title, caseType: value.caseType });
    }
    return out;
  }

  // ---- Gating ----

  _sync(meta) {
    const state = changes.readState(meta.dir);
    const r = gating.syncGating(this.runtime, meta.id, { gatingQuestionsFor: this.caseTypes.gatingQuestionsFor, appliedAnswers: state.appliedAnswers });
    if (r.appliedAnswers.length !== state.appliedAnswers.length) {
      state.appliedAnswers = r.appliedAnswers;
      changes.writeState(meta.dir, state);
    }
    if (r.notes.length) this._journal(meta, ['Gating answers kept as facts but not written to the brief:', ...r.notes.map((n) => `- ${n}`)].join('\n'));
    for (const w of r.warnings) log.debug(`Case ${meta.slug}: ${w}`);
    return r;
  }

  syncGating(caseId) {
    const meta = this.runtime.getCase(caseId);
    if (CLOSED.includes(meta.status)) return { created: [], unknowns: [], briefApplied: [] };
    const r = this._sync(meta);
    return { created: r.created, unknowns: r.unknowns, briefApplied: r.briefApplied };
  }

  pendingGating(caseId) {
    return gating.pendingGating(this.runtime, caseId, { gatingQuestionsFor: this.caseTypes.gatingQuestionsFor });
  }

  assertGatingComplete(caseId) {
    const pending = this.pendingGating(caseId);
    if (pending.length) throw gating.gatingRefusal(pending);
  }

  // The turn-start hook (program §4.20): sync gating, then the orientation
  // section as the hook's note. A failure is a fixed note, never fatal: an
  // error message can quote package or case text, and these notes sit
  // outside every frame (ruling T10-quotes), so the detail goes to the log.
  async turnStartHook({ caseId }) {
    const meta = this.runtime.getCase(caseId);
    const notes = [];
    if (!CLOSED.includes(meta.status)) {
      try {
        this._sync(meta);
      } catch (err) {
        log.warn(`Playbook gating could not be synced on case ${meta.slug}: ${err.message}`);
        notes.push(GATING_SYNC_FAILED_NOTE);
      }
    }
    try {
      const section = this.orientationSection(meta.id);
      if (section) notes.push(section);
    } catch (err) {
      log.warn(`Playbook orientation section failed on case ${meta.slug}: ${err.message}`);
      notes.push(HOOK_FAILED_NOTE);
    }
    return { notes };
  }

  // ---- Defaults (spec §3.7) ----

  _budgetBase() {
    try {
      return typeof this.runtime.settings === 'function' ? (this.runtime.settings().budgets || {}) : {};
    } catch {
      return {};
    }
  }

  // Existing values win. Budget values above the settings default are only
  // offered (R30) unless the owner accepted raises (=== true). Returns what
  // happened.
  _applyDefaults(caseId, playbook, { acceptBudgetRaises = false, onlyBudgetKeys = null, onlyMateriality = null } = {}) {
    const meta = this.runtime.getCase(caseId);
    const applied = [];
    const skipped = [];
    const budgetRaises = [];

    const brief = this.runtime.brief(meta.id);
    const data = brief.read().data || {};
    const current = data.materiality && typeof data.materiality === 'object' ? data.materiality : {};
    const mat = { tell: [...(current.tell || [])], ignore: [...(current.ignore || [])] };
    let matChanged = false;
    for (const list of ['tell', 'ignore']) {
      for (const raw of playbook.materialityDefaults[list] || []) {
        // format.js only lets slugs through; this second guard keeps any
        // other text one line and tag-free all the same (final review I1).
        const item = oneLine(neutralize(raw), 64);
        if (!item) continue;
        if (onlyMateriality && !onlyMateriality.includes(`${list}:${item}`)) continue;
        if (mat.tell.includes(item) || mat.ignore.includes(item)) {
          skipped.push(`materiality ${item} (already in the brief)`);
          continue;
        }
        mat[list].push(item);
        applied.push(`materiality.${list} ${item}`);
        matChanged = true;
      }
    }
    // The owner's attach is the authority for these defaults (materiality is
    // an owner-only brief field after cases stage 2).
    if (matChanged) brief.update('materiality', { ...current, ...mat }, { provenance: 'user' });

    const base = this._budgetBase();
    const budget = meta.budget && typeof meta.budget === 'object' ? { ...meta.budget } : {};
    let budgetChanged = false;
    for (const [key, value] of Object.entries(playbook.budgetDefaults || {})) {
      if (onlyBudgetKeys && !onlyBudgetKeys.includes(key)) continue;
      if (budget[key] !== undefined && budget[key] !== null) {
        skipped.push(`budget.${key} ${value} (the case already has ${budget[key]})`);
        continue;
      }
      const from = base[key] ?? null;
      const lower = !isRaise(value, from);
      if (lower || acceptBudgetRaises === true) {
        budget[key] = value;
        budgetChanged = true;
        applied.push(`budget.${key} ${value}${lower ? '' : ` (raise from ${from}, accepted by the owner)`}`);
      } else {
        budgetRaises.push({ key, from, to: value });
        skipped.push(`budget.${key} ${value} (offered as a raise from ${from})`);
      }
    }
    if (budgetChanged) this.runtime.store.updateMeta(meta.id, { budget });
    return { applied, skipped, budgetRaises };
  }

  // ---- Attaching ----

  // Fetch and validate a resolved source; nothing is written and the temp
  // dir is gone when this returns.
  async _prepareResolved(resolved, ref) {
    const fetched = await vendor.fetchPackage(resolved, { ref, timeoutMs: this.fetchTimeoutMs, tmpRoot: this.tmpRoot });
    try {
      const validation = validatePackage(fetched.pkgDir, { dirName: null, knownCaseTypes: this.caseTypes.knownCaseTypes() });
      if (!validation.ok) {
        throw new PlaybookError(`The playbook at ${resolved.source} is invalid:\n${formatErrors(validation.errors)}`, { code: 'INVALID_PACKAGE', errors: validation.errors });
      }
      const snapshot = vendor.readSnapshot(fetched.pkgDir);
      return {
        source: resolved.source,
        kind: resolved.kind,
        ref: ref || null,
        commit: fetched.commit,
        playbook: validation.playbook,
        warnings: validation.warnings.map((w) => w.message),
        snapshot,
        contentHash: vendor.snapshotHash(snapshot),
        files: snapshotFileHashes(snapshot)
      };
    } finally {
      fetched.cleanup();
    }
  }

  // A source the owner typed (attach, case:create): resolved, allow-checked,
  // fetched and validated.
  async prepare(source, { ref = null } = {}) {
    const resolved = vendor.resolveSource(source, { examplesDir: this.examplesDir, settings: this.settings(), adminPolicy: this.adminPolicy });
    return this._prepareResolved(resolved, ref);
  }

  // A source read back from .kl/playbooks.json (case data, ruling
  // T5-recorded). A local folder needs a matching path: allowlist entry or
  // the owner's confirmSource === true, and no link on its path; then the
  // usual resolveSource rules apply. Examples and URLs resolve as usual (a
  // URL always needs an allowlist entry).
  _resolveRecorded(name, source, settings, { confirmSource = false } = {}) {
    if (typeof source !== 'string' || !source.trim()) {
      throw new PlaybookError(`"${name}" has no recorded source; remove it and add it again from its source.`, { code: 'NO_SOURCE' });
    }
    const abs = recordedLocalPath(source);
    if (abs !== null) {
      const needsConfirm = () => new PlaybookError(
        `The recorded source of "${name}" is a local folder no allowed-folder entry covers (${oneLine(abs, 200)}). Confirm it before King Louie reads it, or ${this.adminPolicy ? 'set playbooks.sources in the admin service.json' : 'add its folder to Settings → Playbooks → Allowed sources'}.`,
        { code: 'SOURCE_NEEDS_CONFIRM' }
      );
      // Unless an entry covers it on its text, refuse before any file system
      // call (a mapped network drive is not touched). Fail closed: a path
      // covered only through a link waits for the owner's confirm.
      const lexical = lexicallyCovered(abs, settings);
      if (!lexical && confirmSource !== true) throw needsConfirm();
      assertNoLinks(abs, name);
      let covered = false;
      if (lexical) {
        try {
          vendor.assertPathAllowed(abs, settings);
          covered = true;
        } catch {
          covered = false;
        }
      }
      if (!covered && confirmSource !== true) throw needsConfirm();
    }
    return vendor.resolveSource(source, { examplesDir: this.examplesDir, settings, adminPolicy: this.adminPolicy });
  }

  async attach(caseId, { source, ref = null, acceptBudgetRaises = false } = {}) {
    this._assertOpen(this.runtime.getCase(caseId));
    const prepared = await this.prepare(source, { ref });
    return this.attachPrepared(caseId, prepared, { acceptBudgetRaises });
  }

  _checkType(meta, playbook) {
    if (meta.type && meta.type !== 'general' && playbook.caseType !== meta.type) {
      throw new PlaybookError(`Playbook "${playbook.name}" is for "${playbook.caseType}" cases; this case is "${meta.type}".`, { code: 'CASE_TYPE' });
    }
  }

  // The steps after the copy and the pin are written (acknowledged state,
  // defaults, gating sync, journal). A failure here keeps the attach: the
  // copy, pin and record are consistent, the next turn re-syncs gating, and
  // the owner gets a warning instead of an error for a half-done attach
  // (final review M-5: ok with a warning, not a rollback).
  _afterAttachOrWarn(meta, name, playbook, opts) {
    try {
      return { ...this._afterAttach(meta, name, playbook, opts), warning: null };
    } catch (err) {
      log.warn(`Case ${meta.slug}: ${opts.what} ${name}, but its defaults, gating or journal step failed: ${err.message}`);
      try {
        this._journal(meta, `${opts.what} playbook ${name}@${playbook.version}; applying its defaults, gating questions or journal entry failed (details in the log).`);
      } catch (journalErr) {
        log.warn(`Case ${meta.slug}: journaling the partial ${name} attach failed: ${journalErr.message}`);
      }
      return {
        defaults: { applied: [], skipped: [], budgetRaises: [] },
        synced: { created: [], unknowns: [] },
        warning: `${opts.what} ${name}, but applying its defaults, gating questions or journal entry failed (details in the log). Check the brief and budget; gating questions sync again at the next turn.`
      };
    }
  }

  _afterAttach(meta, name, playbook, { acceptBudgetRaises, what, extra = [] }) {
    const state = changes.readState(meta.dir);
    state.acknowledged[name] = changes.snapshotOf(this._loader(this.runtime.getCase(meta.id)).get(name));
    changes.writeState(meta.dir, state);
    const defaults = this._applyDefaults(meta.id, playbook, { acceptBudgetRaises });
    const synced = this._sync(this.runtime.getCase(meta.id));
    this._journal(meta, [
      `${what} playbook ${name}@${playbook.version}.`,
      ...extra,
      `Defaults applied: ${defaults.applied.length ? defaults.applied.join('; ') : 'none'}.`,
      `Defaults skipped: ${defaults.skipped.length ? defaults.skipped.join('; ') : 'none'}.`,
      `Budget raises offered: ${defaults.budgetRaises.length ? defaults.budgetRaises.map((r) => `${r.key} ${r.from} -> ${r.to}`).join('; ') : 'none'}.`,
      `Gating questions: ${synced.created.length ? synced.created.join(', ') : 'none'}; unknowns: ${synced.unknowns.length ? synced.unknowns.join(', ') : 'none'}.`
    ].join('\n'));
    return { defaults, synced };
  }

  async attachPrepared(caseId, prepared, { acceptBudgetRaises = false } = {}) {
    const { name, version } = prepared.playbook;
    return this._action(caseId, `playbook attach ${name}@${version}`, (meta) => {
      this._assertOpen(meta);
      if ((meta.playbooks || []).some((p) => p && p.name === name)) {
        throw new PlaybookError(`Playbook "${name}" is already attached to this case. Use Update to change its version.`, { code: 'ATTACHED' });
      }
      this._checkType(meta, prepared.playbook);
      vendor.removeTempLeftovers(meta.dir);
      ensureGitattributes(meta.dir);
      const stateBefore = changes.readState(meta.dir);
      const target = vendor.vendorInto(meta.dir, prepared.snapshot, name);
      // The copy, the pin and the vendoring record stand or fall together:
      // a failure after the copy is written undoes all three, so a retry
      // attaches cleanly instead of finding "already exists".
      try {
        const pin = { name, version, source: prepared.source, mode: 'vendored', commit: prepared.commit, contentHash: prepared.contentHash };
        this.runtime.store.updateMeta(meta.id, { playbooks: [...(meta.playbooks || []), pin] });
        const state = changes.readState(meta.dir);
        state.vendored[name] = {
          source: prepared.source,
          ref: prepared.ref,
          commit: prepared.commit,
          vendoredAt: this.now().toISOString(),
          contentHash: prepared.contentHash,
          onDiskVersion: version,
          files: prepared.files
        };
        changes.writeState(meta.dir, state);
      } catch (err) {
        const undo = [
          () => fs.rmSync(target, { recursive: true, force: true }),
          () => this.runtime.store.updateMeta(meta.id, { playbooks: meta.playbooks || [] }),
          () => changes.writeState(meta.dir, stateBefore)
        ];
        for (const step of undo) {
          try {
            step();
          } catch (undoErr) {
            log.warn(`Case ${meta.slug}: undoing the attach of ${name} failed: ${undoErr.message}`);
          }
        }
        throw err;
      }
      const { defaults, synced, warning } = this._afterAttachOrWarn(meta, name, prepared.playbook, {
        acceptBudgetRaises,
        what: 'Attached',
        extra: [`Source: ${prepared.source}${prepared.ref ? ` (ref ${prepared.ref})` : ''}; commit: ${prepared.commit || 'none'}.`]
      });
      return {
        ok: true,
        playbook: { name, version },
        warnings: warning ? [...prepared.warnings, warning] : prepared.warnings,
        budgetRaises: defaults.budgetRaises,
        questionIds: synced.created,
        unknownIds: synced.unknowns
      };
    });
  }

  async adopt(caseId, name, { acceptBudgetRaises = false } = {}) {
    checkName(name);
    return this._action(caseId, `playbook adopt ${name}`, (meta) => {
      this._assertOpen(meta);
      const entry = this._loader(meta).get(name);
      if (!entry || entry.state !== 'unregistered') {
        throw new PlaybookError(`"${name}" is not an unregistered playbook in this case${entry ? ` (it is ${entry.state})` : ''}.`, { code: 'NOT_UNREGISTERED' });
      }
      const playbook = entry.package.playbook;
      this._checkType(meta, playbook);
      ensureGitattributes(meta.dir);
      const submodule = entry.mode === 'submodule';
      const pin = {
        name,
        version: entry.onDisk.version,
        source: submodule ? (entry.submodule.url || 'submodule') : 'adopted',
        mode: entry.mode,
        commit: submodule ? entry.submodule.commit : null,
        contentHash: entry.onDisk.contentHash
      };
      this.runtime.store.updateMeta(meta.id, { playbooks: [...(meta.playbooks || []), pin] });
      const { defaults, synced, warning } = this._afterAttachOrWarn(meta, name, playbook, { acceptBudgetRaises, what: 'Adopted' });
      return {
        ok: true,
        playbook: { name, version: pin.version },
        warnings: warning ? [...entry.warnings, warning] : entry.warnings,
        budgetRaises: defaults.budgetRaises,
        questionIds: synced.created,
        unknownIds: synced.unknowns
      };
    });
  }

  // Budget defaults above the settings default that no playbook has been
  // allowed to write yet (R30); the panel offers them for the owner to accept.
  // The raises one attached playbook still offers: budgetDefaults keys the
  // case has not set whose value is above the settings default. The panel
  // lists these per playbook, and applyBudgetRaises writes exactly these.
  _raisesOf(entry, budget, base) {
    const out = [];
    for (const [key, value] of Object.entries(entry.package.playbook.budgetDefaults || {})) {
      if (budget[key] !== undefined && budget[key] !== null) continue;
      const from = base[key] ?? null;
      if (!isRaise(value, from)) continue;
      out.push({ key, from, to: value });
    }
    return out;
  }

  // Every playbook's own offers; a key two playbooks raise is listed under
  // each, so a per-playbook Accept shows everything it will write.
  offeredBudgetRaises(caseId) {
    const meta = this.runtime.getCase(caseId);
    const base = this._budgetBase();
    const budget = meta.budget && typeof meta.budget === 'object' ? meta.budget : {};
    const out = [];
    for (const e of this._loader(meta).list()) {
      if (e.state !== 'ok' || !e.pinned) continue;
      for (const r of this._raisesOf(e, budget, base)) out.push({ playbook: e.name, ...r });
    }
    return out;
  }

  // The owner accepted the raises an attach offered.
  async applyBudgetRaises(caseId, name) {
    checkName(name);
    return this._action(caseId, `playbook budget ${name}`, (meta) => {
      this._assertOpen(meta);
      const entry = this._loader(meta).get(name);
      if (!entry || !entry.pinned || entry.state !== 'ok') throw new PlaybookError(`"${name}" is not attached and in use in this case.`);
      const budget = meta.budget && typeof meta.budget === 'object' ? { ...meta.budget } : {};
      // Only the raises this playbook offers now, as the owner saw them.
      const applied = this._raisesOf(entry, budget, this._budgetBase());
      for (const r of applied) budget[r.key] = r.to;
      if (applied.length) {
        this.runtime.store.updateMeta(meta.id, { budget });
        this._journal(meta, `The owner accepted budget raises from playbook ${name}: ${applied.map((r) => `${r.key} ${r.from} -> ${r.to}`).join('; ')}.`);
      }
      return { ok: true, applied };
    });
  }

  async remove(caseId, name) {
    if (typeof name === 'string' && !NAME_RE.test(name) && name.length <= 256) {
      const pins = this.runtime.getCase(caseId).playbooks || [];
      if (pins.some((p) => p && p.name === name)) return this._removeInvalidPin(caseId, name);
    }
    checkName(name);
    return this._action(caseId, `playbook remove ${name}`, (meta) => {
      this._assertOpen(meta);
      const entry = this._loader(meta).get(name);
      if (!entry) throw new PlaybookError(`"${name}" is not attached to this case.`, { code: 'NOT_ATTACHED' });
      if (entry.mode === 'submodule') {
        throw new PlaybookError(`"${name}" is a git submodule; remove it with git ("git rm playbooks/${name}").`, { code: 'SUBMODULE' });
      }
      // entry.dir is null when playbooks/ itself is a link. A linked copy is
      // unlinked, never followed.
      const st = entry.dir ? lstatOrNull(entry.dir) : null;
      if (st && st.isSymbolicLink()) {
        try { fs.unlinkSync(entry.dir); } catch { fs.rmdirSync(entry.dir); }
      } else if (st) {
        fs.rmSync(entry.dir, { recursive: true, force: true });
      }
      this.runtime.store.updateMeta(meta.id, { playbooks: (meta.playbooks || []).filter((p) => !(p && p.name === name)) });
      const state = changes.readState(meta.dir);
      delete state.vendored[name];
      delete state.acknowledged[name];
      changes.writeState(meta.dir, state);
      this._journal(meta, `Removed playbook ${name}${entry.onDisk ? `@${entry.onDisk.version}` : ''}. Question records it created and defaults it applied stay.`);
      return { ok: true };
    });
  }

  // A pin whose name is not a valid playbook name (an imported case.yaml can
  // hold "../../evil"): only the exact-match entry leaves case.yaml. No path
  // is built from the name and the file system is not touched; the name is
  // kept out of the commit message.
  async _removeInvalidPin(caseId, name) {
    return this._action(caseId, 'playbook remove (invalid name)', (meta) => {
      this._assertOpen(meta);
      const pins = meta.playbooks || [];
      if (!pins.some((p) => p && p.name === name)) throw new PlaybookError('That playbook is not attached to this case.', { code: 'NOT_ATTACHED' });
      this.runtime.store.updateMeta(meta.id, { playbooks: pins.filter((p) => !(p && p.name === name)) });
      this._journal(meta, 'Removed a playbook entry with an invalid name from case.yaml; no files were touched.');
      return { ok: true };
    });
  }

  // ---- Updates ----

  async _upstreamManifest(entry, state, settings, { confirmSource }) {
    if (entry.mode === 'submodule') {
      return vendor.fetchSubmoduleManifest(entry.dir, entry.submodule?.url, { settings, adminPolicy: this.adminPolicy, timeoutMs: this.fetchTimeoutMs, tmpRoot: this.tmpRoot });
    }
    const rec = state.vendored[entry.name];
    const resolved = this._resolveRecorded(entry.name, rec && rec.source, settings, { confirmSource });
    const fetched = await vendor.fetchPackage(resolved, { ref: rec.ref, timeoutMs: this.fetchTimeoutMs, tmpRoot: this.tmpRoot });
    try {
      return fs.readFileSync(path.join(fetched.pkgDir, 'playbook.yaml'), 'utf8');
    } finally {
      fetched.cleanup();
    }
  }

  // Reads only (and records lastUpdateCheck). With { apply: true } and
  // settings.playbooks.autoUpdate, same-major updates apply at once.
  // confirmSource === true is the owner re-confirming recorded local
  // folders for this call (ruling T5-recorded).
  // A confirmation covers one named playbook only, never every recorded
  // folder in the case.
  async checkUpdates(caseId, name = null, { apply = false, confirmSource = false } = {}) {
    if (name !== null && name !== undefined) checkName(name);
    if (confirmSource === true && (name === null || name === undefined)) {
      throw new PlaybookError('confirmSource needs a playbook name.', { code: 'CONFIRM_NEEDS_NAME' });
    }
    const meta = this.runtime.getCase(caseId);
    const settings = this.settings();
    const state = changes.readState(meta.dir);
    const entries = this._loader(meta).list().filter((e) => e.pinned && (!name || e.name === name));
    if (name && !entries.length) throw new PlaybookError(`"${name}" is not attached to this case.`, { code: 'NOT_ATTACHED' });
    const results = [];
    for (const e of entries) {
      const onDisk = e.onDisk?.version ?? e.pinned.version ?? null;
      const row = { name: e.name, pinned: e.pinned.version ?? null, upstream: null, updateAvailable: false, sameMajor: false };
      try {
        const text = await this._upstreamManifest(e, state, settings, { confirmSource });
        const up = parsePlaybookYaml(text).value;
        if (!up || typeof up.version !== 'string') throw new PlaybookError('the upstream playbook.yaml has no version');
        row.upstream = up.version;
        row.updateAvailable = onDisk ? compareVersions(up.version, onDisk) > 0 : true;
        row.sameMajor = onDisk ? majorOf(up.version) === majorOf(onDisk) : false;
      } catch (err) {
        row.error = err.message;
        if (err.code === 'SOURCE_NEEDS_CONFIRM' || err.code === 'SOURCE_IS_LINK') row.code = err.code;
      }
      results.push(row);
    }
    // A closed case is read only: no lastUpdateCheck write, no commit.
    if (!CLOSED.includes(meta.status)) {
      await this._action(meta.id, 'playbook check', (m) => {
        const s = changes.readState(m.dir);
        s.lastUpdateCheck = this.now().toISOString();
        changes.writeState(m.dir, s);
      });
    }
    // A closed case's playbooks cannot change: report, never apply (M-1).
    if (apply && settings.autoUpdate && !CLOSED.includes(meta.status)) {
      for (const row of results) {
        if (!row.updateAvailable || !row.sameMajor || row.error) continue;
        const u = await this.update(meta.id, row.name, { confirmSource });
        if (u.ok) row.applied = u.to;
        else row.applyError = u.error;
      }
    }
    return results;
  }

  // Why the vendored copy may not be replaced, or null. Hashing refuses an
  // oversized or unwalkable copy (PACKAGE_TOO_LARGE); that is a refusal
  // with or without force. A record without a hash counts as edited.
  _editedRefusal(name, entry, rec, force) {
    const st = entry.dir ? lstatOrNull(entry.dir) : null;
    if (!st) return null;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, error: `playbooks/${name} is not a real folder; remove it and add the playbook again from its source.` };
    }
    let current;
    let files;
    try {
      current = hashPackage(entry.dir);
      files = rec.contentHash && current === rec.contentHash ? null : fileHashes(entry.dir);
    } catch (err) {
      if (err && err.code === 'PACKAGE_TOO_LARGE') {
        const why = String(err.message).replace(/^cannot hash this package: /, '');
        return { ok: false, error: `The vendored copy of "${name}" cannot be checked (${oneLine(why, 300)}); remove it and add it again from its source.` };
      }
      throw err;
    }
    if (rec.contentHash && current === rec.contentHash) return null;
    if (force === true) return null;
    const edited = editedFiles(rec.files, files);
    return {
      ok: false,
      error: `The vendored copy of "${name}" was edited (${edited.join(', ')}); updating would overwrite those edits.`,
      editedFiles: edited
    };
  }

  // force === true overwrites local edits; confirmSource === true is the
  // owner re-confirming a recorded local folder (ruling T5-recorded).
  async update(caseId, name, { force = false, confirmSource = false } = {}) {
    checkName(name);
    const meta = this.runtime.getCase(caseId);
    this._assertOpen(meta);
    const entry = this._loader(meta).get(name);
    if (!entry || !entry.pinned) return { ok: false, error: `"${name}" is not attached to this case.` };
    if (entry.mode === 'submodule') {
      return { ok: false, error: `"${name}" is a git submodule; update it with git ("git submodule update --remote playbooks/${name}") and the next turn will re-orient.` };
    }
    const state = changes.readState(meta.dir);
    const rec = state.vendored[name];
    if (!rec || !rec.source) return { ok: false, error: `"${name}" has no recorded source; remove it and add it again from its source.` };
    const early = this._editedRefusal(name, entry, rec, force);
    if (early) return early;
    let prepared;
    try {
      const resolved = this._resolveRecorded(name, rec.source, this.settings(), { confirmSource });
      prepared = await this._prepareResolved(resolved, rec.ref);
    } catch (err) {
      const code = err && (err.code === 'SOURCE_NEEDS_CONFIRM' || err.code === 'SOURCE_IS_LINK') ? { code: err.code } : {};
      return { ok: false, error: err.message, ...code };
    }
    if (prepared.playbook.name !== name) {
      return {
        ok: false,
        error: `Upstream playbook at ${rec.source} is now named "${prepared.playbook.name}" (attached as "${name}"). Remove "${name}" and add "${prepared.playbook.name}" to switch.`
      };
    }
    const to = prepared.playbook.version;
    return this._action(meta.id, `playbook update ${name}@${to}`, (m) => {
      // Checked again under the lock: the copy or its record may have
      // changed while the source was fetched.
      this._assertOpen(m);
      const now = this._loader(m).get(name);
      if (!now || !now.pinned || now.mode === 'submodule') return { ok: false, error: `"${name}" is not attached to this case.` };
      const s = changes.readState(m.dir);
      const recNow = s.vendored[name];
      if (!recNow || recNow.source !== rec.source) return { ok: false, error: `The recorded source of "${name}" changed while it was being fetched; check for updates again.` };
      const refused = this._editedRefusal(name, now, recNow, force);
      if (refused) return refused;
      // The same case type rule as attach: an upstream that changed its
      // caseType does not land silently on a typed case (M-2).
      try {
        this._checkType(m, prepared.playbook);
      } catch (err) {
        if (err.code !== 'CASE_TYPE') throw err;
        return { ok: false, error: err.message, code: err.code };
      }
      const from = now.onDisk?.version ?? now.pinned.version;
      const oldPlaybook = now.package?.playbook || null;

      const parkedRoot = path.join(m.dir, '.kl', 'runs');
      fs.mkdirSync(parkedRoot, { recursive: true });
      const parked = path.join(parkedRoot, `playbook-${name}-${Date.now()}`);
      const target = path.join(m.dir, 'playbooks', name);
      const hadCopy = Boolean(lstatOrNull(target));
      if (hadCopy) fs.renameSync(target, parked);
      const restore = () => {
        if (lstatOrNull(target)) fs.rmSync(target, { recursive: true, force: true });
        if (hadCopy && lstatOrNull(parked)) fs.renameSync(parked, target);
      };
      try {
        vendor.vendorInto(m.dir, prepared.snapshot, name);
        s.vendored[name] = {
          ...recNow,
          commit: prepared.commit,
          vendoredAt: this.now().toISOString(),
          contentHash: prepared.contentHash,
          onDiskVersion: to,
          files: prepared.files
        };
        changes.writeState(m.dir, s);
      } catch (err) {
        try {
          restore();
        } catch (undoErr) {
          log.warn(`Case ${m.slug}: restoring playbooks/${name} failed: ${undoErr.message}`);
        }
        throw err;
      }
      fs.rmSync(parked, { recursive: true, force: true });
      const newKeys = oldPlaybook ? Object.keys(prepared.playbook.budgetDefaults).filter((k) => !(k in oldPlaybook.budgetDefaults)) : null;
      const newMateriality = oldPlaybook
        ? ['tell', 'ignore'].flatMap((l) => prepared.playbook.materialityDefaults[l]
          .filter((i) => !oldPlaybook.materialityDefaults[l].includes(i))
          .map((i) => `${l}:${i}`))
        : null;
      const defaults = this._applyDefaults(m.id, prepared.playbook, { onlyBudgetKeys: newKeys, onlyMateriality: newMateriality });
      this._journal(m, [
        `Updated playbook ${name} from ${from} to ${to}${force === true ? ' (the owner chose to overwrite local edits)' : ''}. The next turn re-orients.`,
        `Defaults applied: ${defaults.applied.length ? defaults.applied.join('; ') : 'none'}.`,
        `Budget raises offered: ${defaults.budgetRaises.length ? defaults.budgetRaises.map((r) => `${r.key} ${r.from} -> ${r.to}`).join('; ') : 'none'}.`
      ].join('\n'));
      return { ok: true, from, to, budgetRaises: defaults.budgetRaises };
    });
  }

  // ---- Acknowledgement (C2's Reorient) ----

  // Takes no lock and does not commit: call it only from C2's Reorient
  // (runtime.acknowledgePlaybooks) inside a turn that holds the case lock
  // and commits. Never call it from IPC or anywhere outside a turn.
  // shownKeys: the playbook-update trigger keys the turn showed the model.
  // Only a change whose current key is among them is acknowledged; one that
  // moved on mid-turn (new key) stays pending. No keys, nothing acknowledged.
  acknowledge(caseId, { shownKeys = [] } = {}) {
    const meta = this.runtime.getCase(caseId);
    const entries = this._loader(meta).list();
    const state = changes.readState(meta.dir);
    const shown = new Set(Array.isArray(shownKeys) ? shownKeys.filter((k) => typeof k === 'string') : []);
    const pending = changes.computeChanges(entries, state.acknowledged).filter((c) => shown.has(c.key));
    const names = new Set(pending.map((c) => c.name));
    const pins = (meta.playbooks || []).map((p) => {
      const e = p && names.has(p.name) && entries.find((x) => x.name === p.name);
      if (!e || e.state !== 'ok') return p;
      return {
        ...p,
        version: e.onDisk.version,
        mode: e.mode,
        commit: e.mode === 'submodule' ? e.submodule.commit : (state.vendored[p.name]?.commit ?? p.commit ?? null),
        contentHash: e.onDisk.contentHash
      };
    });
    this.runtime.store.updateMeta(meta.id, { playbooks: pins });
    const fresh = this._loader(this.runtime.getCase(meta.id)).list();
    for (const e of fresh) if (e.pinned && names.has(e.name)) state.acknowledged[e.name] = changes.snapshotOf(e);
    changes.writeState(meta.dir, state);
    const synced = this._sync(this.runtime.getCase(meta.id));
    return { acknowledged: pending.map((c) => c.name), questionIds: synced.created };
  }

  // ---- Creating a case with playbooks (IPC case:create) ----

  // Every source is resolved, allow-checked, fetched and validated before a
  // case exists; any failure refuses the whole create.
  async prepareForCreate(list, { type = null } = {}) {
    if (!Array.isArray(list) || list.length > MAX_CREATE_PLAYBOOKS) {
      return { ok: false, error: `playbooks must be a list of at most ${MAX_CREATE_PLAYBOOKS} { source, ref? }.` };
    }
    const prepared = [];
    const errors = [];
    for (const [i, item] of list.entries()) {
      const source = item && typeof item.source === 'string' ? item.source : null;
      if (!source) {
        errors.push(`playbooks[${i}]: source is required.`);
        continue;
      }
      try {
        prepared.push(await this.prepare(source, { ref: item.ref || null }));
      } catch (err) {
        errors.push(`${source}: ${err.message}`);
      }
    }
    const names = prepared.map((p) => p.playbook.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) errors.push(`Playbook "${dup}" is listed twice.`);
    if (errors.length) return { ok: false, error: `The case was not created:\n${errors.join('\n')}`, errors };
    const types = [...new Set(prepared.map((p) => p.playbook.caseType))];
    if (!type) {
      if (types.length > 1) return { ok: false, error: `Playbooks disagree on case type (${types.join(', ')}); pick a type.` };
      return { ok: true, prepared, type: types[0] || null };
    }
    if (type !== 'general') {
      const wrong = prepared.find((p) => p.playbook.caseType !== type);
      if (wrong) return { ok: false, error: `Playbook "${wrong.playbook.name}" is for "${wrong.playbook.caseType}" cases; this case is "${type}".` };
    }
    return { ok: true, prepared, type };
  }

  // ---- Proposals (spec §3.10) ----

  // The model's Playbook.propose: only in a done case. It stores a patch;
  // applying it is the owner's (applyProposal).
  async propose(caseId, { playbook = null, newPlaybook = null, files, rationale, factIds = [], turnId = null } = {}) {
    const meta = this.runtime.getCase(caseId);
    if (meta.status !== 'done') return { ok: false, error: 'Playbook changes can only be proposed once the case is done.' };
    if (Boolean(playbook) === Boolean(newPlaybook)) return { ok: false, error: 'Name exactly one of "playbook" (a change) or "newPlaybook" (a new playbook).' };
    if (typeof rationale !== 'string' || !rationale.trim() || rationale.length > 2000) return { ok: false, error: 'rationale must be 1 to 2000 characters.' };
    if (!Array.isArray(factIds) || factIds.length > MAX_FACT_IDS) return { ok: false, error: `factIds must be a list of at most ${MAX_FACT_IDS} fact ids.` };
    if (!factIds.every((x) => typeof x === 'string' && x.length <= 64)) return { ok: false, error: 'factIds must be a list of fact ids.' };
    const facts = this.runtime.ledger(meta.id).view().facts;
    const bad = factIds.filter((id) => facts.get(id)?.status !== 'active');
    if (bad.length) return { ok: false, error: `These fact ids are missing or no longer active: ${bad.map((x) => oneLine(x, 64)).join(', ')}.` };
    const name = playbook || newPlaybook;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return { ok: false, error: typeof name === 'string' ? `"${oneLine(name, 60)}" is not a valid playbook name.` : 'A playbook name must be a string.' };
    }
    let base = null;
    let baseVersion = null;
    let baseCommit = null;
    let baseContentHash = null;
    if (playbook) {
      const entry = this._loader(meta).get(playbook);
      if (!entry || !entry.pinned || entry.state !== 'ok') return { ok: false, error: `Playbook "${playbook}" is not attached and in use in this case.` };
      base = vendor.readSnapshot(entry.dir);
      baseVersion = entry.onDisk.version;
      baseCommit = entry.mode === 'submodule' ? entry.submodule.commit : (changes.readState(meta.dir).vendored[playbook]?.commit ?? null);
      baseContentHash = entry.onDisk.contentHash;
    } else if ((meta.playbooks || []).some((p) => p && p.name === newPlaybook)) {
      return { ok: false, error: `Playbook "${newPlaybook}" is already attached; propose a change to it instead.` };
    }
    let built;
    try {
      built = await proposals.buildProposal({ name, isNew: !playbook, base, files, knownCaseTypes: this.caseTypes.knownCaseTypes(), tmpRoot: this.tmpRoot });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    let record;
    try {
      record = await this._action(meta.id, `playbook propose ${name}`, (m) => {
        if (m.status !== 'done') throw new PlaybookError('Playbook changes can only be proposed once the case is done.');
        const r = proposals.storeProposal(m.dir, {
          name, isNew: !playbook, patch: built.patch, files, baseVersion, baseCommit, baseContentHash,
          changedFiles: built.changedFiles, rationale: rationale.trim(), factIds, turnId, now: this.now()
        });
        this._journal(m, [
          `Proposed ${playbook ? `a change to playbook ${name}@${baseVersion}` : `a new playbook ${name}`} (${r.id}): ${r.files.join(', ')}.`,
          `Rationale: ${r.rationale}`,
          `Facts: ${factIds.length ? factIds.join(', ') : 'none'}.`,
          `Patch: ${r.patch}`
        ].join('\n'));
        return r;
      });
    } catch (err) {
      if (err instanceof PlaybookError || err instanceof proposals.ProposalError) return { ok: false, error: err.message };
      throw err;
    }
    return {
      ok: true,
      proposal: { id: record.id, patch: record.patch, files: record.files, ...(record.packageDir ? { packageDir: record.packageDir } : {}) },
      note: 'The owner reviews and applies it to the playbook repository from the case panel.'
    };
  }

  proposals(caseId) {
    const meta = this.runtime.getCase(caseId);
    const entries = this._loader(meta).list();
    const state = changes.readState(meta.dir);
    return proposals.listProposals(meta.dir).map((r) => {
      const e = entries.find((x) => x.name === r.playbook);
      const source = e?.pinned?.source || state.vendored[r.playbook]?.source || null;
      return {
        ...r,
        stale: !r.newPlaybook && (!e || !e.onDisk || e.onDisk.contentHash !== r.baseContentHash),
        hint: typeof source === 'string' && source.startsWith('example:') ? `Copy examples/playbooks/${r.playbook} into your own repository, then apply there.` : null
      };
    });
  }

  patchText(caseId, proposalId) {
    const meta = this.runtime.getCase(caseId);
    const r = proposals.getProposal(meta.dir, proposalId);
    if (!r) throw new PlaybookError(`Proposal ${showProposalId(proposalId)} was not found.`);
    const file = path.join(meta.dir, ...r.patch.split('/'));
    if (!vendor.isInside(file, meta.dir)) throw new PlaybookError(`Proposal ${r.id} points outside the case.`);
    // Stat first: the patch file is case data, so a file that is not a plain
    // file or is larger than any patch storeProposal writes is never read.
    const st = lstatOrNull(file);
    if (!st || !st.isFile()) throw new PlaybookError(`The patch of proposal ${r.id} is missing or not a regular file.`, { code: 'PATCH_UNREADABLE' });
    if (st.size > proposals.MAX_PATCH_BYTES) throw new PlaybookError(`The patch of proposal ${r.id} is too large to show here; review it in the case folder.`, { code: 'PATCH_TOO_LARGE' });
    return fs.readFileSync(file, 'utf8');
  }

  // The owner's explicit action only (IPC case:applyPlaybookProposal); no
  // model tool reaches it. The status check, the apply and the status write
  // run in one exclusive section, so two racing calls apply once.
  async applyProposal(caseId, proposalId, repoPath) {
    if (typeof proposalId !== 'string' || !PROPOSAL_ID_RE.test(proposalId)) return { ok: false, error: 'Proposal (invalid id) was not found.' };
    if (typeof repoPath !== 'string' || !repoPath.trim()) return { ok: false, error: 'repoPath is required.' };
    return this._action(caseId, `playbook apply ${proposalId}`, async (m) => {
      const record = proposals.getProposal(m.dir, proposalId);
      if (!record) return { ok: false, error: `Proposal ${proposalId} was not found.` };
      if (record.status !== 'proposed') return { ok: false, error: `Proposal ${proposalId} is ${record.status}.` };
      let applied;
      try {
        applied = await proposals.applyProposalTo({ caseDir: m.dir, casesRoot: this.runtime.root, record, repoPath, tmpRoot: this.tmpRoot });
      } catch (err) {
        return { ok: false, error: err.message };
      }
      proposals.setProposalStatus(m.dir, proposalId, 'applied', { appliedTo: repoPath, appliedOver: applied.appliedOver }, this.now());
      this._journal(m, `The owner applied proposal ${proposalId} (${record.playbook}) to ${repoPath}${applied.appliedOver ? ` at ${applied.appliedOver}` : ''}; the changes are uncommitted there.`);
      return { ok: true, appliedTo: repoPath, appliedOver: applied.appliedOver };
    });
  }

  async rejectProposal(caseId, proposalId) {
    if (typeof proposalId !== 'string' || !PROPOSAL_ID_RE.test(proposalId)) return { ok: false, error: 'Proposal (invalid id) was not found.' };
    return this._action(caseId, `playbook reject ${proposalId}`, (m) => {
      const record = proposals.getProposal(m.dir, proposalId);
      if (!record) return { ok: false, error: `Proposal ${proposalId} was not found.` };
      if (record.status !== 'proposed') return { ok: false, error: `Proposal ${proposalId} is ${record.status}.` };
      proposals.setProposalStatus(m.dir, proposalId, 'rejected', {}, this.now());
      this._journal(m, `The owner rejected proposal ${proposalId} (${record.playbook}).`);
      return { ok: true };
    });
  }
}

module.exports = { PlaybookManager, PlaybookError, resolvePlaybookSettings, isRaise, MAX_CREATE_PLAYBOOKS, GATING_SYNC_FAILED_NOTE, HOOK_FAILED_NOTE };

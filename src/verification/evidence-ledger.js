/**
 * Verification evidence ledger.
 *
 * Records what the agent actually *proved* while working in a code
 * workspace: which verification commands ran, what they covered, and
 * whether they passed — plus when files were edited, so evidence can be
 * ordered against the changes it is supposed to justify.
 *
 * Deliberately **passive**. It never runs a suite, never decides that a
 * turn is finished, and never blocks anything. Policy lives in
 * verify-on-stop.js; this module only remembers.
 *
 * The invariant that matters most: **a targeted check is never reported
 * as a full pass.** Running one test file proves that file works. It is
 * not evidence the suite is green, and quietly upgrading it would make
 * the whole feature worse than nothing — it would manufacture confidence
 * rather than track it.
 *
 * Storage is a versioned JSON file, following the conventions in
 * [event-ledger.js](../events/event-ledger.js). Evidence ages out and is
 * capped per workspace so the file cannot grow without bound.
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('evidence-ledger');

const LEDGER_VERSION = 1;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_EVENTS_PER_WORKSPACE = 100;
const DEFAULT_MAX_WORKSPACES = 50;

function nowIso() {
  return new Date().toISOString();
}

function normalizeRoot(root) {
  if (!root) return '';
  return path.resolve(String(root)).replace(/[\\/]+$/, '');
}

function emptyStore() {
  return { version: LEDGER_VERSION, workspaces: {} };
}

function emptyWorkspace(root) {
  return { root, lastEditedAt: null, editedPaths: [], events: [] };
}

class EvidenceLedger {
  /**
   * @param {object} options
   * @param {string} [options.storageFile] Omit for an in-memory ledger
   *                                       (tests, ephemeral sessions).
   * @param {number} [options.maxAgeDays]
   * @param {number} [options.maxEventsPerWorkspace]
   */
  constructor(options = {}) {
    this.storageFile = options.storageFile || null;
    this.maxAgeDays = Number.isFinite(options.maxAgeDays)
      ? options.maxAgeDays
      : DEFAULT_MAX_AGE_DAYS;
    this.maxEventsPerWorkspace = Number.isFinite(options.maxEventsPerWorkspace)
      ? options.maxEventsPerWorkspace
      : DEFAULT_MAX_EVENTS_PER_WORKSPACE;
    this.maxWorkspaces = Number.isFinite(options.maxWorkspaces)
      ? options.maxWorkspaces
      : DEFAULT_MAX_WORKSPACES;

    this.store = this._load();
  }

  _load() {
    if (!this.storageFile) return emptyStore();

    try {
      const raw = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
      if (!raw || typeof raw !== 'object') return emptyStore();

      // A version bump means the on-disk shape is no longer trusted.
      // Evidence is cheap to recreate and dangerous to misread, so drop it
      // rather than attempt a migration.
      if (raw.version !== LEDGER_VERSION) {
        log.info(`Ledger version ${raw.version} != ${LEDGER_VERSION}; starting fresh`);
        return emptyStore();
      }

      return {
        version: LEDGER_VERSION,
        workspaces: raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {}
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn(`Could not read ledger, starting fresh: ${err.message}`);
      }
      return emptyStore();
    }
  }

  _persist() {
    if (!this.storageFile) return;

    try {
      fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
      const tmp = `${this.storageFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store), 'utf8');
      fs.renameSync(tmp, this.storageFile);
    } catch (err) {
      // Losing evidence degrades the nudge to a false positive at worst.
      // It must never take down the turn that produced it.
      log.warn(`Could not persist ledger: ${err.message}`);
    }
  }

  _workspace(root) {
    const key = normalizeRoot(root);
    if (!this.store.workspaces[key]) {
      this.store.workspaces[key] = emptyWorkspace(key);
    }
    return this.store.workspaces[key];
  }

  /**
   * Note that the agent changed files. Evidence recorded before this
   * moment no longer justifies the current state of the code.
   */
  markEdited(root, paths = []) {
    const workspace = this._workspace(root);
    const list = Array.isArray(paths) ? paths : [paths];

    workspace.lastEditedAt = nowIso();
    for (const entry of list) {
      const value = String(entry || '');
      if (value && !workspace.editedPaths.includes(value)) {
        workspace.editedPaths.push(value);
      }
    }

    this._prune();
    this._persist();
    return workspace;
  }

  /**
   * Record a classified verification result. Accepts the output of
   * `classifyCommand`; ignores null so callers can pass it straight
   * through without a branch.
   */
  record(root, evidence) {
    if (!evidence) return null;

    const workspace = this._workspace(root);
    const event = {
      ...evidence,
      recordedAt: nowIso()
    };

    workspace.events.push(event);
    this._prune();
    this._persist();
    return event;
  }

  /** Clear the edited-since marker, e.g. after a turn is fully verified. */
  clearEdited(root) {
    const workspace = this._workspace(root);
    workspace.lastEditedAt = null;
    workspace.editedPaths = [];
    this._persist();
  }

  /**
   * What do we currently know about this workspace?
   *
   * "Fresh" means recorded *after* the most recent edit. A suite that
   * passed before the agent touched the file says nothing about the file
   * now, which is the whole reason edits are timestamped.
   */
  status(root) {
    const workspace = this._workspace(root);
    const editedAt = workspace.lastEditedAt ? Date.parse(workspace.lastEditedAt) : null;

    const fresh = workspace.events.filter((event) => {
      if (editedAt === null) return true;
      return Date.parse(event.recordedAt) >= editedAt;
    });

    const freshPasses = fresh.filter((event) => event.status === 'passed');
    const freshFailures = fresh.filter((event) => event.status === 'failed');

    // Behavior-proving evidence is tests only. A green linter or a clean
    // build says the code is well-formed, not that it works.
    const behavior = freshPasses.filter((event) => event.provesBehavior);

    return {
      root: normalizeRoot(root),
      hasEdits: Boolean(workspace.lastEditedAt),
      lastEditedAt: workspace.lastEditedAt,
      editedPaths: [...workspace.editedPaths],

      freshEvents: fresh,
      freshFailures,

      // Deliberately separate. A caller that wants "is the repo green?"
      // must ask for hasFullPass and get `false` when all we saw was one
      // test file — there is no single boolean that blurs the two.
      hasFullPass: behavior.some((event) => event.scope === 'full'),
      hasTargetedPass: behavior.some((event) => event.scope === 'targeted'),
      hasAnyFreshEvidence: fresh.length > 0,
      hasFreshFailure: freshFailures.length > 0
    };
  }

  /** Drop aged-out evidence and enforce the per-workspace cap. */
  _prune() {
    const cutoff = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;

    for (const [key, workspace] of Object.entries(this.store.workspaces)) {
      workspace.events = workspace.events
        .filter((event) => Date.parse(event.recordedAt) >= cutoff)
        .slice(-this.maxEventsPerWorkspace);

      const idle = workspace.events.length === 0 && !workspace.lastEditedAt;
      if (idle) delete this.store.workspaces[key];
    }

    const keys = Object.keys(this.store.workspaces);
    if (keys.length > this.maxWorkspaces) {
      // Oldest activity first, so the workspaces the user is actually
      // working in survive.
      const ranked = keys.sort((a, b) => {
        const at = this.store.workspaces[a].events.at(-1)?.recordedAt || '';
        const bt = this.store.workspaces[b].events.at(-1)?.recordedAt || '';
        return at.localeCompare(bt);
      });
      for (const key of ranked.slice(0, keys.length - this.maxWorkspaces)) {
        delete this.store.workspaces[key];
      }
    }
  }

  /** Everything we know, for diagnostics. */
  snapshot() {
    return JSON.parse(JSON.stringify(this.store));
  }
}

module.exports = {
  EvidenceLedger,
  LEDGER_VERSION,
  DEFAULT_MAX_AGE_DAYS,
  normalizeRoot
};

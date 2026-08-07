/**
 * Checkpoint manager — transparent per-turn filesystem snapshots.
 *
 * This is NOT a tool. The model never sees it, never calls it, and cannot
 * disable it. It is infrastructure the tool executor drives, gated by the
 * `checkpoints` setting.
 *
 * Policy:
 *   - Snapshot lazily: on the FIRST mutating tool call of a turn, not at
 *     turn start. A turn that only reads costs nothing at all.
 *   - Once per turn per working directory. The snapshot captures the state
 *     *before* the turn's first mutation, which is what "undo this turn"
 *     needs to restore.
 *   - Never break a turn. A snapshot failure is logged and swallowed; a
 *     broken checkpoint store must not stop the user's work.
 *
 * Restore is explicit and user-driven, and always takes a safety snapshot
 * first — so rolling back is itself undoable.
 */

const fs = require('fs');
const path = require('path');
const { ShadowGit, projectKey } = require('./shadow-git');
const { createLogger } = require('../logging');

const log = createLogger('checkpoint-manager');

/**
 * Tools whose execution can change files on disk.
 *
 * Bash is included unconditionally: we cannot know what an arbitrary command
 * does, and the cost of a needless snapshot (one commit whose tree is
 * usually identical to its parent, and which snapshot() then discards) is
 * far lower than the cost of missing the one command that deleted a file.
 */
const DEFAULT_MUTATING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'NotebookEdit'
]);

/** Prune refs whose project has been untouched for this long. */
const DEFAULT_MAX_AGE_DAYS = 14;
/** Run the prune sweep at most this often. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STATE_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

class CheckpointManager {
  /**
   * @param {object} options
   * @param {string} options.rootDir        Where the store lives.
   * @param {boolean} [options.enabled]     Master switch. Default true.
   * @param {Set<string>} [options.mutatingTools]
   * @param {number} [options.maxAgeDays]
   * @param {ShadowGit} [options.shadowGit] Injectable for tests.
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.rootDir = options.rootDir;
    this.maxAgeDays = Number.isFinite(options.maxAgeDays)
      ? options.maxAgeDays
      : DEFAULT_MAX_AGE_DAYS;
    this.mutatingTools = options.mutatingTools instanceof Set
      ? options.mutatingTools
      : DEFAULT_MUTATING_TOOLS;

    this.git = options.shadowGit || (this.rootDir
      ? new ShadowGit({ rootDir: this.rootDir, gitPath: options.gitPath })
      : null);

    if (!this.git) {
      this.enabled = false;
      log.warn('No rootDir supplied — checkpoints disabled');
    }

    /**
     * Turn latch: `${turnId}::${workdir}` for turns already snapshotted.
     * Bounded so a long-lived process can't grow it without limit.
     */
    this._snapshotted = new Set();
    this._maxLatchEntries = options.maxLatchEntries || 500;

    this._pruneMarker = this.rootDir ? path.join(this.rootDir, '.last-prune') : null;
    this._prunePromise = null;
  }

  /** Does this tool call warrant a snapshot? */
  isMutatingTool(toolName) {
    return this.mutatingTools.has(String(toolName || ''));
  }

  _latchKey(turnId, workdir) {
    return `${turnId}::${path.resolve(workdir).toLowerCase()}`;
  }

  /**
   * Called by the tool executor before a tool runs. Returns the snapshot
   * commit when one was taken, or null in every other case (disabled, not a
   * mutating tool, already snapshotted this turn, nothing changed, or a
   * failure — which is logged, never thrown).
   */
  async maybeSnapshot({ toolName, workdir, turnId, label } = {}) {
    if (!this.enabled) return null;
    if (!workdir || !turnId) return null;
    if (!this.isMutatingTool(toolName)) return null;

    const latch = this._latchKey(turnId, workdir);
    if (this._snapshotted.has(latch)) return null;

    // Latch BEFORE the await. Two mutating tools dispatched concurrently in
    // the same turn would otherwise both pass the check and race into two
    // snapshots of the same pre-turn state.
    this._snapshotted.add(latch);
    this._trimLatch();

    try {
      return await this.snapshot(workdir, {
        message: label || `turn ${turnId}: before ${toolName}`
      });
    } catch (err) {
      // A broken checkpoint store must never stop the user's work.
      log.warn(`Snapshot failed for ${workdir}: ${err.message}`);
      return null;
    }
  }

  _trimLatch() {
    if (this._snapshotted.size <= this._maxLatchEntries) return;
    // Sets iterate in insertion order, so this drops the oldest turns.
    const excess = this._snapshotted.size - this._maxLatchEntries;
    let dropped = 0;
    for (const key of this._snapshotted) {
      this._snapshotted.delete(key);
      if (++dropped >= excess) break;
    }
  }

  /** Forget a turn's latch. Optional — the bound handles it otherwise. */
  endTurn(turnId) {
    const prefix = `${turnId}::`;
    for (const key of this._snapshotted) {
      if (key.startsWith(prefix)) this._snapshotted.delete(key);
    }
  }

  /** Take a snapshot unconditionally. Throws on failure. */
  async snapshot(workdir, { message = 'checkpoint', allowEmpty = false } = {}) {
    if (!this.enabled) return null;

    const resolved = path.resolve(workdir);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Working directory does not exist: ${resolved}`);
    }

    if (!(await this.git.isAvailable())) {
      this.enabled = false;
      return null;
    }

    const key = projectKey(resolved);
    const commit = await this.git.snapshot(resolved, { key, message, allowEmpty });

    if (commit) {
      await this._touchProject(key, resolved);
      log.debug(`Checkpoint ${commit.slice(0, 8)} for ${resolved}`);
    }

    this.schedulePrune();
    return commit;
  }

  /** Snapshots for a working directory, newest first. */
  async list(workdir, { limit = 50 } = {}) {
    if (!this.git) return [];
    if (!(await this.git.isAvailable())) return [];

    const key = projectKey(path.resolve(workdir));
    try {
      return await this.git.listCommits(key, { limit });
    } catch (err) {
      log.warn(`Could not list checkpoints for ${workdir}: ${err.message}`);
      return [];
    }
  }

  /** Files a snapshot changed relative to the one before it. */
  async changes(workdir, checkpointId) {
    if (!this.git) return [];
    try {
      return await this.git.diffNames(checkpointId);
    } catch {
      return [];
    }
  }

  /**
   * Roll a working directory back to a snapshot.
   *
   * Always takes a safety snapshot of the current state first — both so the
   * rollback is itself undoable, and because ShadowGit.restore relies on the
   * index reflecting current state in order to delete files created after
   * the target snapshot.
   */
  async restore(workdir, checkpointId, { safetyLabel = 'before restore' } = {}) {
    if (!this.enabled) throw new Error('Checkpoints are disabled');
    if (!checkpointId) throw new Error('restore requires a checkpoint id');

    const resolved = path.resolve(workdir);
    const key = projectKey(resolved);

    const safety = await this.git.snapshot(resolved, {
      key,
      message: safetyLabel,
      allowEmpty: true
    });

    await this.git.restore(resolved, checkpointId, { key });
    await this._touchProject(key, resolved);

    log.info(`Restored ${resolved} to ${String(checkpointId).slice(0, 8)}`);
    return { restoredTo: checkpointId, safetyCheckpoint: safety };
  }

  async _touchProject(key, workdir) {
    const file = path.join(this.git.projectsDir, `${key}.json`);
    let record = { version: STATE_VERSION, workdir, createdAt: nowIso() };

    try {
      const existing = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      record = { ...existing, workdir };
    } catch {
      // First touch for this project.
    }

    record.lastTouch = nowIso();

    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async _readProject(key) {
    try {
      return JSON.parse(
        await fs.promises.readFile(path.join(this.git.projectsDir, `${key}.json`), 'utf8')
      );
    } catch {
      return null;
    }
  }

  /**
   * Kick off a prune at most once a day, in the background.
   *
   * Fire-and-forget by design: pruning must never add latency to a turn.
   */
  schedulePrune() {
    if (!this.enabled || this._prunePromise) return;
    if (!this._shouldPrune()) return;

    this._prunePromise = this.prune()
      .catch((err) => log.warn(`Prune failed: ${err.message}`))
      .finally(() => { this._prunePromise = null; });
  }

  _shouldPrune() {
    if (!this._pruneMarker) return false;
    try {
      const stat = fs.statSync(this._pruneMarker);
      return Date.now() - stat.mtimeMs > PRUNE_INTERVAL_MS;
    } catch {
      return true; // Never pruned.
    }
  }

  /**
   * Drop refs for projects that no longer exist on disk or have gone cold,
   * then reclaim the objects they held.
   */
  async prune({ force = false } = {}) {
    if (!this.git) return { dropped: [], scanned: 0 };
    if (!(await this.git.isAvailable())) return { dropped: [], scanned: 0 };

    const keys = await this.git.listProjectKeys();
    const dropped = [];
    const cutoff = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;

    for (const key of keys) {
      const record = await this._readProject(key);

      // An orphan: a ref with no project record, or one whose working
      // directory the user has since deleted or moved.
      const orphaned = !record?.workdir || !fs.existsSync(record.workdir);
      const stale = !force
        && record?.lastTouch
        && Date.parse(record.lastTouch) < cutoff;

      if (orphaned || stale || force) {
        await this.git.dropProject(key);
        dropped.push({ key, workdir: record?.workdir || null, reason: orphaned ? 'orphaned' : 'stale' });
      }
    }

    if (dropped.length > 0) {
      await this.git.pruneObjects();
      log.info(`Pruned ${dropped.length} checkpoint project(s)`);
    }

    await this._markPruned();
    return { dropped, scanned: keys.length };
  }

  async _markPruned() {
    if (!this._pruneMarker) return;
    try {
      await fs.promises.mkdir(path.dirname(this._pruneMarker), { recursive: true });
      await fs.promises.writeFile(this._pruneMarker, nowIso(), 'utf8');
    } catch {
      // A missing marker just means we re-prune sooner than ideal.
    }
  }
}

module.exports = {
  CheckpointManager,
  DEFAULT_MUTATING_TOOLS,
  DEFAULT_MAX_AGE_DAYS
};

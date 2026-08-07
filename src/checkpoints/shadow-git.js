/**
 * Shadow git — filesystem snapshots taken with git plumbing, in a store
 * that lives entirely outside the user's project.
 *
 * Why git at all: content-addressable storage gives us deduplication for
 * free. A turn that edits one file in a 5000-file repo costs one blob plus
 * a few tree objects, and two worktrees of the same repo share every
 * unchanged object.
 *
 * Why ONE store instead of a shadow repo per project: a per-project store
 * re-stores most of the project's files under its own objects/ directory
 * with zero sharing. A dozen worktrees of the same repo means a dozen full
 * copies. A single shared store lets git dedupe across projects and across
 * turns, so adding a worktree costs close to nothing.
 *
 * Nothing here ever touches the user's own git state. GIT_DIR points at our
 * store, GIT_WORK_TREE at their working directory, and GIT_INDEX_FILE at a
 * per-project index inside the store — so no .git is created, no index is
 * clobbered, and `git status` in their repo stays clean.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createLogger } = require('../logging');

const log = createLogger('shadow-git');

/**
 * Patterns excluded from every snapshot.
 *
 * `.git/` is the critical one and the least obvious: our GIT_WORK_TREE is
 * the user's project, but our GIT_DIR is elsewhere, so git does NOT treat
 * their `.git` as special — without this it would happily snapshot the
 * entire object database of the repo we're shadowing, on every turn.
 *
 * The rest are the usual heavy, regenerable directories. Snapshotting a
 * 200MB node_modules would make every turn feel broken.
 */
const DEFAULT_EXCLUDES = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  'bower_components/',
  'vendor/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  'target/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.cache/',
  '.parcel-cache/',
  '.gradle/',
  '.terraform/',
  'coverage/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  // Our own store, in the pathological case where a user's project
  // directory contains it.
  '.king-louie-checkpoints/'
];

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Stable 16-hex-char key for a working directory. */
function projectKey(workdir) {
  const normalized = path.resolve(String(workdir || '')).replace(/[\\/]+$/, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

class ShadowGit {
  /**
   * @param {object} options
   * @param {string} options.rootDir   Checkpoint root, e.g. <userData>/checkpoints.
   * @param {string} [options.gitPath] Git executable. Defaults to 'git' on PATH.
   * @param {string[]} [options.excludes] Overrides DEFAULT_EXCLUDES entirely.
   */
  constructor(options = {}) {
    this.rootDir = options.rootDir;
    if (!this.rootDir) throw new Error('ShadowGit requires a rootDir');

    this.storeDir = path.join(this.rootDir, 'store');
    this.gitPath = options.gitPath || 'git';
    this.excludes = Array.isArray(options.excludes) ? options.excludes : DEFAULT_EXCLUDES;
    this.timeoutMs = options.timeoutMs || GIT_TIMEOUT_MS;

    this._initPromise = null;
    this._available = null;
  }

  get indexesDir() { return path.join(this.storeDir, 'indexes'); }
  get projectsDir() { return path.join(this.storeDir, 'projects'); }

  indexFileFor(key) { return path.join(this.indexesDir, key); }
  refFor(key) { return `refs/kinglouie/${key}`; }

  /**
   * Run a git command against the shadow store.
   *
   * The three env vars are the whole trick: GIT_DIR sends all git metadata
   * to our store, GIT_WORK_TREE points at the files we're snapshotting, and
   * GIT_INDEX_FILE keeps each project's staging area separate so concurrent
   * projects can't corrupt each other's index.
   */
  _run(args, { workdir, key, env: extraEnv } = {}) {
    const env = {
      ...process.env,
      GIT_DIR: this.storeDir,
      // Never let the user's global hooks/templates/config run against our
      // store — a global `core.hooksPath` or commit signing config would
      // otherwise fire on every snapshot.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      HOME: process.env.HOME || process.env.USERPROFILE || '',
      ...extraEnv
    };

    if (workdir) env.GIT_WORK_TREE = workdir;
    if (key) env.GIT_INDEX_FILE = this.indexFileFor(key);

    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        args,
        {
          env,
          // Run from inside the worktree so a `.` pathspec and any
          // .gitignore lookups resolve against the user's project rather
          // than wherever the Electron process happens to be running.
          cwd: workdir || undefined,
          timeout: this.timeoutMs,
          maxBuffer: MAX_BUFFER,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            const err = new Error(
              `git ${args[0]} failed: ${String(stderr || error.message).trim()}`
            );
            err.cause = error;
            err.stderr = String(stderr || '');
            return reject(err);
          }
          resolve(String(stdout || ''));
        }
      );
    });
  }

  /** True when a usable git binary exists. Cached; never throws. */
  async isAvailable() {
    if (this._available !== null) return this._available;
    try {
      await new Promise((resolve, reject) => {
        execFile(
          this.gitPath,
          ['--version'],
          { timeout: 10_000, windowsHide: true },
          (error) => (error ? reject(error) : resolve())
        );
      });
      this._available = true;
    } catch {
      this._available = false;
      log.warn(`git not available at "${this.gitPath}" — checkpoints are disabled`);
    }
    return this._available;
  }

  /** Create the shared store once. Safe to call concurrently. */
  async init() {
    if (!this._initPromise) {
      this._initPromise = this._init().catch((err) => {
        // Let a later call retry rather than caching the failure forever.
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }

  async _init() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });

    const alreadyInitialized = fs.existsSync(path.join(this.storeDir, 'HEAD'));
    if (!alreadyInitialized) {
      await fs.promises.mkdir(this.storeDir, { recursive: true });
      // --bare: no worktree of its own. We supply GIT_WORK_TREE per call.
      await this._run(['init', '--bare', '--quiet', this.storeDir]);
    }

    await fs.promises.mkdir(this.indexesDir, { recursive: true });
    await fs.promises.mkdir(this.projectsDir, { recursive: true });

    // Snapshots must not depend on the user's identity or signing config,
    // which may prompt, fail, or be absent entirely.
    await this._run(['config', 'user.name', 'King Louie Checkpoints']);
    await this._run(['config', 'user.email', 'checkpoints@kinglouie.local']);
    await this._run(['config', 'commit.gpgsign', 'false']);
    await this._run(['config', 'gc.auto', '0']);
    // Snapshots are throwaway; compression is not worth the CPU on a
    // per-turn hot path.
    await this._run(['config', 'core.compression', '1']);

    await this._writeExcludes();
  }

  async _writeExcludes() {
    const infoDir = path.join(this.storeDir, 'info');
    await fs.promises.mkdir(infoDir, { recursive: true });
    const content = `${[
      '# Written by King Louie. Edits are overwritten on store upgrade.',
      ...this.excludes
    ].join('\n')}\n`;
    await fs.promises.writeFile(path.join(infoDir, 'exclude'), content, 'utf8');
  }

  /** Current tip commit for a project, or null when it has no snapshots. */
  async resolveRef(key) {
    try {
      const out = await this._run(['rev-parse', '--verify', '--quiet', this.refFor(key)]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Snapshot a working directory. Returns the commit sha, or null when
   * nothing changed since the previous snapshot.
   *
   * Uses plumbing (write-tree / commit-tree / update-ref) rather than
   * `git commit` because the store is bare and has no HEAD to move — and
   * because plumbing skips every hook and porcelain safety check.
   */
  async snapshot(workdir, { key = projectKey(workdir), message = 'checkpoint', allowEmpty = false } = {}) {
    await this.init();

    const opts = { workdir, key };

    // Stage everything, honoring info/exclude AND the project's own
    // .gitignore. `--all` picks up deletions too, so a snapshot is a true
    // point-in-time image rather than an additive one.
    //
    // Deliberately NOT `--force`: that flag overrides ignore rules, which
    // would drag node_modules and the user's .git into every snapshot. The
    // consequence is that gitignored files are not checkpointed — correct
    // for build output and caches, and a feature for .env files, which we
    // have no business copying into a shadow store.
    await this._run(['add', '--all', '.'], opts);

    const tree = (await this._run(['write-tree'], opts)).trim();
    const parent = await this.resolveRef(key);

    if (!allowEmpty && parent) {
      // Identical tree means no file changed. Recording another commit
      // would just add noise to the restore list.
      const parentTree = (await this._run(['rev-parse', `${parent}^{tree}`], opts)).trim();
      if (parentTree === tree) return null;
    }

    const commitArgs = ['commit-tree', tree, '-m', message];
    if (parent) commitArgs.push('-p', parent);

    const commit = (await this._run(commitArgs, opts)).trim();
    await this._run(['update-ref', this.refFor(key), commit], opts);

    return commit;
  }

  /**
   * Restore a working directory to a snapshot.
   *
   * `read-tree --reset -u` updates the working tree to match the target and
   * removes files that are in the index but not in the target — which is
   * why the caller must stage current state first (see
   * CheckpointManager.restore, which takes a safety snapshot for exactly
   * this reason). Without that, files created after the snapshot would
   * survive the restore.
   */
  async restore(workdir, commit, { key = projectKey(workdir) } = {}) {
    await this.init();
    const opts = { workdir, key };

    await this._run(['read-tree', '--reset', '-u', commit], opts);
  }

  /** Snapshots for a project, newest first. */
  async listCommits(key, { limit = 50 } = {}) {
    const tip = await this.resolveRef(key);
    if (!tip) return [];

    const out = await this._run([
      'log',
      `--max-count=${limit}`,
      '--format=%H%x1f%at%x1f%s',
      tip
    ]);

    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, at, subject] = line.split('\x1f');
        return {
          id: sha,
          createdAt: new Date(Number(at) * 1000).toISOString(),
          message: subject || ''
        };
      });
  }

  /** Files changed between two snapshots (or a snapshot and its parent). */
  async diffNames(commit, base = null) {
    const args = base
      ? ['diff', '--name-status', base, commit]
      : ['diff', '--name-status', `${commit}^`, commit];

    try {
      const out = await this._run(args);
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [status, ...rest] = line.split('\t');
          return { status, path: rest.join('\t') };
        });
    } catch {
      // A root commit has no parent — everything in it is new.
      return [];
    }
  }

  /** Drop a project's ref and index. Objects are reclaimed by pruneObjects(). */
  async dropProject(key) {
    try {
      await this._run(['update-ref', '-d', this.refFor(key)]);
    } catch {
      // Already gone.
    }
    await fs.promises.rm(this.indexFileFor(key), { force: true });
    await fs.promises.rm(path.join(this.projectsDir, `${key}.json`), { force: true });
  }

  /** Every project key that currently has a ref. */
  async listProjectKeys() {
    try {
      const out = await this._run(['for-each-ref', '--format=%(refname)', 'refs/kinglouie/']);
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((ref) => ref.replace('refs/kinglouie/', ''));
    } catch {
      return [];
    }
  }

  /** Reclaim disk from unreachable objects after refs are dropped. */
  async pruneObjects() {
    await this._run(['reflog', 'expire', '--expire=now', '--all']).catch(() => {});
    await this._run(['gc', '--prune=now', '--quiet']).catch(() => {});
  }
}

module.exports = {
  ShadowGit,
  projectKey,
  DEFAULT_EXCLUDES
};

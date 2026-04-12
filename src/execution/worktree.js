const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

/**
 * Worktree — git worktree isolation for concurrent agent execution.
 *
 * Creates a git worktree so an agent can work on a separate copy of
 * the repo without interfering with the main working directory. This
 * prevents concurrent agents from corrupting each other's edits.
 *
 * Lifecycle:
 *  1. create() — creates a worktree with a new branch
 *  2. Agent runs in the worktree directory
 *  3. cleanup() — removes the worktree (and branch if no changes)
 *
 * Worktrees are stored in .king-louie/worktrees/<slug>/
 */

const WORKTREE_BASE = '.king-louie/worktrees';

/**
 * Sanitize a name for use as a worktree directory/branch slug.
 */
function sanitizeSlug(name) {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50) || 'worktree';
}

/**
 * Create a git worktree for isolated agent execution.
 *
 * @param {string} repoDir - the main repository directory
 * @param {string} taskId - unique task identifier for naming
 * @param {object} [options]
 * @param {string} [options.baseBranch] - branch to base the worktree on (default: HEAD)
 * @param {boolean} [options.symlinkNodeModules] - symlink node_modules from main repo
 * @returns {{ worktreePath: string, branch: string, cleanup: Function }}
 */
async function createWorktree(repoDir, taskId, options = {}) {
  const slug = sanitizeSlug(taskId);
  const branch = `worktree-${slug}-${Date.now()}`;
  const worktreeDir = path.join(repoDir, WORKTREE_BASE, slug);

  // Ensure base directory exists
  fs.mkdirSync(path.join(repoDir, WORKTREE_BASE), { recursive: true });

  // Clean up any stale worktree at this path
  if (fs.existsSync(worktreeDir)) {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreeDir], {
        cwd: repoDir,
        timeout: 10000
      });
    } catch {
      // May not exist in git's worktree list — just remove the directory
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  }

  // Create the worktree
  const baseBranch = options.baseBranch || 'HEAD';
  await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreeDir, baseBranch], {
    cwd: repoDir,
    timeout: 30000
  });

  // Optionally symlink node_modules to avoid install overhead
  if (options.symlinkNodeModules !== false) {
    const mainNodeModules = path.join(repoDir, 'node_modules');
    const worktreeNodeModules = path.join(worktreeDir, 'node_modules');
    if (fs.existsSync(mainNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      try {
        // Use junction on Windows, symlink on Unix
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        fs.symlinkSync(mainNodeModules, worktreeNodeModules, type);
      } catch (err) {
        console.warn(`[worktree] Failed to symlink node_modules: ${err.message}`);
      }
    }
  }

  const cleanup = async () => {
    try {
      // Check if worktree has uncommitted changes
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: worktreeDir,
        timeout: 5000
      });

      const hasChanges = statusOut.trim().length > 0;

      // Remove the worktree
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreeDir], {
        cwd: repoDir,
        timeout: 10000
      });

      // Delete the branch if no commits were made (clean worktree)
      if (!hasChanges) {
        try {
          await execFileAsync('git', ['branch', '-D', branch], {
            cwd: repoDir,
            timeout: 5000
          });
        } catch {
          // Branch may not exist if worktree was already removed
        }
      }

      return { cleaned: true, hasChanges, branch: hasChanges ? branch : null };
    } catch (err) {
      console.warn(`[worktree] Cleanup failed for ${slug}: ${err.message}`);
      // Force remove the directory as fallback
      try {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      } catch { /* best effort */ }
      return { cleaned: false, error: err.message };
    }
  };

  return {
    worktreePath: worktreeDir,
    branch,
    slug,
    cleanup
  };
}

/**
 * List all active worktrees for a repository.
 */
async function listWorktrees(repoDir) {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoDir,
      timeout: 5000
    });

    const worktrees = [];
    let current = {};

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9).trim() };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5).trim();
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).trim();
      } else if (line === 'detached') {
        current.detached = true;
      }
    }
    if (current.path) worktrees.push(current);

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Clean up all worktrees in the .king-louie/worktrees directory.
 */
async function cleanupAllWorktrees(repoDir) {
  const worktreeBase = path.join(repoDir, WORKTREE_BASE);
  if (!fs.existsSync(worktreeBase)) return;

  const entries = fs.readdirSync(worktreeBase, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = path.join(worktreeBase, entry.name);
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoDir,
        timeout: 10000
      });
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }
}

module.exports = { createWorktree, listWorktrees, cleanupAllWorktrees, sanitizeSlug };

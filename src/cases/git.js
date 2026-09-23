// src/cases/git.js
// Minimal git CLI wrapper for case repositories. Every call is execFile with
// an argument array, so titles and messages are never shell-interpreted.
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

class GitUnavailableError extends Error {
  constructor() {
    super('git is required for cases but was not found on PATH.');
    this.name = 'GitUnavailableError';
    this.code = 'GIT_UNAVAILABLE';
  }
}

async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function isGitAvailable() {
  try {
    await run('git', ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function initRepo(dir) {
  await git(dir, ['init', '-q']);
  // Local identity so commits work on machines with no global git config.
  await git(dir, ['config', 'user.name', 'King Louie']);
  await git(dir, ['config', 'user.email', 'king-louie@localhost']);
  // facts.jsonl must stay byte-identical across platforms.
  await git(dir, ['config', 'core.autocrlf', 'false']);
}

async function isDirty(dir) {
  return (await git(dir, ['status', '--porcelain'])).trim().length > 0;
}

async function commitAll(dir, message) {
  if (!(await isDirty(dir))) return null;
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}

module.exports = { git, isGitAvailable, initRepo, isDirty, commitAll, GitUnavailableError };

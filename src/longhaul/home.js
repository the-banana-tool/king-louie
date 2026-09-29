'use strict';
// LONGHAUL_HOME (benchmark spec B-D12, §10.1): private/, sessions/,
// questions/, runs/ and reports/. It is refused inside a git working tree,
// checked on the path as given and on the path with links resolved, so a
// junction or symlink into a repository is refused too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageError } = require('./errors');
const { isInside } = require('./files');

const SUBDIRS = Object.freeze(['private', 'sessions', 'questions', 'runs', 'reports']);

function findGitWorkTree(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The path with links resolved as far as it exists; the missing tail is kept.
function nearestRealPath(target) {
  let cur = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try { real = fs.realpathSync.native(cur); } catch { /* keep the lexical path */ }
  return path.join(real, ...rest);
}

function resolveHome(env = process.env, { homedir } = {}) {
  const raw = typeof env.LONGHAUL_HOME === 'string' ? env.LONGHAUL_HOME.trim() : '';
  const root = path.resolve(raw || path.join((homedir || os.homedir)(), '.longhaul'));
  for (const candidate of [root, nearestRealPath(root)]) {
    const tree = findGitWorkTree(candidate);
    if (tree) throw inGitTreeError('LONGHAUL_HOME', root, tree);
  }
  const home = { root };
  for (const d of SUBDIRS) home[d] = path.join(root, d);
  return home;
}

function inGitTreeError(what, where, tree) {
  return new UsageError(
    `${what} (${where}) is inside the git working tree at ${tree}. `
    + 'Session data must never live in a repository; set LONGHAUL_HOME to a directory outside it.',
    'HOME_IN_GIT_TREE'
  );
}

// Every subdirectory is checked too, once it exists: one that is a junction or
// symlink into a repository, or anywhere outside the home, is refused.
function ensureDirs(home) {
  for (const d of SUBDIRS) fs.mkdirSync(home[d], { recursive: true });
  const rootReal = nearestRealPath(home.root);
  for (const d of SUBDIRS) {
    const real = nearestRealPath(home[d]);
    for (const candidate of [home[d], real]) {
      const tree = findGitWorkTree(candidate);
      if (tree) throw inGitTreeError(`LONGHAUL_HOME/${d}`, real, tree);
    }
    if (!isInside(real, rootReal)) {
      throw new UsageError(
        `LONGHAUL_HOME/${d} (${home[d]}) resolves to ${real}, outside LONGHAUL_HOME (${rootReal}). `
        + 'Remove the link so the directory lives inside LONGHAUL_HOME.',
        'HOME_IN_GIT_TREE'
      );
    }
  }
  return home;
}

module.exports = { SUBDIRS, resolveHome, ensureDirs, findGitWorkTree };

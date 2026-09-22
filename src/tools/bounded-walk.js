// Bounds the directory walk that Grep and Glob do.
//
// Both tools are ungated — no approval, so any remote origin that can get a
// tool call executed can run them. fast-glob follows directory symlinks by
// default and has no cycle detection, so `<ws>/dlink -> <ws>` (or a pair of
// links pointing at each other) makes the walk revisit the same directories
// for ever. A reviewer reproduced it and Node died with "Ineffective
// mark-compacts near heap limit ... heap out of memory". Availability only,
// but killing the process or pinning a core is not something a chat message
// should be able to do.
//
// Two bounds, both cheap:
//
//   1. A depth cap, so even a loop fast-glob's own logic misses terminates.
//   2. A per-run set of directory real paths. A directory symlink is followed
//      only the first time its target is seen; a link back to an ancestor, a
//      link to itself and a link to another link all resolve to a real path
//      that has already been walked, and are left as symlink entries — which
//      is exactly what fast-glob does with `followSymbolicLinks: false`, but
//      only for the entries that would loop.
//
// A symlink to a genuinely new directory is still followed, so the ordinary
// reason to have one (a shared source tree, a linked package) keeps working.
const fs = require('fs');
const path = require('path');

// Deep enough that no real tree hits it; shallow enough that a cycle the
// visited-set somehow misses still ends. Node's own path handling gives up
// long before this on most platforms.
const MAX_DEPTH = 40;

function realPathOrNull(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch {
    return null;
  }
}

// fast-glob's scandir calls `fs.stat` on every symlink entry to decide whether
// to descend (@nodelib/fs.scandir makeRplTaskEntry). Returning the symlink's
// own lstat instead of the target's turns that entry back into a symlink, so
// the walker treats it as a leaf. Nothing else about the entry changes.
function createBoundedFs(baseDir) {
  const visited = new Set();
  const base = realPathOrNull(baseDir);
  if (base) visited.add(base);

  const shouldStopAt = (entryPath) => {
    const real = realPathOrNull(entryPath);
    // A dangling or unreadable link: let the normal error path handle it.
    if (real === null) return false;
    if (visited.has(real)) return true;
    visited.add(real);
    return false;
  };

  const substitute = (entryPath, stats) => {
    if (!stats || !stats.isDirectory() || !shouldStopAt(entryPath)) return stats;
    try {
      return fs.lstatSync(entryPath);
    } catch {
      return stats;
    }
  };

  return {
    stat(entryPath, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      fs.stat(entryPath, (err, stats) => {
        if (err) return callback(err);
        callback(null, substitute(entryPath, stats));
      });
    },
    statSync(entryPath, options) {
      return substitute(entryPath, fs.statSync(entryPath, options));
    }
  };
}

// Merges the bounds into the options a caller hands fast-glob. `deep` is only
// lowered, never raised: a caller that already asked for a shallower walk
// keeps it.
function boundedGlobOptions(options = {}) {
  const baseDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  return {
    ...options,
    deep: Math.min(Number.isFinite(options.deep) ? options.deep : MAX_DEPTH, MAX_DEPTH),
    fs: { ...createBoundedFs(baseDir), ...(options.fs || {}) }
  };
}

module.exports = { boundedGlobOptions, createBoundedFs, MAX_DEPTH };

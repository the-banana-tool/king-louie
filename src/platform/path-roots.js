const fs = require('fs');
const path = require('path');

// Lives on its own, with no requires beyond node built-ins, because the
// runbook engine needs it and the runbook profile must never load the agent
// stack (tests/service-profile-graph.test.js). safety-policy.js pulls in the
// whole tool registry, so the engine cannot reach this through it.

// The real location of `p`: symlinks in every existing ancestor are resolved,
// and whatever does not exist yet (a download destination, say) is appended
// unresolved — nothing can be linked there until it exists.
function realResolve(p) {
  const resolved = path.resolve(p);
  const missing = [];
  let current = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when targetPath, after realpath, lies under one of allowedRoots (also
 * realpath'd). An empty or non-string target is never under a root: callers
 * that treat "no path" as fine must say so themselves.
 */
function isPathUnderRoots(targetPath, allowedRoots = []) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;

  const realTarget = realResolve(targetPath);
  for (const root of allowedRoots) {
    const relative = path.relative(realResolve(root), realTarget);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

module.exports = { isPathUnderRoots, realResolve };

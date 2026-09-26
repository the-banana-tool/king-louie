// src/cases/safe-path.js
// Where a tool's target path really lands relative to a guarded directory.
// Shared by C2's case-file write guard (chat-integration isProtectedCasePath)
// and the C3 case-turn guard (ops memory, executors, workflows). A path is
// compared after the tricks the file system would undo: Windows long-path
// and device prefixes, links and junctions, 8.3 short names (both resolved
// by the native realpath), NTFS stream suffixes, trailing dots and spaces,
// and letter case on case-insensitive platforms.
const fs = require('fs');
const path = require('path');

// A Windows long-path prefix (`\\?\` or `\\.\`) opts a path out of the usual
// MAX_PATH / normalization rules. Strip it before doing anything else so the
// rest sees an ordinary path.
const LONG_PATH_PREFIX = /^\\\\[?.]\\/;

function stripLongPathPrefix(p) {
  return p.replace(LONG_PATH_PREFIX, '');
}

// Resolve as much of `absPath` as already exists on disk to its real path
// (following symlinks and Windows junctions), then re-append whatever
// doesn't exist yet, unchanged. This defeats a link that points *into* a
// guarded directory from outside it, without requiring the whole path to
// already exist (the file being written usually doesn't, yet).
function realpathNearest(absPath) {
  let current = absPath;
  const remainder = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return remainder.length ? path.join(real, ...remainder) : real;
    } catch (err) {
      const parent = path.dirname(current);
      if (parent === current) return absPath; // hit the root; nothing left to resolve
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

// NTFS and APFS/HFS+ are case-insensitive by default; comparing case-
// sensitively there lets `FACTS.JSONL` name the file the guard protects.
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

// → the segments of `target` below `baseDir` ([] for baseDir itself), each
// case-folded with any stream suffix (`name::$DATA`, everything from the
// first ':') and trailing dots/spaces dropped (the Win32 file APIs strip
// both, so `facts.jsonl.` is `facts.jsonl`); null when it is outside.
function segmentsWithin(baseDir, target) {
  if (!baseDir || !target) return null;
  const base = realpathNearest(path.resolve(stripLongPathPrefix(String(baseDir))));
  const resolved = realpathNearest(path.resolve(stripLongPathPrefix(String(target))));
  const rel = path.relative(base, resolved);
  if (path.isAbsolute(rel)) return null;
  if (rel === '') return [];
  const raw = rel.split(/[\\/]/);
  // Outside only when a whole segment is `..`: `..x.js` is a file name.
  if (raw[0] === '..') return null;
  return raw.map((seg) => {
    const streamCut = seg.indexOf(':');
    const name = (streamCut === -1 ? seg : seg.slice(0, streamCut)).replace(/[. ]+$/, '');
    return FOLD_CASE ? name.toLowerCase() : name;
  });
}

module.exports = { segmentsWithin, realpathNearest, stripLongPathPrefix };

// src/cases/safe-path.js
// Where a tool's target path really lands relative to a guarded directory.
// Shared by C2's case-file write guard (chat-integration isProtectedCasePath)
// and the C3 case-turn guard (ops memory, executors, workflows). A path is
// compared after the tricks the file system would undo: Windows long-path
// and device prefixes, links and junctions, 8.3 short names (both resolved
// by the native realpath), NTFS stream suffixes, trailing dots and spaces,
// and letter case on case-insensitive platforms. A path that still looks
// outside is then compared by file identity, because on Windows one
// directory has more spellings than any list holds (see identitySegments).
const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';

// A Windows long-path prefix (`\\?\` or `\\.\`) opts a path out of the usual
// MAX_PATH / normalization rules. In front of a drive path it is stripped,
// and `\\?\UNC\host\share` becomes `\\host\share`, so the rest sees an
// ordinary path. Any other namespace path (`\\?\GLOBALROOT\…`,
// `\\?\Volume{…}\…`) is left as it is: without its prefix it would be a
// relative path, and be resolved under the working directory.
const DRIVE_LONG_PREFIX = /^\\\\[?.]\\(?=[A-Za-z]:(?:[\\/]|$))/;
const UNC_LONG_PREFIX = /^\\\\[?.]\\UNC\\/i;

function stripLongPathPrefix(p) {
  if (UNC_LONG_PREFIX.test(p)) return p.replace(UNC_LONG_PREFIX, '\\\\');
  return p.replace(DRIVE_LONG_PREFIX, '');
}

// Absolute, and without the long-path prefix where it can go. On Windows
// the path is resolved first, so `//?/C:/x` is read as `\\?\C:\x`.
function absolute(p) {
  const text = String(p);
  return path.resolve(stripLongPathPrefix(WIN ? path.resolve(text) : text));
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
const FOLD_CASE = WIN || process.platform === 'darwin';

// A segment as the file system reads it: any stream suffix (`name::$DATA`,
// everything from the first ':') and trailing dots/spaces dropped (the Win32
// file APIs strip both, so `facts.jsonl.` is `facts.jsonl`), case-folded.
function cleanSegment(seg) {
  const streamCut = seg.indexOf(':');
  const name = (streamCut === -1 ? seg : seg.slice(0, streamCut)).replace(/[. ]+$/, '');
  return FOLD_CASE ? name.toLowerCase() : name;
}

// By spelling: the raw segments of `resolved` below `base`, or null.
function lexicalSegments(base, resolved) {
  const rel = path.relative(base, resolved);
  if (path.isAbsolute(rel)) return null;
  if (rel === '') return [];
  const raw = rel.split(/[\\/]/);
  // Outside only when a whole segment is `..`: `..x.js` is a file name.
  return raw[0] === '..' ? null : raw;
}

// Which file or directory a path names, whatever it is called: the volume
// and the file's index on it. → { id }, { missing: true } when nothing is
// there, or {} when it cannot be read (an error other than "no such file",
// or a file system that reports no index).
function identityOf(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    return st.ino === 0n ? {} : { id: `${st.dev}:${st.ino}` };
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? { missing: true } : {};
  }
}

// By identity, for a path whose spelling is outside `base`. On Windows the
// same directory answers to `\\localhost\C$\…`, `\\127.0.0.1\C$\…`, the
// machine's own name and addresses, a mapped drive, and more: no rewrite of
// prefixes can list them. So take the nearest ancestor of `base` that exists
// and look for it among the ancestors of the target, one stat per level.
// A match places the target; what lies below it is compared as text.
function identitySegments(base, resolved) {
  let anchor = base;
  let anchorId = null;
  const below = []; // the part of base that does not exist yet
  for (;;) {
    const found = identityOf(anchor);
    if (found.id) {
      anchorId = found.id;
      break;
    }
    const parent = path.dirname(anchor);
    if (!found.missing || parent === anchor) break;
    below.unshift(cleanSegment(path.basename(anchor)));
    anchor = parent;
  }
  // Once the native realpath has run, only a UNC or device-namespace path
  // can still be a second name for a local directory; a drive path is where
  // it says it is.
  const aliasable = WIN && resolved.startsWith('\\\\');
  if (!anchorId) return { segments: null, unverifiable: aliasable };

  let current = resolved;
  let unreadable = false;
  const rest = [];
  for (;;) {
    const found = identityOf(current);
    if (found.id === anchorId) {
      const cleaned = rest.map(cleanSegment);
      const inside = cleaned.length >= below.length && below.every((seg, i) => cleaned[i] === seg);
      return { segments: inside ? cleaned.slice(below.length) : null, unverifiable: false };
    }
    if (!found.id && !found.missing) unreadable = true;
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  // No ancestor is the guarded directory. That proves the path is outside
  // only when every ancestor that exists could be read.
  return { segments: null, unverifiable: aliasable && unreadable };
}

// → { segments, unverifiable }. `segments` are those of `target` below
// `baseDir` ([] for baseDir itself), each cleaned as cleanSegment says; null
// when it is outside. `unverifiable` is true when that null is not a
// finding: a Windows UNC or device-namespace path, some ancestor of which
// (or the guarded directory itself) gave no identity to compare, so it may
// be the guarded directory under another name. A guard that allows what is
// outside must refuse such a path.
function locateWithin(baseDir, target) {
  if (!baseDir || !target) return { segments: null, unverifiable: false };
  const base = realpathNearest(absolute(baseDir));
  const resolved = realpathNearest(absolute(target));
  const raw = lexicalSegments(base, resolved);
  if (raw) return { segments: raw.map(cleanSegment), unverifiable: false };
  return identitySegments(base, resolved);
}

// → the segments of `target` below `baseDir`, or null when it is outside or
// cannot be placed. Enough for a caller that refuses on null; one that
// allows on null uses locateWithin and refuses `unverifiable`.
function segmentsWithin(baseDir, target) {
  return locateWithin(baseDir, target).segments;
}

// What a write guard tells the model about an unverifiable path.
const UNVERIFIABLE_PATH_ERROR = 'That network or device path could not be confirmed to lie outside the files King Louie guards in a case, so nothing was written. Use an ordinary path (a drive letter, or a path relative to the working directory).';

module.exports = { segmentsWithin, locateWithin, realpathNearest, stripLongPathPrefix, UNVERIFIABLE_PATH_ERROR };

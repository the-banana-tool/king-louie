'use strict';
// Small file helpers for LongHaul: atomic writes (temp file, fsync, rename),
// streaming SHA-256, path containment, JSON lines, and a code-point string
// order.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    if (typeof content === 'function') content((text) => fs.writeSync(fd, text));
    else fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// path.join(base, name), refused unless the result is strictly inside base
// (defence in depth behind session id validation).
function childPath(base, name, onEscape) {
  const out = path.join(base, name);
  if (path.resolve(out) === path.resolve(base) || !isInside(out, base)) throw onEscape();
  return out;
}

// The rows of a JSON-lines file; a missing file has none. tornTail: a line
// that does not parse ends the file (a write cut off mid-line, as an
// interrupted append leaves); otherwise it throws.
function readJsonl(file, { tornTail = false } = {}) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      if (tornTail) break;
      throw err;
    }
  }
  return out;
}

// A sort order that is the same on every machine: UTF-16 code units, never
// the locale's collation (localeCompare), so the same runs give the same
// files and samples everywhere.
function byCodePoint(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = { writeFileAtomic, sha256File, sha256Text, isInside, childPath, readJsonl, byCodePoint };

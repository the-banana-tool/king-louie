'use strict';
// Small file helpers for LongHaul: atomic writes (temp file, fsync, rename),
// streaming SHA-256, and path containment.
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

module.exports = { writeFileAtomic, sha256File, sha256Text, isInside, childPath };

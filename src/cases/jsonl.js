// src/cases/jsonl.js
// Shared JSONL helpers for the case files (facts.jsonl, decisions.jsonl,
// recommendations.jsonl). Appends never glue onto a line that lost its
// final newline (hand edit or a crash mid-write).
const fs = require('fs');

const norm = (v) => String(v ?? '').trim().toLowerCase();

function endsWithNewline(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function appendJsonl(file, obj) {
  const lead = endsWithNewline(file) ? '' : '\n';
  fs.appendFileSync(file, `${lead}${JSON.stringify(obj)}\n`);
}

// Returns { entries, errors }; errors carry the 1-based line number. `check`
// may throw to reject a parsed value.
function readJsonl(file, check) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const entries = [];
  const errors = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    try {
      const value = JSON.parse(line);
      if (check) check(value);
      entries.push(value);
    } catch (err) {
      errors.push({ line: i + 1, message: err.message });
    }
  });
  return { entries, errors };
}

module.exports = { appendJsonl, readJsonl, norm };

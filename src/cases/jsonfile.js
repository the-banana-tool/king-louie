// src/cases/jsonfile.js
// Small JSON files under a case's .kl/: read with a fallback, write through
// a temp file and a rename, and skip the write when nothing changed so a
// quiet sweep leaves a clean git tree.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('cases/jsonfile');

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    log.warn(`${file} is not valid JSON (${err.message}); using defaults.`);
    return fallback;
  }
}

// Raw atomic write (temp file + rename) for callers that need it on text
// that isn't a JSON.stringify of a value (e.g. JSONL files, cursor files).
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonIfChanged(file, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (current === next) return false;
  writeJson(file, value);
  return true;
}

module.exports = { readJson, writeJson, writeJsonIfChanged, writeAtomic };

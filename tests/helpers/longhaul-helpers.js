// tests/helpers/longhaul-helpers.js
// Shared bits for the LongHaul tests: temp directories (never inside the
// repository, so LONGHAUL_HOME's git-tree refusal does not fire) and an
// output sink standing in for stdout/stderr.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO, 'tests', 'fixtures', 'longhaul');

function tmpDir(prefix = 'longhaul-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sink() {
  return { text: '', write(s) { this.text += String(s); return true; } };
}

function tmpHome() {
  const root = path.join(tmpDir(), 'lh');
  return { env: { LONGHAUL_HOME: root }, root };
}

module.exports = { REPO, FIXTURE_ROOT, tmpDir, sink, tmpHome };

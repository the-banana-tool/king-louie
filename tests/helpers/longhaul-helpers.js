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

// Marks a session private, as `longhaul import` does a real one.
function makePrivate(root, sessionId) {
  const file = path.join(root, 'sessions', sessionId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, private: true, license: 'private' }, null, 2)}
`);
}

module.exports = { REPO, FIXTURE_ROOT, tmpDir, sink, tmpHome, makePrivate };

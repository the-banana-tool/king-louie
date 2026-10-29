// tests/tracked-secrets.test.js — push spec C-15: the owner's Firebase app
// config, any local.properties and any service-account key never enter git.
// Each is the owner's own (a Firebase project, a machine's SDK path and
// application id, a key that can send pushes); the repository holds only
// invented values. Runs over `git ls-files`; skipped where git or a work
// tree is not available (a source archive, a sandbox without git).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Why a tracked path must not be there, or null when it may be.
function secretReason(file) {
  const base = path.posix.basename(String(file).replace(/\\/g, '/')).toLowerCase();
  if (base === 'google-services.json') return 'a Firebase app config (the owner\'s project)';
  if (base === 'local.properties') return 'a local.properties (this machine\'s SDK path and application id)';
  if (base.includes('service-account') && base.endsWith('.json')) return 'a service-account key';
  return null;
}

function trackedFiles() {
  let run;
  try {
    run = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  if (run.error || run.status !== 0) return null;
  return run.stdout.split('\0').filter(Boolean);
}

describe('tracked secrets (push spec C-15)', () => {
  it('names the Firebase config, any local.properties and any service-account JSON', () => {
    for (const file of [
      'mobile/android/app/src/fcm/google-services.json',
      'mobile/android/app/google-services.json',
      'mobile/android/local.properties',
      'local.properties',
      'tools/local.properties',
      'kl-push-service-account.json',
      'deploy/fcm-service-account.json',
      'etc\\Service-Account-Key.JSON'
    ]) {
      assert.ok(secretReason(file), `${file} is caught`);
    }
    for (const file of [
      'mobile/android/local.properties.example',
      'docs/service-account.md',
      'src/frontdoor/push/service-account.js',
      'tests/fixtures/push/service-account.json.example',
      'package.json',
      'google-services.json.md'
    ]) {
      assert.equal(secretReason(file), null, `${file} is allowed`);
    }
  });

  it('none is tracked by git', (t) => {
    const files = trackedFiles();
    if (files === null) {
      t.skip('git is not available here');
      return;
    }
    assert.ok(files.length > 0, 'git ls-files lists the repository');
    const found = files.map((f) => [f, secretReason(f)]).filter(([, reason]) => reason).map(([f, reason]) => `${f}: ${reason}`);
    assert.deepEqual(found, [], 'remove these from the index (git rm --cached) and keep them ignored');
  });
});

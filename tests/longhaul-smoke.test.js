// tests/longhaul-smoke.test.js
// The CI smoke run (benchmark spec §14): the real CLI over the committed
// synthetic fixtures with sliding-window and oracle. No models, no network.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, tmpHome } = require('./helpers/longhaul-helpers');

describe('longhaul smoke run', () => {
  it('scores the fixtures; oracle recovers every planted fact and nothing leaks', () => {
    const { root } = tmpHome();
    const out = spawnSync(process.execPath, [
      path.join('bin', 'longhaul.js'), 'run', '--sessions', path.join('tests', 'fixtures', 'longhaul'), '--adapters', 'sliding-window,oracle'
    ], { cwd: REPO, encoding: 'utf8', env: { ...process.env, LONGHAUL_HOME: root } });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /oracle\s+evidence recall 1\.000/);
    const [runId] = fs.readdirSync(path.join(root, 'runs'));
    const dir = path.join(root, 'runs', runId);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.oracle.evidenceRecall, 1);
    assert.ok(summary['sliding-window'].evidenceRecall <= 1);
    assert.strictEqual(summary.oracle.leaks + summary['sliding-window'].leaks, 0);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepStrictEqual(config.sessions.map((s) => s.sessionId), ['synth-compacted', 'synth-medium', 'synth-small']);
    assert.ok(config.sessions.every((s) => s.private === false));
  });
});

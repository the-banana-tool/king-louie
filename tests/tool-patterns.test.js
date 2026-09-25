// tests/tool-patterns.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const patterns = require('../src/execution/tool-patterns');
const policy = require('../src/execution/safety-policy');

const ROOT = path.join(__dirname, '..');
const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

describe('tool-patterns', () => {
  it('is dependency-free: loading it pulls in no other project module', () => {
    const script = `require('./src/execution/tool-patterns'); process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
    const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT }).toString())
      .map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
    assert.deepEqual(loaded, ['src/execution/tool-patterns.js']);
  });

  it('safety-policy re-exports the same functions', () => {
    for (const name of ['formatToolPattern', 'patternMatch', 'splitShellSegments', 'normalizeWhitespace', 'SHELL_SEPARATORS']) {
      assert.equal(policy[name], patterns[name], name);
    }
  });

  it('keeps the helpers behaving as before', () => {
    assert.equal(patterns.formatToolPattern('Bash', { command: 'git push' }), 'Bash(git push)');
    assert.deepEqual(patterns.splitShellSegments('cd x &&  git push ; ls'), ['cd x', 'git push', 'ls']);
    assert.equal(patterns.patternMatch('Bash(git push*)', 'Bash(git  push origin)'), true);
    assert.equal(patterns.normalizeWhitespace(' a \t b '), 'a b');
  });
});

describe('classifyToolCall with { cwd }', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-tier-cwd-'));
  tmp.push(base);
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  const rules = { allowed_roots: [root], remote_sessions: { always_confirm: [], deny: [] } };

  it('resolves a relative file_path against cwd, not process.cwd()', () => {
    assert.equal(policy.classifyToolCall('Read', { file_path: 'notes.txt' }, rules, { cwd: root }).tier, 'read');
    const outside = policy.classifyToolCall('Read', { file_path: '../secret.txt' }, rules, { cwd: root });
    assert.deepEqual(outside, { tier: 'unsafe', reason: 'path_outside_allowed_roots' });
  });

  it('checks every edits[].file_path', () => {
    const inside = { edits: [{ file_path: path.join(root, 'a.txt') }] };
    const mixed = { edits: [{ file_path: path.join(root, 'a.txt') }, { file_path: path.join(base, 'b.txt') }] };
    assert.notEqual(policy.classifyToolCall('KlNoSuchTool', inside, rules, { cwd: root }).tier, 'unsafe');
    assert.equal(policy.classifyToolCall('KlNoSuchTool', mixed, rules, { cwd: root }).reason, 'path_outside_allowed_roots');
  });

  it('extractPathsFromParameters leaves absolute paths alone and keeps the old behaviour without cwd', () => {
    const abs = path.join(root, 'x');
    assert.deepEqual(policy.extractPathsFromParameters('Read', { file_path: abs }, root), [abs]);
    assert.deepEqual(policy.extractPathsFromParameters('Read', { file_path: 'rel' }), ['rel']);
  });
});

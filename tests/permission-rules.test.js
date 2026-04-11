const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluateRules, compilePattern, describeRule } = require('../src/tools/permission-rules');

describe('compilePattern', () => {
  it('matches exact strings case-insensitively', () => {
    const re = compilePattern('git status');
    assert.ok(re.test('git status'));
    assert.ok(re.test('GIT STATUS'));
    assert.ok(!re.test('git status --short'));
  });

  it('treats * as a wildcard', () => {
    const re = compilePattern('git *');
    assert.ok(re.test('git status'));
    assert.ok(re.test('git push origin main'));
    assert.ok(!re.test('npm test'));
  });

  it('escapes regex metacharacters', () => {
    const re = compilePattern('echo (hi)');
    assert.ok(re.test('echo (hi)'));
    assert.ok(!re.test('echo hi'));
  });

  it('treats whitespace as flexible', () => {
    const re = compilePattern('npm  test');
    assert.ok(re.test('npm test'));
    assert.ok(re.test('npm  test'));
  });

  it('falls back to match-all on empty pattern', () => {
    assert.ok(compilePattern('').test('anything'));
    assert.ok(compilePattern('*').test(''));
  });
});

describe('evaluateRules', () => {
  it('returns matched=false for empty rules', () => {
    assert.deepStrictEqual(
      evaluateRules([], 'Bash', { command: 'rm -rf /' }),
      { matched: false }
    );
  });

  it('matches the first rule that fires (deny wins over later allow)', () => {
    const rules = [
      { tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'safety' },
      { tool: 'Bash', pattern: '*', action: 'allow', source: 'session' }
    ];
    const result = evaluateRules(rules, 'Bash', { command: 'rm -rf /' });
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.action, 'deny');
    assert.strictEqual(result.rule.source, 'safety');
  });

  it('skips rules for other tools', () => {
    const rules = [
      { tool: 'Edit', pattern: '*', action: 'allow' },
      { tool: 'Bash', pattern: 'git *', action: 'allow' }
    ];
    const result = evaluateRules(rules, 'Bash', { command: 'git push' });
    assert.strictEqual(result.action, 'allow');
    assert.strictEqual(result.rule.tool, 'Bash');
  });

  it('returns matched=false when no rule matches a non-blanket pattern', () => {
    const rules = [{ tool: 'Bash', pattern: 'git *', action: 'allow' }];
    assert.strictEqual(
      evaluateRules(rules, 'Bash', { command: 'rm file' }).matched,
      false
    );
  });

  it('blanket * matches even when key field is missing', () => {
    const rules = [{ tool: 'Cron', pattern: '*', action: 'deny' }];
    const result = evaluateRules(rules, 'Cron', {});
    assert.strictEqual(result.action, 'deny');
  });

  it('caches compiled regex on the rule object', () => {
    const rule = { tool: 'Bash', pattern: 'git *', action: 'allow' };
    evaluateRules([rule], 'Bash', { command: 'git status' });
    assert.ok(rule._compiled instanceof RegExp);
  });

  it('uses url field for WebFetch', () => {
    const rules = [{ tool: 'WebFetch', pattern: 'https://github.com/*', action: 'allow' }];
    assert.strictEqual(
      evaluateRules(rules, 'WebFetch', { url: 'https://github.com/anthropics/sdk' }).action,
      'allow'
    );
    assert.strictEqual(
      evaluateRules(rules, 'WebFetch', { url: 'https://evil.example.com/' }).matched,
      false
    );
  });

  it('uses file_path field for Read/Edit/Write', () => {
    const rules = [{ tool: 'Edit', pattern: '/tmp/*', action: 'allow' }];
    assert.strictEqual(
      evaluateRules(rules, 'Edit', { file_path: '/tmp/foo.txt' }).action,
      'allow'
    );
  });
});

describe('describeRule', () => {
  it('returns a human summary including pattern and action', () => {
    const desc = describeRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'session' });
    assert.match(desc, /Bash/);
    assert.match(desc, /git/);
    assert.match(desc, /allow/);
    assert.match(desc, /session/);
  });

  it('omits pattern when blanket', () => {
    const desc = describeRule({ tool: 'Cron', pattern: '*', action: 'deny' });
    assert.ok(!desc.includes("'*'"));
  });
});

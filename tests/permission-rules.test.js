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

// Final review I4 (fleet stage 7 §8): rules the desktop adds (origin
// 'desktop') are consulted only when no service rule matched, so a desktop
// allow can never shadow a service deny; service rules keep plain
// first-match order.
describe('evaluateRules two-tier order', () => {
  const bash = (command) => ({ command });

  it('a desktop allow followed by a hand-written deny evaluates to deny', () => {
    const rules = [
      { tool: 'Bash', pattern: 'git *', action: 'allow', source: 'approval-dialog', origin: 'desktop' },
      { tool: 'Bash', pattern: 'git push*', action: 'deny', source: 'user' }
    ];
    const out = evaluateRules(rules, 'Bash', bash('git push origin main'));
    assert.strictEqual(out.action, 'deny');
    assert.strictEqual(out.rule.source, 'user');
    // The desktop allow still applies where no service rule speaks.
    assert.strictEqual(evaluateRules(rules, 'Bash', bash('git status')).action, 'allow');
  });

  it('a service allow beats a desktop deny, wherever the desktop rule sits', () => {
    const rules = [
      { tool: 'Bash', pattern: 'npm *', action: 'deny', origin: 'desktop' },
      { tool: 'Bash', pattern: 'npm test', action: 'allow', source: 'user' }
    ];
    assert.strictEqual(evaluateRules(rules, 'Bash', bash('npm test')).action, 'allow');
    assert.strictEqual(evaluateRules(rules, 'Bash', bash('npm publish')).action, 'deny');
  });

  it('standalone first-match is unchanged: allow specific, deny broad', () => {
    const rules = [
      { tool: 'Bash', pattern: 'rm -rf ./build', action: 'allow', source: 'user' },
      { tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'user' }
    ];
    assert.strictEqual(evaluateRules(rules, 'Bash', bash('rm -rf ./build')).action, 'allow');
    assert.strictEqual(evaluateRules(rules, 'Bash', bash('rm -rf /')).action, 'deny');
    // And the reverse order still means the broad deny wins, as before.
    const reversed = [rules[1], rules[0]];
    assert.strictEqual(evaluateRules(reversed, 'Bash', bash('rm -rf ./build')).action, 'deny');
  });

  it('desktop rules keep first-match order among themselves', () => {
    const rules = [
      { tool: 'Bash', pattern: 'git *', action: 'ask', origin: 'desktop' },
      { tool: 'Bash', pattern: 'git status', action: 'allow', origin: 'desktop' }
    ];
    assert.strictEqual(evaluateRules(rules, 'Bash', bash('git status')).action, 'ask');
  });

  it('only origin === "desktop" is second-tier', () => {
    const rules = [
      { tool: 'Bash', pattern: 'ls', action: 'allow', origin: 'Desktop' },
      { tool: 'Bash', pattern: 'ls', action: 'deny', source: 'user' }
    ];
    assert.strictEqual(evaluateRules(rules, 'Bash', bash('ls')).action, 'allow');
  });
});

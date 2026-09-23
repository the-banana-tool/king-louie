const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  patternMatch,
  formatToolPattern,
  matchesPatternList,
  isPathUnderRoots,
  classifyToolCall
} = require('../src/execution/safety-policy');

describe('Safety Policy Engine', () => {
  it('matches wildcards correctly in patternMatch', () => {
    assert.ok(patternMatch('Bash(ssh *)', 'Bash(ssh user@server.com)'));
    assert.ok(patternMatch('Bash(*deploy*)', 'Bash(npm run deploy)'));
    assert.ok(patternMatch('Vault(*)', 'Vault(get_secret)'));
    assert.ok(patternMatch('Bash(rm -rf /*)', 'Bash(rm -rf /*)'));
    assert.ok(!patternMatch('Bash(ssh *)', 'Bash(ls -la)'));
  });

  it('checks path containment under allowed_roots', () => {
    const roots = ['/srv/site', '/home/user/data'];
    assert.ok(isPathUnderRoots('/srv/site/index.js', roots));
    assert.ok(isPathUnderRoots('/home/user/data/models/m.bin', roots));
    assert.ok(!isPathUnderRoots('/etc/passwd', roots));
    assert.ok(!isPathUnderRoots('/srv/other', roots));
  });

  it('classifies tool calls into appropriate safety tiers', () => {
    const policy = {
      allowed_roots: ['/srv/site'],
      remote_sessions: {
        always_confirm: [
          'Bash(ssh *)',
          'Bash(git push*)',
          'Vault(*)'
        ],
        deny: [
          'Bash(rm -rf /*)'
        ]
      }
    };

    // Denied
    const deniedRes = classifyToolCall('Bash', { command: 'rm -rf /*' }, policy);
    assert.equal(deniedRes.tier, 'denied');

    // Unsafe via always_confirm
    const sshRes = classifyToolCall('Bash', { command: 'ssh admin@web-01' }, policy);
    assert.equal(sshRes.tier, 'unsafe');
    assert.equal(sshRes.reason, 'matched_always_confirm');

    // Unsafe via path outside allowed_roots
    const pathRes = classifyToolCall('Read', { filePath: '/etc/shadow' }, policy);
    assert.equal(pathRes.tier, 'unsafe');
    assert.equal(pathRes.reason, 'path_outside_allowed_roots');

    // Read tier inside allowed_roots
    const readRes = classifyToolCall('Read', { filePath: '/srv/site/package.json' }, policy);
    assert.equal(readRes.tier, 'read');

    // Routine tier inside allowed_roots
    const routineRes = classifyToolCall('Write', { filePath: '/srv/site/log.txt', content: 'test' }, policy);
    assert.equal(routineRes.tier, 'routine');
  });
  describe('command matching', () => {
    const policy = {
      allowed_roots: ['/'],
      remote_sessions: {
        always_confirm: ['Bash(git push*)', 'Bash(ssh *)'],
        deny: ['Bash(rm -rf /*)']
      }
    };

    it('normalises whitespace so extra spaces, tabs, and newlines cannot dodge a pattern', () => {
      for (const command of ['rm  -rf /', '  rm -rf /  ', 'rm\t-rf /', 'rm \t -rf   /']) {
        assert.equal(classifyToolCall('Bash', { command }, policy).tier, 'denied', JSON.stringify(command));
      }
      assert.ok(patternMatch('Bash(rm   -rf /*)', 'Bash(rm -rf /)'));
    });

    it('matches each segment of a compound command', () => {
      const cases = [
        ['echo hi; rm -rf /', 'denied'],
        ['echo hi;rm -rf /', 'denied'],
        ['true && git push', 'unsafe'],
        ['cd x && git push origin', 'unsafe'],
        ['false || git push', 'unsafe'],
        ['cat f | ssh host', 'unsafe'],
        ['echo hi & rm -rf /', 'denied'],
        ['echo hi\nrm -rf /', 'denied'],
        ['echo hi\r\ngit push', 'unsafe']
      ];
      for (const [command, tier] of cases) {
        assert.equal(classifyToolCall('Bash', { command }, policy).tier, tier, JSON.stringify(command));
      }
    });

    it('leaves compound commands with no matching segment routine', () => {
      const res = classifyToolCall('Bash', { command: 'cd x && git status | grep main' }, policy);
      assert.equal(res.tier, 'routine');
    });

    it('classifies command substitution as unsafe', () => {
      for (const command of ['echo $(whoami)', 'echo `whoami`', 'ls "$(cat list)"', 'diff <(ls a) b', 'tee >(sh)']) {
        const res = classifyToolCall('Bash', { command }, policy);
        assert.equal(res.tier, 'unsafe', command);
        assert.equal(res.reason, 'command_substitution');
      }
    });

    it('still denies a deny match that also uses command substitution', () => {
      const res = classifyToolCall('Bash', { command: 'rm -rf /$(echo x)' }, policy);
      assert.equal(res.tier, 'denied');
    });
  });

  it('treats regex metacharacters other than * and ? literally', () => {
    assert.ok(patternMatch('Bash(npm run a.b+c(d))', 'Bash(npm run a.b+c(d))'));
    // `.` must not act as "any char", `+` must not act as "one or more".
    assert.ok(!patternMatch('Bash(a.b)', 'Bash(axb)'));
    assert.ok(!patternMatch('Bash(a+)', 'Bash(aaa)'));
    assert.ok(!patternMatch('Bash(f(x))', 'Bash(fx)'));
    assert.ok(!patternMatch('Bash([ab])', 'Bash(a)'));
    assert.ok(!patternMatch('Bash(a|b)', 'Bash(a)'));
    assert.ok(!patternMatch('Bash(^a$)', 'Bash(a)'));
    assert.ok(patternMatch('Bash(^a$)', 'Bash(^a$)'));
    // The two wildcards still work.
    assert.ok(patternMatch('Bash(a?c)', 'Bash(abc)'));
    assert.ok(!patternMatch('Bash(a?c)', 'Bash(ac)'));
    assert.ok(patternMatch('Bash(a*c)', 'Bash(ac)'));
  });
});

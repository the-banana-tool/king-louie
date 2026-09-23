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
});

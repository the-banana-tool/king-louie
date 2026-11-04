// tests/launch-mode.test.js — the one rule that decides how the app launches
// (spec 2026-11-03-attach-stage2-design §6.1).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolveLaunchMode, STANDALONE_FLAG, STANDALONE_ONCE_FLAG } = require('../src/desktop-bridge/launch-mode');

const argv = (...flags) => ['electron', '.', ...flags];

describe('resolveLaunchMode', () => {
  it('names the two flags', () => {
    assert.strictEqual(STANDALONE_FLAG, '--kl-standalone');
    assert.strictEqual(STANDALONE_ONCE_FLAG, '--kl-standalone-once');
  });

  const rows = [
    ['once', { argv: argv('--kl-standalone-once'), platform: 'win32', stateMode: 'standalone' }, { host: 'standalone', why: 'once', degraded: true }],
    ['once, also when the state says attached', { argv: argv('--kl-standalone-once'), platform: 'win32', stateMode: 'attached' }, { host: 'standalone', why: 'once', degraded: true }],
    ['once wins over the development flag', { argv: argv('--kl-standalone', '--kl-standalone-once'), platform: 'win32', stateMode: 'standalone' }, { host: 'standalone', why: 'once', degraded: true }],
    ['dev', { argv: argv('--kl-standalone'), platform: 'win32', stateMode: 'standalone' }, { host: 'standalone', why: 'dev', degraded: false }],
    ['dev wins over an attached state', { argv: argv('--kl-standalone'), platform: 'win32', stateMode: 'attached' }, { host: 'standalone', why: 'dev', degraded: false }],
    ['attached on a platform with no personal node', { argv: argv(), platform: 'darwin', stateMode: 'attached' }, { host: 'attached', why: 'attached', degraded: false }],
    ['attached on Windows', { argv: argv(), platform: 'win32', stateMode: 'attached' }, { host: 'attached', why: 'attached', degraded: false }],
    ['platform', { argv: argv(), platform: 'linux', stateMode: 'standalone' }, { host: 'standalone', why: 'platform', degraded: false }],
    ['needs-node', { argv: argv(), platform: 'win32', stateMode: 'standalone' }, { host: 'attached', why: 'needs-node', degraded: false }]
  ];
  for (const [name, input, expected] of rows) {
    it(`row: ${name}`, () => {
      assert.deepStrictEqual(resolveLaunchMode(input), expected);
    });
  }

  it('needs-node never picks standalone', () => {
    for (const stateMode of ['standalone', 'attached', 'something-else', '', null, undefined]) {
      assert.strictEqual(resolveLaunchMode({ argv: argv(), platform: 'win32', stateMode }).host, 'attached', String(stateMode));
    }
  });

  it('takes only the exact flags', () => {
    assert.strictEqual(resolveLaunchMode({ argv: argv('--kl-standalone-twice', '--kl-standalone=1'), platform: 'win32', stateMode: 'standalone' }).why, 'needs-node');
  });
});

// tests/launch-mode.test.js — the one rule that decides how the app launches
// (spec 2026-11-03-attach-stage2-design §6.1).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolveLaunchMode, relaunchArgs, startsInTray, STANDALONE_FLAG, STANDALONE_ONCE_FLAG, TRAY_FLAG } = require('../src/desktop-bridge/launch-mode');

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

  it('relaunch drops --kl-tray; --kl-tray never changes attached/standalone', () => {
    assert.strictEqual(TRAY_FLAG, '--kl-tray');
    assert.deepStrictEqual(relaunchArgs(argv('--kl-tray', '--kl-standalone', '--kl-standalone-once', '--user-data-dir=x')), ['.', '--user-data-dir=x']);
    assert.deepStrictEqual(relaunchArgs(argv('--kl-tray'), ['--kl-standalone-once']), ['.', '--kl-standalone-once']);
    for (const [, input] of rows) {
      const withTray = { ...input, argv: [...input.argv, '--kl-tray'] };
      assert.deepStrictEqual(resolveLaunchMode(withTray), resolveLaunchMode(input), JSON.stringify(input));
    }
    assert.strictEqual(startsInTray(argv('--kl-tray')), true);
    assert.strictEqual(startsInTray(argv('--kl-tray=1', '--kl-trays')), false);
    assert.strictEqual(startsInTray(argv()), false);
  });

  it('a migrated profile is not opened by the once flag; the development flag still opens it', () => {
    const once = argv('--kl-standalone-once');
    assert.deepStrictEqual(resolveLaunchMode({ argv: once, platform: 'win32', stateMode: 'standalone', migrated: true }), { host: 'attached', why: 'needs-node', degraded: false });
    assert.deepStrictEqual(resolveLaunchMode({ argv: once, platform: 'win32', stateMode: 'attached', migrated: true }), { host: 'attached', why: 'attached', degraded: false });
    assert.strictEqual(resolveLaunchMode({ argv: argv('--kl-standalone'), platform: 'win32', stateMode: 'attached', migrated: true }).why, 'dev');
    assert.strictEqual(resolveLaunchMode({ argv: once, platform: 'win32', stateMode: 'attached', migrated: false }).why, 'once');
  });
});

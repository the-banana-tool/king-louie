// tests/single-instance.test.js
// One desktop per profile: a second launch on the same userData focuses the
// first window and quits, before it reads or writes anything. The real launch
// is tests/e2e/single-instance.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { claimSingleInstance } = require('../src/ipc/single-instance');

function fakeApp(gotLock) {
  const handlers = {};
  return {
    requestSingleInstanceLock: () => gotLock,
    on: (name, fn) => { handlers[name] = fn; },
    handlers
  };
}
function fakeWindow({ minimized = false, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };
}

describe('claimSingleInstance', () => {
  it('a second instance gets false, and listens for nothing', () => {
    const app = fakeApp(false);
    assert.strictEqual(claimSingleInstance({ app, getWindow: () => null }), false);
    assert.deepStrictEqual(Object.keys(app.handlers), []);
  });

  it('the first instance gets true, and a later launch focuses its window', () => {
    const app = fakeApp(true);
    const win = fakeWindow();
    assert.strictEqual(claimSingleInstance({ app, getWindow: () => win }), true);
    app.handlers['second-instance']({}, ['electron.exe'], 'C:\\somewhere');
    assert.deepStrictEqual(win.calls, ['show', 'focus']);
  });

  it('restores a minimized window first', () => {
    const app = fakeApp(true);
    const win = fakeWindow({ minimized: true });
    claimSingleInstance({ app, getWindow: () => win });
    app.handlers['second-instance']({}, [], '');
    assert.deepStrictEqual(win.calls, ['restore', 'show', 'focus']);
  });

  it('with no window, or a destroyed one, does nothing and does not throw', () => {
    const app = fakeApp(true);
    let win = null;
    claimSingleInstance({ app, getWindow: () => win });
    app.handlers['second-instance']({}, [], '');
    win = fakeWindow({ destroyed: true });
    app.handlers['second-instance']({}, [], '');
    assert.deepStrictEqual(win.calls, []);
  });

  it('never reads the second instance\'s argv, working directory or data', () => {
    const app = fakeApp(true);
    const win = fakeWindow();
    claimSingleInstance({ app, getWindow: () => win });
    const untouchable = new Proxy({}, { get() { throw new Error('read'); } });
    app.handlers['second-instance'](untouchable, untouchable, untouchable, untouchable);
    assert.deepStrictEqual(win.calls, ['show', 'focus']);
    assert.ok(!/argv|workingDirectory|additionalData/.test(claimSingleInstance.toString()));
  });
});

describe('main.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  it('claims the profile after --user-data-dir and before anything reads it', () => {
    const setPath = main.indexOf("app.setPath('userData'");
    const claim = main.indexOf('claimSingleInstance({');
    const state = main.indexOf('openDesktopState(app.getPath');
    assert.ok(setPath >= 0 && claim > setPath, 'the lock is per userData, so it follows setPath');
    assert.ok(state > claim, 'a second instance never opens the desktop state');
    assert.ok(main.indexOf('resolveLaunchMode({') > claim, 'a second instance never reads its argv for a mode');
    assert.ok(main.indexOf('startStandaloneHost(deps)') > claim);
  });

  it('a second instance stops there', () => {
    assert.match(main, /if \(!claimSingleInstance\(\{ app, getWindow \}\)\) \{[^}]*app\.exit\(0\);\s*return;\s*\}/);
  });
});

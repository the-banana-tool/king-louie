// tests/desktop-login-start.test.js
// King Louie's start at login (the HKCU Run value). No test runs a real reg.exe
// or touches the real HKCU: execFile is injected.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readLoginStart, setLoginStart, LOGIN_START_VALUE } = require('../src/desktop-bridge/login-start');

const ENV = { SystemRoot: 'C:\\Windows' };
const REG = 'C:\\Windows\\System32\\reg.exe';
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APP = 'C:\\Program Files\\King Louie\\King Louie.exe';

function recorder(answer = () => '') {
  const calls = [];
  const execFile = (file, args, opts) => { calls.push({ file, args, opts }); return answer(file, args, opts); };
  return { calls, execFile };
}

const regError = (stderr) => Object.assign(new Error('Command failed'), { status: 1, stderr });

describe('login start', () => {
  it('the value is named King Louie', () => {
    assert.equal(LOGIN_START_VALUE, 'King Louie');
  });

  it('setLoginStart on writes reg add HKCU\\...\\Run /v "King Louie" /t REG_SZ /d "\\"<app>\\" --kl-tray" /f', () => {
    const r = recorder();
    setLoginStart({ on: true, appPath: APP }, { execFile: r.execFile, env: ENV });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].file, REG);
    assert.deepEqual(r.calls[0].args, ['add', KEY, '/v', 'King Louie', '/t', 'REG_SZ', '/d', `"${APP}" --kl-tray`, '/f']);
    assert.equal(r.calls[0].opts.windowsHide, true);
  });

  it('setLoginStart on refuses an app path with a double quote, running nothing', () => {
    const r = recorder();
    assert.throws(() => setLoginStart({ on: true, appPath: 'C:\\a"b\\k.exe' }, { execFile: r.execFile, env: ENV }), /double quote/);
    assert.equal(r.calls.length, 0);
  });

  it('setLoginStart on: a reg failure throws', () => {
    const r = recorder(() => { throw regError('ERROR: Access is denied.'); });
    assert.throws(() => setLoginStart({ on: true, appPath: APP }, { execFile: r.execFile, env: ENV }));
  });

  it('setLoginStart off runs reg delete ... /f and treats "unable to find" as done', () => {
    const r = recorder();
    setLoginStart({ on: false }, { execFile: r.execFile, env: ENV });
    assert.deepEqual(r.calls[0].args, ['delete', KEY, '/v', 'King Louie', '/f']);
    assert.equal(r.calls[0].file, REG);

    const gone = recorder(() => { throw regError('ERROR: The system was unable to find the specified registry key or value.\r\n'); });
    setLoginStart({ on: false }, { execFile: gone.execFile, env: ENV });
    assert.equal(gone.calls.length, 1);
  });

  it('setLoginStart off: another failure with the value gone (non-English words) is done; with it still there it throws', () => {
    const gone = recorder((file, args) => { throw regError(args[0] === 'delete' ? 'FEHLER: ...' : 'FEHLER: ...'); });
    setLoginStart({ on: false }, { execFile: gone.execFile, env: ENV });
    assert.deepEqual(gone.calls.map((c) => c.args[0]), ['delete', 'query']);

    const stuck = recorder((file, args) => {
      if (args[0] === 'delete') throw regError('ERROR: Access is denied.');
      return `\r\n${KEY}\r\n    King Louie    REG_SZ    "${APP}" --kl-tray\r\n\r\n`;
    });
    assert.throws(() => setLoginStart({ on: false }, { execFile: stuck.execFile, env: ENV }), /Command failed/);
  });

  it('readLoginStart parses the REG_SZ value', () => {
    const r = recorder(() => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    King Louie    REG_SZ    "${APP}" --kl-tray\r\n\r\n`);
    assert.deepEqual(readLoginStart({ execFile: r.execFile, env: ENV }), { on: true, command: `"${APP}" --kl-tray` });
    assert.equal(r.calls[0].file, REG);
    assert.deepEqual(r.calls[0].args, ['query', KEY, '/v', 'King Louie']);
  });

  it('readLoginStart: no value (reg exits 1) or output with no value line is off', () => {
    const missing = recorder(() => { throw regError('ERROR: The system was unable to find the specified registry key or value.'); });
    assert.deepEqual(readLoginStart({ execFile: missing.execFile, env: ENV }), { on: false, command: null });
    const odd = recorder(() => '\r\nHKEY_CURRENT_USER\\...\\Run\r\n    King Louie Other    REG_SZ    x\r\n');
    assert.deepEqual(readLoginStart({ execFile: odd.execFile, env: ENV }), { on: false, command: null });
  });
});

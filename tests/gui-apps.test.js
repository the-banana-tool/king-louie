// tests/gui-apps.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGuiConfig } = require('../src/gui/config');
const { resolveLaunch, imageMatches, matchSetFor, assertPathsUnchanged } = require('../src/gui/apps');

// Native realpath: resolveLaunch resolves with it, and a Windows CI TEMP is a short path.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-apps-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const plat = process.platform === 'win32' ? 'win32' : 'linux';
const exe = path.join(base, plat === 'win32' ? 'tool.exe' : 'tool');
const other = path.join(base, plat === 'win32' ? 'other.exe' : 'other');
const work = path.join(base, 'work');
const outside = path.join(base, 'outside');
fs.writeFileSync(exe, '');
fs.writeFileSync(other, '');
fs.mkdirSync(work);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(work, 'in.txt'), 'x');
fs.writeFileSync(path.join(outside, 'out.txt'), 'x');

const gui = parseGuiConfig({ apps: { tool: { path: exe, processes: ['helper-*.bin'], args: ['--open=*', '--quiet'] } } }, { platform: plat });
const policy = { allowed_roots: [work] };
const opts = { platform: plat };

describe('resolveLaunch', () => {
  it('an allowlisted app with no args and files is routine', () => {
    const r = resolveLaunch(gui, policy, { app: 'tool' }, opts);
    assert.deepEqual({ tier: r.tier, reason: r.reason, appId: r.appId, exe: r.exe, argv: r.argv, files: r.files }, { tier: 'routine', reason: 'allowlisted', appId: 'tool', exe, argv: [], files: [] });
    assert.deepEqual(r.match, [exe, 'helper-*.bin']);
  });

  it('args must all match the app globs; files must be under allowed_roots', () => {
    assert.equal(resolveLaunch(gui, policy, { app: 'tool', args: ['--open=a', '--quiet'] }, opts).tier, 'routine');
    const a = resolveLaunch(gui, policy, { app: 'tool', args: ['--exec=calc'] }, opts);
    assert.deepEqual([a.tier, a.reason], ['unsafe', 'args_not_allowlisted']);
    assert.equal(resolveLaunch(gui, policy, { app: 'tool', files: [path.join(work, 'in.txt')] }, opts).tier, 'routine');
    const f = resolveLaunch(gui, policy, { app: 'tool', files: [path.join(outside, 'out.txt')] }, opts);
    assert.deepEqual([f.tier, f.reason], ['unsafe', 'file_outside_allowed_roots']);
  });

  it('an absolute path that is not allowlisted is unsafe with no app id', () => {
    const r = resolveLaunch(gui, policy, { app: other }, opts);
    assert.deepEqual([r.tier, r.reason, r.appId, r.exe], ['unsafe', 'app_not_allowlisted', null, other]);
  });

  it('refuses relative paths, "..", null bytes and slash lookalikes as invalid_params', () => {
    for (const app of ['tool.exe', 'bin/tool', `${base}${path.sep}..${path.sep}x`, `${exe}\u0000`, `${base}\u2215tool`]) {
      assert.throws(() => resolveLaunch(gui, policy, { app }, opts), (e) => e.code === 'invalid_params', app);
    }
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', files: ['in.txt'] }, opts), (e) => e.code === 'invalid_params');
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', args: Array(33).fill('--quiet') }, opts), (e) => e.code === 'invalid_params');
  });

  it('a missing file is file_not_found', () => {
    assert.throws(() => resolveLaunch(gui, policy, { app: path.join(base, plat === 'win32' ? 'missing.exe' : 'missing') }, opts), (e) => e.code === 'file_not_found');
    assert.throws(() => resolveLaunch(gui, policy, { app: 'tool', files: [path.join(work, 'nope.txt')] }, opts), (e) => e.code === 'file_not_found');
  });

  it('only .exe on Windows', () => {
    const fake = { statSync: () => ({ isFile: () => true, isDirectory: () => false }), realpath: (p) => p };
    const winGui = parseGuiConfig({}, { platform: 'win32' });
    assert.throws(() => resolveLaunch(winGui, policy, { app: 'C:\\Tools\\run.bat' }, { platform: 'win32', ...fake }), (e) => e.code === 'app_type_not_supported');
    assert.equal(resolveLaunch(winGui, policy, { app: 'C:\\Tools\\run.exe' }, { platform: 'win32', ...fake }).tier, 'unsafe');
  });

  it('a .app bundle directory is launchable on macOS', () => {
    const fake = { statSync: () => ({ isFile: () => false, isDirectory: () => true }), realpath: (p) => p };
    const r = resolveLaunch(parseGuiConfig({}, { platform: 'darwin' }), policy, { app: '/Applications/Notes.app' }, { platform: 'darwin', ...fake });
    assert.equal(r.exe, '/Applications/Notes.app');
  });
});

describe('imageMatches', () => {
  it('absolute paths and globs; bare names compare the basename', () => {
    assert.ok(imageMatches('/usr/bin/gedit', ['/usr/bin/gedit'], 'linux'));
    assert.ok(imageMatches('/opt/app/bin/helper-7.bin', ['helper-*.bin'], 'linux'));
    assert.ok(!imageMatches('/usr/bin/GEDIT', ['/usr/bin/gedit'], 'linux'), 'exact on Linux');
    assert.ok(imageMatches('C:\\Program Files\\WindowsApps\\X\\CalculatorApp.exe', ['calculatorapp.exe'], 'win32'), 'case-insensitive on Windows');
    assert.ok(!imageMatches('C:\\Windows\\explorer.exe', ['C:\\Windows\\System32\\calc.exe', 'CalculatorApp.exe'], 'win32'));
  });

  it('on macOS any image inside the .app bundle matches', () => {
    assert.ok(imageMatches('/System/Applications/Calculator.app/Contents/MacOS/Calculator', ['/System/Applications/Calculator.app'], 'darwin'));
    assert.ok(!imageMatches('/System/Applications/Calculator.app.evil/x', ['/System/Applications/Calculator.app'], 'darwin'));
  });

  it('refuses an empty image', () => {
    assert.ok(!imageMatches('', ['*'], 'linux'));
    assert.ok(!imageMatches(null, ['*'], 'linux'));
  });
});

describe('matchSetFor and assertPathsUnchanged', () => {
  it('unions the leased apps', () => {
    assert.deepEqual(matchSetFor(gui, ['tool'], { realpath: (p) => p }), [exe, 'helper-*.bin']);
  });

  it('refuses a path that resolves elsewhere at spawn', () => {
    assert.doesNotThrow(() => assertPathsUnchanged({ exe, files: [] }, { platform: plat }));
    assert.throws(() => assertPathsUnchanged({ exe, files: [] }, { platform: plat, realpath: () => other }), (e) => e.code === 'path_changed');
  });
});

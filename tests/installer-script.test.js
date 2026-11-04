// The NSIS include electron-builder pulls in (package.json build.nsis.include).
// Nothing here runs an installer: the checks read the script, which shows the
// rules are written, not that the uninstaller works (spec 6.8).
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanForPersonalValues } = require('./helpers/example-denylist');

const root = path.join(__dirname, '..');
const file = path.join(root, 'build', 'installer.nsh');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const text = () => fs.readFileSync(file, 'utf8');
const code = () => text().split(/\r?\n/).filter((l) => !/^\s*;|^\s*#/.test(l)).join('\n');
const macroBody = () => code().match(/!macro customUnInstall([\s\S]*?)!macroend/)[1];

describe('build/installer.nsh', () => {
  it('exists and package.json includes it', () => {
    assert.ok(fs.existsSync(file));
    assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  });

  it('removes the personal node task through the bundled CLI', () => {
    const c = code();
    assert.match(c, /!macro customUnInstall/);
    assert.match(c, /uninstall --personal --yes/);
    assert.match(c, /resources\\app\.asar\\bin\\king-louie-service\.js/);
    assert.match(c, /\$INSTDIR\\$\{APP_EXECUTABLE_FILENAME\}/);
    assert.doesNotMatch(c, /King Louie\.exe/);
    assert.match(c, /nsExec::ExecToLog/);
  });

  it('acts only on a real uninstall, never on an update', () => {
    const body = macroBody();
    // electron-builder runs the old uninstaller (and customUnInstall) during an update
    assert.match(body, /\$\{ifNot\} \$\{isUpdated\}/);
    const guard = body.indexOf('${ifNot} ${isUpdated}');
    assert.ok(guard >= 0 && guard < body.indexOf('nsExec::ExecToLog'));
    assert.ok(body.indexOf('${endIf}', guard) > body.indexOf('nsExec::ExecToLog'));
  });

  it('sets ELECTRON_RUN_AS_NODE for the CLI and clears it afterwards', () => {
    const body = macroBody();
    const set = body.indexOf('SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")');
    const run = body.indexOf('nsExec::ExecToLog');
    const clear = body.indexOf('SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)');
    assert.ok(set >= 0 && set < run, 'set before the run');
    assert.ok(clear > run, 'cleared after the run');
  });

  it('ignores the exit code and deletes nothing itself', () => {
    const body = macroBody();
    assert.match(body, /Pop \$\w+/);
    assert.doesNotMatch(body, /Abort|Quit|SetErrorLevel/);
    assert.doesNotMatch(code(), /\/Delete|Delete\s|RMDir|DeleteRegKey/i);
  });

  it('holds no value from the owner\'s machine', () => {
    assert.deepEqual(scanForPersonalValues(text()), []);
  });
});

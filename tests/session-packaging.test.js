// tests/session-packaging.test.js
// The Windows session backend hands windows-worker.ps1 to powershell.exe by
// path (`-File`). PowerShell reads the file itself and cannot read inside a
// packaged app's app.asar, so the script is unpacked (build.asarUnpack) and
// the backend's default path points at app.asar.unpacked.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { defaultWorkerFile } = require('../src/session/backends/windows');

describe('packaging the Windows session worker', () => {
  it('build.asarUnpack lists windows-worker.ps1', () => {
    assert.ok(pkg.build.asarUnpack.includes('src/session/backends/windows-worker.ps1'));
    assert.ok(fs.existsSync(path.join(root, 'src', 'session', 'backends', 'windows-worker.ps1')));
  });

  it('the default worker path maps app.asar to app.asar.unpacked', () => {
    const dir = 'C:\\Program Files\\King Louie\\resources\\app.asar\\src\\session\\backends';
    assert.strictEqual(defaultWorkerFile(dir),
      path.join('C:\\Program Files\\King Louie\\resources\\app.asar.unpacked\\src\\session\\backends', 'windows-worker.ps1'));
  });

  it('outside an asar the default is the file beside the backend', () => {
    assert.strictEqual(defaultWorkerFile(), path.join(root, 'src', 'session', 'backends', 'windows-worker.ps1'));
  });
});

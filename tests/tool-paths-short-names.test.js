// The file-tool path guard and Windows 8.3 short names.
//
// A folder with a long name also answers to a short one (C:\Users\LONGUS~1),
// and a GitHub Windows runner's TEMP is spelled that way. resolveRealPath used
// the JS realpathSync, which resolves links but keeps a short name, while a
// delegate session's cwd is canonicalized with realpathSync.native (the long
// name): the same folder had two spellings, and a Read inside the working
// directory was refused as "outside". Both sides now resolve to one spelling.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  isPathWithin,
  isPathAllowed,
  isProtectedSecretPath,
  registerSecretDataDir,
  clearSecretDataDirs
} = require('../src/tools/utils');

// The 8.3 spelling of an existing path, or null when the volume makes none.
function shortName(p) {
  const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    windowsHide: true
  }).trim();
  return out && out.toLowerCase() !== p.toLowerCase() ? out : null;
}

describe('the path guard with 8.3 short names', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  let base;
  let long;
  let short;

  before(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-shortnames-')));
    long = path.join(base, 'a-folder-with-a-long-name');
    fs.mkdirSync(long);
    fs.writeFileSync(path.join(long, 'inside.txt'), 'inside');
    short = shortName(long);
  });

  after(() => {
    clearSecretDataDirs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('treats the short and the long spelling of the working directory as one folder', (t) => {
    if (!short) return t.skip('this volume makes no 8.3 names');
    for (const [cwd, target] of [[long, path.join(short, 'inside.txt')], [short, path.join(long, 'inside.txt')]]) {
      assert.strictEqual(isPathWithin(cwd, target), true, `${target} within ${cwd}`);
      assert.strictEqual(isPathAllowed(target, cwd), true, `${target} allowed in ${cwd}`);
    }
    // A file that does not exist yet resolves through its parent the same way.
    assert.strictEqual(isPathAllowed(path.join(short, 'new.txt'), long), true);
  });

  it('still refuses a sibling, whichever spelling the working directory has', (t) => {
    if (!short) return t.skip('this volume makes no 8.3 names');
    const sibling = path.join(base, 'sibling');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'outside.txt'), 'outside');
    for (const cwd of [long, short]) {
      assert.strictEqual(isPathAllowed(path.join(sibling, 'outside.txt'), cwd), false, `sibling refused in ${cwd}`);
    }
  });

  it('names a secret file spelled through the short folder name, before it exists', (t) => {
    if (!short) return t.skip('this volume makes no 8.3 names');
    clearSecretDataDirs();
    registerSecretDataDir(long);
    // No file yet, so the file-identity check cannot help: only the name and
    // folder check can, and it must see through the short spelling.
    assert.strictEqual(fs.existsSync(path.join(long, 'master.key')), false);
    assert.strictEqual(isProtectedSecretPath(path.join(short, 'master.key')), true);
    assert.strictEqual(isPathAllowed(path.join(short, 'master.key'), short), false);
  });
});

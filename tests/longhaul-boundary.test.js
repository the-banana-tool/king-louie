// tests/longhaul-boundary.test.js
// LongHaul can move to its own repository (B-D5): nothing in src/ requires
// src/longhaul/, src/longhaul/ never reaches the Electron host, and the
// Electron build leaves it out.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const LONGHAUL = path.join(SRC, 'longhaul') + path.sep;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

describe('LongHaul boundaries', () => {
  it('nothing in src/ outside src/longhaul/ requires it', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.startsWith(LONGHAUL))
      .filter((f) => /require\(\s*['"][^'"]*\blonghaul\b[^'"]*['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    assert.deepStrictEqual(offenders, []);
  });

  it('src/longhaul/ never requires electron or src/ipc/', () => {
    const offenders = walk(LONGHAUL)
      .filter((f) => /require\(\s*['"](electron|[^'"]*\/ipc\/[^'"]*)['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    assert.deepStrictEqual(offenders, []);
  });

  it('package.json ships the longhaul bin and leaves LongHaul out of the Electron build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.bin.longhaul, 'bin/longhaul.js');
    assert.ok(pkg.build.files.includes('!src/longhaul/**'));
    assert.ok(pkg.build.files.includes('!bin/longhaul.js'));
  });
});

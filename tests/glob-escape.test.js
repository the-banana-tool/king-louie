// Glob and Grep never return what lies outside the directory they search
// (ruling T11-glob): not through an absolute or `..` pattern, and not
// through a symlink or junction inside it that points out.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const globTool = require('../src/tools/builtin/glob-tool');
const grepTool = require('../src/tools/builtin/grep-tool');

const posix = (p) => p.replace(/\\/g, '/');

describe('Glob and Grep stay under their base', () => {
  let root;
  let ws;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-glob-escape-'));
    ws = path.join(root, 'ws', 'inner');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'mine.txt'), 'MARKER inside\n');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'MARKER outside\n');
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.writeFileSync(path.join(root, 'elsewhere', 'linked.txt'), 'MARKER linked\n');
    // A junction needs no privilege on Windows; elsewhere it is a dir symlink.
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(ws, 'out'), 'junction');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const ctx = () => ({ workingDirectory: ws, allowedDirectories: [root] });

  for (const pattern of ['../../*.txt', '../*/../../*.txt', '{..,x}/../*.txt']) {
    it(`Glob "${pattern}" lists nothing outside the base`, async () => {
      const result = await globTool.execute({ pattern }, ctx());
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.files, []);
    });
  }

  it('Glob with an absolute pattern lists nothing outside the base', async () => {
    const result = await globTool.execute({ pattern: `${posix(root)}/*.txt` }, ctx());
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.files, []);
  });

  it('Glob drops matches reached through a junction or symlink pointing out', async () => {
    const result = await globTool.execute({ pattern: '**/*.txt' }, ctx());
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.files.map((f) => posix(f.path)), ['mine.txt']);
  });

  it('Grep with a `..` or absolute glob reads nothing outside the base', async () => {
    for (const glob of ['../../*.txt', `${posix(root)}/*.txt`]) {
      const result = await grepTool.execute({ pattern: 'MARKER', glob }, ctx());
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.matches, [], glob);
    }
  });

  it('Grep skips files reached through a junction or symlink pointing out', async () => {
    const result = await grepTool.execute({ pattern: 'MARKER' }, ctx());
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.matches.map((m) => m.line), ['MARKER inside']);
  });
});

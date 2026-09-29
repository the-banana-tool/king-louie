// Glob and Grep resolve a relative cwd/path against the working directory,
// and return paths the Read tool can open as given: relative to the working
// directory when under it, absolute otherwise. They used to resolve against
// the process's cwd and answer relative to their own search root, so a
// Glob in another folder handed Read paths that pointed into the working
// directory instead (ENOENT).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const globTool = require('../src/tools/builtin/glob-tool');
const grepTool = require('../src/tools/builtin/grep-tool');
const readTool = require('../src/tools/builtin/read-tool');

describe('Glob and Grep paths are Read-ready', () => {
  let root;
  let ws;
  let other;
  let ctx;
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-glob-paths-')));
    ws = path.join(root, 'ws');
    other = path.join(root, 'other');
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(other, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs', 'here.md'), 'MARKER here\n');
    fs.writeFileSync(path.join(other, 'docs', 'there.md'), 'MARKER there\n');
    ctx = { workingDirectory: ws, allowedDirectories: [other] };
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('Glob with a relative cwd searches under the working directory', async () => {
    const result = await globTool.execute({ pattern: '*.md', cwd: 'docs' }, ctx);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.files.map((f) => f.path), ['docs/here.md']);
  });

  it('Glob with cwd "." is the working directory', async () => {
    const result = await globTool.execute({ pattern: 'docs/*.md', cwd: '.' }, ctx);
    assert.deepEqual(result.files.map((f) => f.path), ['docs/here.md']);
  });

  it('Glob outside the working directory returns absolute paths Read can open', async () => {
    const result = await globTool.execute({ pattern: '**/*.md', cwd: other }, ctx);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.files.map((f) => f.path), [path.join(other, 'docs', 'there.md')]);
    const read = await readTool.execute({ file_path: result.files[0].path }, ctx);
    assert.equal(read.success, true, read.error);
  });

  it('Glob in the working directory keeps its relative paths', async () => {
    const result = await globTool.execute({ pattern: '**/*.md' }, ctx);
    assert.deepEqual(result.files.map((f) => f.path), ['docs/here.md']);
  });

  it('Grep with a relative path searches under the working directory', async () => {
    const result = await grepTool.execute({ pattern: 'MARKER', path: 'docs' }, ctx);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.matches.map((m) => m.file), ['docs/here.md']);
  });

  it('Grep outside the working directory returns absolute paths', async () => {
    const result = await grepTool.execute({ pattern: 'MARKER', path: other }, ctx);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.matches.map((m) => m.file), [path.join(other, 'docs', 'there.md')]);
  });

  it('Grep on a single relative file resolves it against the working directory', async () => {
    const result = await grepTool.execute({ pattern: 'MARKER', path: 'docs/here.md' }, ctx);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.matches.map((m) => m.file), ['docs/here.md']);
  });
});

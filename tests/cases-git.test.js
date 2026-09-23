// tests/cases-git.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { CaseRuntime } = require('../src/cases');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-git-')); dirs.push(d); return d; };

describe('case git wrapper', () => {
  it('refuses to commit into an enclosing repository when the case lost its own .git', async () => {
    const parent = tmp();
    await git.initRepo(parent);
    const rt = new CaseRuntime({ root: path.join(parent, 'cases') });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    fs.rmSync(path.join(info.dir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(info.dir, 'notes.md'), 'Survey ordered.\n');
    await assert.rejects(git.commitAll(info.dir, 'turn'), /not its own git repository/);
    const count = await git.git(parent, ['rev-list', '--all', '--count']);
    assert.strictEqual(count.trim(), '0');
  });

  it('ignores repository hooks and commit signing', async () => {
    const dir = tmp();
    await git.initRepo(dir);
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await git.git(dir, ['config', 'commit.gpgsign', 'true']);
    fs.writeFileSync(path.join(dir, 'facts.jsonl'), '');
    assert.ok(await git.commitAll(dir, 'first'));
  });

  it('reports a missing git binary as GitUnavailableError', async () => {
    const saved = process.env.PATH;
    const savedWin = process.env.Path;
    process.env.PATH = '';
    if (savedWin !== undefined) process.env.Path = '';
    try {
      await assert.rejects(git.git(tmp(), ['status']), git.GitUnavailableError);
    } finally {
      process.env.PATH = saved;
      if (savedWin !== undefined) process.env.Path = savedWin;
    }
  });
});

describe('case git hooks path', () => {
  it('points core.hooksPath at an empty directory inside the case', async () => {
    const dir = tmp();
    await git.initRepo(dir);
    const hook = (await git.git(dir, ['rev-parse', '--git-path', 'hooks/pre-commit'])).trim();
    const hooksDir = path.join(dir, '.kl', 'no-hooks');
    assert.strictEqual(path.resolve(dir, hook).toLowerCase(), path.join(hooksDir, 'pre-commit').toLowerCase());
    assert.deepStrictEqual(fs.readdirSync(hooksDir), []);
  });
});

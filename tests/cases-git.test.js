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

// Fix round 4 of fleet stage 7 Task 8, ruling (b): core.hooksPath points at
// a directory the service creates empty and owns, outside every case. A case
// directory is content an import (or the model) can write, so a hooks
// directory inside one (the old <case>/.kl/no-hooks) is only as safe as every
// path check guarding writes into it.
describe('case git hooks path', () => {
  const isUnder = (parent, child) => {
    const rel = path.relative(fs.realpathSync.native(parent), fs.realpathSync.native(child));
    return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
  };

  it('points core.hooksPath at an empty, absolute directory outside the case', async () => {
    const dir = tmp();
    await git.initRepo(dir);
    const hook = (await git.git(dir, ['rev-parse', '--git-path', 'hooks/pre-commit'])).trim();
    const hooksDir = git.noHooksDir();
    assert.ok(path.isAbsolute(hooksDir));
    assert.strictEqual(path.resolve(dir, hook).toLowerCase(), path.join(hooksDir, 'pre-commit').toLowerCase());
    assert.deepStrictEqual(fs.readdirSync(hooksDir), []);
    assert.strictEqual(isUnder(dir, hooksDir), false, 'the hooks directory is not inside the case');
    assert.strictEqual(fs.existsSync(path.join(dir, '.kl', 'no-hooks')), false, 'no hooks directory is created inside the case');
  });

  it('never runs a hook placed in the old <case>/.kl/no-hooks', async () => {
    const dir = tmp();
    await git.initRepo(dir);
    const marker = path.join(tmp(), 'PWNED');
    fs.mkdirSync(path.join(dir, '.kl', 'no-hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.kl', 'no-hooks', 'pre-commit'), `#!/bin/sh\necho ran > '${marker.replace(/\\/g, '/')}'\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'facts.jsonl'), '');
    assert.ok(await git.commitAll(dir, 'first'), 'the commit succeeded, so the pre-commit hook did not run');
    assert.strictEqual(fs.existsSync(marker), false, 'the hook did not run');
  });

  it('fails closed with a clear error when the hooks directory is not empty', async () => {
    const dir = tmp();
    await git.initRepo(dir);
    const planted = path.join(git.noHooksDir(), 'pre-commit');
    fs.writeFileSync(planted, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    try {
      await assert.rejects(git.git(dir, ['status']), /hooks directory .* is not empty/);
    } finally {
      fs.rmSync(planted, { force: true });
    }
    await git.git(dir, ['status']);
  });

  // Fix round 5: on a shared POSIX /tmp another user can learn the name, wait
  // for a tmp cleaner to remove it, and re-create it as their own. The
  // directory must be ours and private on every check, and a directory that
  // fails a check (or vanished) is replaced by a fresh mkdtemp, never reused
  // by name. lstat and getuid are stubbed so the owner/mode cases run on any
  // platform (Windows has no uid and reports synthetic modes).
  function withStat(dirToFake, fake, fn) {
    const realLstat = fs.lstatSync;
    const hadGetuid = typeof process.getuid === 'function';
    const realGetuid = process.getuid;
    const uid = hadGetuid ? process.getuid() : 1000;
    if (!hadGetuid) process.getuid = () => uid;
    fs.lstatSync = (p, ...rest) => {
      const st = realLstat(p, ...rest);
      if (!path.basename(String(p)).startsWith('kl-no-hooks-')) return st;
      const overrides = path.resolve(String(p)) === path.resolve(dirToFake) ? fake(uid) : { uid, mode: 0o40700 };
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, overrides);
    };
    try {
      return fn();
    } finally {
      fs.lstatSync = realLstat;
      if (!hadGetuid) delete process.getuid; else process.getuid = realGetuid;
    }
  }

  it('replaces a hooks directory owned by another user with a fresh one', () => {
    const first = withStat('', () => ({}), () => git.noHooksDir());
    const second = withStat(first, (uid) => ({ uid: uid + 1, mode: 0o40700 }), () => git.noHooksDir());
    assert.notStrictEqual(second, first);
    assert.deepStrictEqual(fs.readdirSync(second), []);
  });

  it('replaces a group- or world-accessible hooks directory with a fresh one', () => {
    const first = withStat('', () => ({}), () => git.noHooksDir());
    const second = withStat(first, (uid) => ({ uid, mode: 0o40770 }), () => git.noHooksDir());
    assert.notStrictEqual(second, first);
  });

  it('never reuses the name of a hooks directory that vanished', () => {
    const first = git.noHooksDir();
    fs.rmdirSync(first);
    const second = git.noHooksDir();
    assert.notStrictEqual(second, first);
    assert.strictEqual(fs.existsSync(first), false, 'the old name was not re-created');
  });
});

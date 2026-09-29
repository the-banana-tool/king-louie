// tests/longhaul-home.test.js
// LONGHAUL_HOME (benchmark spec B-D12, §10.1): default ~/.longhaul, five
// subdirectories, and never inside a git working tree, however it is reached.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveHome, ensureDirs, SUBDIRS } = require('../src/longhaul/home');
const { main } = require('../src/longhaul/cli');
const { REPO, tmpDir, sink } = require('./helpers/longhaul-helpers');

const inGitTree = (err) => err.code === 'HOME_IN_GIT_TREE' && /git working tree/.test(err.message);

describe('resolveHome', () => {
  it('defaults to <homedir>/.longhaul with its six subdirectories', () => {
    const fakeHome = tmpDir();
    const home = resolveHome({}, { homedir: () => fakeHome });
    assert.strictEqual(home.root, path.join(fakeHome, '.longhaul'));
    for (const d of SUBDIRS) assert.strictEqual(home[d], path.join(fakeHome, '.longhaul', d));
    assert.deepStrictEqual(SUBDIRS, ['private', 'sessions', 'questions', 'runs', 'reports', 'tmp']);
  });

  it('uses LONGHAUL_HOME when it is set, and ensureDirs creates the subdirectories', () => {
    const root = path.join(tmpDir(), 'data');
    const home = ensureDirs(resolveHome({ LONGHAUL_HOME: root }));
    assert.strictEqual(home.root, root);
    for (const d of SUBDIRS) assert.ok(fs.statSync(path.join(root, d)).isDirectory());
  });

  it('refuses a home inside a git working tree, even one that does not exist yet', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    assert.throws(() => resolveHome({ LONGHAUL_HOME: path.join(repo, 'deep', 'lh') }), inGitTree);
    assert.strictEqual(fs.existsSync(path.join(repo, 'deep')), false, 'nothing is created before the refusal');
  });

  it('refuses a git worktree whose .git is a file', () => {
    const worktree = tmpDir();
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../elsewhere/.git/worktrees/x\n');
    assert.throws(() => resolveHome({ LONGHAUL_HOME: path.join(worktree, 'lh') }), inGitTree);
  });

  it('refuses a home reached through a junction or symlink into a repository', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, 'inner'));
    const outside = tmpDir();
    const link = path.join(outside, 'link');
    fs.symlinkSync(path.join(repo, 'inner'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveHome({ LONGHAUL_HOME: path.join(link, 'lh') }), inGitTree);
  });
});

describe('ensureDirs subdirectory checks', () => {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  it('refuses a subdirectory that is a junction or symlink into a git working tree', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, 'inner'));
    const root = path.join(tmpDir(), 'lh');
    fs.mkdirSync(root);
    fs.symlinkSync(path.join(repo, 'inner'), path.join(root, 'sessions'), linkType);
    assert.throws(() => ensureDirs(resolveHome({ LONGHAUL_HOME: root })), inGitTree);
  });

  it('refuses a subdirectory whose real path is outside the home', () => {
    const elsewhere = tmpDir();
    const root = path.join(tmpDir(), 'lh');
    fs.mkdirSync(root);
    fs.symlinkSync(elsewhere, path.join(root, 'runs'), linkType);
    assert.throws(() => ensureDirs(resolveHome({ LONGHAUL_HOME: root })), (err) => err.code === 'HOME_IN_GIT_TREE' && /outside/.test(err.message));
  });

  it('the CLI exits 2 for such a home', async () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    const root = path.join(tmpDir(), 'lh');
    fs.mkdirSync(root);
    fs.symlinkSync(repo, path.join(root, 'questions'), linkType);
    const stderr = sink();
    assert.strictEqual(await main(['home'], { stdout: sink(), stderr, env: { LONGHAUL_HOME: root } }), 2);
    assert.match(stderr.text, /git working tree/);
  });
});

describe('longhaul CLI skeleton', () => {
  it('prints usage with no arguments and exits 0', async () => {
    const stdout = sink();
    assert.strictEqual(await main([], { stdout, stderr: sink() }), 0);
    assert.match(stdout.text, /Usage: longhaul <command>/);
  });

  it('rejects an unknown command and an unknown option with exit 2', async () => {
    const stderr = sink();
    assert.strictEqual(await main(['nope'], { stdout: sink(), stderr }), 2);
    assert.match(stderr.text, /Unknown command "nope"/);
    const root = path.join(tmpDir(), 'lh');
    assert.strictEqual(await main(['home', '--bogus'], { stdout: sink(), stderr: sink(), env: { LONGHAUL_HOME: root } }), 2);
  });

  it('home prints LONGHAUL_HOME and creates it', async () => {
    const root = path.join(tmpDir(), 'lh');
    const stdout = sink();
    assert.strictEqual(await main(['home'], { stdout, stderr: sink(), env: { LONGHAUL_HOME: root } }), 0);
    assert.ok(stdout.text.startsWith(root));
    assert.ok(fs.existsSync(path.join(root, 'private')));
    assert.match(stdout.text, /tmp\//);
  });

  it('refuses with exit 2 when LONGHAUL_HOME is inside a git working tree', async () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.git'));
    const stderr = sink();
    assert.strictEqual(await main(['home'], { stdout: sink(), stderr, env: { LONGHAUL_HOME: path.join(repo, 'lh') } }), 2);
    assert.match(stderr.text, /git working tree/);
  });

  it('bin/longhaul.js runs', () => {
    const out = spawnSync(process.execPath, [path.join(REPO, 'bin', 'longhaul.js'), 'help'], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /Usage: longhaul/);
  });
});

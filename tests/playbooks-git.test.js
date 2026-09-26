// tests/playbooks-git.test.js
// The hardened git helpers (cases stage 6 spec §3.4): every call carries the
// same -c flags and env, runGit outside a case creates no .kl/, timeouts are
// named, and new cases commit .gitattributes (R31). Fix round 1 (ruling
// C6-gitcfg): ext:: stays off whatever config says, inherited GIT_* variables
// never reach git, a repo whose config runs programs is refused, and errors
// never carry the argv, raw stderr or a URL credential.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { CaseStore } = require('../src/cases/case-store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbgit-')); dirs.push(d); return d; };
// Commit identity goes through env: callers may not pass leading -c flags.
const ID_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

describe('hardenedGitArgs', () => {
  it('puts every hardening flag before the arguments', () => {
    const argv = git.hardenedGitArgs(['status'], { hooksDir: '/tmp/empty-hooks' });
    const flags = [];
    for (let i = 0; i < argv.length - 1; i += 2) if (argv[i] === '-c') flags.push(argv[i + 1]);
    for (const f of [
      'commit.gpgsign=false', 'core.hooksPath=/tmp/empty-hooks', 'core.fsmonitor=false', 'core.symlinks=false', 'core.autocrlf=false',
      'core.eol=lf', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false',
      'protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always'
    ]) assert.ok(flags.includes(f), `${f} present`);
    assert.ok(!flags.includes('protocol.file.allow=always'));
    assert.strictEqual(argv[argv.length - 1], 'status');
  });

  it('allows the file protocol only when asked, and needs a hooks dir', () => {
    assert.ok(git.hardenedGitArgs(['clone'], { hooksDir: 'h', allowFile: true }).includes('protocol.file.allow=always'));
    assert.throws(() => git.hardenedGitArgs(['status'], {}), /hooksDir/);
  });
});

describe('runGit and runGitSync', () => {
  it('runs outside a case without creating .kl/ and without running repo hooks', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'a.md'), 'one\n');
    await git.runGit(dir, ['add', '-A']);
    await git.runGit(dir, ['commit', '-q', '-m', 'first'], { env: ID_ENV });
    assert.strictEqual((await git.runGit(dir, ['rev-list', '--count', 'HEAD'])).trim(), '1');
    assert.strictEqual(fs.existsSync(path.join(dir, '.kl')), false);
  });

  it('passes the hooks dir and protocol policy to git', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    const hooks = tmp();
    assert.strictEqual((await git.runGit(dir, ['config', 'core.hooksPath'], { hooksDir: hooks })).trim(), hooks);
    assert.strictEqual((await git.runGit(dir, ['config', 'protocol.allow'])).trim(), 'never');
    assert.strictEqual(git.runGitSync(dir, ['config', 'core.symlinks']).trim(), 'false');
    assert.strictEqual(git.runGitSync(dir, ['config', 'core.hooksPath']).trim(), git.noHooksDir());
    assert.strictEqual(git.runGitSync(dir, ['config', 'protocol.allow']).trim(), 'never');
  });

  it('refuses a caller hooks dir that is not empty', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const hooks = tmp();
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    await assert.rejects(git.runGit(tmp(), ['status'], { hooksDir: hooks }), /hooks directory .* is not empty/);
    assert.throws(() => git.runGitSync(tmp(), ['status'], { hooksDir: hooks }), /hooks directory .* is not empty/);
    await assert.rejects(git.runGit(tmp(), ['status'], { hooksDir: path.join(hooks, 'missing') }), /can't be used \(it is missing\)/);
  });

  it('strips inherited GIT_* variables and keeps its own env keys over the caller\'s', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    const other = tmp();
    await git.runGit(dir, ['init', '-q']);
    await git.runGit(other, ['init', '-q']);
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_EDITOR: process.env.GIT_EDITOR };
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_EDITOR = 'kl-planted-editor';
    try {
      await git.runGit(dir, ['config', 'alias.e', '!env']);
      const out = await git.runGit(dir, ['e'], { env: { GIT_TERMINAL_PROMPT: '1', GIT_ALLOW_PROTOCOL: 'ext' } });
      assert.ok(!out.includes(path.basename(other)), 'GIT_DIR from the environment does not reach git');
      assert.ok(!out.includes('kl-planted-editor'), 'GIT_EDITOR from the environment does not reach git');
      assert.match(out, /^GIT_TERMINAL_PROMPT=0$/m);
      assert.match(out, /^GIT_ALLOW_PROTOCOL=https:ssh$/m);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('never runs ext:: even when config turns the transport on', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    const marker = path.join(dir, 'ext-ran');
    const url = `ext::sh -c touch% ${marker.replace(/\\/g, '/')}`;
    // A global protocol.ext.allow=always is more specific than the
    // -c protocol.allow=never flag; only GIT_ALLOW_PROTOCOL stops it.
    const home = tmp();
    fs.writeFileSync(path.join(home, '.gitconfig'), '[protocol "ext"]\n\tallow = always\n');
    await assert.rejects(git.runGit(dir, ['ls-remote', url], { env: { HOME: home, USERPROFILE: home } }), (err) => err.code === 'GIT_FAILED');
    // A caller's -c or GIT_CONFIG_* env: refused before git runs.
    await assert.rejects(git.runGit(dir, ['-c', 'protocol.ext.allow=always', 'ls-remote', url]), (err) => err.code === 'GIT_BAD_ARGS');
    await assert.rejects(git.runGit(dir, ['ls-remote', url], { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always' } }), (err) => err.code === 'GIT_BAD_ARGS');
    // Config injected through inherited GIT_CONFIG_* variables.
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always' });
    try {
      await assert.rejects(git.runGit(dir, ['ls-remote', url]), (err) => err.code === 'GIT_FAILED');
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
    // Repo-local config: refused before git runs the command.
    await git.runGit(dir, ['config', 'protocol.ext.allow', 'always']);
    await assert.rejects(git.runGit(dir, ['ls-remote', url]), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.match(err.message, /protocol\.ext\.allow/);
      return true;
    });
    assert.strictEqual(fs.existsSync(marker), false, 'the ext:: command never ran');
  });

  it('refuses a repo whose config defines a filter driver', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    const marker = path.join(dir, 'filter-ran');
    await git.runGit(dir, ['config', 'filter.evil.clean', `touch "${marker.replace(/\\/g, '/')}"; cat`]);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await assert.rejects(git.runGit(dir, ['add', '-A']), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.match(err.message, /filter\.evil\.clean/);
      return true;
    });
    assert.throws(() => git.runGitSync(dir, ['add', '-A']), (err) => err.code === 'GIT_UNSAFE_CONFIG');
    assert.strictEqual(fs.existsSync(marker), false, 'the filter never ran');
  });

  it('refuses a case repo whose config sets diff.external, through git() too', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await git.commitAll(dir, 'first');
    const marker = path.join(dir, 'diff-ran');
    await git.git(dir, ['config', 'diff.external', `sh -c 'touch "${marker.replace(/\\/g, '/')}"' kl`]);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    await assert.rejects(git.git(dir, ['diff']), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.match(err.message, /diff\.external/);
      return true;
    });
    await assert.rejects(git.runGit(dir, ['diff']), (err) => err.code === 'GIT_UNSAFE_CONFIG');
    assert.strictEqual(fs.existsSync(marker), false, 'the external diff never ran');
  });

  it('refuses a leading global option and config-bearing caller env (GIT_BAD_ARGS)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    // An unsafe repo that a leading -C/--git-dir/--work-tree would otherwise reach
    // past the config check, run from a clean cwd.
    const unsafe = tmp();
    await git.runGit(unsafe, ['init', '-q']);
    const marker = path.join(unsafe, 'bypass-ran');
    await git.runGit(unsafe, ['config', 'filter.evil.clean', `touch "${marker.replace(/\\/g, '/')}"; cat`]);
    fs.writeFileSync(path.join(unsafe, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(unsafe, 'a.txt'), 'one\n');
    const cwd = tmp();
    const leading = [
      ['-C', unsafe, 'add', '-A'],
      ['-c', 'core.hooksPath=.git/hooks', 'status'],
      [`--git-dir=${path.join(unsafe, '.git')}`, `--work-tree=${unsafe}`, 'add', '-A'],
      ['--git-dir', path.join(unsafe, '.git'), 'status'],
      [`--work-tree=${unsafe}`, 'status'],
      ['--namespace=x', 'status'],
      ['--config-env=core.hooksPath=HOME', 'status'],
      ['--exec-path=/tmp', 'status'],
      ['--bare', 'status']
    ];
    for (const args of leading) {
      await assert.rejects(git.runGit(cwd, args), (err) => err.code === 'GIT_BAD_ARGS', args[0]);
      assert.throws(() => git.runGitSync(cwd, args), (err) => err.code === 'GIT_BAD_ARGS', args[0]);
    }
    await assert.rejects(git.runGit(cwd, []), (err) => err.code === 'GIT_BAD_ARGS');
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_ASKPASS', 'git_dir']) {
      await assert.rejects(git.runGit(cwd, ['status'], { env: { [key]: 'x' } }), (err) => err.code === 'GIT_BAD_ARGS', key);
    }
    assert.strictEqual(fs.existsSync(marker), false, 'the filter in the other repo never ran');
    // An option after the subcommand is the caller's business.
    await git.runGit(cwd, ['init', '-q', '--initial-branch=main']);
  });

  it('refuses unsafe config in config.worktree when extensions.worktreeConfig is on', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await git.commitAll(dir, 'first');
    await git.git(dir, ['config', 'extensions.worktreeConfig', 'true']);
    const marker = path.join(dir, 'worktree-diff-ran');
    await git.git(dir, ['config', '--worktree', 'diff.external', `sh -c 'touch "${marker.replace(/\\/g, '/')}"' kl`]);
    assert.ok(fs.existsSync(path.join(dir, '.git', 'config.worktree')));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    await assert.rejects(git.git(dir, ['diff']), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.match(err.message, /diff\.external/);
      return true;
    });
    assert.throws(() => git.runGitSync(dir, ['diff']), (err) => err.code === 'GIT_UNSAFE_CONFIG');
    assert.strictEqual(fs.existsSync(marker), false, 'the external diff never ran');
  });

  it('names a timeout', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    // hash-object --stdin waits for input that never comes.
    await assert.rejects(git.runGit(tmp(), ['hash-object', '--stdin'], { timeoutMs: 300 }), (err) => {
      assert.strictEqual(err.code, 'GIT_TIMEOUT');
      assert.match(err.message, /git hash-object timed out after 300 ms/);
      return true;
    });
  });

  it('names a timeout in runGitSync', { timeout: 20000 }, async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    // A shell alias that outlives the timeout (runGitSync gives git no stdin).
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    await git.runGit(dir, ['config', 'alias.z', '!sleep 5']);
    assert.throws(() => git.runGitSync(dir, ['z'], { timeoutMs: 300 }), (err) => {
      assert.strictEqual(err.code, 'GIT_TIMEOUT');
      assert.match(err.message, /git z timed out after 300 ms/);
      return true;
    });
  });

  it('carries the first stderr line on failure', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    await assert.rejects(git.runGit(dir, ['rev-parse', '--verify', 'no-such-ref']), (err) => {
      assert.ok(err.firstLine.length > 0);
      assert.strictEqual(git.firstStderrLine(err), err.firstLine);
      assert.strictEqual(err.code, 'GIT_FAILED');
      assert.strictEqual(err.exitCode, 128);
      assert.strictEqual(err.message, `git rev-parse failed: ${err.firstLine}`);
      return true;
    });
    assert.throws(() => git.runGitSync(dir, ['rev-parse', '--verify', 'no-such-ref']), (err) => {
      assert.strictEqual(err.code, 'GIT_FAILED');
      assert.strictEqual(err.exitCode, 128);
      return err.firstLine.length > 0;
    });
  });

  it('never puts a URL credential, the argv or raw stderr on the error', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const url = 'https://someone:s3cr3t-token@127.0.0.1:1/x.git';
    const check = (err) => {
      assert.strictEqual(err.code, 'GIT_FAILED');
      assert.match(err.message, /^git ls-remote failed: /);
      assert.ok(!err.message.includes('s3cr3t-token'), err.message);
      assert.ok(!err.firstLine.includes('s3cr3t-token'));
      for (const key of ['cmd', 'stderr', 'stdout', 'spawnargs']) assert.strictEqual(err[key], undefined, key);
      return true;
    };
    await assert.rejects(git.runGit(tmp(), ['ls-remote', url], { timeoutMs: 30000 }), check);
    assert.throws(() => git.runGitSync(tmp(), ['ls-remote', url], { timeoutMs: 30000 }), check);
    // Git's own stderr may echo the URL; firstStderrLine strips userinfo too.
    assert.strictEqual(git.firstStderrLine({ stderr: `\nfatal: repository '${url}' not found\n` }), "fatal: repository 'https://127.0.0.1:1/x.git' not found");
  });

  it('keeps git() on the checked hooks dir outside the case, with fsmonitor off', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.initRepo(dir);
    assert.strictEqual(fs.existsSync(path.join(dir, '.kl')), false);
    assert.strictEqual((await git.git(dir, ['config', 'core.hooksPath'])).trim(), git.noHooksDir());
    assert.strictEqual((await git.git(dir, ['config', 'core.fsmonitor'])).trim(), 'false');
  });
});

describe('.gitattributes (R31)', () => {
  it('a new case commits playbooks/** -text', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const info = await new CaseStore({ root: tmp() }).create({ title: 'Lakeside lot' });
    assert.strictEqual(fs.readFileSync(path.join(info.dir, '.gitattributes'), 'utf8'), 'playbooks/** -text\n');
    assert.strictEqual((await git.git(info.dir, ['ls-files', '.gitattributes'])).trim(), '.gitattributes');
    const attr = await git.git(info.dir, ['check-attr', 'text', '--', 'playbooks/property-sale/steps.md']);
    assert.match(attr, /text: unset/);
  });

  it('ensureGitattributes appends to an existing file once', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.png binary');
    assert.strictEqual(git.ensureGitattributes(dir), true);
    assert.strictEqual(git.ensureGitattributes(dir), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), '*.png binary\nplaybooks/** -text\n');
  });
});

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
      'commit.gpgsign=false', 'tag.gpgsign=false', 'core.hooksPath=/tmp/empty-hooks', 'core.fsmonitor=false', 'core.symlinks=false', 'core.autocrlf=false',
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
      const syncOut = git.runGitSync(dir, ['e']);
      assert.ok(!syncOut.includes(path.basename(other)), 'runGitSync: GIT_DIR from the environment does not reach git');
      assert.ok(!syncOut.includes('kl-planted-editor'), 'runGitSync: GIT_EDITOR from the environment does not reach git');
      assert.match(syncOut, /^GIT_TERMINAL_PROMPT=0$/m);
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

  it('refuses a repo whose config sets submodule.<name>.update (a "!command" update)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    const marker = path.join(dir, 'update-ran');
    await git.runGit(dir, ['config', 'submodule.x.update', `!touch "${marker.replace(/\\/g, '/')}"`]);
    await assert.rejects(git.runGit(dir, ['status']), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.match(err.message, /submodule.x.update/);
      return true;
    });
    assert.throws(() => git.runGitSync(dir, ['status']), (err) => err.code === 'GIT_UNSAFE_CONFIG');
    assert.strictEqual(fs.existsSync(marker), false);
  });

  it('with killTree, a timeout kills the whole process tree, so a hung transport helper dies with git', { timeout: 30000 }, async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const net = require('net');
    const sockets = [];
    let closed = 0;
    const server = net.createServer((s) => {
      sockets.push(s);
      s.on('error', () => {});
      s.on('close', () => { closed += 1; });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `https://127.0.0.1:${server.address().port}/x.git`;
    const noProxy = { NO_PROXY: '*', no_proxy: '*', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' };
    try {
      await assert.rejects(
        git.runGit(tmp(), ['ls-remote', '--', url], { timeoutMs: 3000, killTree: true, env: noProxy }),
        (err) => err.code === 'GIT_TIMEOUT'
      );
      assert.ok(sockets.length >= 1, 'git connected to the server');
      const until = Date.now() + 10000;
      while (closed < sockets.length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(closed, sockets.length, 'the transport helper holding the connection was killed');
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
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

  // A repo whose config defines a clean filter over every file; returns the
  // marker path the filter would create.
  async function plantFilter(repo) {
    const marker = path.join(repo, 'filter-ran');
    await git.runGit(repo, ['config', 'filter.evil.clean', `touch "${marker.replace(/\\/g, '/')}"; cat`]);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
    return marker;
  }
  const refusedUnsafe = (err) => err.code === 'GIT_UNSAFE_CONFIG';

  it('does not trust a cached check once .git gains a commondir', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const evil = tmp();
    await git.runGit(evil, ['init', '-q']);
    const marker = await plantFilter(evil);
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    await git.runGit(dir, ['status']); // a clean check, cacheable
    fs.writeFileSync(path.join(dir, '.git', 'commondir'), `${path.join(evil, '.git')}\n`);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await assert.rejects(git.runGit(dir, ['add', '-A']), refusedUnsafe);
    assert.throws(() => git.runGitSync(dir, ['add', '-A']), refusedUnsafe);
    assert.strictEqual(fs.existsSync(marker), false, 'the filter from the common dir never ran');
  });

  it('does not cache a decoy .git that git passes over for the enclosing repo', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.runGit(parent, ['init', '-q']);
    // HEAD, objects/ and a clean config, but no refs/: git does not accept it.
    const sub = path.join(parent, 'sub');
    fs.mkdirSync(path.join(sub, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(sub, '.git', 'config'), '[core]\n\tbare = false\n');
    // Clean parent config, checked through both paths; must not be cached for sub.
    await git.runGit(sub, ['status']);
    git.runGitSync(sub, ['status']);
    const marker = await plantFilter(parent);
    fs.writeFileSync(path.join(sub, 'a.txt'), 'one\n');
    await assert.rejects(git.runGit(sub, ['add', '-A']), refusedUnsafe);
    assert.throws(() => git.runGitSync(sub, ['add', '-A']), refusedUnsafe);
    assert.strictEqual(fs.existsSync(marker), false, 'the enclosing repo\'s filter never ran');
  });

  it('re-checks when HEAD breaks after a clean check and git walks up to a parent', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.runGit(parent, ['init', '-q']);
    const sub = path.join(parent, 'sub');
    fs.mkdirSync(sub);
    await git.runGit(sub, ['init', '-q']);
    await git.runGit(sub, ['status']); // a real repo: cached
    const marker = await plantFilter(parent);
    fs.writeFileSync(path.join(sub, '.git', 'HEAD'), 'not a ref\n');
    fs.writeFileSync(path.join(sub, 'a.txt'), 'one\n');
    await assert.rejects(git.runGit(sub, ['add', '-A']), refusedUnsafe);
    assert.strictEqual(fs.existsSync(marker), false, 'the parent\'s filter never ran');
  });

  it('never walks up to a parent when refs/ vanishes after a clean check', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.runGit(parent, ['init', '-q']);
    const sub = path.join(parent, 'sub');
    fs.mkdirSync(sub);
    await git.runGit(sub, ['init', '-q']);
    await git.runGit(sub, ['status']); // a real repo: cached
    git.runGitSync(sub, ['status']);
    const marker = await plantFilter(parent);
    fs.rmSync(path.join(sub, '.git', 'refs'), { recursive: true, force: true });
    fs.writeFileSync(path.join(sub, 'a.txt'), 'one\n');
    // Without refs/ the cache misses and the full check finds the parent's
    // filter. (The GIT_DIR pin alone would also stop it, as GIT_FAILED.)
    await assert.rejects(git.runGit(sub, ['add', '-A']), refusedUnsafe);
    assert.throws(() => git.runGitSync(sub, ['add', '-A']), refusedUnsafe);
    assert.strictEqual(fs.existsSync(marker), false, 'the parent\'s filter never ran');
  });

  it('pins git to the checked repository, except for init and clone and outside a repo', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const envVar = (out, name) => { const m = String(out).match(new RegExp(`^${name}=(.*)$`, 'm')); return m ? m[1].trim() : null; };
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    await git.runGit(dir, ['config', 'alias.e', '!env']);
    for (const out of [await git.runGit(dir, ['e']), await git.runGit(dir, ['e']), git.runGitSync(dir, ['e'])]) {
      assert.ok(git.samePath(envVar(out, 'GIT_DIR'), path.join(dir, '.git')), `GIT_DIR pinned: ${envVar(out, 'GIT_DIR')}`);
      assert.ok(git.samePath(envVar(out, 'GIT_WORK_TREE'), dir), `GIT_WORK_TREE pinned: ${envVar(out, 'GIT_WORK_TREE')}`);
    }
    // init and clone at a path inside a checked repo create their own repository.
    await git.runGit(dir, ['init', '-q', 'nested']);
    assert.ok(fs.existsSync(path.join(dir, 'nested', '.git', 'HEAD')));
    const source = tmp();
    await git.runGit(source, ['init', '-q']);
    await git.runGit(source, ['commit', '-q', '--allow-empty', '-m', 'first'], { env: ID_ENV });
    await git.runGit(dir, ['clone', '-q', source, 'copy'], { allowFile: true });
    assert.ok(fs.existsSync(path.join(dir, 'copy', '.git', 'HEAD')));
    assert.strictEqual((await git.runGit(path.join(dir, 'copy'), ['rev-list', '--count', 'HEAD'])).trim(), '1');
    // Not a repository: nothing is pinned, and git reports it as before.
    await assert.rejects(git.runGit(tmp(), ['rev-parse', '--show-toplevel']), (err) => err.code === 'GIT_FAILED' && /not a git repository/i.test(err.message));
  });

  it('refuses a repo whose remote sets uploadpack', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const source = tmp();
    await git.runGit(source, ['init', '-q']);
    fs.writeFileSync(path.join(source, 'a.txt'), 'one\n');
    await git.runGit(source, ['add', '-A']);
    await git.runGit(source, ['commit', '-q', '-m', 'first'], { env: ID_ENV });
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    const marker = path.join(dir, 'uploadpack-ran');
    await git.runGit(dir, ['remote', 'add', 'origin', source]);
    await git.runGit(dir, ['config', 'remote.origin.uploadpack', `sh -c 'touch "${marker.replace(/\\/g, '/')}"; exec git-upload-pack "$@"' kl`]);
    await assert.rejects(git.runGit(dir, ['fetch', '-q', 'origin'], { allowFile: true }), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.match(err.message, /remote\.origin\.uploadpack/);
      return true;
    });
    assert.strictEqual(fs.existsSync(marker), false, 'the upload-pack program never ran');
  });

  it('refuses a repo whose config sets gpg.program', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    const marker = path.join(dir, 'gpg-ran');
    const script = path.join(dir, 'fake-gpg.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\nexit 1\n`, { mode: 0o755 });
    await git.runGit(dir, ['config', 'gpg.program', script.replace(/\\/g, '/')]);
    await assert.rejects(git.runGit(dir, ['commit', '-q', '-S', '--allow-empty', '-m', 'signed'], { env: ID_ENV }), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.match(err.message, /gpg\.program/);
      return true;
    });
    assert.strictEqual(fs.existsSync(marker), false, 'the gpg program never ran');
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

  it('names a timeout', { timeout: 20000 }, async (t) => {
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

// Task 2b (ruling C6-submod): git reads a checked-out submodule's own config,
// and runs its filters, on status, add and diff in the parent repository.
describe('checked-out submodules', () => {
  // A committed repo with one file.
  async function sourceRepo(file = 's.txt') {
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, file), 'one\n');
    await git.runGit(dir, ['add', '-A']);
    await git.runGit(dir, ['commit', '-q', '-m', 'first'], { env: ID_ENV });
    return dir;
  }
  async function addSubmodule(parent, source, rel) {
    await git.runGit(parent, ['submodule', 'add', '-q', source, rel], { allowFile: true, env: ID_ENV });
    await git.runGit(parent, ['commit', '-q', '-m', `add ${rel}`], { env: ID_ENV });
  }
  // Plants a clean filter over every file of the checked-out repo at `tree`
  // (through its own git config) and dirties a file so git runs it.
  function plantSubFilter(tree, marker, file = 's.txt') {
    const out = spawnGit(tree, ['config', 'filter.evil.clean', `touch "${marker.replace(/\\/g, '/')}"; cat`]);
    assert.strictEqual(out.status, 0, out.stderr);
    fs.writeFileSync(path.join(tree, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(tree, file), 'two\n');
  }
  // Raw git, only to plant config the way an attacker would.
  function spawnGit(cwd, args) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
    return require('child_process').spawnSync('git', args, { cwd, encoding: 'utf8', env });
  }
  const refusedFor = (submodule) => (err) => {
    assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
    assert.strictEqual(err.submodule, submodule);
    assert.match(err.message, new RegExp(`submodule ${submodule.replace(/\//g, '\\/')}`));
    assert.match(err.message, /filter\.evil\.clean/);
    return true;
  };

  it('refuses status, add and diff in a case whose submodule defines a filter', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.initRepo(parent);
    await addSubmodule(parent, await sourceRepo(), 'sub');
    const marker = path.join(parent, 'sub-filter-ran');
    plantSubFilter(path.join(parent, 'sub'), marker);
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('sub'));
    await assert.rejects(git.git(parent, ['add', '-A']), refusedFor('sub'));
    await assert.rejects(git.git(parent, ['diff', 'HEAD']), refusedFor('sub'));
    await assert.rejects(git.commitAll(parent, 'turn'), refusedFor('sub'));
    assert.throws(() => git.runGitSync(parent, ['status', '--porcelain']), refusedFor('sub'));
    assert.strictEqual(fs.existsSync(marker), false, 'the submodule filter never ran');
  });

  it('refuses a filter in a nested submodule at depth 2', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const inner = await sourceRepo('i.txt');
    const middle = await sourceRepo();
    await addSubmodule(middle, inner, 'inner');
    const parent = tmp();
    await git.initRepo(parent);
    await addSubmodule(parent, middle, 'sub');
    await git.runGit(parent, ['submodule', 'update', '-q', '--init', '--recursive'], { allowFile: true });
    assert.ok(fs.existsSync(path.join(parent, 'sub', 'inner', '.git')), 'the nested submodule is checked out');
    await git.git(parent, ['status', '--porcelain']); // clean at every depth
    const marker = path.join(parent, 'nested-filter-ran');
    plantSubFilter(path.join(parent, 'sub', 'inner'), marker, 'i.txt');
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('sub/inner'));
    await assert.rejects(git.git(parent, ['add', '-A']), refusedFor('sub/inner'));
    assert.strictEqual(fs.existsSync(marker), false, 'the nested submodule filter never ran');
  });

  it('re-checks after a submodule config is edited behind a clean cached check', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.initRepo(parent);
    await addSubmodule(parent, await sourceRepo(), 'sub');
    await git.git(parent, ['status', '--porcelain']);
    await git.git(parent, ['status', '--porcelain']); // a cache hit
    // Edit the submodule's config file directly: no git command in the parent.
    const subConfig = path.join(parent, '.git', 'modules', 'sub', 'config');
    const marker = path.join(parent, 'edited-filter-ran');
    fs.appendFileSync(subConfig, `[filter "evil"]\n\tclean = touch \\"${marker.replace(/\\/g, '/')}\\"; cat\n`);
    fs.writeFileSync(path.join(parent, 'sub', '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(parent, 'sub', 's.txt'), 'two\n');
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('sub'));
    assert.throws(() => git.runGitSync(parent, ['status', '--porcelain']), refusedFor('sub'));
    assert.strictEqual(fs.existsSync(marker), false, 'the edited submodule filter never ran');
  });

  it('checks a submodule checked out after a clean cached check', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.initRepo(parent);
    await addSubmodule(parent, await sourceRepo(), 'sub');
    // Deinit: the gitlink stays, nothing is checked out.
    await git.runGit(parent, ['submodule', 'deinit', '-q', '-f', 'sub']);
    assert.strictEqual(fs.existsSync(path.join(parent, 'sub', '.git')), false);
    await git.git(parent, ['status', '--porcelain']);
    await git.git(parent, ['status', '--porcelain']); // cached without the submodule
    await git.runGit(parent, ['submodule', 'update', '-q', '--init'], { allowFile: true });
    const marker = path.join(parent, 'late-filter-ran');
    plantSubFilter(path.join(parent, 'sub'), marker);
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('sub'));
    assert.strictEqual(fs.existsSync(marker), false, 'the late submodule filter never ran');
  });

  it('leaves a clean submodule and a repo without submodules working as before', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.initRepo(parent);
    fs.writeFileSync(path.join(parent, 'a.txt'), 'one\n');
    assert.ok(await git.commitAll(parent, 'plain'));
    await addSubmodule(parent, await sourceRepo(), 'sub');
    fs.writeFileSync(path.join(parent, 'a.txt'), 'two\n');
    assert.ok(await git.commitAll(parent, 'with a clean submodule'));
    assert.strictEqual((await git.git(parent, ['status', '--porcelain'])).trim(), '');
  });

  // A nested repo at `rel` inside `parent` with a committed s.txt; returns its HEAD.
  async function nestedRepo(parent, rel) {
    const tree = path.join(parent, rel);
    fs.mkdirSync(tree, { recursive: true });
    await git.runGit(tree, ['init', '-q']);
    fs.writeFileSync(path.join(tree, 's.txt'), 'one\n');
    await git.runGit(tree, ['add', '-A']);
    await git.runGit(tree, ['commit', '-q', '-m', 'first'], { env: ID_ENV });
    return (await git.runGit(tree, ['rev-parse', 'HEAD'])).trim();
  }
  // Records a gitlink in the parent's index only: no config, no .gitmodules.
  function addGitlink(parent, rel, sha) {
    const out = spawnGit(parent, ['update-index', '--add', '--cacheinfo', `160000,${sha},${rel}`]);
    assert.strictEqual(out.status, 0, out.stderr);
  }

  it('refuses an index whose padding hides a longer name than the flags give', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.initRepo(parent);
    assert.ok(await git.commitAll(parent, 'plain'));
    await git.git(parent, ['status', '--porcelain']);
    await git.git(parent, ['status', '--porcelain']); // cached with no gitlinks
    // The gitlink is recorded as "subz" (flags length 4), then its NUL padding
    // is filled with "zzzzz". Git copies the byte after the 4 name bytes as the
    // terminator and so uses the path "subzz", where the planted repository
    // is; a NUL search reads "subzzzzzz", a path that does not exist, and
    // would key the index as having no checked-out submodule.
    const sha = await nestedRepo(parent, 'subzz');
    const marker = path.join(parent, 'padded-filter-ran');
    plantSubFilter(path.join(parent, 'subzz'), marker);
    addGitlink(parent, 'subz', sha);
    const indexFile = path.join(parent, '.git', 'index');
    const buf = fs.readFileSync(indexFile);
    const at = buf.indexOf(Buffer.from('subz\0\0\0\0\0\0', 'latin1'));
    assert.ok(at > 0, 'the subz entry has six bytes of NUL padding');
    assert.strictEqual(buf.readUInt16BE(at - 2) & 0xfff, 4);
    buf.write('zzzzz', at + 4, 'latin1');
    require('crypto').createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest().copy(buf, buf.length - 20);
    fs.writeFileSync(indexFile, buf);
    const listed = spawnGit(parent, ['ls-files', '--stage']);
    assert.strictEqual(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^160000 [0-9a-f]+ 0\tsubzz$/m, 'git reads the gitlink as subzz');
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('subzz'));
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('subzz')); // not cached either
    assert.throws(() => git.runGitSync(parent, ['status', '--porcelain']), refusedFor('subzz'));
    assert.strictEqual(fs.existsSync(marker), false, 'the filter behind the padded name never ran');
  });

  it('refuses a checked-out submodule nested 4 levels deep', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    // s4 inside s3 inside s2 inside s1 inside the case: sub/x/y/z is depth 4.
    let inner = await sourceRepo();
    for (const rel of ['z', 'y', 'x']) {
      const outer = await sourceRepo();
      await addSubmodule(outer, inner, rel);
      inner = outer;
    }
    const parent = tmp();
    await git.initRepo(parent);
    await addSubmodule(parent, inner, 'sub');
    await git.runGit(parent, ['submodule', 'update', '-q', '--init', '--recursive'], { allowFile: true });
    assert.ok(fs.existsSync(path.join(parent, 'sub', 'x', 'y', 'z', '.git')), 'depth 4 is checked out');
    await assert.rejects(git.git(parent, ['status', '--porcelain']), (err) => {
      assert.strictEqual(err.code, 'GIT_UNSAFE_CONFIG');
      assert.strictEqual(err.submodule, 'sub/x/y/z');
      assert.match(err.message, /nested more than 3 levels deep/);
      return true;
    });
  });

  it('never caches a split index', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.initRepo(parent);
    assert.ok(await git.commitAll(parent, 'plain'));
    await git.runGit(parent, ['update-index', '--split-index']);
    assert.ok(fs.readdirSync(path.join(parent, '.git')).some((n) => n.startsWith('sharedindex.')), 'the index is split');
    await git.git(parent, ['status', '--porcelain']);
    await git.git(parent, ['status', '--porcelain']);
    // A gitlink written straight into a fresh shared index: the main index
    // file then lists no entries at all, only the "link" extension.
    const sha = await nestedRepo(parent, 'sub');
    const marker = path.join(parent, 'split-filter-ran');
    plantSubFilter(path.join(parent, 'sub'), marker);
    const out = spawnGit(parent, ['-c', 'splitIndex.maxPercentChange=0', 'update-index', '--add', '--cacheinfo', `160000,${sha},sub`]);
    assert.strictEqual(out.status, 0, out.stderr);
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('sub'));
    assert.throws(() => git.runGitSync(parent, ['status', '--porcelain']), refusedFor('sub'));
    assert.strictEqual(fs.existsSync(marker), false, 'the filter behind the shared index never ran');
  });

  it('checks a gitlink added after a cached check whose .git points outside the case', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const parent = tmp();
    await git.initRepo(parent);
    assert.ok(await git.commitAll(parent, 'plain'));
    await git.git(parent, ['status', '--porcelain']);
    await git.git(parent, ['status', '--porcelain']); // cached with no gitlinks
    // A repository outside the case, checked out into the case through a
    // "gitdir:" file.
    const outside = tmp();
    const sha = await nestedRepo(outside, 'repo');
    const tree = path.join(parent, 'ext');
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${path.join(outside, 'repo', '.git').replace(/\\/g, '/')}\n`);
    fs.writeFileSync(path.join(tree, 's.txt'), 'one\n');
    const marker = path.join(parent, 'outside-filter-ran');
    plantSubFilter(tree, marker);
    addGitlink(parent, 'ext', sha);
    await assert.rejects(git.git(parent, ['status', '--porcelain']), refusedFor('ext'));
    assert.throws(() => git.runGitSync(parent, ['status', '--porcelain']), refusedFor('ext'));
    assert.strictEqual(fs.existsSync(marker), false, 'the outside repository\'s filter never ran');
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

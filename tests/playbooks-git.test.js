// tests/playbooks-git.test.js
// The hardened git helpers (cases stage 6 spec §3.4): every call carries the
// same -c flags and env, runGit outside a case creates no .kl/, timeouts are
// named, and new cases commit .gitattributes (R31).
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
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

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
    await git.runGit(dir, [...ID, 'commit', '-q', '-m', 'first']);
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

  it('carries the first stderr line on failure', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = tmp();
    await git.runGit(dir, ['init', '-q']);
    await assert.rejects(git.runGit(dir, ['rev-parse', '--verify', 'no-such-ref']), (err) => {
      assert.ok(err.firstLine.length > 0);
      assert.strictEqual(git.firstStderrLine(err), err.firstLine);
      return true;
    });
    assert.throws(() => git.runGitSync(dir, ['rev-parse', '--verify', 'no-such-ref']), (err) => err.firstLine.length > 0);
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

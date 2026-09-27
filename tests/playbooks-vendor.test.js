// tests/playbooks-vendor.test.js
// Vendoring (cases stage 6 spec §3.4, §6): sources, the allowlist, hardened
// fetches, and the copy into the case.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const v = require('../src/cases/playbooks/vendor');
const { hashPackage } = require('../src/cases/playbooks/format');
const { writePackage, makeGitPackage, commitPackage, GIT_ID, PLAYBOOK_YAML } = require('./helpers/playbook-fixture');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbvend-')); dirs.push(d); return d; };
const UNSUPPORTED = (s) => `Unsupported playbook source "${s}". Use example:<name>, an absolute folder path, or an https/ssh git URL.`;
const ALLOWED = { sources: ['https://example.com/playbooks/', 'ssh://git@example.com/'] };

// A directory link that needs no privilege: a junction on Windows, a
// symlink elsewhere. null when the platform refuses both.
function dirLink(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  } catch {
    return null;
  }
}

describe('resolveSource', () => {
  it('example:<name> from the examples dir', () => {
    const examples = tmp();
    writePackage(path.join(examples, 'land-sale'));
    assert.deepStrictEqual(v.resolveSource('example:land-sale', { examplesDir: examples }), {
      kind: 'example', source: 'example:land-sale', fetchSpec: { path: path.join(examples, 'land-sale') }
    });
    assert.throws(() => v.resolveSource('example:nope', { examplesDir: examples }), /Unknown example playbook "nope"\./);
    assert.throws(() => v.resolveSource('example:../land-sale', { examplesDir: examples }), /Unknown example playbook/);
    assert.throws(() => v.resolveSource('example:land-sale', { examplesDir: null }), /Example playbooks are not available in this build\./);
  });

  it('an absolute folder, with or without path:', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    assert.deepStrictEqual(v.resolveSource(dir), { kind: 'path', source: `path:${dir}`, fetchSpec: { path: dir } });
    assert.strictEqual(v.resolveSource(`path:${dir}`).source, `path:${dir}`);
    assert.throws(() => v.resolveSource(path.join(dir, 'missing')), /does not exist/);
  });

  it('https and ssh URLs against the allowlist; git+ is stripped, scp form kept verbatim', () => {
    assert.deepStrictEqual(v.resolveSource('git+https://example.com/playbooks/land-sale.git', { settings: ALLOWED }), {
      kind: 'git', source: 'https://example.com/playbooks/land-sale.git', fetchSpec: { url: 'https://example.com/playbooks/land-sale.git' }
    });
    assert.strictEqual(v.resolveSource('git@example.com:team/land-sale.git', { settings: ALLOWED }).source, 'git@example.com:team/land-sale.git');
    assert.strictEqual(v.resolveSource('ssh://git@EXAMPLE.com/team/land-sale.git', { settings: ALLOWED }).kind, 'git');
    assert.throws(
      () => v.resolveSource('https://example.org/playbooks/land-sale.git', { settings: ALLOWED }),
      { message: 'Playbook source https://example.org/playbooks/land-sale.git is not allowed. Add its host to Settings → Playbooks → Allowed sources.' }
    );
    assert.throws(() => v.resolveSource('https://example.com/playbooks/land-sale.git', { settings: { sources: [] } }), /is not allowed/);
  });

  it('matches an allowlist entry only at a path boundary', () => {
    const settings = { sources: ['https://example.com'] };
    assert.strictEqual(v.isUrlAllowed('https://example.com/a/b.git', settings), true);
    assert.strictEqual(v.isUrlAllowed('https://example.com.evil.example/a.git', settings), false);
    assert.strictEqual(v.isUrlAllowed('https://example.com/playbooks-other/x.git', { sources: ['https://example.com/playbooks'] }), false);
    assert.strictEqual(v.normalizeUrl('git@Example.COM:team/x.git'), 'ssh://git@example.com/team/x');
  });

  it('refuses UNC and device paths before any file system call (no SMB connection, no NTLM)', (t) => {
    const forms = ['\\\\host\\share\\pb', '//host/share/pb', '\\\\?\\UNC\\host\\share\\pb', '\\\\?\\C:\\pb', '\\\\.\\C:\\pb', 'path:\\\\host\\share\\pb', 'path://host/share/pb'];
    const names = ['statSync', 'lstatSync', 'existsSync', 'realpathSync', 'readdirSync', 'openSync', 'accessSync'];
    const calls = [];
    for (const name of names) t.mock.method(fs, name, (...args) => { calls.push([name, String(args[0])]); throw new Error(`fs.${name} called`); });
    t.mock.method(fs.realpathSync, 'native', (p) => { calls.push(['realpathSync.native', String(p)]); throw new Error('realpath called'); });
    for (const s of forms) {
      assert.throws(() => v.resolveSource(s, { settings: ALLOWED }), (err) => err.code === 'UNSUPPORTED_SOURCE' && err.message === UNSUPPORTED(s), s);
    }
    // A UNC path: allowlist entry is never resolved either; it matches nothing.
    assert.throws(() => v.assertPathAllowed(path.resolve('/srv/pb'), { sources: ['path:\\\\host\\share'] }), /outside the allowed folders/);
    assert.deepStrictEqual(calls, []);
  });

  it('an allowlist entry ending in .git names one repository: exact match only', () => {
    const settings = { sources: ['https://example.com/org/repo.git'] };
    assert.strictEqual(v.isUrlAllowed('https://example.com/org/repo.git', settings), true);
    assert.strictEqual(v.isUrlAllowed('https://example.com/org/repo', settings), true);
    assert.strictEqual(v.isUrlAllowed('https://example.com/org/repo/other', settings), false);
    assert.strictEqual(v.isUrlAllowed('https://example.com/org/repo/other.git', settings), false);
    // Without .git the entry is still a prefix.
    assert.strictEqual(v.isUrlAllowed('https://example.com/org/repo/other', { sources: ['https://example.com/org/repo'] }), true);
  });

  it('refuses unsupported schemes, relative paths, a leading dash and passwords', () => {
    for (const s of ['http://example.com/x.git', 'git://example.com/x.git', 'file:///srv/x', 'ext::sh -c touch% /tmp/pwned', 'playbooks/land-sale', '-uhttps://example.com/x']) {
      assert.throws(() => v.resolveSource(s, { settings: ALLOWED }), { message: UNSUPPORTED(s) }, s);
    }
    assert.throws(() => v.resolveSource('https://user:secret@example.com/playbooks/x.git', { settings: ALLOWED }), /cannot carry a password/);
  });

  it('scp-style ssh: accepted only in its ssh:// form under an entry, never with an option-like host, user or path', () => {
    const scp = v.resolveSource('git@example.com:team/land-sale.git', { settings: ALLOWED });
    assert.deepStrictEqual(scp, { kind: 'git', source: 'git@example.com:team/land-sale.git', fetchSpec: { url: 'git@example.com:team/land-sale.git' } });
    // Another user on the allowed host is a different entry.
    assert.throws(() => v.resolveSource('deploy@example.com:team/x.git', { settings: ALLOWED }), /is not allowed/);
    assert.throws(() => v.resolveSource('git@example.org:team/x.git', { settings: ALLOWED }), /is not allowed/);
    for (const s of ['git@-oProxyCommand=x:team/x.git', '-oProxyCommand=x@example.com:team/x.git', 'git@example.com:-x/y.git']) {
      assert.throws(() => v.resolveSource(s, { settings: ALLOWED }), { message: UNSUPPORTED(s) }, s);
      assert.strictEqual(v.normalizeUrl(s), null, s);
    }
  });

  it('refuses URLs that the allowlist and git could read differently', () => {
    // A URL parser strips tabs, folds backslashes and resolves dot segments;
    // git would be handed the raw text. Such URLs are never allowed.
    for (const s of [
      'https://example.com/playbooks/../evil/x.git',
      'https://example.com/playbooks/./x.git',
      'https://example.com\\playbooks\\x.git',
      'https://exa\tmple.com/playbooks/x.git',
      'https://example.com/playbooks/%2e%2e/x.git',
      'https://example.com/playbooks/x.git?ref=main',
      'https://example.com/playbooks/x.git#main',
      'https://example.com/playbooks/x y.git'
    ]) {
      assert.throws(() => v.resolveSource(s, { settings: ALLOWED }), { message: UNSUPPORTED(s) }, s);
      assert.strictEqual(v.isUrlAllowed(s, ALLOWED), false, s);
    }
  });

  it('path: entries limit local folders to their roots', () => {
    const root = tmp();
    const inside = writePackage(path.join(root, 'land-sale'));
    const outside = writePackage(path.join(tmp(), 'land-sale'));
    const settings = { sources: [`path:${root}`] };
    assert.strictEqual(v.resolveSource(inside, { settings }).kind, 'path');
    assert.throws(() => v.resolveSource(outside, { settings }), { message: `Playbook source ${outside} is outside the allowed folders.` });
  });

  it('path: containment is by realpath: a link inside a root that leads out is outside', (t) => {
    const root = tmp();
    const outside = writePackage(path.join(tmp(), 'land-sale'));
    const link = dirLink(outside, path.join(root, 'land-sale'));
    if (!link) return t.skip('directory links cannot be created here');
    assert.throws(() => v.resolveSource(link, { settings: { sources: [`path:${root}`] } }), /is outside the allowed folders/);
  });

  it('isInside is realpath containment, case-folded on Windows and macOS', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    assert.strictEqual(v.isInside(path.join(root, 'a', 'b'), root), true);
    assert.strictEqual(v.isInside(root, root), true);
    assert.strictEqual(v.isInside(path.join(root, '..'), root), false);
    assert.strictEqual(v.isInside(`${root}-other`, root), false);
    // Not-yet-existing children resolve through their nearest existing parent.
    assert.strictEqual(v.isInside(path.join(root, 'a', 'new', 'file.md'), root), true);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.strictEqual(v.isInside(path.join(root.toUpperCase(), 'A'), root), true);
    }
  });
});

describe('fetchPackage', () => {
  it('copies a plain folder with commit null', async () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    const f = await v.fetchPackage(v.resolveSource(dir), { tmpRoot: tmp() });
    try {
      assert.strictEqual(f.commit, null);
      assert.strictEqual(hashPackage(f.pkgDir), hashPackage(dir));
    } finally {
      f.cleanup();
    }
    assert.strictEqual(fs.existsSync(f.tmpDir), false);
  });

  it('clones a local git top level, records HEAD, honours a ref', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const head1 = (await git.runGit(repo, ['rev-parse', 'HEAD'])).trim();
    await git.runGit(repo, ['branch', 'v1']);
    await commitPackage(repo, { 'sources.md': 'Placeholders only.\n' }, 'newer');
    const head2 = (await git.runGit(repo, ['rev-parse', 'HEAD'])).trim();
    const latest = await v.fetchPackage(v.resolveSource(repo), { tmpRoot: tmp() });
    assert.strictEqual(latest.commit, head2);
    assert.strictEqual(fs.existsSync(path.join(latest.pkgDir, '.git')), true);
    latest.cleanup();
    const pinned = await v.fetchPackage(v.resolveSource(repo), { ref: 'v1', tmpRoot: tmp() });
    assert.strictEqual(pinned.commit, head1);
    pinned.cleanup();
  });

  it('a tag works as a ref even though tags are not fetched', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const head1 = (await git.runGit(repo, ['rev-parse', 'HEAD'])).trim();
    await git.runGit(repo, ['tag', 'v1.2.0']);
    await commitPackage(repo, { 'sources.md': 'Placeholders only.\n' }, 'newer');
    const pinned = await v.fetchPackage(v.resolveSource(repo), { ref: 'v1.2.0', tmpRoot: tmp() });
    try {
      assert.strictEqual(pinned.commit, head1);
    } finally {
      pinned.cleanup();
    }
  });

  it('a failed fetch leaves nothing behind', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const root = tmp();
    await assert.rejects(v.fetchPackage(v.resolveSource(repo), { ref: 'no-such-branch', tmpRoot: root }), (err) => {
      assert.strictEqual(err.code, 'FETCH_FAILED');
      assert.ok(err.message.startsWith(`Could not fetch path:${repo}: `), err.message);
      return true;
    });
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });

  it('validates the fetched package before returning it, and leaves nothing behind when it is invalid', async (t) => {
    const plain = writePackage(path.join(tmp(), 'land-sale'), { 'steps.md': null });
    const root = tmp();
    await assert.rejects(v.fetchPackage(v.resolveSource(plain), { tmpRoot: root }), (err) => {
      assert.strictEqual(err.code, 'INVALID_PACKAGE');
      assert.strictEqual(err.message, `The playbook at path:${plain} is invalid:\nsteps.md: steps.md is missing`);
      assert.ok(Array.isArray(err.errors) && err.errors.length === 1);
      return true;
    });
    assert.deepStrictEqual(fs.readdirSync(root), []);
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'), { 'playbook.yaml': PLAYBOOK_YAML.replace('version: "1.2.0"', 'version: 1.2') });
    await assert.rejects(v.fetchPackage(v.resolveSource(repo), { tmpRoot: root }), (err) => {
      assert.strictEqual(err.code, 'INVALID_PACKAGE');
      assert.match(err.message, /^The playbook at path:.* is invalid:\nplaybook\.yaml: version must be a quoted string like "1\.2\.0"$/);
      return true;
    });
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });

  it('refuses a symlink committed to a git package, though core.symlinks=false checks it out as a file', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const blob = (await git.runGit(repo, ['hash-object', '-w', '--', 'steps.md'])).trim();
    await git.runGit(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},link.md`]);
    await git.runGit(repo, ['commit', '-q', '-m', 'link'], { env: GIT_ID });
    const root = tmp();
    await assert.rejects(v.fetchPackage(v.resolveSource(repo), { tmpRoot: root }), (err) => {
      assert.strictEqual(err.code, 'INVALID_PACKAGE');
      assert.match(err.message, /link\.md: symbolic links are not allowed/);
      return true;
    });
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });

  it('refuses a git source whose own config runs programs, and does not fall back to a plain copy', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const marker = path.join(tmp(), 'filter-ran');
    await git.runGit(repo, ['config', 'filter.evil.smudge', `touch "${marker.replace(/\\/g, '/')}"; cat`]);
    const root = tmp();
    await assert.rejects(v.fetchPackage(v.resolveSource(repo), { tmpRoot: root }), (err) => {
      assert.strictEqual(err.code, 'FETCH_FAILED');
      assert.match(err.message, /^Could not fetch path:.*Refusing to run git in .*filter\.evil\.smudge/);
      return true;
    });
    assert.deepStrictEqual(fs.readdirSync(root), []);
    assert.strictEqual(fs.existsSync(marker), false);
  });

  it('validates refs and refuses a ref for a plain folder', async () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    for (const ref of ['-x', 'a b', 'x'.repeat(101), 'v1;rm', '--upload-pack=x']) {
      await assert.rejects(v.fetchPackage(v.resolveSource(dir), { ref, tmpRoot: tmp() }), /Invalid ref/, ref);
    }
    const root = tmp();
    await assert.rejects(v.fetchPackage(v.resolveSource(dir), { ref: 'v1', tmpRoot: root }), /A ref applies only to git sources\./);
    assert.deepStrictEqual(fs.readdirSync(root), []);
    assert.strictEqual(v.REF_RE.test('-x'), false);
  });

  it('refuses a folder holding a symlink', async (t) => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    try {
      fs.symlinkSync(path.join(dir, 'steps.md'), path.join(dir, 'link.md'));
    } catch {
      return t.skip('symlinks cannot be created here');
    }
    await assert.rejects(v.fetchPackage(v.resolveSource(dir), { tmpRoot: tmp() }), /link\.md: symbolic links are not allowed/);
  });

  it('puts every hardening flag and "--" on the clone argv', () => {
    const args = v.cloneArgs({ kind: 'git', fetchSpec: { url: 'https://example.com/playbooks/x.git' } }, { ref: 'v1', dest: '/tmp/k/src' });
    assert.deepStrictEqual(args, ['clone', '--depth', '1', '--no-recurse-submodules', '--no-tags', '--branch', 'v1', '--', 'https://example.com/playbooks/x.git', '/tmp/k/src']);
    const argv = git.hardenedGitArgs(args, { hooksDir: '/tmp/k/hooks' });
    for (const flag of ['protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always', 'core.symlinks=false', 'filter.lfs.smudge=', 'core.hooksPath=/tmp/k/hooks']) {
      assert.ok(argv.includes(flag), flag);
    }
    assert.ok(!argv.includes('protocol.file.allow=always'));
    const local = v.cloneArgs({ kind: 'path', fetchSpec: { path: '/srv/pb' } }, { dest: 'd' });
    assert.deepStrictEqual(local, ['clone', '--no-hardlinks', '--no-recurse-submodules', '--no-tags', '--', '/srv/pb', 'd']);
    assert.throws(() => v.cloneArgs({ kind: 'git', fetchSpec: { url: 'https://example.com/x' } }, { ref: '-x', dest: 'd' }), /Invalid ref/);
  });
});

describe('config cache hygiene', () => {
  it('fetchPackage and readRemoteManifest forget the temp repositories they checked', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const root = tmp();
    // Control: a clean check under root is cached, and forgetConfigs finds it.
    const probe = path.join(root, 'probe');
    fs.mkdirSync(probe);
    await git.runGit(probe, ['init', '-q']);
    await git.runGit(probe, ['status']);
    assert.strictEqual(git.forgetConfigs(root), 1);
    const f = await v.fetchPackage(v.resolveSource(repo), { tmpRoot: root });
    f.cleanup();
    await v.readRemoteManifest(repo, { tmpRoot: root, allowFile: true });
    await assert.rejects(v.fetchPackage(v.resolveSource(repo), { ref: 'no-such-branch', tmpRoot: root }));
    fs.rmSync(probe, { recursive: true, force: true });
    assert.strictEqual(git.forgetConfigs(root), 0);
  });
});

describe('snapshots and vendorInto', () => {
  it('copies by rename, refuses an existing directory, and cleans leftovers', async () => {
    const src = writePackage(path.join(tmp(), 'land-sale'));
    const snap = v.readSnapshot(src);
    assert.strictEqual(v.snapshotHash(snap), hashPackage(src));
    const caseDir = tmp();
    const target = v.vendorInto(caseDir, snap, 'land-sale');
    assert.strictEqual(hashPackage(target), hashPackage(src));
    assert.deepStrictEqual(fs.readdirSync(path.join(caseDir, 'playbooks')), ['land-sale']);
    assert.throws(() => v.vendorInto(caseDir, snap, 'land-sale'), /playbooks\/land-sale already exists/);
    assert.throws(() => v.vendorInto(caseDir, snap, '../x'), /not a valid playbook name/);
    fs.mkdirSync(path.join(caseDir, 'playbooks', '.land-sale.tmp-0a1b2c3d'));
    assert.deepStrictEqual(v.removeTempLeftovers(caseDir), ['.land-sale.tmp-0a1b2c3d']);
    assert.deepStrictEqual(fs.readdirSync(path.join(caseDir, 'playbooks')), ['land-sale']);
  });

  it('refuses a link at playbooks/ or at the target, and writes nothing through it', (t) => {
    const snap = v.readSnapshot(writePackage(path.join(tmp(), 'land-sale')));
    const elsewhere = tmp();
    const caseA = tmp();
    if (!dirLink(elsewhere, path.join(caseA, 'playbooks'))) return t.skip('directory links cannot be created here');
    assert.throws(() => v.vendorInto(caseA, snap, 'land-sale'), /playbooks is a link/);
    const caseB = tmp();
    fs.mkdirSync(path.join(caseB, 'playbooks'));
    dirLink(elsewhere, path.join(caseB, 'playbooks', 'land-sale'));
    assert.throws(() => v.vendorInto(caseB, snap, 'land-sale'), /playbooks\/land-sale already exists/);
    assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(caseB, 'playbooks')), ['land-sale']);
  });

  it('refuses snapshot paths that leave the package, and a package that fails validation, leaving no temp dir', () => {
    const good = v.readSnapshot(writePackage(path.join(tmp(), 'land-sale')));
    const caseDir = tmp();
    for (const rel of [
      '../evil.md', 'a/../../evil.md', '/abs.md', 'C:/abs.md', 'a\\b.md', '.git/config', 'a//b.md', '',
      // Names Windows rewrites or maps to a device: nothing may be written for them.
      'steps~1.md', 'notes.md ', 'notes.md.', 'sub./a.md', 'con.md', 'NUL.txt', 'lpt1/a.md', 'aux'
    ]) {
      const snap = { files: [...good.files, { rel, data: Buffer.from('x\n') }] };
      assert.throws(() => v.vendorInto(caseDir, snap, 'land-sale'), /not a valid package path/, rel);
    }
    assert.throws(() => v.vendorInto(caseDir, { files: good.files.filter((f) => f.rel !== 'steps.md') }, 'land-sale'), /steps\.md is missing/);
    // A package vendored under a name it does not carry is refused.
    assert.throws(() => v.vendorInto(caseDir, good, 'other-name'), /must equal the directory name "other-name"/);
    assert.deepStrictEqual(fs.readdirSync(path.join(caseDir, 'playbooks')), []);
    assert.strictEqual(fs.existsSync(path.join(caseDir, 'evil.md')), false);
  });

  it('removeTempLeftovers removes only temp names and never follows a link', (t) => {
    const caseDir = tmp();
    const pb = path.join(caseDir, 'playbooks');
    fs.mkdirSync(pb);
    fs.mkdirSync(path.join(pb, '.keep'));
    fs.mkdirSync(path.join(pb, 'land-sale.tmp-00'));
    const victim = tmp();
    fs.writeFileSync(path.join(victim, 'keep.md'), 'keep\n');
    const linked = dirLink(victim, path.join(pb, '.land-sale.tmp-ff00'));
    const removed = v.removeTempLeftovers(caseDir);
    assert.deepStrictEqual(removed, linked ? ['.land-sale.tmp-ff00'] : []);
    assert.deepStrictEqual(fs.readdirSync(pb).sort(), ['.keep', 'land-sale.tmp-00']);
    assert.strictEqual(fs.readFileSync(path.join(victim, 'keep.md'), 'utf8'), 'keep\n');
    if (!linked) t.diagnostic('directory links cannot be created here; link case not exercised');
    // A playbooks/ that is itself a link is left alone.
    const caseB = tmp();
    fs.mkdirSync(path.join(victim, '.x.tmp-aa'));
    if (dirLink(victim, path.join(caseB, 'playbooks'))) {
      assert.deepStrictEqual(v.removeTempLeftovers(caseB), []);
      assert.strictEqual(fs.existsSync(path.join(victim, '.x.tmp-aa')), true);
    }
  });
});

describe('submodule manifests', () => {
  it('refuses a .gitmodules URL outside the allowlist before any fetch', async () => {
    const sub = tmp();
    await assert.rejects(
      v.fetchSubmoduleManifest(sub, 'https://example.org/x.git', { settings: ALLOWED, tmpRoot: tmp() }),
      /Playbook source https:\/\/example\.org\/x\.git is not allowed/
    );
    await assert.rejects(v.fetchSubmoduleManifest(sub, 'file:///srv/x', { settings: ALLOWED }), /Unsupported playbook source/);
    await assert.rejects(v.fetchSubmoduleManifest(sub, '-uhttps://example.com/playbooks/x', { settings: ALLOWED }), /Unsupported playbook source/);
    assert.deepStrictEqual(fs.readdirSync(sub), []);
  });

  it('runGit with its own hooks dir creates no .kl/ in the submodule', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const sub = tmp();
    await git.runGit(sub, ['init', '-q']);
    await git.runGit(sub, ['commit', '-q', '--allow-empty', '-m', 'x'], { env: GIT_ID });
    assert.strictEqual(fs.existsSync(path.join(sub, '.kl')), false);
  });

  it('reads the upstream playbook.yaml in a fresh temp repository, never in the case', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const upstream = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const sub = tmp();
    fs.writeFileSync(path.join(sub, 'playbook.yaml'), 'old\n');
    const root = tmp();
    const text = await v.readRemoteManifest(upstream, { tmpRoot: root, allowFile: true });
    assert.strictEqual(text, PLAYBOOK_YAML);
    assert.deepStrictEqual(fs.readdirSync(root), []);
    assert.deepStrictEqual(fs.readdirSync(sub), ['playbook.yaml']);
    // Over the per-file limit: refused, nothing left.
    await commitPackage(upstream, { 'playbook.yaml': `${PLAYBOOK_YAML}# ${'x'.repeat(300 * 1024)}\n` }, 'huge');
    await assert.rejects(v.readRemoteManifest(upstream, { tmpRoot: root, allowFile: true }), /playbook\.yaml is larger than 256 KiB/);
    assert.deepStrictEqual(fs.readdirSync(root), []);
    // Without allowFile a local path is not a transport it may use.
    await assert.rejects(v.readRemoteManifest(upstream, { tmpRoot: root }), (err) => err.code === 'FETCH_FAILED');
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });

  it('the GIT_DIR pin never leaks into a checked-out submodule', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const inner = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const parent = tmp();
    await git.runGit(parent, ['init', '-q']);
    await git.runGit(parent, ['clone', '-q', '--', inner, 'land-sale'], { allowFile: true });
    fs.writeFileSync(path.join(parent, '.gitmodules'), `[submodule "land-sale"]\n\tpath = land-sale\n\turl = https://example.com/playbooks/land-sale.git\n`);
    await git.runGit(parent, ['add', '.gitmodules', 'land-sale']);
    await git.runGit(parent, ['commit', '-q', '-m', 'sub'], { env: GIT_ID });
    const sub = path.join(parent, 'land-sale');
    // Run in the submodule: git resolves the submodule's own repository.
    assert.ok(git.samePath((await git.runGit(sub, ['rev-parse', '--absolute-git-dir'])).trim(), path.join(sub, '.git')));
    // Run pinned in the parent: the child git of `submodule foreach` sees the
    // submodule's repository, not the parent's pinned GIT_DIR.
    const out = await git.runGit(parent, ['submodule', 'foreach', '--quiet', 'git rev-parse --absolute-git-dir']);
    assert.ok(git.samePath(out.trim(), path.join(sub, '.git')), out);
    // And the parent's status reads the submodule through its own repository.
    fs.writeFileSync(path.join(sub, 'steps.md'), 'changed\n');
    assert.match(await git.runGit(parent, ['status', '--porcelain']), /^ M land-sale$/m);
  });
});

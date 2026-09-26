// tests/playbooks-loader.test.js
// PlaybookLoader (cases stage 6 spec §3.3): states, gitlink detection and
// the content hash.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const git = require('../src/cases/git');
const { PlaybookLoader, parseGitmodules, STATES, GITMODULES_MAX_BYTES } = require('../src/cases/playbooks/loader');
const { hashPackage } = require('../src/cases/playbooks/format');
const { writePackage, makeGitPackage, STEPS_MD, PLAYBOOK_YAML, GIT_ID } = require('./helpers/playbook-fixture');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbload-')); dirs.push(d); return d; };

// A case directory with a git repo and the given case.yaml playbooks list.
async function caseDir(playbooks = []) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'playbooks'));
  fs.writeFileSync(path.join(dir, 'playbooks', '.gitkeep'), '');
  fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({ id: 'c-1', title: 'Lakeside lot', type: 'general', playbooks }));
  await git.initRepo(dir);
  return dir;
}

const pin = (dir, name = 'land-sale') => ({
  name, version: '1.2.0', source: 'example:land-sale', mode: 'vendored', commit: null, contentHash: hashPackage(path.join(dir, 'playbooks', name))
});

// Counts runGitSync calls (the loader calls git through the module object).
function countGitSync(t) {
  const calls = [];
  const real = git.runGitSync;
  git.runGitSync = (...args) => { calls.push(args[1]); return real(...args); };
  t.after(() => { git.runGitSync = real; });
  return calls;
}

// A checked-out submodule at playbooks/<name>: its own git repo holding the
// package, recorded in the case as a gitlink.
async function checkedOutSubmodule(dir, name = 'remote-pb') {
  const sub = path.join(dir, 'playbooks', name);
  await makeGitPackage(sub, { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', `name: ${name}`) });
  const sha = (await git.runGit(sub, ['rev-parse', 'HEAD'])).trim();
  fs.writeFileSync(path.join(dir, '.gitmodules'), `[submodule "${name}"]\n\tpath = playbooks/${name}\n\turl = https://example.com/playbooks/${name}.git\n`);
  await git.runGit(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},playbooks/${name}`]);
  await git.runGit(dir, ['add', '.gitmodules', 'case.yaml']);
  await git.runGit(dir, ['commit', '-q', '-m', 'submodule'], { env: GIT_ID });
  return { sub, sha };
}

describe('PlaybookLoader states', () => {
  it('exports the five states', () => {
    assert.deepStrictEqual([...STATES], ['ok', 'invalid', 'unavailable', 'missing', 'unregistered']);
  });

  it('ok: a vendored copy named in case.yaml', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({ id: 'c-1', type: 'general', playbooks: [pin(dir)] }));
    const [e] = new PlaybookLoader(dir).list();
    assert.strictEqual(e.state, 'ok');
    assert.strictEqual(e.mode, 'vendored');
    assert.deepStrictEqual(e.onDisk, { version: '1.2.0', contentHash: hashPackage(e.dir) });
    assert.strictEqual(e.pinned.name, 'land-sale');
    assert.strictEqual(e.package.steps.steps.length, 2);
    assert.strictEqual(e.submodule, null);
  });

  it('unregistered, missing and invalid', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'gone', version: '1.0.0' }, { name: '../escape', version: '1.0.0' }]);
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    writePackage(path.join(dir, 'playbooks', 'broken'), { 'playbook.yaml': 'name: broken\nversion: 1.0\n' });
    const byName = Object.fromEntries(new PlaybookLoader(dir).list().map((e) => [e.name, e]));
    assert.strictEqual(byName['land-sale'].state, 'unregistered');
    assert.strictEqual(byName.gone.state, 'missing');
    assert.match(byName.gone.reason, /does not exist/);
    assert.strictEqual(byName['../escape'].state, 'invalid');
    assert.strictEqual(byName['../escape'].dir, null);
    assert.strictEqual(byName.broken.state, 'invalid');
    assert.match(byName.broken.reason, /version must be a quoted string/);
  });

  it('ignores dot-prefixed entries and plain files', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    writePackage(path.join(dir, 'playbooks', '.land-sale.tmp-1234'));
    fs.writeFileSync(path.join(dir, 'playbooks', 'README.md'), 'notes\n');
    assert.deepStrictEqual(new PlaybookLoader(dir).list(), []);
  });

  it('a pinned name that is a plain file is invalid', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'land-sale', version: '1.2.0' }]);
    fs.writeFileSync(path.join(dir, 'playbooks', 'land-sale'), 'not a folder\n');
    const e = new PlaybookLoader(dir).get('land-sale');
    assert.strictEqual(e.state, 'invalid');
    assert.match(e.reason, /is not a folder/);
  });

  it('warns about a step whose executor the registry lacks, keeping the step', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({ id: 'c-1', type: 'general', playbooks: [pin(dir)] }));
    const e = new PlaybookLoader(dir, { knownExecutors: ['web', 'owner'] }).get('land-sale');
    assert.strictEqual(e.state, 'ok');
    assert.deepStrictEqual(e.warnings, ['step "call-buyers" expects executor "phone-agent", which is not registered']);
  });

  it('a CRLF checkout does not report edited: the hash matches the LF copy', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const lf = writePackage(path.join(tmp(), 'land-sale'));
    const dir = await caseDir();
    writePackage(path.join(dir, 'playbooks', 'land-sale'), {
      'playbook.yaml': PLAYBOOK_YAML.replace(/\n/g, '\r\n'),
      'steps.md': STEPS_MD.replace(/\n/g, '\r\n')
    });
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({
      id: 'c-1', type: 'general', playbooks: [{ ...pin(dir), contentHash: hashPackage(lf) }]
    }));
    const e = new PlaybookLoader(dir).get('land-sale');
    assert.strictEqual(e.onDisk.contentHash, e.pinned.contentHash);
  });
});

describe('links under playbooks/ are never followed', () => {
  it('a symlink or junction entry is invalid, and git is not asked because of it', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'linked', version: '1.2.0' }]);
    const target = writePackage(path.join(tmp(), 'linked'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: linked') });
    const empty = tmp();
    fs.symlinkSync(target, path.join(dir, 'playbooks', 'linked'), 'junction');
    fs.symlinkSync(empty, path.join(dir, 'playbooks', 'empty-link'), 'junction');
    const calls = countGitSync(t);
    const byName = Object.fromEntries(new PlaybookLoader(dir).list().map((e) => [e.name, e]));
    assert.deepStrictEqual(Object.keys(byName).sort(), ['empty-link', 'linked']);
    for (const e of Object.values(byName)) {
      assert.strictEqual(e.state, 'invalid');
      assert.match(e.reason, /is a symbolic link/);
      assert.strictEqual(e.package, null);
      assert.strictEqual(e.onDisk, null);
    }
    assert.deepStrictEqual(calls, [], 'an empty folder behind a link must not make the case a submodule candidate');
  });

  it('a linked playbooks folder lists nothing from its target', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'land-sale', version: '1.2.0' }]);
    const target = tmp();
    writePackage(path.join(target, 'land-sale'));
    writePackage(path.join(target, 'other'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: other') });
    fs.rmSync(path.join(dir, 'playbooks'), { recursive: true });
    fs.symlinkSync(target, path.join(dir, 'playbooks'), 'junction');
    const list = new PlaybookLoader(dir).list();
    assert.deepStrictEqual(list.map((e) => e.name), ['land-sale']);
    assert.strictEqual(list[0].state, 'invalid');
    assert.match(list[0].reason, /playbooks is a symbolic link/);
    assert.strictEqual(list[0].package, null);
  });
});

describe('no git process for a plain case', () => {
  it('vendored folders with no .gitmodules, no empty folder and no .git spawn nothing', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'gone', version: '1.0.0' }]);
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({ id: 'c-1', type: 'general', playbooks: [pin(dir), { name: 'gone', version: '1.0.0' }] }));
    const calls = countGitSync(t);
    const loader = new PlaybookLoader(dir);
    assert.strictEqual(loader.get('land-sale').state, 'ok');
    assert.strictEqual(loader.get('gone').state, 'missing');
    assert.deepStrictEqual(calls, []);
  });

  it('an empty playbook folder does ask git (the spy sees it)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    fs.mkdirSync(path.join(dir, 'playbooks', 'empty'));
    const calls = countGitSync(t);
    const e = new PlaybookLoader(dir).get('empty');
    assert.strictEqual(e.state, 'invalid');
    assert.deepStrictEqual(calls, [['ls-tree', '-z', 'HEAD', 'playbooks/']]);
  });
});

describe('submodules are gitlinks only', () => {
  it('a .git file alone is not a submodule', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    fs.writeFileSync(path.join(dir, 'playbooks', 'land-sale', '.git'), 'gitdir: ../../.git/modules/land-sale\n');
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({ id: 'c-1', type: 'general', playbooks: [pin(dir)] }));
    await git.commitAll(dir, 'setup');
    const e = new PlaybookLoader(dir).get('land-sale');
    assert.strictEqual(e.mode, 'vendored');
    assert.strictEqual(e.state, 'ok');
  });

  it('a .gitmodules line alone is not a submodule', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    fs.writeFileSync(path.join(dir, '.gitmodules'), '[submodule "land-sale"]\n\tpath = playbooks/land-sale\n\turl = https://example.com/playbooks/land-sale.git\n');
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({ id: 'c-1', type: 'general', playbooks: [pin(dir)] }));
    await git.commitAll(dir, 'setup');
    assert.strictEqual(new PlaybookLoader(dir).get('land-sale').mode, 'vendored');
  });

  it('uninitialized submodule: a gitlink with an empty directory is unavailable', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'remote-pb', version: '1.0.0', mode: 'submodule' }]);
    const sha = '4b1e0c9d2f7a8b6e5d4c3b2a1f0e9d8c7b6a5f4e';
    fs.writeFileSync(path.join(dir, '.gitmodules'), '[submodule "remote-pb"]\n\tpath = playbooks/remote-pb\n\turl = https://example.com/playbooks/remote-pb.git\n');
    await git.runGit(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},playbooks/remote-pb`]);
    await git.runGit(dir, ['add', '.gitmodules', 'case.yaml']);
    await git.runGit(dir, ['commit', '-q', '-m', 'gitlink'], { env: GIT_ID });
    fs.mkdirSync(path.join(dir, 'playbooks', 'remote-pb'), { recursive: true });
    const e = new PlaybookLoader(dir).get('remote-pb');
    assert.strictEqual(e.mode, 'submodule');
    assert.strictEqual(e.state, 'unavailable');
    assert.deepStrictEqual(e.submodule, { url: 'https://example.com/playbooks/remote-pb.git', commit: sha });
    assert.match(e.reason, /submodule not checked out \(remote https:\/\/example\.com\/playbooks\/remote-pb\.git\)/);
    writePackage(path.join(dir, 'playbooks', 'remote-pb'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: remote-pb') });
    const checkedOut = new PlaybookLoader(dir).get('remote-pb');
    assert.strictEqual(checkedOut.state, 'ok');
    assert.strictEqual(checkedOut.mode, 'submodule');
  });

  it('a checked-out submodule (its own .git) is found with git pinned to the case repo', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'remote-pb', version: '1.2.0', mode: 'submodule' }]);
    const { sha } = await checkedOutSubmodule(dir);
    const e = new PlaybookLoader(dir).get('remote-pb');
    assert.strictEqual(e.mode, 'submodule');
    assert.strictEqual(e.state, 'ok');
    assert.deepStrictEqual(e.submodule, { url: 'https://example.com/playbooks/remote-pb.git', commit: sha });
    assert.strictEqual(e.onDisk.version, '1.2.0');
  });

  it('GIT_UNSAFE_CONFIG in a checked-out submodule: every playbook unavailable, list() does not throw', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'remote-pb', version: '1.2.0', mode: 'submodule' }]);
    const { sub } = await checkedOutSubmodule(dir);
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    // A benign value: only the key name matters to the check, and nothing
    // here runs a command that would read it.
    fs.appendFileSync(path.join(sub, '.git', 'config'), '[filter "kl-test"]\n\tclean = kl-never-run\n');
    let list;
    assert.doesNotThrow(() => { list = new PlaybookLoader(dir).list(); });
    assert.deepStrictEqual(list.map((e) => e.name), ['remote-pb', 'land-sale']);
    for (const e of list) {
      assert.strictEqual(e.state, 'unavailable');
      assert.match(e.reason, /^git refused to read this case, so its playbooks can't be checked: /);
      assert.match(e.reason, /filter\.kl-test\.clean/);
      assert.strictEqual(e.package, null);
    }
  });

  it('runGitSync lists the gitlink with mode 160000', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    const sha = '1111111111111111111111111111111111111111';
    await git.runGit(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},playbooks/x`]);
    await git.runGit(dir, ['commit', '-q', '-m', 'gitlink'], { env: GIT_ID });
    assert.match(git.runGitSync(dir, ['ls-tree', 'HEAD', 'playbooks/']), new RegExp(`^160000 commit ${sha}\tplaybooks/x$`, 'm'));
  });

  it('a case with no commit yet has no gitlinks (ls-tree HEAD fails, nothing crashes)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir();
    fs.mkdirSync(path.join(dir, 'playbooks', 'empty'));
    const e = new PlaybookLoader(dir).get('empty');
    assert.strictEqual(e.mode, 'vendored');
    assert.strictEqual(e.state, 'invalid');
  });
});

describe('parseGitmodules', () => {
  it('maps paths to urls and ignores other sections', () => {
    const text = '[core]\n\turl = nope\n[submodule "a"]\n\tpath = playbooks/a/\n\turl = https://example.com/a.git\n[submodule "b"]\n\turl = ssh://git@example.com/b.git\n\tpath = playbooks\\b\n';
    assert.deepStrictEqual(parseGitmodules(text), { 'playbooks/a': 'https://example.com/a.git', 'playbooks/b': 'ssh://git@example.com/b.git' });
  });

  it('reads section and key names case-insensitively, as git does', () => {
    const text = '[Submodule "a"]\n\tPath = playbooks/a\n\tURL = https://example.com/a.git\n';
    assert.deepStrictEqual(parseGitmodules(text), { 'playbooks/a': 'https://example.com/a.git' });
  });

  it('keeps the path but drops any url that is not plain https or ssh', () => {
    const bad = [
      'ext::sh -c touch% /tmp/pwned',
      'EXT::sh -c id',
      '--upload-pack=touch /tmp/pwned',
      '-u./payload',
      'file:///srv/playbooks/a.git',
      'http://example.com/a.git',
      'git://example.com/a.git',
      'fd::3',
      '../sibling.git',
      '/srv/playbooks/a.git',
      'C:\\playbooks\\a.git',
      'git@example.com:playbooks/a.git',
      'https://user:secret@example.com/a.git',
      'https://example.com/a b.git',
      'https://example.com/a.git\u0000x',
      'https://'
    ];
    for (const url of bad) {
      const out = parseGitmodules(`[submodule "a"]\n\tpath = playbooks/a\n\turl = ${url}\n`);
      assert.deepStrictEqual(out, { 'playbooks/a': null }, url);
    }
  });

  it('refuses a .gitmodules over the size limit without parsing it', () => {
    const text = `[submodule "a"]\n\tpath = playbooks/a\n\turl = https://example.com/a.git\n${'#'.repeat(GITMODULES_MAX_BYTES)}`;
    assert.throws(() => parseGitmodules(text), (err) => err.code === 'GITMODULES_TOO_LARGE');
  });

  it('an oversized .gitmodules in a case leaves the remote unknown', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const dir = await caseDir([{ name: 'remote-pb', version: '1.0.0', mode: 'submodule' }]);
    const sha = '4b1e0c9d2f7a8b6e5d4c3b2a1f0e9d8c7b6a5f4e';
    fs.writeFileSync(path.join(dir, '.gitmodules'), `[submodule "remote-pb"]\n\tpath = playbooks/remote-pb\n\turl = https://example.com/playbooks/remote-pb.git\n${'#'.repeat(GITMODULES_MAX_BYTES)}\n`);
    await git.runGit(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},playbooks/remote-pb`]);
    await git.runGit(dir, ['commit', '-q', '-m', 'gitlink'], { env: GIT_ID });
    const e = new PlaybookLoader(dir).get('remote-pb');
    assert.strictEqual(e.state, 'unavailable');
    assert.deepStrictEqual(e.submodule, { url: null, commit: sha });
    assert.match(e.reason, /remote unknown/);
  });
});

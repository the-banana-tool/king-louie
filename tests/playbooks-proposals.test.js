// tests/playbooks-proposals.test.js
// Proposals back to playbook repositories (cases stage 6 spec §3.10, §4.7):
// patches built by code, stored with their hash, applied only outside cases.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const p = require('../src/cases/playbooks/proposals');
const { readSnapshot } = require('../src/cases/playbooks/vendor');
const { STEPS_MD, PLAYBOOK_YAML, BRIEF_RULES_MD, makeGitPackage, commitPackage, writePackage, GIT_ID } = require('./helpers/playbook-fixture');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbprop-')); dirs.push(d); return d; };
const NOW = new Date('2026-11-30T14:12:00.000Z');
const BETTER_STEPS = STEPS_MD.replace('Call the buyers on the list;', 'Call the buyers on the list in order of offer size;');

// An upstream playbook repo, a case dir with the vendored copy's snapshot,
// and a stored change proposal to steps.md.
async function world(files = [{ path: 'steps.md', content: BETTER_STEPS }]) {
  const upstream = await makeGitPackage(path.join(tmp(), 'land-sale'));
  const base = readSnapshot(upstream);
  const casesRoot = tmp();
  const caseDir = path.join(casesRoot, 'lakeside-lot');
  fs.mkdirSync(caseDir);
  const built = await p.buildProposal({ name: 'land-sale', isNew: false, base, files, tmpRoot: tmp() });
  const record = p.storeProposal(caseDir, {
    name: 'land-sale', isNew: false, patch: built.patch, baseVersion: '1.2.0', baseCommit: null, baseContentHash: 'sha256:base',
    changedFiles: built.changedFiles, rationale: 'Offers arrive faster from the largest bidders.', factIds: ['f-0001'], turnId: 'turn-1', now: NOW
  });
  return { upstream, base, casesRoot, caseDir, built, record };
}

// A patch as git writes it: `overrides` (name → text) written over a copy
// of `pkgDir` (a git package), staged and diffed. Lets tests build patches
// buildProposal would refuse, as a crafted case would carry.
async function diffAgainst(pkgDir, overrides) {
  const work = path.join(tmp(), 'work');
  fs.cpSync(pkgDir, work, { recursive: true });
  for (const [name, text] of Object.entries(overrides)) fs.writeFileSync(path.join(work, name), text);
  await git.runGit(work, ['add', '-A']);
  return git.runGit(work, ['diff', '--cached', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames']);
}

// A patch creating `files` in an empty repo.
async function newFilesPatch(files) {
  const work = tmp();
  await git.runGit(work, ['init', '-q']);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(work, name), text);
  await git.runGit(work, ['add', '-A']);
  return git.runGit(work, ['diff', '--cached', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames']);
}

// A record as an imported case could carry it: `patch` written in the
// proposals folder with a matching hash; `extra` overrides record fields.
let craftSeq = 0;
function craft(caseDir, record, patch, extra = {}) {
  craftSeq += 1;
  const rel = `artifacts/playbook-proposals/land-sale-2026-11-30-1500-${craftSeq + 1}.patch`;
  fs.mkdirSync(path.join(caseDir, 'artifacts', 'playbook-proposals'), { recursive: true });
  fs.writeFileSync(path.join(caseDir, rel), patch);
  return { ...record, patch: rel, patchSha256: require('crypto').createHash('sha256').update(patch).digest('hex'), ...extra };
}

// Upstream moved to 1.3.0 with a non-conflicting change, so an apply takes
// the 3-way path through the throwaway clone.
async function movedWorld() {
  const w = await world();
  await commitPackage(w.upstream, { 'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"1.3.0"'), 'briefRules.md': `${BRIEF_RULES_MD}- Keep calls short.\n` }, '1.3.0');
  return w;
}

describe('buildProposal', () => {
  it('refuses bad paths and too many files', async () => {
    const base = readSnapshot(writePackage(path.join(tmp(), 'land-sale')));
    const bad = async (files, re) => assert.rejects(p.buildProposal({ name: 'land-sale', isNew: false, base, files, tmpRoot: tmp() }), re);
    for (const name of ['../steps.md', 'sub/steps.md', '.hidden.md', 'run.js', 'steps.md.', 'con.md', 'C:steps.md', 'sub\\steps.md']) {
      await bad([{ path: name, content: 'x' }], /is not a playbook file name/);
    }
    await bad(Array.from({ length: 9 }, (_, i) => ({ path: `n${i}.md`, content: 'x' })), /files must list 1 to 8/);
    await bad([{ path: 'steps.md', content: 'x' }, { path: 'steps.md', content: 'y' }], /listed twice/);
    await bad([{ path: 'steps.md', content: 'x' }, { path: 'Steps.md', content: 'y' }], /listed twice/);
    await bad([{ path: 'notes.txt', content: 'x' }], /notes\.txt is not in the playbook; a new file must be \.md\./);
    await bad([{ path: 'STEPS.md', content: 'x' }], /STEPS\.md differs only in case from steps\.md/);
  });

  it('refuses a version change, an invalid result and an empty diff', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const base = readSnapshot(writePackage(path.join(tmp(), 'land-sale')));
    const build = (files) => p.buildProposal({ name: 'land-sale', isNew: false, base, files, tmpRoot: tmp() });
    await assert.rejects(build([{ path: 'playbook.yaml', content: PLAYBOOK_YAML.replace('"1.2.0"', '"1.3.0"') }]), { message: "The version is the owner's to bump; leave playbook.yaml version as it is." });
    await assert.rejects(build([{ path: 'steps.md', content: '## 1. A\n- executor: web\n- establishes: a.b\n- owner: me\n' }]), /does not validate:\nsteps\.md:4: steps\.md step "a": unknown key "owner"/);
    await assert.rejects(build([{ path: 'steps.md', content: STEPS_MD }]), { message: 'The proposal changes nothing.' });
  });

  it('refuses a base snapshot path that leaves the package', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const root = tmp();
    const base = readSnapshot(writePackage(path.join(root, 'land-sale')));
    for (const rel of ['../escape.md', '/abs.md', 'a\\b.md', 'sub/../x.md']) {
      const crafted = { files: [...base.files, { rel, data: Buffer.from('x') }] };
      await assert.rejects(p.buildProposal({ name: 'land-sale', isNew: false, base: crafted, files: [{ path: 'steps.md', content: BETTER_STEPS }], tmpRoot: root }), /is not a valid package path/);
    }
    assert.strictEqual(fs.existsSync(path.join(root, 'escape.md')), false);
  });

  it('produces a full-index patch naming the changed files, and removes its temp repo', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const upstream = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const tmpRoot = tmp();
    const built = await p.buildProposal({ name: 'land-sale', isNew: false, base: readSnapshot(upstream), files: [{ path: 'steps.md', content: BETTER_STEPS }, { path: 'notes.md', content: 'Offer sizes vary widely.\n' }], tmpRoot });
    assert.deepStrictEqual(built.changedFiles, ['notes.md', 'steps.md']);
    assert.match(built.patch, /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m);
    assert.match(built.patch, /^\+\+\+ b\/steps\.md$/m);
    assert.deepStrictEqual(p.checkPatch(built.patch), ['notes.md', 'steps.md']);
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
  });
});

describe('checkPatch (patch confinement)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const Z = '0'.repeat(40);
  const hunk = '@@ -1 +1 @@\n-x\n+y\n';
  const modify = (name) => `diff --git a/${name} b/${name}\nindex ${A}..${B} 100644\n--- a/${name}\n+++ b/${name}\n${hunk}`;
  const refuses = (text, re) => assert.throws(() => p.checkPatch(text), (err) => err.code === 'UNSAFE_PATCH' && re.test(err.message));

  it('accepts a modify, a new file and an empty new file', () => {
    const created = `diff --git a/notes.md b/notes.md\nnew file mode 100644\nindex ${Z}..${B}\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n`;
    const empty = `diff --git a/empty.md b/empty.md\nnew file mode 100644\nindex ${Z}..${B}\n`;
    assert.deepStrictEqual(p.checkPatch(modify('steps.md') + created + empty), ['steps.md', 'notes.md', 'empty.md']);
    assert.throws(() => p.checkPatch(modify('steps.md'), { newOnly: true }), /changes an existing file/);
  });

  it('refuses absolute, parent, nested, backslash and drive-letter paths', () => {
    refuses(modify('/etc/steps.md'), /absolute/);
    refuses(modify('C:/steps.md'), /absolute/);
    refuses(modify('c:steps.md'), /absolute/);
    refuses(modify('../steps.md'), /"\.\."/);
    refuses(modify('sub/../steps.md'), /"\.\."/);
    refuses(modify('sub\\steps.md'), /backslash/);
    refuses(modify('sub/steps.md'), /not a bare playbook file name/);
    refuses(modify('.git.md'), /not a bare playbook file name/);
    refuses(modify('run.js'), /not a bare playbook file name/);
    refuses(`diff --git "a/st\\teps.md" "b/st\\teps.md"\nindex ${A}..${B} 100644\n--- "a/st\\teps.md"\n+++ "b/st\\teps.md"\n${hunk}`, /not part of a file diff/);
    // ---/+++ naming another file than the diff --git line
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B} 100644\n--- a/../../x.md\n+++ b/../../x.md\n${hunk}`, /expected "--- a\/steps\.md"/);
  });

  it('refuses symlink, gitlink, executable and other modes', () => {
    refuses(`diff --git a/link.md b/link.md\nnew file mode 120000\nindex ${Z}..${B}\n--- /dev/null\n+++ b/link.md\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n`, /symlink/);
    refuses(`diff --git a/sub.md b/sub.md\nnew file mode 160000\nindex ${Z}..${B}\n`, /gitlink/);
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B} 160000\n--- a/steps.md\n+++ b/steps.md\n@@ -1 +1 @@\n-Subproject commit ${A}\n+Subproject commit ${B}\n`, /gitlink/);
    refuses(`diff --git a/steps.md b/steps.md\nold mode 100644\nnew mode 100755\n`, /executable/);
    refuses(`diff --git a/steps.md b/steps.md\nold mode 100644\nnew mode 100644\nindex ${A}..${B}\n--- a/steps.md\n+++ b/steps.md\n${hunk}`, /changes the mode/);
    refuses(`diff --git a/steps.md b/steps.md\nold mode 100644\nnew mode 120000\nindex ${A}..${B}\n--- a/steps.md\n+++ b/steps.md\n${hunk}`, /symlink/);
    refuses(`diff --git a/run.md b/run.md\nnew file mode 100755\nindex ${Z}..${B}\n--- /dev/null\n+++ b/run.md\n@@ -0,0 +1 @@\n+x\n`, /executable/);
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B} 100664\n--- a/steps.md\n+++ b/steps.md\n${hunk}`, /mode 100664/);
  });

  it('refuses renames and copies (inside or out), deletes and binary patches', () => {
    refuses(`diff --git a/steps.md b/../x.md\nsimilarity index 90%\nrename from steps.md\nrename to ../x.md\n`, /"\.\."/);
    refuses(`diff --git a/steps.md b/other.md\nsimilarity index 90%\nrename from steps.md\nrename to other.md\n`, /rename/);
    refuses(`diff --git a/steps.md b/steps.md\nsimilarity index 100%\ncopy from ../../secret.md\ncopy to steps.md\n`, /"\.\."/);
    refuses(`diff --git a/steps.md b/steps.md\ncopy from steps.md\ncopy to notes.md\n`, /copies/);
    refuses(`diff --git a/steps.md b/steps.md\ndeleted file mode 100644\nindex ${A}..${Z}\n--- a/steps.md\n+++ /dev/null\n${hunk}`, /deletes/);
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B}\nGIT binary patch\nliteral 0\nHcmV?d00001\n\n`, /binary/);
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B} 100644\nBinary files a/steps.md and b/steps.md differ\n`, /binary/);
  });

  it('refuses text outside counted hunks, duplicates, abbreviated ids and CRs in headers', () => {
    // A traditional diff smuggled after a hunk: git apply would read it.
    refuses(`${modify('steps.md')}--- a/../../evil.md\n+++ b/../../evil.md\n@@ -0,0 +1 @@\n+pwned\n`, /not part of a file diff/);
    // An extra line past the hunk's counts.
    refuses(`${modify('steps.md')}+z\n`, /not part of a file diff/);
    // Lines inside a hunk that are not context, removal or addition.
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B} 100644\n--- a/steps.md\n+++ b/steps.md\n@@ -1 +1 @@\n-x\nfoo\n+y\n`, /does not match its hunk's counts/);
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B} 100644\n--- a/steps.md\n+++ b/steps.md\n@@ -1 +1 @@\n-x\n\n+y\n`, /does not match its hunk's counts/);
    refuses(`Subject: hi\n\n${modify('steps.md')}`, /line 1 is not part of a file diff/);
    refuses(`diff --git a/steps.md b/steps.md\nindex ${A}..${B} 100644\n--- a/steps.md\n+++ b/steps.md\n@@ -1,3 +1,3 @@\n-x\n+y\n`, /truncated/);
    refuses(modify('steps.md') + modify('steps.md'), /twice/);
    refuses(modify('steps.md') + modify('STEPS.md'), /twice/);
    refuses(`diff --git a/steps.md b/steps.md\nindex abc1234..def5678 100644\n--- a/steps.md\n+++ b/steps.md\n${hunk}`, /unexpected header/);
    refuses(modify('steps.md').replace('100644\n', '100644\r\n'), /unexpected header/);
    refuses(modify('steps.md').slice(0, -1), /newline/);
    refuses('', /changes no file/);
    refuses(Array.from({ length: 9 }, (_, i) => modify(`n${i}.md`)).join(''), /more than 8/);
  });
});

describe('store and replay', () => {
  it('stores the patch with its hash, suffixes a same-minute name, and replays status lines', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { caseDir, built, record } = await world();
    assert.strictEqual(record.id, 'pp-001');
    assert.strictEqual(record.patch, 'artifacts/playbook-proposals/land-sale-2026-11-30-1412.patch');
    assert.match(record.patchSha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(fs.readFileSync(path.join(caseDir, record.patch), 'utf8'), built.patch);
    const second = p.storeProposal(caseDir, { name: 'land-sale', isNew: false, patch: built.patch, changedFiles: built.changedFiles, rationale: 'Again', now: NOW });
    assert.strictEqual(second.id, 'pp-002');
    assert.strictEqual(second.patch, 'artifacts/playbook-proposals/land-sale-2026-11-30-1412-2.patch');
    p.setProposalStatus(caseDir, 'pp-002', 'rejected', {}, NOW);
    assert.deepStrictEqual(p.listProposals(caseDir).map((r) => [r.id, r.status]), [['pp-001', 'proposed'], ['pp-002', 'rejected']]);
    assert.throws(() => p.setProposalStatus(caseDir, 'pp-009', 'rejected', {}, NOW), /pp-009 was not found/);
    assert.throws(() => p.setProposalStatus(caseDir, 'pp-001', 'proposed', {}, NOW), /status must be/);
    assert.throws(() => p.setProposalStatus(caseDir, 'pp-001', 'applied', { owner: 'x' }, NOW), /unknown/);
  });

  it('refuses to store an unconfined patch or bad fields', (t) => {
    const caseDir = tmp();
    const evil = `diff --git a/../x.md b/../x.md\nnew file mode 100644\nindex ${'0'.repeat(40)}..${'b'.repeat(40)}\n--- /dev/null\n+++ b/../x.md\n@@ -0,0 +1 @@\n+x\n`;
    assert.throws(() => p.storeProposal(caseDir, { name: 'land-sale', isNew: false, patch: evil, changedFiles: ['x.md'], rationale: '', now: NOW }), { code: 'UNSAFE_PATCH' });
    assert.throws(() => p.storeProposal(caseDir, { name: '../land-sale', isNew: false, patch: evil, changedFiles: ['x.md'], rationale: '', now: NOW }), /not a valid playbook name/);
    assert.strictEqual(fs.existsSync(path.join(caseDir, 'artifacts')), false);
    t.diagnostic('nothing written for a refused proposal');
  });

  it('refuses to write through a linked artifacts folder', (t) => {
    const caseDir = tmp();
    const outside = tmp();
    try {
      fs.symlinkSync(outside, path.join(caseDir, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return t.skip('no directory link can be created here');
    }
    const ok = `diff --git a/notes.md b/notes.md\nnew file mode 100644\nindex ${'0'.repeat(40)}..${'b'.repeat(40)}\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+x\n`;
    assert.throws(() => p.storeProposal(caseDir, { name: 'land-sale', isNew: false, patch: ok, changedFiles: ['notes.md'], rationale: '', now: NOW }), /is a link/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  it('drops malformed, unknown-key and out-of-folder records when replaying', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { caseDir, record } = await world();
    const file = path.join(caseDir, p.PROPOSALS_FILE);
    const lines = [
      { ...record, id: 'pp-1' },
      { ...record, id: 'x-002' },
      { ...record, id: 'pp-003', patch: '../../evil.patch' },
      { ...record, id: 'pp-004', patch: 'artifacts/playbook-proposals/../../evil.patch' },
      { ...record, id: 'pp-005', patchSha256: 'nothex' },
      { ...record, id: 'pp-006', owner: true },
      { ...record, id: 'pp-007', files: ['../x.md'] },
      { id: 'pp-001', status: 'applied', at: NOW.toISOString(), appliedTo: 5 },
      { id: 'pp-001', status: 'proposed', at: NOW.toISOString() }
    ];
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.appendFileSync(file, `{"id":"pp-008","__proto__":{"polluted":true},${JSON.stringify(record).slice(1).replace('"id":"pp-001",', '')}\n`);
    fs.appendFileSync(file, 'not json\n');
    const list = p.listProposals(caseDir);
    assert.deepStrictEqual(list.map((r) => [r.id, r.status]), [['pp-001', 'proposed']]);
    assert.strictEqual(Object.getPrototypeOf(list[0]), null);
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(p.getProposal(caseDir, 'pp-003'), null);
    assert.strictEqual(p.getProposal(caseDir, '__proto__'), null);
  });

  it('refuses an oversized proposals file', () => {
    const caseDir = tmp();
    fs.mkdirSync(path.join(caseDir, '.kl'));
    fs.writeFileSync(path.join(caseDir, p.PROPOSALS_FILE), 'x'.repeat(p.MAX_PROPOSALS_BYTES + 1));
    assert.throws(() => p.listProposals(caseDir), /too large/);
  });
});

describe('applyProposalTo', () => {
  it('applies into the playbook repo and leaves the change uncommitted', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record } = await world();
    const tmpRoot = tmp();
    const r = await p.applyProposalTo({ caseDir, casesRoot, record, repoPath: upstream, tmpRoot });
    assert.deepStrictEqual(r, { appliedOver: '1.2.0', rel: '' });
    assert.strictEqual(fs.readFileSync(path.join(upstream, 'steps.md'), 'utf8'), BETTER_STEPS);
    assert.match(await git.runGit(upstream, ['status', '--porcelain']), /^ M steps\.md$/m);
    assert.strictEqual((await git.runGit(upstream, ['rev-list', '--count', 'HEAD'])).trim(), '1');
    assert.strictEqual(fs.existsSync(path.join(upstream, '.kl')), false);
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
  });

  it('--directory applies into a package subfolder of a larger repo', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { caseDir, casesRoot, record } = await world();
    const mono = tmp();
    writePackage(path.join(mono, 'playbooks', 'land-sale'));
    fs.writeFileSync(path.join(mono, 'README.md'), 'Playbooks.\n');
    await git.runGit(mono, ['init', '-q']);
    await git.runGit(mono, ['add', '-A']);
    await git.runGit(mono, ['commit', '-q', '-m', 'all'], { env: GIT_ID });
    const r = await p.applyProposalTo({ caseDir, casesRoot, record, repoPath: path.join(mono, 'playbooks', 'land-sale'), tmpRoot: tmp() });
    assert.strictEqual(r.rel, 'playbooks/land-sale');
    assert.strictEqual(fs.readFileSync(path.join(mono, 'playbooks', 'land-sale', 'steps.md'), 'utf8'), BETTER_STEPS);
    assert.strictEqual(fs.readFileSync(path.join(mono, 'README.md'), 'utf8'), 'Playbooks.\n');
  });

  it('apply inside a case is refused', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { caseDir, casesRoot, record } = await world();
    const inCase = await makeGitPackage(path.join(caseDir, 'playbooks', 'land-sale'));
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: inCase }), { message: `${inCase} is inside a case; apply to the playbook's own repository.` });
    const other = await makeGitPackage(path.join(casesRoot, 'other-case', 'land-sale'));
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: other }), /is inside a case/);
  });

  it('refuses a non-repo, a relative path, a UNC path, another playbook and a dirty repo', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record } = await world();
    const plain = writePackage(path.join(tmp(), 'land-sale'));
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: plain }), { message: `${plain} is not inside a git repository.` });
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: 'land-sale' }), { message: 'land-sale is not inside a git repository.' });
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: '\\\\host.example.com\\share\\land-sale' }), { code: 'NOT_A_REPO' });
    const farm = await makeGitPackage(path.join(tmp(), 'farm'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: farm') });
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: farm }), { message: `${farm} holds playbook "farm", not "land-sale".` });
    fs.appendFileSync(path.join(upstream, 'sources.md'), '- local note\n');
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: upstream }), { message: `${upstream} has uncommitted changes; commit or stash them first.` });
  });

  it('refuses a repository whose own config runs programs', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record } = await world();
    await git.runGit(upstream, ['config', 'filter.kl-probe.clean', 'cat']);
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: upstream, tmpRoot: tmp() }), { code: 'GIT_UNSAFE_CONFIG' });
    assert.strictEqual(fs.readFileSync(path.join(upstream, 'steps.md'), 'utf8'), STEPS_MD);
  });

  it('ruling T9-casesroot: an apply without an absolute cases root is refused', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, record } = await world();
    for (const casesRoot of [undefined, null, 'cases', 42]) {
      await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: upstream, tmpRoot: tmp() }), { code: 'NO_CASES_ROOT' });
    }
    assert.strictEqual(fs.readFileSync(path.join(upstream, 'steps.md'), 'utf8'), STEPS_MD);
  });

  it('ruling T9-files: the patch must touch exactly the listed files, at store and at apply', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record } = await world();
    const patch = await diffAgainst(upstream, { 'steps.md': BETTER_STEPS, 'notes.md': 'Extra.\n' });
    assert.throws(() => p.storeProposal(caseDir, { name: 'land-sale', isNew: false, patch, changedFiles: ['steps.md'], rationale: '', now: NOW }), { code: 'UNSAFE_PATCH', message: /other files than the proposal lists/ });
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record: craft(caseDir, record, patch), repoPath: upstream, tmpRoot: tmp() }), { code: 'TAMPERED', message: /other files than its record lists/ });
    assert.strictEqual((await git.runGit(upstream, ['status', '--porcelain'])).trim(), '');
  });

  it('ruling T9-files: a change proposal creates only .md files, at store and at apply', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record } = await world();
    const patch = await diffAgainst(upstream, { 'steps.md': BETTER_STEPS, 'CMakeLists.txt': 'add_custom_target(x ALL)\n' });
    const files = ['CMakeLists.txt', 'steps.md'];
    assert.throws(() => p.storeProposal(caseDir, { name: 'land-sale', isNew: false, patch, changedFiles: files, rationale: '', now: NOW }), { code: 'UNSAFE_PATCH', message: /must be \.md/ });
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record: craft(caseDir, record, patch, { files }), repoPath: upstream, tmpRoot: tmp() }), { code: 'UNSAFE_PATCH', message: /must be \.md/ });
    assert.strictEqual(fs.existsSync(path.join(upstream, 'CMakeLists.txt')), false);
  });

  it('ruling T9-version: a name or version line in playbook.yaml is refused, at store and at apply', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record } = await world();
    const files = ['playbook.yaml'];
    const variants = [
      PLAYBOOK_YAML.replace('"1.2.0"', '"9.9.9"'),
      PLAYBOOK_YAML.replace('name: land-sale', 'name: farm'),
      `${PLAYBOOK_YAML}"version": "9.9.9"\n`,
      `${PLAYBOOK_YAML}? version\n: "9.9.9"\n`
    ];
    for (const yamlText of variants) {
      const patch = await diffAgainst(upstream, { 'playbook.yaml': yamlText });
      assert.throws(() => p.storeProposal(caseDir, { name: 'land-sale', isNew: false, patch, changedFiles: files, rationale: '', now: NOW }), { code: 'UNSAFE_PATCH', message: /name or version line/ });
      await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record: craft(caseDir, record, patch, { files }), repoPath: upstream, tmpRoot: tmp() }), { code: 'UNSAFE_PATCH', message: /name or version line/ });
    }
    // Ruling T9-lines: a nested line with "name:" in it stays editable.
    const nestedYaml = PLAYBOOK_YAML.replace('    text: What is the lowest price you would accept?', '    text: "Whose name: is on the deed, and what is the lowest price?"');
    const nested = await diffAgainst(upstream, { 'playbook.yaml': nestedYaml });
    assert.match(nested, /^\+ {4}text: "Whose name: is/m);
    const stored = p.storeProposal(caseDir, { name: 'land-sale', isNew: false, patch: nested, changedFiles: files, rationale: '', baseVersion: '1.2.0', now: NOW });
    assert.deepStrictEqual(p.checkPatch(`diff --git a/playbook.yaml b/playbook.yaml\nindex ${'a'.repeat(40)}..${'b'.repeat(40)} 100644\n--- a/playbook.yaml\n+++ b/playbook.yaml\n@@ -1 +1 @@\n-  name: a\n+  name: b\n`), ['playbook.yaml']);
    // A key spelled with a YAML escape passes the line rule; the applied
    // result in the throwaway clone is what refuses it.
    const escaped = await diffAgainst(upstream, { 'playbook.yaml': `${PLAYBOOK_YAML}"vers\\x69on": "9.9.9"\n` });
    assert.deepStrictEqual(p.checkPatch(escaped), ['playbook.yaml']);
    const tmpRoot = tmp();
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record: craft(caseDir, record, escaped, { files }), repoPath: upstream, tmpRoot }), { code: 'UNSAFE_PATCH', message: /would change the playbook's name or version/ });
    assert.strictEqual(fs.readFileSync(path.join(upstream, 'playbook.yaml'), 'utf8'), PLAYBOOK_YAML);
    assert.strictEqual((await git.runGit(upstream, ['status', '--porcelain'])).trim(), '');
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
    // The nested edit stored above applies: the clone check sees the
    // top-level name and version unchanged.
    await p.applyProposalTo({ caseDir, casesRoot, record: stored, repoPath: upstream, tmpRoot: tmp() });
    assert.strictEqual(fs.readFileSync(path.join(upstream, 'playbook.yaml'), 'utf8'), nestedYaml);
  });

  it('refuses a tampered patch', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record } = await world();
    fs.appendFileSync(path.join(caseDir, record.patch), '\n');
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: upstream }), { message: 'The proposal file was changed after it was proposed; review it by hand.' });
  });

  it('never follows a record path outside the proposals folder, and refuses a crafted unconfined patch', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { upstream, caseDir, casesRoot, record, built } = await world();
    // Same bytes, same hash, but outside artifacts/playbook-proposals/.
    fs.writeFileSync(path.join(caseDir, 'outside.patch'), built.patch);
    for (const patch of ['outside.patch', 'artifacts/playbook-proposals/../../outside.patch', '../lakeside-lot/outside.patch']) {
      await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record: { ...record, patch }, repoPath: upstream }), { code: 'TAMPERED' });
    }
    // An imported case: a record and patch written together, hash matching,
    // but the patch reaches outside the package.
    const crypto = require('crypto');
    const evil = `diff --git a/../../evil.md b/../../evil.md\nnew file mode 100644\nindex ${'0'.repeat(40)}..${'b'.repeat(40)}\n--- /dev/null\n+++ b/../../evil.md\n@@ -0,0 +1 @@\n+pwned\n`;
    const rel = 'artifacts/playbook-proposals/land-sale-2026-11-30-1500.patch';
    fs.writeFileSync(path.join(caseDir, rel), evil);
    const crafted = { ...record, patch: rel, patchSha256: crypto.createHash('sha256').update(evil).digest('hex') };
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record: crafted, repoPath: upstream, tmpRoot: tmp() }), { code: 'UNSAFE_PATCH' });
    assert.strictEqual(fs.existsSync(path.join(upstream, '..', '..', 'evil.md')), false);
    assert.strictEqual((await git.runGit(upstream, ['status', '--porcelain'])).trim(), '');
  });

  it('upstream moved: a non-conflicting change applies 3-way; a conflict is refused and leaves the repo clean', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const a = await movedWorld();
    const tmpA = tmp();
    const r = await p.applyProposalTo({ caseDir: a.caseDir, casesRoot: a.casesRoot, record: a.record, repoPath: a.upstream, tmpRoot: tmpA });
    assert.strictEqual(r.appliedOver, '1.3.0');
    assert.strictEqual(fs.readFileSync(path.join(a.upstream, 'steps.md'), 'utf8'), BETTER_STEPS);
    assert.deepStrictEqual(fs.readdirSync(tmpA), []);

    const b = await world();
    await commitPackage(b.upstream, {
      'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"1.3.0"'),
      'steps.md': STEPS_MD.replace('Call the buyers on the list;', 'Phone every buyer on the list;')
    }, '1.3.0');
    const tmpB = tmp();
    await assert.rejects(
      p.applyProposalTo({ caseDir: b.caseDir, casesRoot: b.casesRoot, record: b.record, repoPath: b.upstream, tmpRoot: tmpB }),
      { message: 'Proposal was written against land-sale 1.2.0; the repository is at 1.3.0 and the patch does not apply. Open artifacts/playbook-proposals/land-sale-2026-11-30-1412.patch and merge by hand.' }
    );
    assert.strictEqual((await git.runGit(b.upstream, ['status', '--porcelain'])).trim(), '');
    assert.deepStrictEqual(fs.readdirSync(tmpB), []);
  });

  it('a timed-out clone is killed and removed, and the repo is untouched', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await movedWorld();
    const tmpRoot = tmp();
    await assert.rejects(p.applyProposalTo({ caseDir: w.caseDir, casesRoot: w.casesRoot, record: w.record, repoPath: w.upstream, tmpRoot, timeoutMs: 1 }), { code: 'TIMEOUT' });
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
    assert.strictEqual((await git.runGit(w.upstream, ['status', '--porcelain'])).trim(), '');
  });

  it('a change to the repo while the clone was checked is caught before the repo is touched', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await movedWorld();
    const tmpRoot = tmp();
    const onProbeApplied = () => fs.appendFileSync(path.join(w.upstream, 'sources.md'), '- local note\n');
    await assert.rejects(p.applyProposalTo({ caseDir: w.caseDir, casesRoot: w.casesRoot, record: w.record, repoPath: w.upstream, tmpRoot, onProbeApplied }), { code: 'DIRTY' });
    assert.strictEqual(fs.readFileSync(path.join(w.upstream, 'steps.md'), 'utf8'), STEPS_MD);
    assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);

    const v = await movedWorld();
    const commitMeanwhile = () => commitPackage(v.upstream, { 'sources.md': '- moved\n' }, 'meanwhile');
    await assert.rejects(p.applyProposalTo({ caseDir: v.caseDir, casesRoot: v.casesRoot, record: v.record, repoPath: v.upstream, tmpRoot: tmp(), onProbeApplied: commitMeanwhile }), { code: 'DOES_NOT_APPLY', message: /changed while the proposal was checked/ });
    assert.strictEqual(fs.readFileSync(path.join(v.upstream, 'steps.md'), 'utf8'), STEPS_MD);
  });
});

describe('new-playbook proposals (R29)', () => {
  const NEW_YAML = PLAYBOOK_YAML.replace('name: land-sale', 'name: dock-repair').replace('"1.2.0"', '"0.1.0"');

  it('patches against an empty base, stores the package folder, and applies into an empty repo', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const files = [{ path: 'playbook.yaml', content: NEW_YAML }, { path: 'steps.md', content: STEPS_MD }];
    const built = await p.buildProposal({ name: 'dock-repair', isNew: true, files, tmpRoot: tmp() });
    assert.deepStrictEqual(built.changedFiles, ['playbook.yaml', 'steps.md']);
    assert.match(built.patch, /^new file mode 100644$/m);
    const casesRoot = tmp();
    const caseDir = path.join(casesRoot, 'dock-case');
    fs.mkdirSync(caseDir);
    const record = p.storeProposal(caseDir, { name: 'dock-repair', isNew: true, patch: built.patch, files, changedFiles: built.changedFiles, rationale: 'A method that worked', now: NOW });
    assert.strictEqual(record.newPlaybook, true);
    assert.strictEqual(record.packageDir, 'artifacts/playbook-proposals/dock-repair');
    assert.strictEqual(fs.readFileSync(path.join(caseDir, record.packageDir, 'steps.md'), 'utf8'), STEPS_MD);
    assert.strictEqual(fs.readFileSync(path.join(caseDir, record.packageDir, 'playbook.yaml'), 'utf8'), NEW_YAML);
    const empty = tmp();
    await git.runGit(empty, ['init', '-q']);
    const r = await p.applyProposalTo({ caseDir, casesRoot, record, repoPath: empty, tmpRoot: tmp() });
    assert.strictEqual(r.appliedOver, null);
    assert.strictEqual(fs.readFileSync(path.join(empty, 'playbook.yaml'), 'utf8'), NEW_YAML);
    const full = await makeGitPackage(path.join(tmp(), 'dock-repair'), { 'playbook.yaml': NEW_YAML });
    await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: full }), { message: `${full} already holds a playbook.` });
  });

  it('the package folder is written from the patch; files that differ from it are refused', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const files = [{ path: 'playbook.yaml', content: NEW_YAML }, { path: 'steps.md', content: STEPS_MD }];
    const built = await p.buildProposal({ name: 'dock-repair', isNew: true, files, tmpRoot: tmp() });
    const caseDir = tmp();
    const store = (f) => p.storeProposal(caseDir, { name: 'dock-repair', isNew: true, patch: built.patch, files: f, changedFiles: built.changedFiles, rationale: '', now: NOW });
    assert.throws(() => store([files[0], { path: 'steps.md', content: 'Something else.\n' }]), { code: 'UNSAFE_PATCH', message: /files differ/ });
    assert.throws(() => store([files[0]]), { code: 'UNSAFE_PATCH', message: /files differ/ });
    assert.strictEqual(fs.existsSync(path.join(caseDir, 'artifacts')), false);
    const record = store(undefined);
    assert.strictEqual(fs.readFileSync(path.join(caseDir, record.packageDir, 'steps.md'), 'utf8'), STEPS_MD);
  });

  it('a new playbook patch must name the playbook and start at 0.1.0, at store and at apply', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const casesRoot = tmp();
    const caseDir = path.join(casesRoot, 'dock-case');
    fs.mkdirSync(caseDir);
    for (const [yamlText, re] of [[NEW_YAML.replace('name: dock-repair', 'name: pier-repair'), /does not name the playbook "dock-repair"/], [NEW_YAML.replace('"0.1.0"', '"9.0.0"'), /start at version "0\.1\.0"/]]) {
      const patch = await newFilesPatch({ 'playbook.yaml': yamlText, 'steps.md': STEPS_MD });
      assert.throws(() => p.storeProposal(caseDir, { name: 'dock-repair', isNew: true, patch, changedFiles: ['playbook.yaml', 'steps.md'], rationale: '', now: NOW }), { code: 'UNSAFE_PATCH', message: re });
      const good = await newFilesPatch({ 'playbook.yaml': NEW_YAML, 'steps.md': STEPS_MD });
      const record = craft(caseDir, p.storeProposal(caseDir, { name: 'dock-repair', isNew: true, patch: good, changedFiles: ['playbook.yaml', 'steps.md'], rationale: '', now: NOW }), patch);
      const empty = tmp();
      await git.runGit(empty, ['init', '-q']);
      await assert.rejects(p.applyProposalTo({ caseDir, casesRoot, record, repoPath: empty, tmpRoot: tmp() }), { code: 'TAMPERED', message: re });
      assert.deepStrictEqual(fs.readdirSync(empty), ['.git']);
    }
  });

  it('a new-playbook record whose patch changes an existing file is refused', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { built } = await world();
    const caseDir = tmp();
    assert.throws(() => p.storeProposal(caseDir, { name: 'dock-repair', isNew: true, patch: built.patch, files: [{ path: 'steps.md', content: BETTER_STEPS }], changedFiles: built.changedFiles, rationale: '', now: NOW }), /changes an existing file/);
  });

  it('a new playbook must be named as proposed and start at 0.1.0', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const build = (yamlText) => p.buildProposal({ name: 'dock-repair', isNew: true, files: [{ path: 'playbook.yaml', content: yamlText }, { path: 'steps.md', content: STEPS_MD }], tmpRoot: tmp() });
    await assert.rejects(build(NEW_YAML.replace('"0.1.0"', '"1.0.0"')), { message: 'A new playbook starts at version "0.1.0".' });
    await assert.rejects(build(NEW_YAML.replace('name: dock-repair', 'name: pier-repair')), /name "pier-repair" must equal the directory name "dock-repair"/);
  });
});

// tests/playbooks-manager.test.js
// PlaybookManager (cases stage 6 spec §3.5, §3.7): attach, defaults,
// remove, updates, adopt, create preparation and proposals.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { CaseRuntime } = require('../src/cases');
const { PlaybookManager } = require('../src/cases/playbooks/manager');
const { hashPackage } = require('../src/cases/playbooks/format');
const { readState, writeState } = require('../src/cases/playbooks/changes');
const { listProposals } = require('../src/cases/playbooks/proposals');
const { PLAYBOOK_YAML, STEPS_MD, writePackage, makeGitPackage, commitPackage, withYaml, GIT_ID } = require('./helpers/playbook-fixture');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
// Real paths: a recorded local source must have no link on its way (ruling
// T5-recorded), and some platforms' temp dir sits behind one.
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbmgr-'))); dirs.push(d); return d; };
const lastSubject = async (dir) => (await git.git(dir, ['log', '-1', '--format=%s'])).trim();
const clean = async (dir) => (await git.git(dir, ['status', '--porcelain'])).trim() === '';

// A runtime, a manager, and an examples dir holding the fixture as land-sale.
async function world({ playbooks = {}, examples = {}, registry = null, type, adminPolicy } = {}) {
  const examplesDir = tmp();
  writePackage(path.join(examplesDir, 'land-sale'), examples);
  const settings = { playbooks: { sources: [], autoUpdate: false, ...playbooks } };
  const rt = new CaseRuntime({ root: tmp(), getSettings: () => settings });
  const mgr = new PlaybookManager({ runtime: rt, getSettings: () => settings, examplesDir, getExecutorRegistry: () => registry, tmpRoot: tmp(), ...(adminPolicy === undefined ? {} : { adminPolicy }) });
  rt.playbooks = mgr;
  const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the lot', ...(type ? { type } : {}) });
  return { rt, mgr, id: info.id, dir: info.dir, examplesDir, settings };
}

// An upstream folder under its own root, and a world whose allowlist names
// that root (a recorded path: source is read on update only under a
// matching entry, ruling T5-recorded).
async function allowedUpstream({ gitRepo = true, name = 'land-sale', overrides = {} } = {}) {
  const root = tmp();
  const dir = path.join(root, name);
  if (gitRepo) await makeGitPackage(dir, overrides);
  else writePackage(dir, overrides);
  return { root, dir };
}

// Every fs call that reads through `target` (or anything under it) is
// recorded and refused before it reaches the file system.
function watchFs(t, target, { lstatSelf = false } = {}) {
  const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const root = fold(path.resolve(target));
  const hits = [];
  const under = (p, self) => {
    if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
    const s = fold(path.resolve(String(p)));
    return (self && s === root) || s.startsWith(root + path.sep);
  };
  const wrap = (obj, name, self) => {
    const real = obj[name];
    const fn = function (p, ...rest) {
      if (under(p, self)) {
        hits.push(`${name} ${p}`);
        throw Object.assign(new Error(`test: ${name} on a watched path`), { code: 'EWATCHED' });
      }
      return real.call(this, p, ...rest);
    };
    Object.assign(fn, real);
    obj[name] = fn;
    t.after(() => { obj[name] = real; });
  };
  // Calls that follow a link at `target` itself, and lstat of anything under it.
  for (const n of ['statSync', 'readdirSync', 'readFileSync', 'openSync', 'existsSync', 'accessSync', 'opendirSync']) wrap(fs, n, true);
  wrap(fs.realpathSync, 'native', true);
  wrap(fs, 'realpathSync', true);
  wrap(fs, 'lstatSync', lstatSelf);
  return hits;
}

describe('attach', () => {
  it('vendors the copy, records it, commits once, and asks the gating questions', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    fs.rmSync(path.join(dir, '.gitattributes'));
    await git.commitAll(dir, 'a case from before stage 6');
    const r = await mgr.attach(id, { source: 'example:land-sale' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.playbook, { name: 'land-sale', version: '1.2.0' });
    assert.deepStrictEqual(r.budgetRaises, []);
    assert.strictEqual(r.questionIds.length, 2, 'floor-price and financing');
    assert.strictEqual(r.unknownIds.length, 1, 'parcel-id');
    const pb = path.join(dir, 'playbooks', 'land-sale');
    assert.deepStrictEqual(rt.getCase(id).playbooks, [{
      name: 'land-sale', version: '1.2.0', source: 'example:land-sale', mode: 'vendored', commit: null, contentHash: hashPackage(pb)
    }]);
    const state = readState(dir);
    assert.strictEqual(state.vendored['land-sale'].contentHash, hashPackage(pb));
    assert.deepStrictEqual(Object.keys(state.vendored['land-sale'].files).sort(), ['briefRules.md', 'playbook.yaml', 'sources.md', 'steps.md']);
    assert.strictEqual(state.acknowledged['land-sale'].version, '1.2.0');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), 'playbooks/** -text\n');
    assert.strictEqual(await lastSubject(dir), 'system: playbook attach land-sale@1.2.0');
    assert.ok(await clean(dir), 'one commit holds every write');
    assert.ok(fs.readdirSync(path.join(dir, 'journal')).some((f) => f.endsWith('-playbook.md')));
    assert.deepStrictEqual(rt.questions(id).list().map((q) => q.text).sort(), [
      '[land-sale] What is the lowest price you would accept?',
      '[land-sale] Will you consider seller financing?'
    ]);
  });

  it('refuses a second attach, a case type mismatch and a closed case', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id } = await world();
    await mgr.attach(id, { source: 'example:land-sale' });
    await assert.rejects(mgr.attach(id, { source: 'example:land-sale' }), { message: 'Playbook "land-sale" is already attached to this case. Use Update to change its version.' });
    const typed = await world({ type: 'outreach' });
    await assert.rejects(typed.mgr.attach(typed.id, { source: 'example:land-sale' }), { message: 'Playbook "land-sale" is for "general" cases; this case is "outreach".' });
    const outreach = await world({ examples: { 'playbook.yaml': withYaml(/caseType: general/, 'caseType: outreach') } });
    assert.strictEqual((await outreach.mgr.attach(outreach.id, { source: 'example:land-sale' })).ok, true, 'a general case takes any playbook');
    assert.strictEqual(outreach.rt.getCase(outreach.id).type, 'general');
    rt.setStatus(id, 'abandoned', { kind: 'owner', by: 'owner' });
    await assert.rejects(mgr.remove(id, 'land-sale'), { message: 'Case is abandoned; its playbooks cannot change.' });
  });

  it('nothing is written when the source is invalid', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    const bad = writePackage(path.join(tmp(), 'land-sale'), { 'playbook.yaml': PLAYBOOK_YAML.replace('version: "1.2.0"', 'version: 1.2') });
    await assert.rejects(mgr.attach(id, { source: bad }), /is invalid:\nplaybook\.yaml: version must be a quoted string like "1\.2\.0"/);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'playbooks')), ['.gitkeep']);
    assert.deepStrictEqual(rt.getCase(id).playbooks, []);
  });

  it('a failure after the copy is written rolls the attach back', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    let failed = false;
    // The state file is written after the pin; fail there, once.
    const changesMod = require('../src/cases/playbooks/changes');
    const realWrite = changesMod.writeState;
    changesMod.writeState = (...args) => {
      if (!failed) { failed = true; throw new Error('disk full'); }
      return realWrite(...args);
    };
    t.after(() => { changesMod.writeState = realWrite; });
    await assert.rejects(mgr.attach(id, { source: 'example:land-sale' }), /disk full/);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'playbooks')), ['.gitkeep'], 'the copy is removed');
    assert.deepStrictEqual(rt.getCase(id).playbooks, [], 'the pin is removed');
    assert.deepStrictEqual(readState(dir).vendored, {});
    const retry = await mgr.attach(id, { source: 'example:land-sale' });
    assert.strictEqual(retry.ok, true, 'a retry attaches');
  });
});

describe('defaults', () => {
  it('materiality fills gaps and never moves an owner ignore to tell', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id } = await world();
    rt.brief(id).update('materiality', { tell: [], ignore: ['offers'] }, { provenance: 'user' });
    await mgr.attach(id, { source: 'example:land-sale' });
    assert.deepStrictEqual(rt.brief(id).read().data.materiality, { tell: ['deadline-risk'], ignore: ['offers', 'no-answer'] });
  });

  it('budget lower applied, higher offered, and applied only with acceptBudgetRaises === true', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const raise = { 'playbook.yaml': withYaml(/budgetDefaults: .*/, 'budgetDefaults: { usd: 40, contactsPerDay: 5 }') };
    const a = await world({ examples: raise });
    const r = await a.mgr.attach(a.id, { source: 'example:land-sale' });
    assert.deepStrictEqual(r.budgetRaises, [{ key: 'usd', from: 20, to: 40 }]);
    assert.deepStrictEqual(a.rt.getCase(a.id).budget, { contactsPerDay: 5 });
    assert.deepStrictEqual(a.mgr.offeredBudgetRaises(a.id), [{ playbook: 'land-sale', key: 'usd', from: 20, to: 40 }]);
    const accepted = await a.mgr.applyBudgetRaises(a.id, 'land-sale');
    assert.deepStrictEqual(accepted, { ok: true, applied: [{ key: 'usd', from: 20, to: 40 }] });
    assert.deepStrictEqual(a.rt.getCase(a.id).budget, { contactsPerDay: 5, usd: 40 });
    assert.deepStrictEqual(a.mgr.offeredBudgetRaises(a.id), []);

    const b = await world({ examples: raise });
    const rb = await b.mgr.attach(b.id, { source: 'example:land-sale', acceptBudgetRaises: true });
    assert.deepStrictEqual(rb.budgetRaises, []);
    assert.deepStrictEqual(b.rt.getCase(b.id).budget, { usd: 40, contactsPerDay: 5 });

    const c = await world({ examples: raise });
    c.rt.store.updateMeta(c.id, { budget: { usd: 15 } });
    const rc = await c.mgr.attach(c.id, { source: 'example:land-sale' });
    assert.deepStrictEqual(rc.budgetRaises, [], 'an existing value wins');
    assert.deepStrictEqual(c.rt.getCase(c.id).budget, { usd: 15, contactsPerDay: 5 });

    const d = await world({ examples: raise });
    const rd = await d.mgr.attach(d.id, { source: 'example:land-sale', acceptBudgetRaises: 'yes' });
    assert.deepStrictEqual(rd.budgetRaises, [{ key: 'usd', from: 20, to: 40 }], 'a truthy string is not an accept');
    assert.deepStrictEqual(d.rt.getCase(d.id).budget, { contactsPerDay: 5 });
  });
});

describe('remove', () => {
  it('deletes the copy and both entries; question records stay', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    await mgr.attach(id, { source: 'example:land-sale' });
    assert.deepStrictEqual(await mgr.remove(id, 'land-sale'), { ok: true });
    assert.strictEqual(fs.existsSync(path.join(dir, 'playbooks', 'land-sale')), false);
    assert.deepStrictEqual(rt.getCase(id).playbooks, []);
    assert.deepStrictEqual(readState(dir).vendored, {});
    assert.deepStrictEqual(readState(dir).acknowledged, {});
    assert.strictEqual(rt.questions(id).list().length, 2);
    assert.deepStrictEqual(mgr.pendingGating(id), [], 'open records stop blocking');
    assert.strictEqual(await lastSubject(dir), 'system: playbook remove land-sale');
    await assert.rejects(mgr.remove(id, '../x'), /is not a valid playbook name/);
    await assert.rejects(mgr.remove(id, { toString: () => 'x' }), { message: 'A playbook name must be a string.' });
  });

  it('a pin with an invalid name leaves case.yaml; nothing on disk is touched', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    await mgr.attach(id, { source: 'example:land-sale' });
    // Where a path built from the name would land (the cases root).
    const evil = path.resolve(dir, 'playbooks', '..', '..', 'evil');
    const good = rt.getCase(id).playbooks[0];
    rt.store.updateMeta(id, { playbooks: [good, { name: '../../evil', version: '1.0.0', source: 'adopted', mode: 'vendored', commit: null, contentHash: 'sha256:x' }] });
    const hits = watchFs(t, evil, { lstatSelf: true });
    assert.deepStrictEqual(await mgr.remove(id, '../../evil'), { ok: true });
    assert.deepStrictEqual(hits, []);
    assert.deepStrictEqual(rt.getCase(id).playbooks, [good], 'only the exact-match entry is dropped');
    assert.strictEqual(await lastSubject(dir), 'system: playbook remove (invalid name)');
    await assert.rejects(mgr.remove(id, '../../other'), /is not a valid playbook name/);
  });

  it('a linked copy is unlinked, never followed', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    const outside = writePackage(path.join(tmp(), 'land-sale'));
    try {
      fs.symlinkSync(outside, path.join(dir, 'playbooks', 'land-sale'), 'junction');
    } catch (err) {
      return t.skip(`cannot create a link here (${err.code})`);
    }
    rt.store.updateMeta(id, { playbooks: [{ name: 'land-sale', version: '1.2.0', source: 'adopted', mode: 'vendored', commit: null, contentHash: 'sha256:x' }] });
    assert.deepStrictEqual(await mgr.remove(id, 'land-sale'), { ok: true });
    assert.strictEqual(fs.existsSync(path.join(outside, 'steps.md')), true, 'the link target is untouched');
    assert.strictEqual(fs.existsSync(path.join(dir, 'playbooks', 'land-sale')), false);
  });
});

describe('updates', () => {
  it('checkUpdates and update from a local git source; case.yaml keeps the oriented version', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const up = await allowedUpstream();
    const upstream = up.dir;
    const { rt, mgr, id, dir } = await world({ playbooks: { sources: [`path:${up.root}`] } });
    const head = (await git.runGit(upstream, ['rev-parse', 'HEAD'])).trim();
    await mgr.attach(id, { source: upstream });
    assert.strictEqual(rt.getCase(id).playbooks[0].commit, head);
    assert.strictEqual(rt.getCase(id).playbooks[0].source, `path:${upstream}`);
    await commitPackage(upstream, { 'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"1.3.0"'), 'sources.md': 'Placeholders only.\n' }, '1.3.0');
    assert.deepStrictEqual(await mgr.checkUpdates(id), [{ name: 'land-sale', pinned: '1.2.0', upstream: '1.3.0', updateAvailable: true, sameMajor: true }]);
    assert.ok(readState(dir).lastUpdateCheck);
    assert.deepStrictEqual(await mgr.update(id, 'land-sale'), { ok: true, from: '1.2.0', to: '1.3.0', budgetRaises: [] });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'playbooks', 'land-sale', 'sources.md'), 'utf8'), 'Placeholders only.\n');
    assert.strictEqual(rt.getCase(id).playbooks[0].version, '1.2.0', 'the next turn\'s trigger sees the move');
    assert.strictEqual(readState(dir).vendored['land-sale'].onDiskVersion, '1.3.0');
    assert.deepStrictEqual(mgr.changes(id).map((c) => [c.kind, c.from, c.to]), [['version-changed', '1.2.0', '1.3.0']]);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.kl', 'runs')), []);
    assert.ok(await clean(dir));
  });

  it('an edited copy is refused without force, naming the files', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const up = await allowedUpstream();
    const { mgr, id, dir } = await world({ playbooks: { sources: [`path:${up.root}`] } });
    await mgr.attach(id, { source: up.dir });
    fs.appendFileSync(path.join(dir, 'playbooks', 'land-sale', 'steps.md'), '\nLocal note.\n');
    assert.deepStrictEqual(await mgr.update(id, 'land-sale'), {
      ok: false,
      error: 'The vendored copy of "land-sale" was edited (steps.md); updating would overwrite those edits.',
      editedFiles: ['steps.md']
    });
    assert.strictEqual((await mgr.update(id, 'land-sale', { force: 'yes' })).ok, false, 'force only on === true');
    const forced = await mgr.update(id, 'land-sale', { force: true });
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'playbooks', 'land-sale', 'steps.md'), 'utf8'), STEPS_MD);
  });

  it('a recorded hash that is missing counts as an edit', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const up = await allowedUpstream();
    const { mgr, id, dir } = await world({ playbooks: { sources: [`path:${up.root}`] } });
    await mgr.attach(id, { source: up.dir });
    const s = readState(dir);
    s.vendored['land-sale'].contentHash = null;
    writeState(dir, s);
    const r = await mgr.update(id, 'land-sale');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /was edited/);
  });

  it('an oversized copy is refused with or without force', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const up = await allowedUpstream();
    const { mgr, id, dir } = await world({ playbooks: { sources: [`path:${up.root}`] } });
    await mgr.attach(id, { source: up.dir });
    fs.writeFileSync(path.join(dir, 'playbooks', 'land-sale', 'notes.md'), 'x'.repeat(300 * 1024));
    const expected = {
      ok: false,
      error: 'The vendored copy of "land-sale" cannot be checked (notes.md is larger than 256 KiB); remove it and add it again from its source.'
    };
    assert.deepStrictEqual(await mgr.update(id, 'land-sale'), expected);
    assert.deepStrictEqual(await mgr.update(id, 'land-sale', { force: true }), expected);
    assert.strictEqual(fs.statSync(path.join(dir, 'playbooks', 'land-sale', 'notes.md')).size, 300 * 1024, 'nothing overwritten');
  });

  it('a copy edited while the source is fetched is refused under the lock', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const up = await allowedUpstream();
    const { mgr, id, dir } = await world({ playbooks: { sources: [`path:${up.root}`] } });
    await mgr.attach(id, { source: up.dir });
    await commitPackage(up.dir, { 'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"1.3.0"') }, '1.3.0');
    const steps = path.join(dir, 'playbooks', 'land-sale', 'steps.md');
    const real = mgr._prepareResolved.bind(mgr);
    mgr._prepareResolved = async (...args) => {
      const prepared = await real(...args);
      fs.appendFileSync(steps, '\nLocal note.\n');
      return prepared;
    };
    const r = await mgr.update(id, 'land-sale');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.editedFiles, ['steps.md']);
    assert.match(fs.readFileSync(steps, 'utf8'), /Local note\./);
  });

  it('upstream rename: update refused with the exact message, old copy intact', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const up = await allowedUpstream();
    const upstream = up.dir;
    const { mgr, id, dir } = await world({ playbooks: { sources: [`path:${up.root}`] } });
    await mgr.attach(id, { source: upstream });
    const before = hashPackage(path.join(dir, 'playbooks', 'land-sale'));
    await commitPackage(upstream, { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: land-sale-v2').replace('"1.2.0"', '"2.0.0"') }, 'rename');
    assert.deepStrictEqual(await mgr.update(id, 'land-sale'), {
      ok: false,
      error: `Upstream playbook at path:${upstream} is now named "land-sale-v2" (attached as "land-sale"). Remove "land-sale" and add "land-sale-v2" to switch.`
    });
    assert.strictEqual(hashPackage(path.join(dir, 'playbooks', 'land-sale')), before);
  });

  it('checkUpdates per source: example and plain folder; autoUpdate applies same-major only', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const up = await allowedUpstream({ gitRepo: false, name: 'farm', overrides: { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: farm') } });
    const folder = up.dir;
    const { mgr, id, examplesDir, settings } = await world({ playbooks: { sources: [`path:${up.root}`] } });
    await mgr.attach(id, { source: 'example:land-sale' });
    await mgr.attach(id, { source: folder });
    writePackage(path.join(examplesDir, 'land-sale'), { 'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"1.2.1"') });
    writePackage(folder, { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: farm').replace('"1.2.0"', '"2.0.0"') });
    settings.playbooks.autoUpdate = true;
    const rows = await mgr.checkUpdates(id, null, { apply: true });
    assert.deepStrictEqual(rows, [
      { name: 'land-sale', pinned: '1.2.0', upstream: '1.2.1', updateAvailable: true, sameMajor: true, applied: '1.2.1' },
      { name: 'farm', pinned: '1.2.0', upstream: '2.0.0', updateAvailable: true, sameMajor: false }
    ]);
    settings.playbooks.autoUpdate = false;
    const again = await mgr.checkUpdates(id, 'land-sale', { apply: true });
    assert.strictEqual(again[0].updateAvailable, false);
  });

  it('checkUpdates on a closed case writes and commits nothing', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    for (const status of ['done', 'abandoned']) {
      const { rt, mgr, id, dir } = await world();
      await mgr.attach(id, { source: 'example:land-sale' });
      if (status === 'done') {
        rt.brief(id).update('why', 'Need the cash', { provenance: 'user' });
        rt.brief(id).append('successCriteria', 'Sold', { provenance: 'model' });
        for (const q of rt.questions(id).open()) await rt.answerQuestion(id, q.id, { text: q.options?.length ? null : '250000', optionId: q.options?.[0]?.id ?? null });
        rt.completeGating(id);
      }
      rt.setStatus(id, status, { kind: 'owner', by: 'owner' });
      await git.commitAll(dir, `closed ${status}`);
      const head = (await git.git(dir, ['rev-parse', 'HEAD'])).trim();
      const rows = await mgr.checkUpdates(id);
      assert.strictEqual(rows[0].upstream, '1.2.0');
      assert.strictEqual(readState(dir).lastUpdateCheck, null);
      assert.strictEqual((await git.git(dir, ['rev-parse', 'HEAD'])).trim(), head, `${status}: no commit`);
      assert.ok(await clean(dir), `${status}: nothing written`);
    }
  });

  it('a submodule update is refused', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    const sha = '4b1e0c9d2f7a8b6e5d4c3b2a1f0e9d8c7b6a5f4e';
    fs.writeFileSync(path.join(dir, '.gitmodules'), '[submodule "remote-pb"]\n\tpath = playbooks/remote-pb\n\turl = https://example.com/playbooks/remote-pb.git\n');
    await git.runGit(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},playbooks/remote-pb`]);
    await git.runGit(dir, ['add', '.gitmodules']);
    await git.runGit(dir, ['commit', '-q', '-m', 'gitlink'], { env: GIT_ID });
    writePackage(path.join(dir, 'playbooks', 'remote-pb'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: remote-pb') });
    rt.store.updateMeta(id, { playbooks: [{ name: 'remote-pb', version: '1.2.0', source: 'https://example.com/playbooks/remote-pb.git', mode: 'submodule', commit: sha, contentHash: 'sha256:x' }] });
    assert.deepStrictEqual(await mgr.update(id, 'remote-pb'), {
      ok: false,
      error: '"remote-pb" is a git submodule; update it with git ("git submodule update --remote playbooks/remote-pb") and the next turn will re-orient.'
    });
  });
});

// Ruling T5-recorded: a path: source recorded in .kl/playbooks.json is case
// data (imported, or rewritten through Bash). It is read on update only
// under a matching path: allowlist entry, or after the owner re-confirms.
describe('recorded local sources', () => {
  async function imported(t, { sources = [] } = {}) {
    // The owner attached from a folder they typed; then the recorded source
    // was rewritten to point at another folder.
    const typed = await allowedUpstream();
    const other = await allowedUpstream({ overrides: { 'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"9.9.9"') } });
    const w = await world({ playbooks: { sources } });
    await w.mgr.attach(w.id, { source: typed.dir });
    const s = readState(w.dir);
    s.vendored['land-sale'].source = `path:${other.dir}`;
    writeState(w.dir, s);
    return { ...w, typed, other };
  }

  it('a crafted source outside the allowlist is not read until the owner re-confirms', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    const hits = watchFs(t, w.other.dir);
    const [row] = await w.mgr.checkUpdates(w.id);
    assert.strictEqual(row.upstream, null);
    assert.strictEqual(row.code, 'SOURCE_NEEDS_CONFIRM');
    assert.match(row.error, /^The recorded source of "land-sale" is a local folder no allowed-folder entry covers/);
    const upd = await w.mgr.update(w.id, 'land-sale');
    assert.strictEqual(upd.ok, false);
    assert.strictEqual(upd.code, 'SOURCE_NEEDS_CONFIRM');
    w.settings.playbooks.autoUpdate = true;
    const auto = await w.mgr.checkUpdates(w.id, null, { apply: true });
    assert.strictEqual(auto[0].code, 'SOURCE_NEEDS_CONFIRM', 'autoUpdate does not confirm');
    assert.deepStrictEqual(await w.mgr.update(w.id, 'land-sale', { confirmSource: 'yes' }).then((r) => r.code), 'SOURCE_NEEDS_CONFIRM', 'confirm only on === true');
    assert.deepStrictEqual(hits, [], 'nothing under the recorded folder was touched');
    assert.strictEqual(readState(w.dir).vendored['land-sale'].onDiskVersion, '1.2.0');
  });

  it('with no path: entry the recorded path is refused before any file system call', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    // Stands in for a folder on a mapped network drive: nothing on its way
    // may be lstat-ed (or read) before the owner confirms.
    const drive = path.join(tmp(), 'mapped');
    const s = readState(w.dir);
    s.vendored['land-sale'].source = `path:${path.join(drive, 'land-sale')}`;
    writeState(w.dir, s);
    const hits = watchFs(t, drive, { lstatSelf: true });
    const [row] = await w.mgr.checkUpdates(w.id);
    assert.strictEqual(row.code, 'SOURCE_NEEDS_CONFIRM');
    assert.strictEqual((await w.mgr.update(w.id, 'land-sale')).code, 'SOURCE_NEEDS_CONFIRM');
    assert.deepStrictEqual(hits, [], 'zero file system calls before confirming');
    const confirmed = await w.mgr.update(w.id, 'land-sale', { confirmSource: true });
    assert.strictEqual(confirmed.ok, false);
    assert.ok(hits.length > 0, 'a confirmed path is then checked');
  });

  // The allowlist lives in a different place per mode (ruling T14-admin), so
  // the hint names the one the owner can edit.
  it('the confirm hint names Settings on the desktop and the admin service.json in service mode', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const typed = await allowedUpstream({ gitRepo: false });
    for (const [adminPolicy, hint, not] of [
      [false, /or add its folder to Settings → Playbooks → Allowed sources\.$/, /service\.json/],
      [true, /or set playbooks\.sources in the admin service\.json\.$/, /Settings/]
    ]) {
      const w = await world({ adminPolicy });
      await w.mgr.attach(w.id, { source: typed.dir });
      const [row] = await w.mgr.checkUpdates(w.id);
      assert.strictEqual(row.code, 'SOURCE_NEEDS_CONFIRM');
      assert.match(row.error, hint);
      assert.doesNotMatch(row.error, not);
      const upd = await w.mgr.update(w.id, 'land-sale');
      assert.match(upd.error, hint);
    }
  });

  it('with entries that do not cover it on its text, the recorded path is refused before any file system call', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    const drive = path.join(tmp(), 'mapped');
    const s = readState(w.dir);
    s.vendored['land-sale'].source = `path:${path.join(drive, 'land-sale')}`;
    writeState(w.dir, s);
    // One entry elsewhere, one sharing a name prefix but not a segment.
    w.settings.playbooks.sources = [`path:${w.typed.root}`, `path:${drive}-other`];
    const hits = watchFs(t, drive, { lstatSelf: true });
    const [row] = await w.mgr.checkUpdates(w.id);
    assert.strictEqual(row.code, 'SOURCE_NEEDS_CONFIRM');
    assert.strictEqual((await w.mgr.update(w.id, 'land-sale')).code, 'SOURCE_NEEDS_CONFIRM');
    assert.deepStrictEqual(hits, [], 'zero file system calls before confirming');
    // An entry that is a text prefix of the path but not a whole segment.
    const sibling = `${drive}-evil`;
    const s2 = readState(w.dir);
    s2.vendored['land-sale'].source = `path:${path.join(sibling, 'land-sale')}`;
    writeState(w.dir, s2);
    w.settings.playbooks.sources = [`path:${drive}`];
    const siblingHits = watchFs(t, sibling, { lstatSelf: true });
    assert.strictEqual((await w.mgr.update(w.id, 'land-sale')).code, 'SOURCE_NEEDS_CONFIRM');
    assert.deepStrictEqual(siblingHits, []);
    writeState(w.dir, s);
    const upper = process.platform === 'win32' ? drive.toUpperCase() : drive;
    w.settings.playbooks.sources = [`path:${upper}`];
    await w.mgr.update(w.id, 'land-sale');
    assert.ok(hits.length > 0, 'a covering entry (case-folded on Windows) goes on to the checks');
  });

  it('the owner re-confirming reads it', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    await assert.rejects(w.mgr.checkUpdates(w.id, null, { confirmSource: true }), { code: 'CONFIRM_NEEDS_NAME', message: 'confirmSource needs a playbook name.' });
    const [row] = await w.mgr.checkUpdates(w.id, 'land-sale', { confirmSource: true });
    assert.strictEqual(row.upstream, '9.9.9');
    const r = await w.mgr.update(w.id, 'land-sale', { confirmSource: true });
    assert.deepStrictEqual(r, { ok: true, from: '1.2.0', to: '9.9.9', budgetRaises: [] });
  });

  it('a matching allowlist entry reads it; an entry that does not match refuses it even confirmed', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    w.settings.playbooks.sources = [`path:${w.other.root}`];
    assert.strictEqual((await w.mgr.checkUpdates(w.id))[0].upstream, '9.9.9');
    w.settings.playbooks.sources = [`path:${w.typed.root}`];
    const r = await w.mgr.update(w.id, 'land-sale', { confirmSource: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /is outside the allowed folders/);
  });

  it('a recorded path through a link is refused without following it', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    const link = path.join(tmp(), 'linked');
    try {
      fs.symlinkSync(w.other.root, link, 'junction');
    } catch (err) {
      return t.skip(`cannot create a link here (${err.code})`);
    }
    const s = readState(w.dir);
    s.vendored['land-sale'].source = `path:${path.join(link, 'land-sale')}`;
    writeState(w.dir, s);
    w.settings.playbooks.sources = [`path:${path.dirname(link)}`];
    const hits = watchFs(t, link);
    const r = await w.mgr.update(w.id, 'land-sale', { confirmSource: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SOURCE_IS_LINK');
    assert.deepStrictEqual(hits, []);
  });

  it('a recorded link to a UNC share is refused before anything follows it', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    const link = path.join(tmp(), 'share');
    try {
      fs.symlinkSync('\\\\unc-host.example.com\\share', link, 'dir');
    } catch (err) {
      return t.skip(`cannot create a symbolic link here (${err.code})`);
    }
    const s = readState(w.dir);
    s.vendored['land-sale'].source = `path:${link}`;
    writeState(w.dir, s);
    const hits = watchFs(t, link);
    const r = await w.mgr.update(w.id, 'land-sale', { confirmSource: true });
    assert.strictEqual(r.code, 'SOURCE_IS_LINK');
    assert.deepStrictEqual(hits, []);
  });

  it('a recorded UNC path is refused on its text', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await imported(t);
    for (const unc of ['\\\\unc-host.example.com\\share\\land-sale', '//unc-host.example.com/share/land-sale']) {
      const s = readState(w.dir);
      s.vendored['land-sale'].source = `path:${unc}`;
      writeState(w.dir, s);
      const hits = watchFs(t, unc, { lstatSelf: true });
      const r = await w.mgr.update(w.id, 'land-sale', { confirmSource: true });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /Unsupported playbook source/);
      assert.deepStrictEqual(hits, []);
    }
  });
});

describe('executors and adoption', () => {
  it('unknown executor: the step is kept with executorKnown false and a warning', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const registry = { ids: () => ['web', 'owner'], get: (x) => (['web', 'owner'].includes(x) ? { id: x } : null) };
    const { mgr, id } = await world({ registry });
    await mgr.attach(id, { source: 'example:land-sale' });
    const steps = mgr.steps(id);
    assert.deepStrictEqual(steps.map((s) => [s.id, s.executorKnown]), [['confirm-parcel', true], ['call-buyers', false]]);
    assert.deepStrictEqual(mgr.summary(id)[0].warnings, ['step "call-buyers" expects executor "phone-agent", which is not registered']);
    assert.match(mgr.orientationSection(id), /step "call-buyers" expects executor "phone-agent", which is not registered/);
  });

  it('adopt registers an unregistered folder; anything else is refused', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, mgr, id, dir } = await world();
    writePackage(path.join(dir, 'playbooks', 'land-sale'));
    const r = await mgr.adopt(id, 'land-sale');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(rt.getCase(id).playbooks[0].source, 'adopted');
    await assert.rejects(mgr.adopt(id, 'land-sale'), { message: '"land-sale" is not an unregistered playbook in this case (it is ok).' });
    assert.strictEqual((await mgr.update(id, 'land-sale')).error, '"land-sale" has no recorded source; remove it and add it again from its source.');
  });
});

describe('prepareForCreate', () => {
  it('validates every source first and infers the shared type', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { mgr } = await world();
    const bad = writePackage(path.join(tmp(), 'farm'), { 'steps.md': null, 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: farm') });
    const r = await mgr.prepareForCreate([{ source: 'example:land-sale' }, { source: bad }]);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /^The case was not created:\n.*farm: The playbook at path:.* is invalid:\nsteps\.md: steps\.md is missing$/s);
    const good = await mgr.prepareForCreate([{ source: 'example:land-sale' }]);
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.type, 'general');
    const outreach = writePackage(path.join(tmp(), 'farm'), { 'playbook.yaml': withYaml(/caseType: general/, 'caseType: outreach').replace('name: land-sale', 'name: farm') });
    assert.deepStrictEqual(await mgr.prepareForCreate([{ source: 'example:land-sale' }, { source: outreach }]), { ok: false, error: 'Playbooks disagree on case type (general, outreach); pick a type.' });
    assert.match((await mgr.prepareForCreate(Array.from({ length: 6 }, () => ({ source: 'example:land-sale' })))).error, /at most 5/);
  });

  it('lists the examples', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { mgr } = await world();
    assert.deepStrictEqual(mgr.listExamples(), [{ name: 'land-sale', version: '1.2.0', title: 'Sell a parcel of land', caseType: 'general' }]);
    assert.deepStrictEqual(new PlaybookManager({ runtime: mgr.runtime, examplesDir: null }).listExamples(), []);
  });
});

describe('proposals through the manager', () => {
  async function doneCase() {
    const w = await world();
    await w.mgr.attach(w.id, { source: 'example:land-sale' });
    w.rt.brief(w.id).update('why', 'Need the cash', { provenance: 'user' });
    w.rt.brief(w.id).append('successCriteria', 'Sold', { provenance: 'model' });
    for (const q of w.rt.questions(w.id).open()) await w.rt.answerQuestion(w.id, q.id, { text: q.options?.length ? null : '250000', optionId: q.options?.[0]?.id ?? null });
    w.rt.completeGating(w.id);
    return w;
  }
  const change = { playbook: 'land-sale', files: [{ path: 'steps.md', content: STEPS_MD.replace('Call the buyers on the list;', 'Call the largest buyers first;') }], rationale: 'Larger buyers answered first.', factIds: [] };

  it('proposals only once the case is done', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await doneCase();
    assert.deepStrictEqual(await w.mgr.propose(w.id, change), { ok: false, error: 'Playbook changes can only be proposed once the case is done.' });
    w.rt.setStatus(w.id, 'done', { kind: 'owner', by: 'owner' });
    const r = await w.mgr.propose(w.id, change);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.proposal.id, 'pp-001');
    assert.deepStrictEqual(r.proposal.files, ['steps.md']);
    const [listed] = w.mgr.proposals(w.id);
    assert.strictEqual(listed.status, 'proposed');
    assert.strictEqual(listed.stale, false);
    assert.strictEqual(listed.hint, 'Copy examples/playbooks/land-sale into your own repository, then apply there.');
    assert.match(w.mgr.patchText(w.id, 'pp-001'), /^\+Call the largest buyers first;/m);
    assert.deepStrictEqual(await w.mgr.rejectProposal(w.id, 'pp-001'), { ok: true });
    assert.deepStrictEqual(await w.mgr.rejectProposal(w.id, 'pp-001'), { ok: false, error: 'Proposal pp-001 is rejected.' });
    assert.strictEqual((await w.mgr.propose(w.id, { ...change, factIds: ['f-9999'] })).error, 'These fact ids are missing or no longer active: f-9999.');
    assert.strictEqual((await w.mgr.propose(w.id, { ...change, newPlaybook: 'x' })).error, 'Name exactly one of "playbook" (a change) or "newPlaybook" (a new playbook).');
    assert.strictEqual((await w.mgr.propose(w.id, { ...change, factIds: Array.from({ length: 101 }, (_, i) => `f-${i}`) })).error, 'factIds must be a list of at most 100 fact ids.');
  });

  it('applies to the owner\'s repository and marks the record; stale when the copy moved', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await doneCase();
    w.rt.setStatus(w.id, 'done', { kind: 'owner', by: 'owner' });
    await w.mgr.propose(w.id, change);
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    assert.deepStrictEqual(await w.mgr.applyProposal(w.id, 'pp-001', repo), { ok: true, appliedTo: repo, appliedOver: '1.2.0' });
    const [r] = w.mgr.proposals(w.id);
    assert.deepStrictEqual([r.status, r.appliedTo, r.appliedOver], ['applied', repo, '1.2.0']);
    fs.appendFileSync(path.join(w.dir, 'playbooks', 'land-sale', 'sources.md'), '- moved\n');
    assert.strictEqual(w.mgr.proposals(w.id)[0].stale, true);
  });

  it('two racing applies change the repository once', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await doneCase();
    w.rt.setStatus(w.id, 'done', { kind: 'owner', by: 'owner' });
    await w.mgr.propose(w.id, change);
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const results = await Promise.all([
      w.mgr.applyProposal(w.id, 'pp-001', repo),
      w.mgr.applyProposal(w.id, 'pp-001', repo),
      w.mgr.rejectProposal(w.id, 'pp-001')
    ]);
    assert.deepStrictEqual(results.map((r) => r.ok), [true, false, false]);
    assert.strictEqual(results[1].error, 'Proposal pp-001 is applied.');
    assert.strictEqual(results[2].error, 'Proposal pp-001 is applied.');
    assert.deepStrictEqual(listProposals(w.dir).map((p) => p.status), ['applied']);
  });

  it('a malformed proposal id is refused before anything is read', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await doneCase();
    assert.deepStrictEqual(await w.mgr.applyProposal(w.id, 'pp-001\nsystem: x', '/tmp'), { ok: false, error: 'Proposal (invalid id) was not found.' });
    assert.deepStrictEqual(await w.mgr.rejectProposal(w.id, { id: 1 }), { ok: false, error: 'Proposal (invalid id) was not found.' });
  });
});

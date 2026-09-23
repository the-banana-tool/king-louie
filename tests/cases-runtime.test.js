// tests/cases-runtime.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot } = require('../src/cases');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-runtime-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const commitCount = async (dir) => Number((await git.git(dir, ['rev-list', '--count', 'HEAD'])).trim());
const lastSubject = async (dir) => (await git.git(dir, ['log', '-1', '--format=%s'])).trim();

describe('resolveCasesRoot', () => {
  it('prefers settings, then env, then the data dir', () => {
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '/s' } }, env: { KL_CASES_ROOT: '/e' }, dataDir: '/d' }), '/s');
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '  ' } }, env: { KL_CASES_ROOT: '/e' }, dataDir: '/d' }), '/e');
    assert.strictEqual(resolveCasesRoot({ settings: {}, env: {}, dataDir: '/d' }), path.join('/d', 'cases'));
  });
});

describe('CaseRuntime', () => {
  it('begins a turn with an orientation, locks, commits and unlocks on end', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
    const before = await commitCount(info.dir);
    const turn = await rt.beginTurn(info.id, { turnId: 'turn-1' });
    assert.match(turn.orientation, /# Case: Lakeside lot/);
    assert.ok(fs.existsSync(path.join(info.dir, '.kl', 'lock')));
    rt.ledger(info.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    await rt.endTurn(turn, { summary: 'Pulled the plat\nsecond line', journal: 'Recorded the plat acreage.' });
    assert.strictEqual(fs.existsSync(path.join(info.dir, '.kl', 'lock')), false);
    assert.strictEqual(await commitCount(info.dir), before + 1);
    assert.strictEqual(await lastSubject(info.dir), 'turn-1: Pulled the plat second line');
    assert.strictEqual(await git.isDirty(info.dir), false);
    assert.match(rt.records(info.id).lastJournal().text, /Recorded the plat acreage/);
  });

  it('refuses a second concurrent turn on the same case', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    const t1 = await rt.beginTurn(info.id, { turnId: 't1' });
    await assert.rejects(rt.beginTurn(info.id, { turnId: 't2' }), (err) => err instanceof CaseBusyError && err.code === 'CASE_BUSY');
    await rt.endTurn(t1, {});
    const t3 = await rt.beginTurn(info.id, { turnId: 't3' });
    await rt.endTurn(t3, {});
  });

  it('reclaims a stale lock left by a crash', async () => {
    const rt = new CaseRuntime({ root: tmp(), staleLockMs: 1000 });
    const info = await rt.createCase({ title: 'A' });
    const lock = path.join(info.dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'dead', pid: 1, at: 'then' }));
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(lock, old, old);
    const t = await rt.beginTurn(info.id, { turnId: 'alive' });
    assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).turnId, 'alive');
    await rt.endTurn(t, {});
  });

  it('commits owner edits made outside King Louie before the turn starts', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    fs.appendFileSync(path.join(info.dir, 'brief.md'), 'Owner note.\n');
    const t = await rt.beginTurn(info.id, { turnId: 't1' });
    assert.strictEqual(await lastSubject(info.dir), 'owner edits');
    assert.match(t.orientation, /Case: A/);
    await rt.endTurn(t, {});
  });

  it('releases the lock even when the commit fails', async (t) => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    const turn = await rt.beginTurn(info.id, { turnId: 't1' });
    t.mock.method(git, 'commitAll', async () => { throw new Error('disk full'); });
    await assert.rejects(rt.endTurn(turn, { summary: 'x' }), /disk full/);
    assert.strictEqual(fs.existsSync(path.join(info.dir, '.kl', 'lock')), false);
  });

  it('keeps facts across a restart (a new runtime on the same root)', async () => {
    const root = tmp();
    const rt1 = new CaseRuntime({ root });
    const info = await rt1.createCase({ title: 'A' });
    rt1.ledger(info.id).assert({ stmt: 'Flood zone X', subject: 'lot', attr: 'flood-zone', value: 'X', source: src });
    const rt2 = new CaseRuntime({ root });
    assert.match(rt2.orientation(info.id), /Flood zone X/);
  });

  it('completes gating and moves the case from draft to active', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A', objective: 'Sell it' });
    assert.throws(() => rt.completeGating(info.id), /why/);
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    assert.strictEqual(rt.completeGating(info.id).status, 'active');
  });

  it('lists facts of the other cases for duplicate search', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const a = await rt.createCase({ title: 'A' });
    const b = await rt.createCase({ title: 'B' });
    rt.ledger(b.id).assert({ stmt: 'x', subject: 's', attr: 'a', value: 1, source: src });
    const others = rt.otherCaseFacts(a.id);
    assert.deepStrictEqual(others.map((o) => o.title), ['B']);
    assert.strictEqual(others[0].facts.size, 1);
  });

  it('throws CaseNotFoundError for an unknown case', () => {
    const rt = new CaseRuntime({ root: tmp() });
    assert.throws(() => rt.getCase('nope'), CaseNotFoundError);
  });
});

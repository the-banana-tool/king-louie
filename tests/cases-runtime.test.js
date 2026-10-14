// tests/cases-runtime.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot } = require('../src/cases');
const { confirmAll } = require('./helpers/case-scope');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-runtime-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const commitCount = async (dir) => Number((await git.git(dir, ['rev-list', '--count', 'HEAD'])).trim());
const lastSubject = async (dir) => (await git.git(dir, ['log', '-1', '--format=%s'])).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeLock = (dir, holder) => fs.writeFileSync(path.join(dir, '.kl', 'lock'), JSON.stringify({ at: new Date().toISOString(), ...holder }));
const deadPid = () => {
  const { spawnSync } = require('child_process');
  return spawnSync(process.execPath, ['-e', '0']).pid;
};

describe('resolveCasesRoot', () => {
  it('prefers settings, then env, then the data dir', () => {
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '/s' } }, env: { KL_CASES_ROOT: '/e' }, dataDir: '/d' }), '/s');
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '  ' } }, env: { KL_CASES_ROOT: '/e' }, dataDir: '/d' }), '/e');
    assert.strictEqual(resolveCasesRoot({ settings: {}, env: {}, dataDir: '/d' }), path.join('/d', 'cases'));
  });

  it('expands a leading ~ and resolves a relative settings root against the data dir', () => {
    const dataDir = path.resolve(tmp());
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '~/cases' } }, env: {}, dataDir }), path.join(os.homedir(), 'cases'));
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: '~' } }, env: {}, dataDir }), os.homedir());
    // The platform separator: a backslash on Windows.
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: path.join('~', 'cases') } }, env: {}, dataDir }), path.join(os.homedir(), 'cases'));
    assert.strictEqual(resolveCasesRoot({ settings: { cases: { root: 'my-cases' } }, env: {}, dataDir }), path.join(dataDir, 'my-cases'));
    assert.strictEqual(resolveCasesRoot({ settings: {}, env: { KL_CASES_ROOT: '~/elsewhere' }, dataDir }), path.join(os.homedir(), 'elsewhere'));
    assert.strictEqual(resolveCasesRoot({ settings: {}, env: { KL_CASES_ROOT: 'rel' }, dataDir }), 'rel');
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

  it('reclaims a fresh lock whose process is gone', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    writeLock(info.dir, { turnId: 'crashed', pid: deadPid() });
    const t = await rt.beginTurn(info.id, { turnId: 'alive' });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(info.dir, '.kl', 'lock'), 'utf8')).turnId, 'alive');
    await rt.endTurn(t, {});
  });

  it('reclaims a lock with this process id and a turn this runtime is not holding', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    writeLock(info.dir, { turnId: 'before-restart', pid: process.pid });
    const t = await rt.beginTurn(info.id, { turnId: 'alive' });
    await rt.endTurn(t, {});
  });

  it('stays busy while another live process holds the lock, and says how to recover', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    writeLock(info.dir, { turnId: 'other', pid: process.ppid });
    await assert.rejects(rt.beginTurn(info.id, { turnId: 't' }), (err) => (
      err.code === 'CASE_BUSY' && err.message.includes(String(process.ppid)) && /delete/i.test(err.message)
    ));
  });

  it('a same-process, non-wake-up holder gets "busy with another turn in this app", never quit-or-delete advice (F6 re-review)', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    const t1 = await rt.beginTurn(info.id, { turnId: 't1', source: 'owner' });
    await assert.rejects(rt.beginTurn(info.id, { turnId: 't2', source: 'owner' }), (err) => (
      err instanceof CaseBusyError && err.code === 'CASE_BUSY'
      && err.message === 'Case is busy with another turn in this app; try again in a moment.'
      && !/quit|delete/i.test(err.message)
    ));
    await rt.endTurn(t1, {});
  });

  it('a wake-up beginTurn that finds another in-process wake-up holding the lock gets the spec §9 text, never quit-or-delete advice (F6 re-review)', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A' });
    const w1 = await rt.beginTurn(info.id, { turnId: 'w1', source: 'wakeup' });
    await assert.rejects(rt.beginTurn(info.id, { turnId: 'w2', source: 'wakeup' }), (err) => (
      err instanceof CaseBusyError && err.code === 'CASE_BUSY'
      && err.message === 'Case is busy with a wake-up; try again in a minute.'
      && !/quit|delete/i.test(err.message)
    ));
    await rt.endTurn(w1, {});
  });

  it('an owner turn preempts an in-process wake-up: it aborts it, waits, and proceeds (F6)', async () => {
    // The wait ends as soon as the aborted wake-up's endTurn (a git commit)
    // releases the lock; the bound only has to outlast a slow CI runner.
    const rt = new CaseRuntime({ root: tmp(), wakeupPreemptTimeoutMs: 30000 });
    const info = await rt.createCase({ title: 'Lot' });
    const wake = await rt.beginTurn(info.id, { turnId: 'wakeup-1', source: 'wakeup' });
    // Stands in for turn-runner.js noticing the abort and ending the turn,
    // which is what actually releases the lock in the real wake-up path.
    wake.signal.addEventListener('abort', () => {
      rt.endTurn(wake, { summary: 'aborted' }).catch(() => {});
    });
    const owner = await rt.beginTurn(info.id, { turnId: 'owner-1', source: 'owner' });
    assert.strictEqual(wake.signal.aborted, true, 'the wake-up turn was aborted so the owner could proceed');
    await rt.endTurn(owner, {});
  });

  it('an owner turn does not preempt another in-process owner turn (unaffected by F6)', async () => {
    const rt = new CaseRuntime({ root: tmp(), wakeupPreemptTimeoutMs: 50 });
    const info = await rt.createCase({ title: 'A' });
    const t1 = await rt.beginTurn(info.id, { turnId: 't1', source: 'owner' });
    await assert.rejects(rt.beginTurn(info.id, { turnId: 't2', source: 'owner' }), (err) => (
      err instanceof CaseBusyError && err.code === 'CASE_BUSY' && !/wake-up/i.test(err.message)
    ));
    await rt.endTurn(t1, {});
  });

  it('an owner turn refused after a bounded wait gets the wake-up busy message, not "quit it or delete" (F6)', async () => {
    const rt = new CaseRuntime({ root: tmp(), wakeupPreemptTimeoutMs: 80 });
    const info = await rt.createCase({ title: 'Lot' });
    const wake = await rt.beginTurn(info.id, { turnId: 'wakeup-1', source: 'wakeup' });
    // No listener releases the lock: the wake-up never notices the abort in time.
    await assert.rejects(rt.beginTurn(info.id, { turnId: 'owner-1', source: 'owner' }), (err) => (
      err.code === 'CASE_BUSY' && err.message === 'Case is busy with a wake-up; try again in a minute.'
    ));
    await rt.endTurn(wake, {});
  });

  it('releaseAll removes every lock the runtime holds', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const a = await rt.createCase({ title: 'A' });
    const b = await rt.createCase({ title: 'B' });
    await rt.beginTurn(a.id, { turnId: 'ta' });
    await rt.beginTurn(b.id, { turnId: 'tb' });
    rt.releaseAll();
    assert.strictEqual(fs.existsSync(path.join(a.dir, '.kl', 'lock')), false);
    assert.strictEqual(fs.existsSync(path.join(b.dir, '.kl', 'lock')), false);
    const t = await rt.beginTurn(a.id, { turnId: 'again' });
    await rt.endTurn(t, {});
  });

  it('refreshes a held lock so a long turn does not go stale', async () => {
    const rt = new CaseRuntime({ root: tmp(), staleLockMs: 300 });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const t1 = await rt.beginTurn(info.id, { turnId: 'long' });
    await sleep(700);
    const age = Date.now() - fs.statSync(path.join(info.dir, '.kl', 'lock')).mtimeMs;
    assert.ok(age < 300, `lock is ${age}ms old`);
    await assert.rejects(rt.beginTurn(info.id, { turnId: 'second' }), CaseBusyError);
    await rt.endTurn(t1, {});
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
    // Cases stage 8 (R-C8-2): the model's criterion is a proposal.
    assert.throws(() => rt.completeGating(info.id), /successCriteria/);
    confirmAll(rt, info.id);
    assert.strictEqual(rt.completeGating(info.id).status, 'active');
  });

  it('endTurn commits when updating the case index throws', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const a = await rt.createCase({ title: 'A' });
    const turn = await rt.beginTurn(a.id, { turnId: 'turn-1' });
    rt.ledger(a.id).assert({ stmt: 'x', subject: 's', attr: 'a', value: 1, source: src });
    rt.index.upsertCase = () => { throw new Error('index disk full'); };
    await rt.endTurn(turn, { summary: 'recorded x' });
    const git = require('../src/cases/git');
    assert.strictEqual(await git.isDirty(a.dir), false);
    assert.strictEqual(rt.turns.has(a.id), false);
  });

  it('throws CaseNotFoundError for an unknown case', () => {
    const rt = new CaseRuntime({ root: tmp() });
    assert.throws(() => rt.getCase('nope'), CaseNotFoundError);
  });
});

// Cases stage 8 (spec §6.1, §10): the scope record beside the brief.
describe('CaseRuntime scope', () => {
  const scopeFile = (dir) => path.join(dir, '.kl', 'scope.json');
  // Every file of the case outside .git, with a hash of its bytes.
  const snapshot = (dir) => {
    const out = {};
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.name === '.git') continue;
        if (e.isDirectory()) walk(next);
        else out[next] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, next))).digest('hex');
      }
    };
    walk('');
    return out;
  };
  // A case as stage 7 left it: criteria in brief.md, no scope record.
  const legacyCase = async (rt) => {
    const info = await rt.createCase({ title: 'Lakeside lot' });
    const brief = rt.brief(info.id);
    brief.update('objective', 'Sell the Lakeside lot', { provenance: 'model' });
    brief.update('successCriteria', ['Signed contract at or above the floor', 'Closed within 90 days'], { provenance: 'model' });
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-0' }), { summary: 'setup' });
    fs.rmSync(scopeFile(info.dir), { force: true });
    return info;
  };
  const journals = (dir, kind) => fs.readdirSync(path.join(dir, 'journal')).filter((n) => n.includes(`-${kind}`));

  it('a case created before this stage reads unchanged', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await legacyCase(rt);
    const before = snapshot(info.dir);
    const view = rt.scopeView(info.id);
    assert.deepStrictEqual(view.criteria.map((r) => [r.id, r.state, r.origin, r.provisional]), [['sc-001', 'proposed', 'legacy', true], ['sc-002', 'proposed', 'legacy', true]]);
    assert.deepStrictEqual([view.objective.state, view.objective.origin], ['proposed', 'legacy']);
    rt.orientation(info.id);
    assert.deepStrictEqual(snapshot(info.dir), before);

    const turn = await rt.beginTurn(info.id, { turnId: 'turn-1' });
    const during = snapshot(info.dir);
    assert.deepStrictEqual(Object.keys(during).filter((f) => !(f in before)).sort(), ['.kl/lock', '.kl/scope.json']);
    assert.strictEqual(during['brief.md'], before['brief.md']);
    assert.strictEqual(during['case.yaml'], before['case.yaml']);
    const stored = JSON.parse(fs.readFileSync(scopeFile(info.dir), 'utf8'));
    assert.deepStrictEqual(stored.criteria.map((e) => [e.id, e.state, e.origin]), [['sc-001', 'proposed', 'legacy'], ['sc-002', 'proposed', 'legacy']]);
    assert.deepStrictEqual([stored.objective.state, stored.objective.origin], ['proposed', 'legacy']);
    await rt.endTurn(turn, { summary: 'first turn of this stage' });
    assert.strictEqual(await git.isDirty(info.dir), false);
  });

  it('a done case never gets the file', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await legacyCase(rt);
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(info.id).completeGating();
    rt.setStatus(info.id, 'active', { kind: 'gating' });
    rt.setStatus(info.id, 'done', { kind: 'owner', by: 'owner' });
    const before = snapshot(info.dir);
    assert.strictEqual(rt.scopeView(info.id).criteria.length, 2);
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'add', text: 'Three written offers', by: 'owner-action' }), (err) => err.code === 'CASE_CLOSED');
    assert.deepStrictEqual(snapshot(info.dir), before);
  });

  it('an owner edit to brief.md is proposed until pressed', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await legacyCase(rt);
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-1' }), { summary: 'migrated' });
    const brief = rt.brief(info.id);
    const { data, body } = brief.read();
    data.successCriteria.push('Buyer pays the closing costs');
    brief._write(data, body);
    const turn = await rt.beginTurn(info.id, { turnId: 'turn-2' });
    const row = rt.scopeView(info.id).criteria[2];
    assert.deepStrictEqual([row.id, row.state, row.origin, row.provisional], ['sc-003', 'proposed', 'file', false]);
    await rt.endTurn(turn, { summary: 'saw the edit' });
    const view = await rt.applyScopeAction(info.id, { action: 'confirm', target: 'sc-003', hash: row.hash, by: 'owner-action', channel: 'in-app' });
    assert.deepStrictEqual([view.criteria[2].state, view.criteria[2].origin, view.criteria[2].confirmed.by, view.criteria[2].confirmed.channel], ['confirmed', 'file', 'owner-action', 'in-app']);
    assert.strictEqual(await git.isDirty(info.dir), false);
  });

  it('applyScopeAction: a stale hash refuses, drop removes the words, edit and add are the owner\'s, all-proposed confirms the rest', async () => {
    const events = [];
    const rt = new CaseRuntime({ root: tmp(), host: { notify: (event, payload) => events.push([event, payload]) } });
    const info = await legacyCase(rt);
    const first = rt.scopeView(info.id);
    const [a, b] = first.criteria;
    const stale = 'sha256:' + '0'.repeat(64);
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'confirm', target: a.id, hash: stale, by: 'owner-action' }), (err) => err.code === 'SCOPE_STALE');
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'confirm', target: a.id, by: 'owner-action' }), (err) => err.code === 'SCOPE_STALE');
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'drop', target: b.id, hash: stale, by: 'owner-action' }), (err) => err.code === 'SCOPE_STALE');
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'confirm', target: 'sc-099', hash: stale, by: 'owner-action' }), (err) => err.code === 'CRITERION_NOT_FOUND');
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'confirm', target: a.id, hash: a.hash }), (err) => err.code === 'SCOPE_INVALID');
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'promote', target: a.id, hash: a.hash, by: 'owner-action' }), (err) => err.code === 'SCOPE_INVALID');
    assert.deepStrictEqual(rt.scopeView(info.id).criteria.map((r) => r.state), ['proposed', 'proposed']);
    assert.deepStrictEqual(journals(info.dir, 'scope'), []);
    events.length = 0;

    // confirm one
    let view = await rt.applyScopeAction(info.id, { action: 'confirm', target: a.id, hash: a.hash, by: 'owner-action', channel: 'in-app' });
    assert.deepStrictEqual(view.criteria.map((r) => [r.id, r.state]), [['sc-001', 'confirmed'], ['sc-002', 'proposed']]);
    assert.strictEqual(journals(info.dir, 'scope').length, 1);
    assert.deepStrictEqual(events.filter(([e, p]) => e === 'case:changed' && p.what === 'progress').map(([, p]) => p.caseId), [info.id]);

    // drop the other: the words leave brief.md and are kept in `removed`
    view = await rt.applyScopeAction(info.id, { action: 'drop', target: b.id, hash: b.hash, by: 'owner-action' });
    assert.deepStrictEqual(rt.brief(info.id).read().data.successCriteria, ['Signed contract at or above the floor']);
    assert.deepStrictEqual(view.removed.map((r) => [r.id, r.text, r.by]), [['sc-002', 'Closed within 90 days', 'owner-action']]);

    // edit a confirmed criterion: new words, still confirmed, the owner's
    view = await rt.applyScopeAction(info.id, { action: 'edit', target: a.id, hash: a.hash, text: 'Signed contract at 40,000 dollars or more', by: 'owner-action', channel: 'in-app' });
    assert.deepStrictEqual(rt.brief(info.id).read().data.successCriteria, ['Signed contract at 40,000 dollars or more']);
    assert.deepStrictEqual(view.criteria.map((r) => [r.id, r.state, r.origin, r.confirmed.by]), [['sc-003', 'confirmed', 'owner-action', 'owner-action']]);
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'edit', target: 'sc-003', text: 'two\nlines', by: 'owner-action' }), (err) => err.code === 'CRITERION_INVALID');

    // add: confirmed at birth; a duplicate refuses
    view = await rt.applyScopeAction(info.id, { action: 'add', text: 'Closed before the new year', by: 'owner-action' });
    assert.deepStrictEqual(view.criteria.map((r) => [r.id, r.state, r.origin]), [['sc-003', 'confirmed', 'owner-action'], ['sc-004', 'confirmed', 'owner-action']]);
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'add', text: 'CLOSED before the new year', by: 'owner-action' }), (err) => err.code === 'CRITERION_DUPLICATE');

    // all-proposed: every proposed row whose words the owner saw, and the
    // objective when its hash came too; confirmed rows are left alone.
    rt.brief(info.id).append('successCriteria', 'Three written offers', { provenance: 'model' });
    rt.brief(info.id).append('successCriteria', 'Survey on file', { provenance: 'model' });
    const shown = rt.scopeView(info.id);
    const proposed = shown.criteria.filter((r) => r.state === 'proposed');
    assert.strictEqual(proposed.length, 2);
    await assert.rejects(rt.applyScopeAction(info.id, { action: 'confirm', target: 'all-proposed', hash: { [proposed[0].id]: proposed[0].hash }, by: 'owner-action' }), (err) => err.code === 'SCOPE_STALE');
    assert.strictEqual(rt.scopeView(info.id).criteria.filter((r) => r.state === 'proposed').length, 2);
    const at003 = shown.criteria[0].confirmed.at;
    view = await rt.applyScopeAction(info.id, {
      action: 'confirm', target: 'all-proposed', by: 'owner-action', channel: 'in-app',
      hash: { ...Object.fromEntries(proposed.map((r) => [r.id, r.hash])), objective: shown.objective.hash }
    });
    assert.deepStrictEqual(view.criteria.map((r) => r.state), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
    assert.strictEqual(view.criteria[0].confirmed.at, at003);
    assert.deepStrictEqual([view.objective.state, view.objective.origin], ['confirmed', 'legacy']);
    assert.strictEqual(await git.isDirty(info.dir), false);
    assert.strictEqual(fs.existsSync(path.join(info.dir, '.kl', 'lock')), false);
  });

  it('applyScopeAction inside a turn runs inline and the turn commits it', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await legacyCase(rt);
    const turn = await rt.beginTurn(info.id, { turnId: 'turn-1' });
    const row = rt.scopeView(info.id).criteria[0];
    await rt.applyScopeAction(info.id, { action: 'confirm', target: row.id, hash: row.hash, by: 'question', channel: 'in-app-chat', quote: 'confirm all of those', factId: 'f-0001' });
    const stored = rt.scopeView(info.id).criteria[0];
    assert.deepStrictEqual([stored.state, stored.confirmed.by, stored.confirmed.channel, stored.confirmed.quote, stored.confirmed.factId], ['confirmed', 'question', 'in-app-chat', 'confirm all of those', 'f-0001']);
    assert.ok(fs.existsSync(path.join(info.dir, '.kl', 'lock')));
    await rt.endTurn(turn, { summary: 'confirmed one' });
    assert.strictEqual(await git.isDirty(info.dir), false);
  });

  it('writeScope records the origin of what it writes, and confirms only with a confirming origin', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    await rt.systemAction(info.id, 'test', async () => {
      rt.writeScope(info.id, { field: 'successCriteria', value: ['Three written offers'], origin: 'model', addedBy: 'turn-9' });
      rt.writeScope(info.id, {
        field: 'successCriteria', value: ['Three written offers', 'Closed within 90 days'], origin: 'owner-quote',
        confirmed: { by: 'owner-quote', channel: 'in-app-chat', quote: 'closed within 90 days' }, addedBy: 'turn-9'
      });
      assert.throws(() => rt.writeScope(info.id, { field: 'successCriteria', value: ['Three written offers', 'Closed within 90 days', 'Survey on file'], origin: 'model', confirmed: { by: 'model' } }), (err) => err.code === 'SCOPE_INVALID');
      assert.throws(() => rt.writeScope(info.id, { field: 'successCriteria', value: ['Three written offers', 'three written  offers'], origin: 'model' }), (err) => err.code === 'CRITERION_DUPLICATE');
      assert.throws(() => rt.writeScope(info.id, { field: 'why', value: 'x', origin: 'model' }), (err) => err.code === 'SCOPE_INVALID');
      rt.writeScope(info.id, { field: 'objective', value: 'Sell the Lakeside lot', origin: 'model' });
    });
    const view = rt.scopeView(info.id);
    assert.deepStrictEqual(rt.brief(info.id).read().data.successCriteria, ['Three written offers', 'Closed within 90 days']);
    assert.deepStrictEqual(view.criteria.map((r) => [r.id, r.state, r.origin, r.addedBy]), [['sc-001', 'proposed', 'model', 'turn-9'], ['sc-002', 'confirmed', 'owner-quote', 'turn-9']]);
    assert.deepStrictEqual([view.objective.state, view.objective.origin], ['proposed', 'model']);
    // The 7th proposal is refused, and nothing is written.
    await rt.systemAction(info.id, 'test', async () => {
      const list = rt.brief(info.id).read().data.successCriteria;
      const more = ['Offer one', 'Offer two', 'Offer three', 'Offer four', 'Offer five'];
      rt.writeScope(info.id, { field: 'successCriteria', value: [...list, ...more], origin: 'model' });
      assert.throws(() => rt.writeScope(info.id, { field: 'successCriteria', value: [...list, ...more, 'Offer six'], origin: 'model' }), (err) => err.code === 'CRITERION_LIMIT');
    });
    assert.strictEqual(rt.brief(info.id).read().data.successCriteria.length, 7);
  });

  it('createCase records who gave the objective: the owner confirms it, anything else proposes it', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const owned = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
    const o = rt.scopeView(owned.id).objective;
    assert.deepStrictEqual([o.state, o.origin, o.confirmed.by, o.provisional], ['confirmed', 'owner-create', 'owner-create', false]);
    const modelled = await rt.createCase({ title: 'Permit filing', objective: 'File the county permit' });
    const m = rt.scopeView(modelled.id).objective;
    assert.deepStrictEqual([m.state, m.origin, m.confirmed, m.provisional], ['proposed', 'model', null, false]);
    const claimed = await rt.createCase({ title: 'Fence repair', objective: 'Mend the north fence', objectiveBy: 'model', confirmed: true, state: 'confirmed' });
    assert.strictEqual(rt.scopeView(claimed.id).objective.state, 'proposed');
    const bare = await rt.createCase({ title: 'Roof quotes' });
    assert.strictEqual(rt.scopeView(bare.id).objective, null);
    assert.strictEqual(fs.existsSync(scopeFile(bare.dir)), false);
    for (const c of [owned, modelled, claimed, bare]) assert.strictEqual(await git.isDirty(c.dir), false);
  });

  it('completeGating waits for a criterion the owner confirmed, and never sends an active case back', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'A', objective: 'Sell it' });
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    assert.throws(() => rt.completeGating(info.id), /still missing: successCriteria \(no criterion is confirmed by the owner; ask with Progress askScope\)\./);
    assert.strictEqual(rt.getCase(info.id).status, 'draft');
    const row = rt.scopeView(info.id).criteria[0];
    await rt.applyScopeAction(info.id, { action: 'confirm', target: row.id, hash: row.hash, by: 'owner-action' });
    assert.strictEqual(rt.completeGating(info.id).status, 'active');
    // The owner drops the only criterion: the case stays active and gated.
    await rt.applyScopeAction(info.id, { action: 'drop', target: row.id, hash: row.hash, by: 'owner-action' });
    rt.brief(info.id).append('successCriteria', 'Sold by spring', { provenance: 'model' });
    assert.strictEqual(rt.completeGating(info.id).status, 'active');
    assert.strictEqual(rt.brief(info.id).isGatingComplete(), true);
  });
});

describe('CaseRuntime turn close (cases stage 8)', () => {
  const journals = (dir) => fs.readdirSync(path.join(dir, 'journal')).filter((n) => n.endsWith('.md')).sort().map((n) => fs.readFileSync(path.join(dir, 'journal', n), 'utf8'));

  it('a turn carries the marks taken when it began', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot' });
    rt.ledger(info.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    const turn = await rt.beginTurn(info.id, { turnId: 'turn-1' });
    assert.deepStrictEqual(
      [turn.marks.ledgerLines, turn.marks.decisions, turn.marks.jobRecords, turn.marks.head, turn.marks.dirty],
      [1, 0, 0, null, null]
    );
    await rt.endTurn(turn, { summary: 'read' });
  });

  it('hands evidence and verify to the close step, and only when the caller passed them', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot' });
    const seen = [];
    rt._closeProgress = async (turn, opts) => { seen.push([turn.turnId, opts]); return { block: null }; };
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-1' }), { summary: 'plain' });
    const evidence = { toolResults: [{ tool: 'Ledger', action: 'query', ok: true, text: 'none' }] };
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-2' }), { summary: 'normal', evidence, verify: true });
    assert.deepStrictEqual(seen, [['turn-1', { evidence: null, verify: false }], ['turn-2', { evidence, verify: true }]]);
  });

  it('a close step that throws still commits the turn and releases the lock', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot' });
    const before = await commitCount(info.dir);
    rt._closeProgress = async () => { throw new Error('boom'); };
    const turn = await rt.beginTurn(info.id, { turnId: 'turn-1' });
    rt.ledger(info.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    await rt.endTurn(turn, { summary: 'wrote', journal: 'Recorded the acreage.', verify: true });
    assert.strictEqual(await commitCount(info.dir), before + 1);
    assert.strictEqual(fs.existsSync(path.join(info.dir, '.kl', 'lock')), false);
    assert.strictEqual(rt.runningTurn(info.id), null);
    assert.deepStrictEqual(journals(info.dir), ['Recorded the acreage.\n']);
    assert.strictEqual(await git.isDirty(info.dir), false);
  });

  it('a block the close step returns is the first text of the journal entry, and is written with no other text too', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot' });
    const block = '## Verification (written by King Louie)\n- Now met: sc-001 (f-0001).';
    rt._closeProgress = async () => ({ block });
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-1' }), { summary: 'one', journal: 'The contract is signed.', verify: true });
    assert.deepStrictEqual(journals(info.dir), [`${block}\n\nThe contract is signed.\n`]);
    fs.rmSync(path.join(info.dir, 'journal'), { recursive: true });
    fs.mkdirSync(path.join(info.dir, 'journal'));
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-2' }), { summary: 'two', journal: null, verify: true });
    assert.deepStrictEqual(journals(info.dir), [`${block}\n`]);
    // Anything but a non-empty string is no block.
    rt._closeProgress = async () => ({ block: 42 });
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-3' }), { summary: 'three', journal: null, verify: true });
    assert.strictEqual(journals(info.dir).length, 1);
  });
});

describe('CaseRuntime progress: regressions and the freeze (cases stage 8)', () => {
  // An active case with one confirmed criterion, sc-001.
  async function world(opts = {}) {
    const rt = new CaseRuntime({ root: tmp(), ...opts });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    await rt.applyScopeAction(info.id, { action: 'add', text: 'Signed contract at or above the floor', by: 'owner-action' });
    rt.completeGating(info.id);
    return { rt, id: info.id, dir: info.dir };
  }
  // A sourced fact and a verification record citing it: sc-001 is met.
  function meet(rt, id) {
    const fact = rt.ledger(id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src });
    const row = rt.scopeView(id).criteria.find((r) => r.id === 'sc-001');
    rt.verification(id).addRecord({ criterion: 'sc-001', criterionHash: row.hash, evidence: [fact.id], note: 'Signed.', turnId: 'turn-0', model: 'example-provider:example-model' });
    return fact;
  }
  const regressed = (turn) => turn.triggers.filter((t) => t.kind === 'criterion-regressed');
  const cache = (rt, id) => rt.verification(id).read().cache;

  it('a criterion that left met between turns asks for re-orientation, once', async () => {
    const { rt, id } = await world();
    const fact = meet(rt, id);
    let turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    assert.deepStrictEqual(regressed(turn), []);
    assert.deepStrictEqual(cache(rt, id).states, { 'sc-001': 'met' });
    await rt.endTurn(turn, { summary: 'read' });

    // Corrected outside a turn (an answered question, an ingest review).
    const newer = rt.ledger(id).assert({ stmt: 'The contract was not signed after all', subject: 'contract', attr: 'signed', value: 0, source: src, supersedes: fact.id });
    turn = await rt.beginTurn(id, { turnId: 'turn-2' });
    const detail = `sc-001 ("Signed contract at or above the floor") was met and is now stale: ${fact.id} was superseded by ${newer.id}.`;
    assert.deepStrictEqual(regressed(turn), [{ kind: 'criterion-regressed', key: 'criterion:sc-001:v-0001:stale', blocking: true, detail }]);
    assert.strictEqual(turn.reorientPending, true);
    assert.match(turn.orientation, /## Since last turn\n(- .*\n)*- sc-001 was met and is now stale: f-0001 was superseded by f-0002\.\n/);
    assert.match(rt.requireReoriented(id).error, /Re-orientation is required first: sc-001 \("Signed contract at or above the floor"\) was met and is now stale/);
    assert.deepStrictEqual(cache(rt, id).states, { 'sc-001': 'stale' });

    rt.recordReorientation(id, turn, { changed: 'The contract fell through', affects: [], action: 'Look for another buyer', note: 'sc-001 is open again' });
    assert.strictEqual(turn.reorientPending, false);
    assert.strictEqual(rt.requireReoriented(id), null);
    await rt.endTurn(turn, { summary: 're-oriented' });

    turn = await rt.beginTurn(id, { turnId: 'turn-3' });
    assert.deepStrictEqual(regressed(turn), []);
    assert.strictEqual(turn.reorientPending, false);
    assert.doesNotMatch(turn.orientation, /- sc-001 was met and is now stale/);
    await rt.endTurn(turn, { summary: 'read' });
    assert.strictEqual(await git.isDirty(rt.getCase(id).dir), false);
  });

  it('a wake-up turn is told too, and the text of a criterion in the trigger is one cut line', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    const long = `Signed contract at or above the floor ${'and every page initialled '.repeat(6)}`.trim();
    await rt.applyScopeAction(info.id, { action: 'add', text: long, by: 'owner-action' });
    rt.completeGating(info.id);
    const fact = meet(rt, info.id);
    await rt.endTurn(await rt.beginTurn(info.id, { turnId: 'turn-1' }), { summary: 'read' });
    rt.ledger(info.id).retract(fact.id, 'wrong lot');
    const turn = await rt.beginTurn(info.id, { turnId: 'wakeup-1', source: 'wakeup' });
    const [t] = regressed(turn);
    assert.strictEqual(t.detail, `sc-001 ("${long.slice(0, 80)}") was met and is now stale: ${fact.id} was retracted.`);
    assert.strictEqual(turn.reorientPending, true);
    await rt.endTurn(turn, { summary: 'wake-up' });
  });

  it('a hook that cannot read the record never fails the turn', async () => {
    const { rt, id, dir } = await world();
    meet(rt, id);
    fs.writeFileSync(path.join(dir, '.kl', 'verification.json'), '{ not json');
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    assert.deepStrictEqual(regressed(turn), []);
    await rt.endTurn(turn, { summary: 'read' });
    // A draft case with nothing confirmed gets no file from the hook.
    const plain = await rt.createCase({ title: 'Roof quotes', objective: 'Get three roof quotes' });
    await rt.endTurn(await rt.beginTurn(plain.id, { turnId: 'turn-1' }), { summary: 'read' });
    assert.strictEqual(fs.existsSync(path.join(plain.dir, '.kl', 'verification.json')), false);
  });

  it('the close of a verified turn writes the cache; a close that is not verified leaves it for the next turn to notice', async () => {
    const { rt, id } = await world();
    const fact = meet(rt, id);
    let turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    // The turn itself corrects the fact, and is stopped: no verify, no block.
    rt.ledger(id).assert({ stmt: 'The contract was not signed after all', subject: 'contract', attr: 'signed', value: 0, source: src, supersedes: fact.id, addedBy: 'turn-1' });
    await rt.endTurn(turn, { summary: 'turn stopped by owner', journal: null });
    assert.deepStrictEqual(cache(rt, id).states, { 'sc-001': 'met' });
    turn = await rt.beginTurn(id, { turnId: 'turn-2' });
    assert.deepStrictEqual(regressed(turn).map((t) => t.key), ['criterion:sc-001:v-0001:stale']);
    await rt.endTurn(turn, { summary: 'read' });

    // A verified close: the entry says it first, and the cache follows.
    const other = await world();
    const cited = meet(other.rt, other.id);
    turn = await other.rt.beginTurn(other.id, { turnId: 'turn-1' });
    other.rt.ledger(other.id).retract(cited.id, 'wrong lot');
    await other.rt.endTurn(turn, { summary: 'retracted', journal: 'Retracted the signing.', verify: true });
    assert.deepStrictEqual(cache(other.rt, other.id).states, { 'sc-001': 'stale' });
    assert.match(other.rt.records(other.id).lastJournal().text, /^## Verification \(written by King Louie\)\n- Now stale: sc-001 \(f-0001 was retracted\)\.\n\nRetracted the signing\./);
    turn = await other.rt.beginTurn(other.id, { turnId: 'turn-2' });
    assert.deepStrictEqual(regressed(turn), []);
    await other.rt.endTurn(turn, { summary: 'read' });
    assert.strictEqual(await git.isDirty(other.rt.getCase(other.id).dir), false);
  });

  it('progress is frozen at done and not recomputed', async () => {
    const at = new Date('2026-10-21T09:00:00.000Z');
    const { rt, id, dir } = await world({ now: () => at });
    const fact = meet(rt, id);
    const live = rt.progress(id);
    assert.strictEqual(live.view.criteria[0].state, 'met');
    rt.setStatus(id, 'done', { kind: 'owner', by: 'owner' });
    // The ledger changes after the close, by hand.
    fs.appendFileSync(path.join(dir, 'facts.jsonl'), `${JSON.stringify({ kind: 'retract', target: fact.id, reason: 'edited after the close', at: at.toISOString() })}\n`);
    assert.strictEqual(rt.ledger(id).view().facts.get(fact.id).status, 'retracted');
    const p = rt.progress(id);
    assert.strictEqual(p.closed.frozen, true);
    assert.deepStrictEqual([p.closed.at, p.closed.status, p.closed.summary], [at.toISOString(), 'done', live.summary]);
    assert.deepStrictEqual(p.closed.criteria.map((c) => [c.id, c.state, c.evidence.map((e) => e.id)]), [['sc-001', 'met', [fact.id]]]);
    assert.deepStrictEqual(p.closed.readiness.items.map((i) => [i.id, i.state]), live.readiness.items.map((i) => [i.id, i.state]));
    assert.deepStrictEqual([p.view, p.readiness, p.scope, p.summary], [null, null, null, live.summary]);
    // The frozen record is what the file holds; a turn on the closed case
    // neither recomputes it nor raises a regression.
    const frozen = JSON.stringify(rt.verification(id).read().closed);
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    assert.deepStrictEqual(regressed(turn), []);
    assert.strictEqual(turn.marks.states, null);
    await rt.endTurn(turn, { summary: 'read', verify: true });
    assert.strictEqual(JSON.stringify(rt.verification(id).read().closed), frozen);
    assert.strictEqual(rt.progress(id).closed.criteria[0].state, 'met');
  });

  it('a case set abandoned is frozen too, with what was open', async () => {
    const { rt, id } = await world();
    const live = rt.progress(id);
    rt.setStatus(id, 'abandoned', { kind: 'owner', by: 'owner' });
    const p = rt.progress(id);
    assert.deepStrictEqual([p.closed.frozen, p.closed.status, p.closed.summary], [true, 'abandoned', live.summary]);
    assert.deepStrictEqual(p.closed.criteria.map((c) => c.state), ['unmet']);
    assert.strictEqual(p.closed.readiness.ready, false);
    // A pause is not a close.
    const paused = await world();
    paused.rt.setStatus(paused.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.strictEqual(paused.rt.verification(paused.id).read().closed, null);
    assert.strictEqual(paused.rt.progress(paused.id).closed, null);
  });

  it('a freeze that throws does not stop setStatus', async () => {
    const { rt, id } = await world();
    meet(rt, id);
    const real = rt.verification.bind(rt);
    rt.verification = (caseId) => {
      const store = real(caseId);
      store.freeze = () => { throw new Error('disk full'); };
      return store;
    };
    assert.strictEqual(rt.setStatus(id, 'done', { kind: 'owner', by: 'owner' }).status, 'done');
    assert.strictEqual(rt.getCase(id).status, 'done');
    // Nothing was frozen: the case reads as one closed before progress was tracked.
    assert.strictEqual(rt.progress(id).closed, null);

    // Nor does a progress read that throws.
    const second = await world();
    second.rt.progress = () => { throw new Error('boom'); };
    assert.strictEqual(second.rt.setStatus(second.id, 'abandoned', { kind: 'owner', by: 'owner' }).status, 'abandoned');
  });
});

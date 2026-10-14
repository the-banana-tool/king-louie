// tests/cases-scope.test.js
// Cases stage 8, Task 1: the scope record beside the brief (spec §6.1, §7.1).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addSink } = require('../src/logging');
const {
  ScopeStore, ScopeError, textHash, validateCriterionText, MAX_CRITERIA, MAX_PROPOSED, ORIGINS
} = require('../src/cases/scope');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function caseDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-scope-'));
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.kl'));
  return d;
}
const file = (dir) => path.join(dir, '.kl', 'scope.json');
const clock = (...times) => { let i = 0; return () => new Date(times[Math.min(i++, times.length - 1)]); };
const T1 = '2026-10-20T14:02:11.000Z';
const T2 = '2026-10-21T09:12:03.000Z';
const BRIEF = { objective: 'Sell the Lakeside lot', successCriteria: ['Signed contract', 'Three written quotes'] };
const code = (c) => (err) => err instanceof ScopeError && err.code === c;

function warnings(fn) {
  const lines = [];
  const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
  try { return { value: fn(), lines }; } finally { remove(); }
}

describe('textHash', () => {
  it('folds case, spacing and curly quotes, and nothing else', () => {
    assert.match(textHash('Signed contract'), /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(textHash('Signed  contract'), textHash('signed contract'));
    assert.strictEqual(textHash('The "signed" contract'), textHash('the “signed”  contract'));
    assert.notStrictEqual(textHash('Signed contract'), textHash('Signed contrast'));
  });
});

describe('validateCriterionText', () => {
  it('returns the trimmed text of one plain line of 3 to 300 characters', () => {
    assert.strictEqual(validateCriterionText('  Signed contract '), 'Signed contract');
    assert.strictEqual(validateCriterionText('abc'), 'abc');
    assert.strictEqual(validateCriterionText('x'.repeat(300)).length, 300);
  });

  it('refuses anything else with CRITERION_INVALID', () => {
    for (const bad of ['ab', 'x'.repeat(301), 'Signed\ncontract', 'Signed\tcontract', 'Signed​contract', '', null, 7, ['Signed contract']]) {
      assert.throws(() => validateCriterionText(bad), code('CRITERION_INVALID'), JSON.stringify(bad));
    }
  });
});

describe('ScopeStore.view', () => {
  it('first contact marks every string legacy and proposed', () => {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1) });
    assert.strictEqual(store.read(), null);
    const v = store.view(BRIEF);
    assert.strictEqual(v.migrated, false);
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.text, c.state, c.origin, c.provisional, c.confirmed]), [
      ['sc-001', 'Signed contract', 'proposed', 'legacy', true, null],
      ['sc-002', 'Three written quotes', 'proposed', 'legacy', true, null]
    ]);
    assert.strictEqual(v.criteria[0].hash, textHash('Signed contract'));
    assert.deepStrictEqual(
      { text: v.objective.text, hash: v.objective.hash, state: v.objective.state, origin: v.objective.origin, confirmed: v.objective.confirmed },
      { text: 'Sell the Lakeside lot', hash: textHash('Sell the Lakeside lot'), state: 'proposed', origin: 'legacy', confirmed: null }
    );
    assert.deepStrictEqual(v.removed, []);
    assert.deepStrictEqual(v.duplicates, []);
    assert.strictEqual(fs.existsSync(file(dir)), false, 'a view never writes');
  });

  it('an empty brief has no objective row and no criteria', () => {
    const store = new ScopeStore(caseDir());
    for (const brief of [{}, null, { objective: '  ', successCriteria: 'not a list' }]) {
      const v = store.view(brief);
      assert.strictEqual(v.objective, null);
      assert.deepStrictEqual(v.criteria, []);
    }
  });

  it('the same string twice is one row and one duplicates entry', () => {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1) });
    const brief = { successCriteria: ['Signed contract', 'signed  CONTRACT', 'Three written quotes'] };
    const v = store.view(brief);
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.text]), [['sc-001', 'Signed contract'], ['sc-002', 'Three written quotes']]);
    assert.deepStrictEqual(v.duplicates, [{ text: 'signed  CONTRACT', hash: textHash('Signed contract') }]);
    const w = store.reconcile(brief);
    assert.strictEqual(w.criteria.length, 2);
    assert.strictEqual(w.duplicates.length, 1);
    assert.strictEqual(store.read().criteria.length, 2);
  });
});

describe('ScopeStore.reconcile', () => {
  it('writes the rows of the view once, and the same data changes no byte', () => {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1, T2) });
    const v = store.reconcile(BRIEF);
    assert.strictEqual(v.migrated, true);
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.state, c.origin, c.provisional]), [
      ['sc-001', 'proposed', 'legacy', false], ['sc-002', 'proposed', 'legacy', false]
    ]);
    const onDisk = store.read();
    assert.strictEqual(onDisk.version, 1);
    assert.strictEqual(onDisk.migratedAt, T1);
    assert.strictEqual(onDisk.nextCriterion, 3);
    assert.deepStrictEqual(onDisk.objective, { hash: textHash(BRIEF.objective), state: 'proposed', origin: 'legacy', at: T1, confirmed: null });
    assert.deepStrictEqual(onDisk.criteria[0], { id: 'sc-001', hash: textHash('Signed contract'), state: 'proposed', origin: 'legacy', addedBy: null, at: T1, confirmed: null });
    assert.deepStrictEqual(onDisk.removed, []);
    assert.ok(!JSON.stringify(onDisk).includes('Signed contract'), 'the words of a live criterion are only in brief.md');
    const bytes = fs.readFileSync(file(dir));
    store.reconcile(BRIEF);
    store.reconcile({ objective: ' sell the  lakeside lot', successCriteria: ['signed contract', 'Three written quotes'] });
    assert.ok(bytes.equals(fs.readFileSync(file(dir))));
  });

  it('a string with no entry after migration is file and proposed', () => {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1, T2) });
    store.reconcile(BRIEF);
    const brief = { objective: 'Sell the Lakeside lot by spring', successCriteria: [...BRIEF.successCriteria, 'Closing costs under 2,000 dollars'] };
    const v = store.view(brief);
    assert.strictEqual(v.migrated, true);
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.origin, c.state, c.provisional]), [
      ['sc-001', 'legacy', 'proposed', false], ['sc-002', 'legacy', 'proposed', false], ['sc-003', 'file', 'proposed', true]
    ]);
    assert.deepStrictEqual([v.objective.origin, v.objective.state], ['file', 'proposed']);
    const w = store.reconcile(brief);
    assert.deepStrictEqual([w.criteria[2].id, w.criteria[2].origin, w.criteria[2].provisional], ['sc-003', 'file', false]);
    assert.strictEqual(store.read().objective.origin, 'file');
    assert.strictEqual(store.read().migratedAt, T1, 'migratedAt is set once');
  });

  it('new strings take the origin the caller names', () => {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1) });
    const confirmed = { by: 'owner-quote', channel: 'in-app-chat', at: T2, quote: 'signed contract', factId: null };
    const v = store.reconcile(BRIEF, {
      addedBy: 'turn-7f3a',
      origins: {
        [textHash('Signed contract')]: { origin: 'owner-quote', confirmed },
        [textHash('Three written quotes')]: { origin: 'model', confirmed: null },
        objective: { origin: 'owner-create', confirmed: { by: 'owner-create' } }
      }
    });
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.state, c.origin, c.addedBy]), [
      ['sc-001', 'confirmed', 'owner-quote', 'turn-7f3a'], ['sc-002', 'proposed', 'model', 'turn-7f3a']
    ]);
    assert.deepStrictEqual(v.criteria[0].confirmed, confirmed);
    assert.strictEqual(v.criteria[1].confirmed, null);
    assert.strictEqual(v.objective.state, 'confirmed');
    assert.deepStrictEqual(v.objective.confirmed, { by: 'owner-create', channel: null, at: T1, quote: null, factId: null });
  });

  it('origins never change an entry that already exists', () => {
    const store = new ScopeStore(caseDir(), { now: clock(T1) });
    store.reconcile(BRIEF);
    const v = store.reconcile(BRIEF, { origins: {
      [textHash('Signed contract')]: { origin: 'owner-quote', confirmed: { by: 'owner-quote' } },
      objective: { origin: 'owner-create', confirmed: { by: 'owner-create' } }
    } });
    assert.deepStrictEqual([v.criteria[0].state, v.criteria[0].origin], ['proposed', 'legacy']);
    assert.strictEqual(v.objective.state, 'proposed');
  });

  it('refuses an unknown origin, and a confirmation on an origin that is born proposed', () => {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1) });
    const h = textHash('Signed contract');
    assert.throws(() => store.reconcile(BRIEF, { origins: { [h]: { origin: 'owner', confirmed: null } } }), code('SCOPE_INVALID'));
    for (const origin of ['model', 'detour', 'legacy', 'file']) {
      assert.throws(() => store.reconcile(BRIEF, { origins: { [h]: { origin, confirmed: { by: 'owner-action' } } } }), code('SCOPE_INVALID'), origin);
    }
    assert.throws(() => store.reconcile(BRIEF, { origins: { [h]: { origin: 'owner-quote', confirmed: {} } } }), code('SCOPE_INVALID'), 'a confirmation names who');
    assert.strictEqual(fs.existsSync(file(dir)), false);
  });

  it('a reworded string is a new entry; the old one is removed and its id never reused', () => {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1, T2) });
    const before = store.reconcile(BRIEF);
    const reworded = { ...BRIEF, successCriteria: ['Signed contract', 'Four written quotes'] };
    const v = store.reconcile(reworded, { removedTexts: before, removedBy: 'owner-action' });
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.text]), [['sc-001', 'Signed contract'], ['sc-003', 'Four written quotes']]);
    assert.deepStrictEqual(v.removed, [{ id: 'sc-002', hash: textHash('Three written quotes'), text: 'Three written quotes', state: 'proposed', at: T2, by: 'owner-action' }]);
    assert.strictEqual(store.read().nextCriterion, 4);

    // Everything goes; ids still only grow. No text is known for these.
    const w = store.reconcile({ ...BRIEF, successCriteria: [] });
    assert.deepStrictEqual(w.criteria, []);
    assert.deepStrictEqual(w.removed.map((r) => [r.id, r.text]), [['sc-002', 'Three written quotes'], ['sc-001', ''], ['sc-003', '']]);
    const x = store.reconcile({ ...BRIEF, successCriteria: ['Signed contract'] });
    assert.deepStrictEqual(x.criteria.map((c) => [c.id, c.origin]), [['sc-004', 'file']], 'a string that comes back is a new entry');
    assert.strictEqual(store.read().nextCriterion, 5);
  });

  it('removedTexts may be a plain map by id or by hash', () => {
    const store = new ScopeStore(caseDir(), { now: clock(T1) });
    store.reconcile(BRIEF);
    const v = store.reconcile({ successCriteria: [] }, { removedTexts: { 'sc-001': 'Signed contract', [textHash('Three written quotes')]: 'Three written quotes' } });
    assert.deepStrictEqual(v.removed.map((r) => r.text), ['Signed contract', 'Three written quotes']);
  });

  it('a file that is not a scope record reads as absent with one warning, and is replaced by file entries', () => {
    for (const text of ['not json', '[]', '"scope"', 'null']) {
      const dir = caseDir();
      fs.writeFileSync(file(dir), text);
      const store = new ScopeStore(dir, { now: clock(T1) });
      const { value, lines } = warnings(() => store.read());
      assert.strictEqual(value, null, text);
      assert.strictEqual(lines.length, 1, `${text}: ${lines.join(' | ')}`);
      assert.match(lines[0], /scope\.json/);
      const v = store.view(BRIEF);
      assert.strictEqual(v.migrated, true, 'a corrupt file is not first contact');
      assert.deepStrictEqual(v.criteria.map((c) => c.origin), ['file', 'file']);
      assert.strictEqual(fs.readFileSync(file(dir), 'utf8'), text, 'a view never writes');
      const w = store.reconcile(BRIEF);
      assert.deepStrictEqual(w.criteria.map((c) => [c.id, c.origin, c.state]), [['sc-001', 'file', 'proposed'], ['sc-002', 'file', 'proposed']]);
      assert.strictEqual(w.objective.origin, 'file');
      assert.strictEqual(store.read().migratedAt, T1);
    }
  });

  it('a hand-made entry that is not well formed is not believed', () => {
    const dir = caseDir();
    const h = textHash('Signed contract');
    fs.writeFileSync(file(dir), JSON.stringify({
      version: 1, migratedAt: T1, nextCriterion: 3,
      objective: { hash: textHash(BRIEF.objective), state: 'confirmed', origin: 'owner-create', at: T1, confirmed: null },
      criteria: [
        { id: 'sc-001', hash: h, state: 'confirmed', origin: 'owner-quote', addedBy: null, at: T1, confirmed: null },
        { id: 'two', hash: textHash('Three written quotes'), state: 'confirmed', origin: 'owner-action', at: T1, confirmed: { by: 'owner-action' } }
      ],
      removed: []
    }));
    const v = new ScopeStore(dir).view(BRIEF);
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.state]), [['sc-001', 'proposed'], ['sc-003', 'proposed']]);
    assert.strictEqual(v.objective.state, 'proposed');
  });
});

describe('ScopeStore.confirm', () => {
  function seeded() {
    const dir = caseDir();
    const store = new ScopeStore(dir, { now: clock(T1, T2) });
    store.reconcile(BRIEF);
    return { dir, store, h1: textHash('Signed contract'), h2: textHash('Three written quotes'), ho: textHash(BRIEF.objective) };
  }

  it('refuses a stale hash and changes nothing', () => {
    const { dir, store, h1 } = seeded();
    const bytes = fs.readFileSync(file(dir));
    assert.throws(() => store.confirm(['sc-001'], { hashes: { 'sc-001': textHash('Signed contrast') }, by: 'owner-action' }), code('SCOPE_STALE'));
    assert.throws(() => store.confirm(['sc-001'], { hashes: {}, by: 'owner-action' }), code('SCOPE_STALE'));
    // One good and one stale target: neither is confirmed.
    assert.throws(() => store.confirm(['sc-001', 'sc-002'], { hashes: { 'sc-001': h1, 'sc-002': h1 }, by: 'owner-action' }), code('SCOPE_STALE'));
    assert.ok(bytes.equals(fs.readFileSync(file(dir))));
  });

  it('confirms with the hash the caller saw', () => {
    const { store, h1 } = seeded();
    store.confirm(['sc-001'], { hashes: { 'sc-001': h1 }, by: 'owner-action', channel: 'in-app' });
    const v = store.view(BRIEF);
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.state, c.origin]), [['sc-001', 'confirmed', 'legacy'], ['sc-002', 'proposed', 'legacy']]);
    assert.deepStrictEqual(v.criteria[0].confirmed, { by: 'owner-action', channel: 'in-app', at: T2, quote: null, factId: null });
  });

  it('confirming a confirmed entry is a no-op', () => {
    const { dir, store, h1 } = seeded();
    store.confirm(['sc-001'], { hashes: { 'sc-001': h1 }, by: 'question', channel: 'in-app-chat', quote: 'confirm all three please', factId: 'f-0042' });
    const bytes = fs.readFileSync(file(dir));
    store.confirm(['sc-001'], { hashes: { 'sc-001': h1 }, by: 'owner-action', channel: 'in-app' });
    assert.ok(bytes.equals(fs.readFileSync(file(dir))));
    assert.strictEqual(store.read().criteria[0].confirmed.factId, 'f-0042');
  });

  it('an unknown id, a removed id and a missing objective are CRITERION_NOT_FOUND', () => {
    const { store, h1, h2 } = seeded();
    assert.throws(() => store.confirm(['sc-009'], { hashes: { 'sc-009': h1 }, by: 'owner-action' }), code('CRITERION_NOT_FOUND'));
    assert.throws(() => store.confirm(['nonsense'], { hashes: { nonsense: h1 }, by: 'owner-action' }), code('CRITERION_NOT_FOUND'));
    store.reconcile({ ...BRIEF, successCriteria: ['Signed contract'] });
    assert.throws(() => store.confirm(['sc-002'], { hashes: { 'sc-002': h2 }, by: 'owner-action' }), code('CRITERION_NOT_FOUND'));
    const empty = new ScopeStore(caseDir());
    assert.throws(() => empty.confirm(['objective'], { hashes: { objective: h1 }, by: 'owner-action' }), code('CRITERION_NOT_FOUND'));
    assert.throws(() => empty.confirm(['sc-001'], { hashes: { 'sc-001': h1 }, by: 'owner-action' }), code('CRITERION_NOT_FOUND'));
  });

  it('confirms the objective', () => {
    const { store, ho, h1 } = seeded();
    assert.throws(() => store.confirm(['objective'], { hashes: { objective: h1 }, by: 'owner-action' }), code('SCOPE_STALE'));
    store.confirm(['objective', 'sc-001'], { hashes: { objective: ho, 'sc-001': h1 }, by: 'owner-action', channel: 'in-app' });
    const v = store.view(BRIEF);
    assert.strictEqual(v.objective.state, 'confirmed');
    assert.strictEqual(v.objective.confirmed.by, 'owner-action');
    assert.strictEqual(v.criteria[0].state, 'confirmed');
    // A reworded objective is a new, proposed one.
    assert.strictEqual(store.view({ ...BRIEF, objective: 'Sell both lots' }).objective.state, 'proposed');
  });

  it('needs to know who confirms', () => {
    const { store, h1 } = seeded();
    assert.throws(() => store.confirm(['sc-001'], { hashes: { 'sc-001': h1 } }), code('SCOPE_INVALID'));
    assert.strictEqual(store.view(BRIEF).criteria[0].state, 'proposed');
  });
});

describe('ScopeStore.limitsProblem', () => {
  const rows = (confirmed, proposed) => ({
    criteria: [
      ...Array.from({ length: confirmed }, () => ({ state: 'confirmed' })),
      ...Array.from({ length: proposed }, () => ({ state: 'proposed' }))
    ]
  });

  it('allows 12 criteria and refuses the 13th', () => {
    const store = new ScopeStore(caseDir());
    assert.deepStrictEqual([MAX_CRITERIA, MAX_PROPOSED], [12, 6]);
    assert.strictEqual(store.limitsProblem(rows(12, 0)), null);
    assert.strictEqual(store.limitsProblem(rows(11, 0), { adding: 1 }), null);
    const err = store.limitsProblem(rows(12, 0), { adding: 1 });
    assert.ok(err instanceof ScopeError);
    assert.strictEqual(err.code, 'CRITERION_LIMIT');
    assert.strictEqual(store.limitsProblem(rows(8, 4), { adding: 1, addingProposed: 1 }).code, 'CRITERION_LIMIT');
  });

  it('allows 6 proposed and refuses the 7th', () => {
    const store = new ScopeStore(caseDir());
    assert.strictEqual(store.limitsProblem(rows(0, 6)), null);
    assert.strictEqual(store.limitsProblem(rows(2, 5), { adding: 1, addingProposed: 1 }), null);
    assert.strictEqual(store.limitsProblem(rows(2, 6), { adding: 1 }), null, 'a confirmed one may still be added');
    assert.strictEqual(store.limitsProblem(rows(2, 6), { adding: 1, addingProposed: 1 }).code, 'CRITERION_LIMIT');
    assert.strictEqual(store.limitsProblem(rows(2, 6), { addingProposed: 1 }).code, 'CRITERION_LIMIT');
  });
});

describe('scope origins', () => {
  it('are the eight of the spec', () => {
    assert.deepStrictEqual([...ORIGINS], ['model', 'owner-quote', 'gating-answer', 'detour', 'owner-create', 'owner-action', 'legacy', 'file']);
  });
});

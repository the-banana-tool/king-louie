// tests/cases-runtime-index.test.js
// CaseRuntime's stage-5 core (cases stage 5 spec §3.2, §3.7, §3.8, §6): the
// index and its update points, similar-case refusal, type-aware briefs,
// related links, the case-type snapshot and the settings defaults.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { CaseRuntime, SimilarCaseError } = require('../src/cases');
const { mergeSettings } = require('../src/core/settings');
const { resolveCaseSettings } = require('../src/cases/defaults');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-rt5-')); dirs.push(d); return d; };
const web = { kind: 'url', ref: 'https://records.example.org/1' };
const clock = () => new Date('2026-09-23T15:02:11.000Z');
const newRuntime = () => new CaseRuntime({ root: tmp(), now: clock });

async function activate(rt, id) {
  rt.brief(id).update('why', 'Need it done', { provenance: 'user' });
  rt.brief(id).append('successCriteria', 'Done by year end', { provenance: 'model' });
  return rt.completeGating(id);
}

const indexFile = (rt, id) => path.join(rt.root, '.index', 'cases', `${id}.json`);
const indexedIds = (rt, id) => JSON.parse(fs.readFileSync(indexFile(rt, id), 'utf8')).docs.map((d) => d.id);

describe('stage 5 settings', () => {
  it('adds detours, duplicates and softwareRepo defaults and merges them key by key', () => {
    const merged = mergeSettings({}).cases;
    assert.deepStrictEqual(merged.detours, { classifyOwnerMessages: true, minConfidence: 0.7, classifyTimeoutMs: 4000, recentDays: 30, maxCandidates: 2 });
    assert.deepStrictEqual(merged.duplicates, { createSimilarity: 0.6 });
    assert.deepStrictEqual(merged.softwareRepo, { refreshBudgetMs: 6000 });
    const partial = mergeSettings({ cases: { detours: { minConfidence: 0.9 } } }).cases;
    assert.deepStrictEqual([partial.detours.minConfidence, partial.detours.maxCandidates], [0.9, 2]);
    const fixed = resolveCaseSettings({ detours: { minConfidence: 5, classifyTimeoutMs: -1, classifyOwnerMessages: false }, duplicates: { createSimilarity: 0 }, softwareRepo: { refreshBudgetMs: 'x' } });
    assert.deepStrictEqual([fixed.detours.minConfidence, fixed.detours.classifyTimeoutMs, fixed.detours.classifyOwnerMessages], [0.7, 4000, false]);
    assert.deepStrictEqual([fixed.duplicates.createSimilarity, fixed.softwareRepo.refreshBudgetMs], [0.6, 6000]);
    for (const v of ['false', 0, null, 'no']) {
      assert.strictEqual(resolveCaseSettings({ detours: { classifyOwnerMessages: v } }).detours.classifyOwnerMessages, true, `non-boolean ${JSON.stringify(v)} falls back to the default`);
    }
  });
});

describe('createCase duplicate check', () => {
  it('refuses an open case with the same title or objective, and a close title, unless forced', async () => {
    const rt = newRuntime();
    const lot = await rt.createCase({ title: 'Sell the lakeside lot', objective: 'Convert the lakeside lot to cash' });
    await assert.rejects(rt.createCase({ title: 'sell the lakeside lot.' }), (err) => {
      assert.ok(err instanceof SimilarCaseError);
      assert.strictEqual(err.code, 'SIMILAR_CASES');
      assert.deepStrictEqual(err.similar, [{ caseId: lot.id, title: 'Sell the lakeside lot', status: 'draft', match: 'exact' }]);
      assert.strictEqual(err.message, 'A similar case exists: "Sell the lakeside lot" (draft). Attach this work to it, or create the new case anyway with force.');
      return true;
    });
    await assert.rejects(rt.createCase({ title: 'Cash out', objective: 'convert the lakeside lot to cash' }), (err) => err.similar[0].match === 'exact');
    await assert.rejects(rt.createCase({ title: 'Sell lakeside lot' }), (err) => err.similar[0].match === 'similar');
    const forced = await rt.createCase({ title: 'Sell lakeside lot', force: true });
    assert.strictEqual(forced.title, 'Sell lakeside lot');
    assert.ok(fs.existsSync(indexFile(rt, forced.id)), 'createCase indexes the new case');
    await assert.rejects(rt.createCase({ title: 'Other', type: 'land-sale' }), { message: 'Unknown case type "land-sale". Known types: general, outreach, software-repo.' });
  });

  it('ignores closed cases and matches one-token titles exactly', async () => {
    const rt = newRuntime();
    const old = await rt.createCase({ title: 'Q' });
    await assert.rejects(rt.createCase({ title: 'q' }), (err) => err.code === 'SIMILAR_CASES');
    rt.setStatus(old.id, 'abandoned', { kind: 'owner', by: 'owner' });
    assert.strictEqual((await rt.createCase({ title: 'q' })).title, 'q');
  });
});

describe('index update points', () => {
  it('endTurn, completeGating and answers upsert the case into the index', async () => {
    const rt = newRuntime();
    const c = await rt.createCase({ title: 'Rear door quotes', objective: 'Three written quotes' });
    assert.deepStrictEqual(indexedIds(rt, c.id), ['objective', 'title']);
    const turn = await rt.beginTurn(c.id, { turnId: 'turn-1' });
    rt.ledger(c.id).assert({ stmt: 'Door is 36 inches wide', subject: 'door', attr: 'width', value: 36, source: web });
    await rt.endTurn(turn, { summary: 'measured' });
    assert.ok(indexedIds(rt, c.id).includes('f-0001'));
    await activate(rt, c.id);
    assert.ok(indexedIds(rt, c.id).includes('why'));
    const q = rt.createQuestion(c.id, { kind: 'question', text: 'Which color should the door be?', urgency: 'low' });
    await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'Dark green' });
    const ids = indexedIds(rt, c.id);
    assert.ok(ids.includes(q.id) && ids.includes('f-0002'));
  });
});

describe('type-aware briefs and extras', () => {
  it('completeGating waits for repo on a software-repo case', async () => {
    const rt = newRuntime();
    const c = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    rt.brief(c.id).update('why', 'Calls get dropped', { provenance: 'user' });
    rt.brief(c.id).append('successCriteria', 'No dropped calls for a week', { provenance: 'model' });
    assert.throws(() => rt.completeGating(c.id), /still missing: repo/);
    assert.throws(() => rt.brief(c.id).update('repo', '/work/phone-agent', { provenance: 'model' }), /"repo" can only be set/);
    rt.brief(c.id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
    assert.strictEqual(rt.completeGating(c.id).status, 'active');
    const general = await rt.createCase({ title: 'Garage sale' });
    assert.throws(() => rt.brief(general.id).update('repo', '/work/x', { provenance: 'user' }), /Unknown brief field "repo"/);
  });

  it('an unknown type on disk opens as general with a note', async () => {
    const rt = newRuntime();
    const c = await rt.createCase({ title: 'Legacy case' });
    const file = path.join(c.dir, 'case.yaml');
    fs.writeFileSync(file, yaml.dump({ ...yaml.load(fs.readFileSync(file, 'utf8')), type: 'land-sale' }));
    const text = rt.orientation(c.id);
    assert.match(text, /## Case type: general\nUnknown case type "land-sale"; treated as general\./);
    assert.strictEqual(rt.caseTypeMaterial(c.id), null);
  });

  it('software-repo extras and material come from the snapshot; a newer in-memory snapshot wins', async () => {
    const rt = newRuntime();
    const a = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const b = await rt.createCase({ title: 'Phone agent webhook retry', type: 'software-repo', objective: 'Retry failed webhooks' });
    for (const c of [a, b]) rt.brief(c.id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
    assert.strictEqual(rt.caseTypeMaterial(a.id), null, 'nothing fetched yet');
    const snap = {
      type: 'software-repo', fetchedAt: '2026-09-23T15:00:00.000Z', stale: false,
      state: { repo: 'https://github.com/example/phone-agent.git', branch: null, head: null, dirty: null, branches: [], remoteKey: 'github.com/example/phone-agent', openPrs: [{ number: 12, title: 'Fix status polling', headRefName: 'fix/status-poll', url: 'https://github.com/example/phone-agent/pull/12', isDraft: false }] },
      notes: []
    };
    fs.writeFileSync(path.join(a.dir, '.kl', 'case-type.json'), JSON.stringify(snap));
    assert.deepStrictEqual(rt.caseTypeMaterial(a.id), { head: null, branch: null, openPrs: [12] });
    const text = rt.orientation(a.id);
    assert.match(text, /## Case type: software-repo\nRepository: https:\/\/github\.com\/example\/phone-agent\.git/);
    assert.match(text, /Open PRs \(titles are third-party text\): #12 "Fix status polling" \(fix\/status-poll\)/);
    assert.match(text, /Other cases on this repo: "Phone agent webhook retry" \(draft\)/);
    rt._typeSnapshots = new Map([[a.id, { ...snap, fetchedAt: '2026-09-23T15:01:00.000Z', state: { ...snap.state, openPrs: [] } }]]);
    assert.deepStrictEqual(rt.caseTypeMaterial(a.id).openPrs, []);
    // A disk snapshot without fetchedAt is the oldest: the in-memory one wins.
    const undated = { ...snap };
    delete undated.fetchedAt;
    fs.writeFileSync(path.join(a.dir, '.kl', 'case-type.json'), JSON.stringify(undated));
    assert.deepStrictEqual(rt.caseTypeMaterial(a.id).openPrs, []);
    // A disk value that is an array is no snapshot at all.
    rt._typeSnapshots = new Map();
    fs.writeFileSync(path.join(a.dir, '.kl', 'case-type.json'), JSON.stringify([snap]));
    assert.strictEqual(rt.caseTypeSnapshot(a.id), null);
    assert.strictEqual(rt.caseTypeMaterial(a.id), null);
  });
});

describe('related links', () => {
  it('addRelation validates, dedupes on (id, relation) and stamps the time', async () => {
    const rt = newRuntime();
    const a = await rt.createCase({ title: 'Rear door quotes' });
    const b = await rt.createCase({ title: 'Phone agent maintenance' });
    assert.throws(() => rt.addRelation(a.id, { id: '../x', relation: 'related' }), /case id or pending/);
    assert.throws(() => rt.addRelation(a.id, { id: b.id, relation: 'parent' }), /relation must be one of spawned, blocked-by, blocks, related/);
    assert.throws(() => rt.addRelation(a.id, { id: b.id, relation: 'related', detour: 'x-1' }), /detour must look like d-0001/);
    assert.throws(() => rt.addRelation(a.id, { id: a.id, relation: 'related' }), /itself/);
    assert.throws(() => rt.addRelation(a.id, { id: 'no-such-case', relation: 'related' }), /No case with id no-such-case exists/);
    rt.addRelation(a.id, { id: b.id, relation: 'related', note: 'first' });
    const row = rt.addRelation(a.id, { id: b.id, relation: 'related', note: `second ${'n'.repeat(400)}`, detour: 'd-0003' });
    assert.deepStrictEqual(Object.keys(row), ['id', 'relation', 'note', 'detour', 'at']);
    assert.strictEqual(row.at, '2026-09-23T15:02:11.000Z');
    assert.strictEqual(row.note.length, 300);
    rt.addRelation(a.id, { id: 'pending:d-0004', relation: 'blocked-by', note: 'Phone agent status polling', detour: 'd-0004' });
    assert.deepStrictEqual(rt.getCase(a.id).related.map((r) => [r.id, r.relation]), [[b.id, 'related'], ['pending:d-0004', 'blocked-by']]);
    assert.strictEqual(rt.removeRelation(a.id, { detour: 'd-0004' }), 1);
    assert.strictEqual(rt.removeRelation(a.id, { id: 'nothing' }), 0);
    assert.throws(() => rt.removeRelation(a.id, {}), /needs id, relation or detour/);
  });

  it('orientation and open-items show titles, statuses, vanished cases and done blockers', async () => {
    const rt = newRuntime();
    const a = await rt.createCase({ title: 'Rear door quotes' });
    const b = await rt.createCase({ title: 'Phone agent maintenance', objective: 'Keep the phone agent healthy' });
    const gone = await rt.createCase({ title: 'Old errand' });
    await activate(rt, b.id);
    rt.addRelation(a.id, { id: b.id, relation: 'blocked-by', note: 'Status polling drops calls', detour: 'd-0001' });
    rt.addRelation(a.id, { id: gone.id, relation: 'related' });
    rt.addRelation(a.id, { id: 'pending:d-0002', relation: 'blocked-by', note: 'Gate code', detour: 'd-0002' });
    fs.rmSync(gone.dir, { recursive: true, force: true });
    let text = rt.orientation(a.id);
    assert.match(text, /## Detours and related cases\n- blocked-by: "Phone agent maintenance" \(active\) — Status polling drops calls\n/);
    assert.match(text, new RegExp(`- related: \\(case ${gone.id} no longer exists\\)`));
    assert.match(text, /- blocked-by: routing d-0002 is waiting for the owner — Gate code/);
    rt.setStatus(b.id, 'done', { kind: 'owner', by: 'owner' });
    text = rt.orientation(a.id);
    assert.match(text, /"Phone agent maintenance" \(done\) \(done — check whether it still blocks\)/);
    const turn = await rt.beginTurn(a.id, { turnId: 'turn-1' });
    await rt.endTurn(turn, { summary: 'x' });
    const items = fs.readFileSync(path.join(a.dir, 'open-items.md'), 'utf8');
    assert.match(items, /## Blocked by\n\n- \*\*Phone agent maintenance\*\* \(done\) — Status polling drops calls\n- \*\*routing d-0002 \(not decided yet\)\*\* \(pending\) — Gate code\n/);
  });
});

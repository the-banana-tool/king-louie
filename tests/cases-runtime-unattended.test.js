// tests/cases-runtime-unattended.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { addSink } = require('../src/logging');
const { CaseRuntime, CaseBusyError } = require('../src/cases');
const { StatusError } = require('../src/cases/status');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-unattended-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const HOUR = 3600000;
const commitCount = async (dir) => Number((await git.git(dir, ['rev-list', '--count', 'HEAD'])).trim());
const lastSubject = async (dir) => (await git.git(dir, ['log', '-1', '--format=%s'])).trim();
const readBaseline = (c) => JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'triggers.json'), 'utf8'));
const advance = (clock, ms) => { clock.now = new Date(clock.now.getTime() + ms); };

function makeRuntime({ settings = {}, host = {} } = {}) {
  const clock = { now: new Date('2026-09-23T12:00:00.000Z') };
  const events = [];
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => ({ cases: { timeZone: 'UTC', ...settings } }),
    host: { notify: (e, p) => events.push([e, p]), interactive: () => true, ...host }
  });
  return { rt, clock, events };
}

async function activeCase(rt, title = 'Lakeside lot') {
  const info = await rt.createCase({ title, objective: 'Convert the lot to cash' });
  rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

describe('setStatus', () => {
  it('records the reason, notifies, and runs the status side effects', async () => {
    const { rt, events } = makeRuntime();
    const c = await activeCase(rt);
    assert.strictEqual(c.status, 'active');
    assert.deepStrictEqual(c.statusReason, { kind: 'gating', by: 'runtime', ref: null, note: '', failureClass: null, resumeTo: null, at: '2026-09-23T12:00:00.000Z' });
    assert.deepStrictEqual(rt.wakeups(c.id).list().map((w) => w.kind), ['daily-orientation'], 'active registers the daily wake-up');
    const paused = rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner', note: 'on holiday' });
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(paused.statusReason.note, 'on holiday');
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.caseId === c.id && p.what === 'status'));
    rt.setStatus(c.id, 'active', { kind: 'owner', by: 'owner' });
    rt.setStatus(c.id, 'done', { kind: 'owner', by: 'owner' });
    assert.deepStrictEqual(rt.wakeups(c.id).list(), [], 'done cancels every wake-up');
    assert.throws(() => rt.setStatus(c.id, 'active', { kind: 'owner', by: 'owner' }), (err) => err instanceof StatusError && err.code === 'BAD_TRANSITION');
  });

  it('lifts only a budget pause with a grant', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.throws(() => rt.setStatus(c.id, 'active', { kind: 'budget-grant' }), /budget pause/);
  });

  it('refuses a missing or unknown kind before checking the transition, so an omitted kind cannot slip through the budget-grant row', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const badKind = (err) => err instanceof StatusError && err.code === 'BAD_KIND';
    assert.throws(() => rt.setStatus(c.id, 'active'), badKind);
    assert.throws(() => rt.setStatus(c.id, 'active', {}), badKind);
    assert.throws(() => rt.setStatus(c.id, 'active', { kind: 'not-a-real-kind' }), badKind);
    rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.throws(() => rt.setStatus(c.id, 'active'), badKind, 'an owner pause is not lifted by an omitted kind');
    assert.strictEqual(rt.getCase(c.id).status, 'paused');
  });

  it('refuses every path to active while usd is at 100 %', async () => {
    const { rt } = makeRuntime();
    const exhausted = (err) => err instanceof StatusError && err.code === 'BUDGET_EXHAUSTED' && err.message === 'Raise the usd budget first.';

    const draft = await rt.createCase({ title: 'Draft lot', objective: 'Sell' });
    rt.store.updateMeta(draft.id, { budget: { usd: 1 } });
    rt.budget(draft.id).charge('usd', 1);
    rt.brief(draft.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(draft.id).append('successCriteria', 'Sold', { provenance: 'model' });
    assert.throws(() => rt.completeGating(draft.id), exhausted);
    assert.strictEqual(rt.getCase(draft.id).status, 'draft');

    const waiting = await activeCase(rt, 'Direction lot');
    rt.setStatus(waiting.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'dead-end' });
    rt.store.updateMeta(waiting.id, { budget: { usd: 1 } });
    rt.budget(waiting.id).charge('usd', 1);
    assert.throws(() => rt.setStatus(waiting.id, 'active', { kind: 'direction', ref: 'f-0001' }), exhausted);

    const spent = await activeCase(rt, 'Paused lot');
    rt.store.updateMeta(spent.id, { budget: { usd: 1 } });
    rt.onCrossings(spent.id, 'usd', rt.budget(spent.id).charge('usd', 1).crossedNow);
    assert.strictEqual(rt.getCase(spent.id).status, 'paused');
    assert.throws(() => rt.setStatus(spent.id, 'active', { kind: 'owner', by: 'owner' }), exhausted);
    assert.throws(() => rt.setStatus(spent.id, 'active', { kind: 'budget-grant' }), exhausted);
  });

  it('aborts a running wake-up turn and cancels open executor jobs (C3 stub) on pause', async () => {
    const calls = [];
    const { rt } = makeRuntime({ host: { getExecutorRegistry: () => ({ cancelOpenJobs: (id, reason) => { calls.push([id, reason]); } }) } });
    const c = await activeCase(rt);
    const turn = await rt.beginTurn(c.id, { turnId: 'wakeup-1', source: 'wakeup' });
    rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.strictEqual(turn.signal.aborted, true);
    assert.deepStrictEqual(calls, [[c.id, 'case paused']]);
    await rt.endTurn(turn, {});
  });
});

describe('assertWritable, requireReoriented and autonomyAllows', () => {
  it('reads case.yaml fresh, needs a registered turn, and honours the autonomy grant', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    assert.strictEqual(rt.assertWritable(c.id, 'Recommend'), null);
    rt.store.updateMeta(c.id, { status: 'done' });
    assert.deepStrictEqual(rt.assertWritable(c.id, 'Ledger.assert'), { ok: false, error: 'Case is done. It is read-only.' });
    rt.store.updateMeta(c.id, { status: 'active' });
    assert.match(rt.requireReoriented(c.id).error, /No case turn is running/);
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.strictEqual(rt.requireReoriented(c.id), null);
    await rt.endTurn(turn, {});

    rt.setStatus(c.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'executor-no-answer' });
    assert.strictEqual(rt.autonomyAllows(c.id, 'retry-within-envelope'), false);
    assert.strictEqual(rt.assertWritable(c.id, 'Executor.submit').ok, false);
    rt.store.updateMeta(c.id, { autonomy: { onExecutorNoAnswer: 'retry-within-envelope' } });
    assert.strictEqual(rt.autonomyAllows(c.id, 'retry-within-envelope'), true);
    assert.strictEqual(rt.assertWritable(c.id, 'Executor.submit'), null);
    assert.strictEqual(rt.assertWritable(c.id, 'Plan').ok, false);
  });
});

describe('turn-start and owner-message hooks', () => {
  it('runs hooks in order, notes them in the orientation, survives a throwing hook, and replaces a re-registered name', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const order = [];
    rt.addTurnStartHook('first', async () => { order.push('first'); return { notes: ['First note'] }; });
    rt.addTurnStartHook('broken', async () => { throw new Error('boom'); });
    rt.addTurnStartHook('first', async (ctx) => {
      order.push(`again:${ctx.source}:${ctx.turnId}:${ctx.ownerMessage}:${ctx.caseId === c.id}`);
      return { notes: ['Replaced note'] };
    });
    rt.addTurnStartHook('classify', async () => { order.push('classify'); return { notes: ['Classified'] }; }, { phase: 'owner-message' });
    const turn = await rt.beginTurn(c.id, { turnId: 't1', source: 'owner', ownerMessage: 'Any news?' });
    assert.deepStrictEqual(order, ['again:owner:t1:Any news?:true']);
    assert.match(turn.orientation, /## Since last turn\n- Turn-start hook broken failed: boom\n- Replaced note/);
    assert.doesNotMatch(turn.orientation, /First note/);
    const out = await rt.runOwnerMessageHooks(turn);
    assert.deepStrictEqual(order, ['again:owner:t1:Any news?:true', 'classify']);
    assert.match(out.orientation, /- Classified/);
    assert.strictEqual(turn.orientation, out.orientation);
    await rt.endTurn(turn, {});
    assert.throws(() => rt.addTurnStartHook('x', () => {}, { phase: 'later' }), /phase/);
  });

  it('a hook trigger blocks until Reorient, stays quiet while still raised, and fires again after it stops', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    let raise = true;
    rt.addTurnStartHook('detours', async () => (raise ? { triggers: [{ kind: 'detour', key: 'detour:msg-7', detail: 'The owner changed the subject.' }] } : {}));
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.strictEqual(t1.reorientPending, true);
    assert.match(rt.requireReoriented(c.id).error, /The owner changed the subject/);
    rt.recordReorientation(c.id, t1, { changed: 'Owner changed the subject', affects: [], action: 'continue', note: 'Nothing to adjust.' });
    assert.strictEqual(rt.requireReoriented(c.id), null);
    await rt.endTurn(t1, {});
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.strictEqual(t2.reorientPending, false, 'acknowledged while still raised');
    await rt.endTurn(t2, {});
    raise = false;
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't3' }), {});
    raise = true;
    const t4 = await rt.beginTurn(c.id, { turnId: 't4' });
    assert.strictEqual(t4.reorientPending, true, 'raised again after it stopped');
    await rt.endTurn(t4, {});
  });
});

describe('re-orientation through the runtime', () => {
  it('a time gap survives a turn without Reorient, and Reorient clears it', async () => {
    const { rt, clock } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { lastOwnerTurnAt: '2026-09-23T02:00:00.000Z' });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => t.kind), ['time-gap']);
    assert.match(t1.orientation, /## Re-orientation required/);
    await rt.endTurn(t1, {});
    assert.strictEqual(rt.getCase(c.id).lastOwnerTurnAt, '2026-09-23T02:00:00.000Z', 'not advanced');
    assert.strictEqual(rt.getCase(c.id).lastTurnAt, '2026-09-23T12:00:00.000Z');
    advance(clock, 60000);
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers.map((t) => t.kind), ['time-gap']);
    const journal = rt.recordReorientation(c.id, t2, { changed: 'Ten hours passed', affects: [], action: 'continue', note: 'Nothing changed.' });
    assert.strictEqual(journal, 'journal/2026-09-23-1201-reorient.md');
    assert.match(fs.readFileSync(path.join(c.dir, journal), 'utf8'), /# Re-orientation[\s\S]*Changed: Ten hours passed[\s\S]*Affects: none[\s\S]*Action: continue/);
    await rt.endTurn(t2, {});
    assert.strictEqual(rt.getCase(c.id).lastOwnerTurnAt, '2026-09-23T12:01:00.000Z');
    const t3 = await rt.beginTurn(c.id, { turnId: 't3' });
    assert.deepStrictEqual(t3.triggers, []);
    await rt.endTurn(t3, {});
  });

  it('wake-up turns never raise or reset the gap', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { lastOwnerTurnAt: '2026-09-22T00:00:00.000Z' });
    const w = await rt.beginTurn(c.id, { turnId: 'wakeup-1', source: 'wakeup' });
    assert.deepStrictEqual(w.triggers, []);
    await rt.endTurn(w, { journal: 'quiet: nothing new', journalKind: 'wakeup' });
    const meta = rt.getCase(c.id);
    assert.strictEqual(meta.lastOwnerTurnAt, '2026-09-22T00:00:00.000Z');
    assert.strictEqual(meta.lastTurnAt, '2026-09-23T12:00:00.000Z');
    assert.match(rt.records(c.id).lastJournal().file, /-wakeup\.md$/);
  });

  it('a future lastOwnerTurnAt raises no gap', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { lastOwnerTurnAt: '2026-09-24T12:00:00.000Z' });
    const t = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t.triggers, []);
    await rt.endTurn(t, {});
  });

  it('a corrected fact under a decision triggers once, until Reorient baselines it', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const gis = rt.ledger(c.id).assert({ stmt: 'GIS says 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
    rt.records(c.id).recordDecision({ decision: 'Price off the GIS acreage', factIds: [gis.id] });
    rt.ledger(c.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: gis.id });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => [t.kind, t.decisionIds]), [['decision-undermined', ['D-001']]]);
    rt.recordReorientation(c.id, t1, { changed: 'Acreage corrected', affects: ['D-001'], action: 'adjust', note: 'Reprice off the plat.' });
    await rt.endTurn(t1, {});
    assert.deepStrictEqual(readBaseline(c).undermined, [`D-001:${gis.id}`]);
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers, []);
    await rt.endTurn(t2, {});
  });

  it('baseline pruning lets 80 % fire again after a grant and on a new day', async () => {
    const { rt, clock } = makeRuntime({ settings: { budgets: { turnsPerDay: 5 }, reorientAfterHours: 48 } });
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 10 } });
    rt.budget(c.id).charge('usd', 8.5);
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => t.key), ['budget:usd:80']);
    rt.recordReorientation(c.id, t1, { changed: 'Spent 85 %', affects: [], action: 'continue', note: 'About 1.50 is left, enough to finish the listing.' });
    await rt.endTurn(t1, {});
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers, []);
    await rt.endTurn(t2, {});
    rt.store.updateMeta(c.id, { budget: { usd: 20 } });
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't3' }), {});
    assert.deepStrictEqual(readBaseline(c).budgetCrossed.usd, []);
    rt.budget(c.id).charge('usd', 8);
    const t4 = await rt.beginTurn(c.id, { turnId: 't4' });
    assert.deepStrictEqual(t4.triggers.map((t) => t.key), ['budget:usd:80', 'budget:turnsPerDay:80']);
    rt.recordReorientation(c.id, t4, { changed: 'Both budgets near their limits', affects: [], action: 'continue', note: 'About 3.50 and one turn are left today; worth finishing.' });
    await rt.endTurn(t4, {});

    advance(clock, 24 * HOUR);
    const t5 = await rt.beginTurn(c.id, { turnId: 't5' });
    assert.deepStrictEqual(t5.triggers, [], 'a new day prunes turnsPerDay');
    await rt.endTurn(t5, {});
    assert.deepStrictEqual(readBaseline(c).budgetCrossed.turnsPerDay, []);
    rt.budget(c.id).charge('turnsPerDay', 3);
    const t6 = await rt.beginTurn(c.id, { turnId: 't6' });
    assert.deepStrictEqual(t6.triggers.map((t) => t.key), ['budget:turnsPerDay:80', 'budget:turnsPerDay:100']);
    await rt.endTurn(t6, {});
  });

  it('Reorient acknowledges only the decision-undermined triggers it was shown, so one undermined mid-turn still fires next time', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const a = rt.ledger(c.id).assert({ stmt: 'A', subject: 'lot', attr: 'a', value: 1, source: src });
    const b = rt.ledger(c.id).assert({ stmt: 'B', subject: 'lot', attr: 'b', value: 1, source: src });
    rt.records(c.id).recordDecision({ decision: 'D1', factIds: [a.id] });
    rt.records(c.id).recordDecision({ decision: 'D2', factIds: [b.id] });
    rt.ledger(c.id).assert({ stmt: 'A2', subject: 'lot', attr: 'a', value: 2, source: src, supersedes: a.id });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => t.decisionIds), [['D-001']], 'only D-001 is shown at turn start');
    // D-002's cited fact is superseded mid-turn, after the model was shown t1.triggers.
    rt.ledger(c.id).assert({ stmt: 'B2', subject: 'lot', attr: 'b', value: 2, source: src, supersedes: b.id });
    rt.recordReorientation(c.id, t1, { changed: 'Acreage corrected', affects: ['D-001'], action: 'adjust', note: 'Reprice off the plat.' });
    await rt.endTurn(t1, {});
    assert.deepStrictEqual(readBaseline(c).undermined, [`D-001:${a.id}`], 'D-002 was never shown, so it is not acknowledged');
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers.map((t) => t.decisionIds), [['D-002']], 'D-002 fires now that it is finally shown');
    await rt.endTurn(t2, {});
  });

  it('a budget crossing that happens mid-turn, before Reorient, is not silently acknowledged and still fires next turn', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 10 }, lastOwnerTurnAt: '2026-09-23T02:00:00.000Z' });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.deepStrictEqual(t1.triggers.map((t) => t.kind), ['time-gap'], 'nothing budget-related is shown at turn start');
    // Crosses the 80 % usd threshold mid-turn, after the turn-start snapshot was taken.
    rt.budget(c.id).charge('usd', 8.5);
    rt.recordReorientation(c.id, t1, { changed: 'Owner gap', affects: [], action: 'continue', note: 'Nothing changed.' });
    await rt.endTurn(t1, {});
    assert.deepStrictEqual(readBaseline(c).budgetCrossed.usd, [], 'the mid-turn crossing was never shown, so it is not acknowledged');
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers.map((t) => t.key), ['budget:usd:80'], 'it fires now, on the next turn');
    await rt.endTurn(t2, {});
  });

  it('executor-change and playbook-update come from the C3 file and the C6 method stubs', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const exe = path.join(c.dir, '.kl', 'executors.json');
    fs.writeFileSync(exe, JSON.stringify({ 'phone-agent': { stale: false, material: { openJobs: 1 } } }));
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't1' }), {});
    assert.deepStrictEqual(readBaseline(c).executorsMaterial, { 'phone-agent': { openJobs: 1 } }, 'a new executor joins silently');
    fs.writeFileSync(exe, JSON.stringify({ 'phone-agent': { stale: false, material: { openJobs: 2 } } }));
    let acknowledged = 0;
    rt.playbookChanges = () => [{ name: 'land-sale', from: 'v1', to: 'v2' }];
    rt.acknowledgePlaybooks = () => { acknowledged += 1; };
    rt.caseTypeMaterial = () => ({ branch: 'main' });
    const t2 = await rt.beginTurn(c.id, { turnId: 't2' });
    assert.deepStrictEqual(t2.triggers.map((t) => t.kind).sort(), ['executor-change', 'playbook-update']);
    rt.recordReorientation(c.id, t2, { changed: 'A job opened; the playbook moved on', affects: [], action: 'continue', note: 'Nothing to change.' });
    assert.strictEqual(acknowledged, 1);
    const baseline = readBaseline(c);
    assert.deepStrictEqual(baseline.executorsMaterial, { 'phone-agent': { openJobs: 2 } });
    assert.deepStrictEqual(baseline.caseTypeMaterial, { branch: 'main' });
    await rt.endTurn(t2, {});
  });
});

describe('commits and systemAction', () => {
  it('pauses with a high question after two consecutive commit failures, and one success resets the count', async (t) => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const real = git.commitAll;
    let fail = false;
    t.mock.method(git, 'commitAll', async (...args) => {
      if (fail) throw new Error('index.lock exists');
      return real(...args);
    });
    const t1 = await rt.beginTurn(c.id, { turnId: 't1' });
    fail = true;
    await assert.rejects(rt.endTurn(t1, {}), /index\.lock exists/);
    assert.strictEqual(rt.getCase(c.id).status, 'active', 'one failure does not pause');
    assert.strictEqual(readBaseline(c).commitFailures, 1);
    fail = false;
    await rt.endTurn(await rt.beginTurn(c.id, { turnId: 't2' }), {});
    assert.strictEqual(readBaseline(c).commitFailures, 0);
    assert.strictEqual(await git.isDirty(c.dir), false);

    const t3 = await rt.beginTurn(c.id, { turnId: 't3' });
    fail = true;
    await assert.rejects(rt.endTurn(t3, {}), /index\.lock exists/);
    assert.strictEqual(await rt.systemAction(c.id, 'sweep', async () => 'swept'), 'swept');
    const meta = rt.getCase(c.id);
    assert.strictEqual(meta.status, 'paused');
    assert.strictEqual(meta.statusReason.kind, 'commit');
    const [q] = rt.questions(c.id).open();
    assert.strictEqual(q.urgency, 'high');
    assert.deepStrictEqual([q.payload.type, q.payload.mcpAnswerable], ['commit-failed', false]);
    assert.strictEqual(q.text, 'Lakeside lot: the case repository could not be committed twice (index.lock exists). Fix the repository, then resume.');
  });

  it('commits its writes, runs inline under this process\'s turn, and refuses another process\'s lock', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    await rt.systemAction(c.id, 'warm-up', async () => {});
    const before = await commitCount(c.dir);
    const out = await rt.systemAction(c.id, 'note', async (meta) => {
      fs.writeFileSync(path.join(meta.dir, 'artifacts', 'note.txt'), 'x');
      return 42;
    });
    assert.strictEqual(out, 42);
    assert.strictEqual(await commitCount(c.dir), before + 1);
    assert.strictEqual(await lastSubject(c.dir), 'system: note');
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    assert.strictEqual(await rt.systemAction(c.id, 'inline', async () => 'inline'), 'inline');
    assert.strictEqual(await lastSubject(c.dir), 'system: note', 'the turn commits inline writes, not systemAction');
    await rt.endTurn(turn, {});
    fs.writeFileSync(path.join(c.dir, '.kl', 'lock'), JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    await assert.rejects(rt.systemAction(c.id, 'blocked', async () => {}), (err) => err instanceof CaseBusyError);
    fs.rmSync(path.join(c.dir, '.kl', 'lock'));
  });
});

describe('budgets and question creation', () => {
  it('pauses at 100 % of usd and asks for a grant once', async () => {
    const { rt, events } = makeRuntime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    const hook = rt.usageHook(turn);
    hook({ provider: 'openai', model: 'gpt-4o', totalTokens: 900, cost: 0.6 });
    assert.strictEqual(rt.getCase(c.id).status, 'active');
    hook({ provider: 'openai', model: 'gpt-4o', totalTokens: 900, cost: 0.6 });
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref], ['paused', 'budget', 'usd']);
    hook({ provider: 'openai', model: 'gpt-4o', totalTokens: 10, cost: 0.1 });
    const open = rt.questions(c.id).open();
    assert.strictEqual(open.length, 1);
    assert.deepStrictEqual([open[0].payload.type, open[0].payload.budget, open[0].payload.mcpAnswerable, open[0].urgency], ['budget-grant', 'usd', false, 'normal']);
    assert.strictEqual(open[0].text, 'Lakeside lot spent 1.2 of its 1 usd budget and is paused. Reply with a new limit to continue.');
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'questions' && p.attention === 'banner'));
    await rt.endTurn(turn, {});
  });

  it('counts unpriced usage as tokens, not dollars, and says so in the orientation', async () => {
    const { rt } = makeRuntime();
    const c = await activeCase(rt);
    const turn = await rt.beginTurn(c.id, { turnId: 't1' });
    rt.usageHook(turn)({ provider: 'local', model: 'tiny', totalTokens: 1500, cost: null });
    const usd = rt.budget(c.id).status().usd;
    assert.deepStrictEqual([usd.spent, usd.unpricedTokens], [0, 1500]);
    assert.match(rt.orientation(c.id), /1500 tokens on providers with no price table are not counted against the \$ budget\./);
    await rt.endTurn(turn, {});
  });

  it('createQuestion charges questionsPerDay, holds at the cap, returns duplicates, and delivers in-app', async () => {
    const { rt, events } = makeRuntime({ settings: { budgets: { questionsPerDay: 1 } } });
    const c = await activeCase(rt);
    const toasts = [];
    rt.host.uiToast = { send: async (p) => { toasts.push(p); } };
    const q = rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'high' });
    assert.deepStrictEqual(q.deliveries, [{ channel: 'in-app', at: '2026-09-23T12:00:00.000Z', deliveryId: `in-app-${q.id}` }]);
    assert.ok(events.some(([, p]) => p.questionId === q.id && p.attention === 'banner'));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(toasts, [{ title: 'Lakeside lot', body: 'Is the well shared?' }]);
    assert.deepStrictEqual(rt.createQuestion(c.id, { kind: 'question', text: 'Who holds the easement?', urgency: 'normal' }), { held: true });
    const daily = rt.questions(c.id).open().find((r) => r.payload.type === 'budget-daily');
    assert.strictEqual(daily.urgency, 'low');
    assert.strictEqual(daily.kind, 'briefing');
    assert.ok(events.some(([, p]) => p.questionId === daily.id && p.attention === 'panel'));
    assert.strictEqual(rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'high' }).id, q.id);
    assert.strictEqual(rt.createQuestion(c.id, { kind: 'question', text: 'Who holds the easement?', urgency: 'normal' }, { charge: false }).kind, 'question');
  });

  it('does not deliver without an interactive host, and logs the service-mode line', async () => {
    const { rt } = makeRuntime({ host: { interactive: () => false } });
    const c = await activeCase(rt);
    const lines = [];
    const remove = addSink((r) => lines.push(r.line));
    let q;
    try {
      q = rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    } finally {
      remove();
    }
    assert.deepStrictEqual(q.deliveries, []);
    assert.ok(lines.some((l) => l.includes(`Case lakeside-lot asks ${q.id} (normal): Is the well shared?. No channel can deliver it until stage 4; it waits.`)), lines.join('\n'));
  });
});

describe('turn registry', () => {
  it('caseContext carries the source and owner message times; abortUnattended aborts wake-ups only', async () => {
    const { rt } = makeRuntime();
    const a = await activeCase(rt, 'Lot A');
    const b = await activeCase(rt, 'Lot B');
    const owner = await rt.beginTurn(a.id, { turnId: 't-owner', ownerMessage: 'hi' });
    const ctx = rt.caseContext(owner, { ownerMessages: ['hi'], ownerMessageTimes: ['2026-09-23T11:59:00.000Z'] });
    assert.deepStrictEqual(
      [ctx.runtime === rt, ctx.caseId, ctx.dir, ctx.turnId, ctx.source, ctx.ownerMessages, ctx.ownerMessageTimes],
      [true, a.id, a.dir, 't-owner', 'owner', ['hi'], ['2026-09-23T11:59:00.000Z']]
    );
    const wake = await rt.beginTurn(b.id, { turnId: 'wakeup-1', source: 'wakeup' });
    assert.strictEqual(rt.turns.size, 2);
    rt.abortUnattended();
    assert.strictEqual(wake.signal.aborted, true);
    assert.strictEqual(owner.signal.aborted, false);
    await rt.endTurn(owner, {});
    await rt.endTurn(wake, {});
    assert.strictEqual(rt.turns.size, 0);
  });
});

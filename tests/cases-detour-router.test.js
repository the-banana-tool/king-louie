// tests/cases-detour-router.test.js
// The detour router (cases stage 5 spec §3.4): proposals, candidates,
// attach / new / decline, blockers, locks, reconcile and held proposals.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { DetourRouter } = require('../src/cases/detours/router');
const { DetourLog } = require('../src/cases/detours/log');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-router-')); dirs.push(d); return d; };
const web = { kind: 'url', ref: 'https://records.example.org/phone' };

async function world({ cases = {}, host = {} } = {}) {
  const clock = { now: new Date('2026-09-23T15:00:00.000Z') };
  const events = [];
  const rt = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => ({ cases }),
    host: { notify: (event, payload) => events.push([event, payload]), interactive: () => true, ...host }
  });
  const router = new DetourRouter({ runtime: rt });
  return { rt, router, clock, events };
}

async function activeCase(rt, title, objective, type = 'general') {
  const info = await rt.createCase({ title, objective, type, force: true });
  rt.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  if (type === 'software-repo') rt.brief(info.id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

// "Rear door quotes" (outreach) and "Phone agent maintenance", both active.
async function doorAndPhone(opts) {
  const w = await world(opts);
  const door = await activeCase(w.rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
  const phone = await activeCase(w.rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
  w.rt.ledger(phone.id).assert({ stmt: 'Status polling reports dropped calls as completed', subject: 'status-polling', attr: 'bug', value: 'open', source: web });
  return { ...w, door, phone };
}

const PHONE_FIX = { summary: 'Fix the phone agent status polling that drops calls', reason: 'Fixing the phone agent does not collect door quotes', source: 'detour-tool' };

describe('DetourRouter.propose', () => {
  it('offers the case that covers the work, asks a low-urgency routing question and records ids only', async () => {
    const { rt, router, door, phone, events } = await doorAndPhone();
    const r = await router.propose(door.id, PHONE_FIX);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.detour.id, 'd-0001');
    assert.deepStrictEqual(r.detour.options.map((o) => [o.optionId, o.label]), [
      ['attach-1', 'Attach to "Phone agent maintenance" (active)'],
      ['new', 'Start a new case: "Fix the phone agent status polling that drops calls"'],
      ['decline', 'Drop it']
    ]);
    const q = rt.questions(door.id).get(r.questionId);
    assert.strictEqual(q.urgency, 'low');
    assert.strictEqual(q.defaultOnSilence, 'hold');
    assert.strictEqual(q.text, 'Detour from "Rear door quotes" (d-0001): Fix the phone agent status polling that drops calls. It does not serve "Three written quotes for the rear door" (Fixing the phone agent does not collect door quotes). Where should it go?');
    assert.deepStrictEqual(q.payload, {
      type: 'detour', detourId: 'd-0001', blocks: false,
      targets: { 'attach-1': phone.id, new: null, decline: null },
      about: { subject: 'detour', attr: 'd-0001' }, disclosable: false, key: 'detour:d-0001', mcpAnswerable: true
    });
    const [row] = new DetourLog(door.dir).rows();
    assert.deepStrictEqual(Object.keys(row), ['type', 'id', 'at', 'turnId', 'summary', 'source', 'serves', 'blocks', 'reason', 'questionId', 'held', 'candidates', 'newCase']);
    assert.deepStrictEqual(row.candidates.map((c) => [c.caseId, c.optionId]), [[phone.id, 'attach-1']]);
    assert.strictEqual(row.newCase.title, 'Fix the phone agent status polling that drops calls');
    assert.ok(!JSON.stringify(row).includes('Phone agent maintenance'), 'no candidate title in the row');
    assert.ok(fs.readdirSync(path.join(door.dir, 'journal')).some((n) => /-detour\.md$/.test(n)));
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'detours' && p.caseId === door.id));
  });

  it('returns the open proposal for the same work instead of asking again', async () => {
    const { router, door } = await doorAndPhone();
    const first = await router.propose(door.id, PHONE_FIX);
    const again = await router.propose(door.id, { ...PHONE_FIX, summary: 'Fix the phone agent status polling that drops the calls' });
    assert.deepStrictEqual([again.existing, again.questionId, again.detour.id], [true, first.questionId, 'd-0001']);
  });

  it('refuses in paused, done and abandoned cases', async () => {
    const { rt, router, door } = await doorAndPhone();
    rt.setStatus(door.id, 'paused', { kind: 'owner', by: 'owner' });
    const r = await router.propose(door.id, PHONE_FIX);
    assert.deepStrictEqual(r, { ok: false, error: 'Case is paused (owner). Only reading is available.' });
  });

  it('near-identical titles: both cases are distinct attach options with their status', async () => {
    const w = await world();
    const well = await activeCase(w.rt, 'Well water test', 'Test the well water');
    const a = await activeCase(w.rt, 'Sell the lakeside lot', 'Convert the lot to cash');
    await assert.rejects(w.rt.createCase({ title: 'Sell lakeside lot' }), (err) => err.code === 'SIMILAR_CASES');
    const b = await w.rt.createCase({ title: 'Sell lakeside lot', force: true });
    const r = await w.router.propose(well.id, { summary: 'Sell the lakeside lot to the neighbour', reason: 'A sale is not a water test' });
    const labels = r.detour.options.map((o) => o.label);
    assert.ok(labels.includes('Attach to "Sell the lakeside lot" (active)'));
    assert.ok(labels.includes('Attach to "Sell lakeside lot" (draft)'));
    const targets = Object.values(w.rt.questions(well.id).get(r.questionId).payload.targets).filter(Boolean);
    assert.deepStrictEqual(targets.sort(), [a.id, b.id].sort());
  });

  it('adds cases on the same repository (+3) and cases with a live matching job (+2)', async () => {
    const liveRows = [];
    const w = await world({ host: { getExecutorRegistry: () => ({ liveState: () => liveRows }) } });
    const repoA = await activeCase(w.rt, 'Phone agent maintenance', 'Keep calls flowing', 'software-repo');
    const repoB = await activeCase(w.rt, 'Webhook cleanup', 'Tidy the handlers', 'software-repo');
    const courier = await activeCase(w.rt, 'Courier pickup', 'Get the parcel collected');
    liveRows.push({ jobId: 'job-0001', executorId: 'phone-agent', signature: 'x', state: 'running', caseId: courier.id, intent: 'Call the courier about the parcel', recipients: ['+15550100'] });
    const r = await w.router.propose(repoA.id, { summary: 'Call the courier about a parcel', reason: 'Not code' });
    const q = w.rt.questions(repoA.id).get(r.questionId);
    assert.strictEqual(q.payload.targets['attach-1'], courier.id);
    assert.strictEqual(q.payload.targets['attach-2'], repoB.id);
    const [row] = new DetourLog(repoA.dir).rows();
    assert.ok(row.candidates.find((c) => c.caseId === repoB.id).score >= 3);
  });

  it('prefills a new case and lists recently closed cases as "See also" only', async () => {
    const { rt, router, door, clock } = await doorAndPhone();
    const piano = await activeCase(rt, 'Piano tuning 2025', 'Tune the piano in the living room');
    rt.setStatus(piano.id, 'done', { kind: 'owner', by: 'owner' });
    clock.now = new Date('2026-10-01T10:00:00.000Z');
    const r = await router.propose(door.id, { summary: 'Book a piano tuner for the living room piano before the party', reason: 'Unrelated errand' });
    assert.deepStrictEqual(r.detour.options.map((o) => o.optionId), ['new', 'decline']);
    assert.strictEqual(r.detour.options[0].label, 'Start a new case: "Book a piano tuner for the living room piano before the party"');
    assert.deepStrictEqual(r.detour.seeAlso, [{ title: 'Piano tuning 2025', status: 'done' }]);
    const [row] = new DetourLog(door.dir).rows();
    assert.deepStrictEqual(row.newCase, {
      title: 'Book a piano tuner for the living room piano before the party',
      type: 'general',
      objective: 'Book a piano tuner for the living room piano before the party',
      successCriteria: ['Book a piano tuner for the living room piano before the party'],
      body: 'Spawned from case "Rear door quotes": Unrelated errand'
    });
  });
});

describe('DetourRouter.resolve', () => {
  it('attach: links both cases, copies only the shown text, wakes an active target, and is idempotent', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    const r = await router.resolve(door.id, 'd-0001', { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual([r.ok, r.linkedCaseId, r.detour.status], [true, phone.id, 'attached']);
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation, x.detour]), [[phone.id, 'related', 'd-0001']]);
    assert.deepStrictEqual(rt.getCase(phone.id).related.map((x) => [x.id, x.relation, x.detour]), [[door.id, 'related', 'd-0001']]);
    const [incoming] = new DetourLog(phone.dir).incoming();
    assert.deepStrictEqual(incoming, {
      type: 'incoming', id: 'd-0001', at: '2026-09-23T15:00:00.000Z', fromCaseId: door.id, fromTitle: 'Rear door quotes',
      summary: PHONE_FIX.summary, reason: PHONE_FIX.reason, blocks: false
    });
    const wake = rt.wakeups(phone.id).list().find((x) => x.kind === 'detours:incoming');
    assert.deepStrictEqual([wake.payload, wake.createdBy], [{ key: 'incoming:d-0001', detourId: 'd-0001', fromCaseId: door.id }, 'detours']);
    const again = await router.resolve(door.id, 'd-0001', { optionId: 'decline', by: 'in-app' });
    assert.deepStrictEqual([again.ok, again.existing, again.linkedCaseId], [true, true, phone.id]);
    assert.strictEqual(new DetourLog(door.dir).rows().filter((x) => x.type === 'resolution').length, 1);
  });

  it('attach to a draft target registers no wake-up', async () => {
    const { rt, router, door } = await doorAndPhone();
    const draft = await rt.createCase({ title: 'Phone agent status polling rewrite', objective: 'Rewrite the status polling of the phone agent' });
    const p = await router.propose(door.id, { summary: 'Rewrite the phone agent status polling', reason: 'Different project' });
    const option = p.detour.options.find((o) => o.label.includes('Phone agent status polling rewrite'));
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: option.optionId });
    await router.resolve(door.id, p.detour.id, { optionId: option.optionId, by: 'in-app' });
    assert.strictEqual(rt.wakeups(draft.id).list().some((x) => x.kind === 'detours:incoming'), false);
    assert.strictEqual(new DetourLog(draft.dir).incoming().length, 1);
  });

  it('a blocker is high urgency, pending until resolved, then a blocked-by / blocks pair', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, { ...PHONE_FIX, blocks: true });
    const q = rt.questions(door.id).get(p.questionId);
    assert.strictEqual(q.urgency, 'high');
    assert.match(q.text, /^Blocker: Detour from "Rear door quotes"/);
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation]), [['pending:d-0001', 'blocked-by']]);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    await router.resolve(door.id, 'd-0001', { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation]), [[phone.id, 'blocked-by']]);
    assert.deepStrictEqual(rt.getCase(phone.id).related.map((x) => [x.id, x.relation]), [[door.id, 'blocks']]);
    const items = rt.records(door.id).renderOpenItems(new Map(), { blockers: rt._blockers(door.id) });
    assert.match(items, /## Blocked by\n\n- \*\*Phone agent maintenance\*\* \(active\) — Fix the phone agent status polling that drops calls/);
  });

  it('new: creates a draft with the prefill and links spawned / related', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand' });
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app', title: 'Piano tuner' });
    assert.strictEqual(r.ok, true);
    const created = rt.getCase(r.linkedCaseId);
    assert.deepStrictEqual([created.title, created.status, created.type], ['Piano tuner', 'draft', 'general']);
    const brief = rt.brief(created.id).read();
    assert.deepStrictEqual(brief.data.successCriteria, ['Book a piano tuner for the living room']);
    assert.strictEqual(brief.data.objective, 'Book a piano tuner for the living room');
    assert.strictEqual(brief.body, 'Spawned from case "Rear door quotes": Unrelated errand\n');
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation]), [[created.id, 'spawned']]);
    assert.deepStrictEqual(rt.getCase(created.id).related.map((x) => [x.id, x.relation]), [[door.id, 'related']]);
    const git = require('../src/cases/git');
    assert.strictEqual(await git.isDirty(created.dir), false, 'the new case is committed');
  });

  it('new: SIMILAR_CASES fails the resolution and re-proposes with that case to attach', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand' });
    const tuner = await rt.createCase({ title: 'Book a piano tuner' });
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /A similar case exists: "Book a piano tuner" \(draft\)/);
    assert.strictEqual(r.retry.ok, true);
    const retryQ = rt.questions(door.id).get(r.retry.questionId);
    assert.strictEqual(retryQ.payload.targets['attach-1'], tuner.id);
    assert.ok(!retryQ.options.some((o) => o.id === 'new'));
    const statuses = [...new DetourLog(door.dir).detours().values()].map((d) => [d.id, d.status]);
    assert.deepStrictEqual(statuses, [['d-0001', 'failed'], ['d-0002', 'proposed']]);
    const forced = await router.resolve(door.id, 'd-0001', { optionId: 'new', by: 'in-app', force: true });
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(rt.getCase(forced.linkedCaseId).title, 'Book a piano tuner for the living room');
  });

  it('decline drops a pending blocker and blocks the same proposal for 30 days', async () => {
    const { rt, router, door, clock } = await doorAndPhone();
    const p = await router.propose(door.id, { ...PHONE_FIX, blocks: true });
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'decline' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'decline', by: 'in-app' });
    assert.deepStrictEqual([r.ok, r.linkedCaseId, r.detour.status], [true, null, 'declined']);
    assert.deepStrictEqual(rt.getCase(door.id).related, []);
    const again = await router.propose(door.id, PHONE_FIX);
    assert.deepStrictEqual(again, { ok: false, error: `The owner declined this on 2026-09-23 (${p.questionId}). Do not do it in this case and do not propose it again.` });
    clock.now = new Date('2026-10-24T15:00:00.000Z');
    assert.strictEqual((await router.propose(door.id, PHONE_FIX)).ok, true);
  });

  it('a closed target fails the resolution and re-proposes without it', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    rt.setStatus(phone.id, 'done', { kind: 'owner', by: 'owner' });
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual([r.ok, r.error], [false, 'Case "Phone agent maintenance" is done; pick another option.']);
    const retryQ = rt.questions(door.id).get(r.retry.questionId);
    assert.ok(!Object.values(retryQ.payload.targets).includes(phone.id));
    assert.deepStrictEqual(rt.getCase(phone.id).related, []);
  });

  it('a busy target writes nothing in either case', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    // Another live process holds the target's turn lock.
    fs.writeFileSync(path.join(phone.dir, '.kl', 'lock'), JSON.stringify({ turnId: 'turn-9', pid: process.ppid, at: new Date().toISOString() }));
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    assert.deepStrictEqual(r, { ok: false, error: 'Case "Phone agent maintenance" is busy with another turn. Try again when it finishes.' });
    assert.deepStrictEqual([rt.getCase(door.id).related, rt.getCase(phone.id).related], [[], []]);
    assert.strictEqual(new DetourLog(door.dir).rows().some((x) => x.type === 'resolution'), false);
    assert.strictEqual(new DetourLog(phone.dir).incoming().length, 0);
    fs.rmSync(path.join(phone.dir, '.kl', 'lock'));
  });
});

describe('DetourRouter.reconcile, held proposals and views', () => {
  it('resolves option answers, and turns word answers into awaiting-mapping', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const a = await router.propose(door.id, PHONE_FIX);
    const b = await router.propose(door.id, { summary: 'Order a new doorbell for the side gate', reason: 'Not the rear door' });
    await rt.answerQuestion(door.id, a.questionId, { channel: 'telegram', optionId: 'attach-1' });
    await rt.answerQuestion(door.id, b.questionId, { channel: 'in-app', text: 'put it with the house stuff' });
    const out = await router.reconcile(door.id);
    assert.deepStrictEqual(out, { applied: ['d-0001', 'd-0002'] });
    const log = new DetourLog(door.dir).detours();
    assert.deepStrictEqual([log.get('d-0001').status, log.get('d-0001').last.by], ['attached', 'telegram']);
    assert.strictEqual(log.get('d-0002').status, 'awaiting-mapping');
    assert.ok(rt.getCase(phone.id).related.some((x) => x.id === door.id));
    assert.ok(router.orientationLines(door.id).includes(`The owner answered routing question ${b.questionId} in words: "put it with the house stuff". Call Detour "resolve" with the option that matches, or ask.`));
    assert.deepStrictEqual(await router.reconcile(door.id), { applied: [] });
  });

  it('returns busy without reconciling while another process holds the case', async () => {
    const { rt, router, door } = await doorAndPhone();
    // An answered proposal gives reconcile work to do, so it needs the lock.
    const p = await router.propose(door.id, PHONE_FIX);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    fs.writeFileSync(path.join(door.dir, '.kl', 'lock'), JSON.stringify({ turnId: 'turn-9', pid: process.ppid, at: new Date().toISOString() }));
    assert.deepStrictEqual(await router.reconcile(door.id), { applied: [], busy: true });
    fs.rmSync(path.join(door.dir, '.kl', 'lock'));
    assert.strictEqual(new DetourLog(door.dir).detours().get('d-0001').status, 'proposed', 'nothing resolved while busy');
  });

  it('takes no lock and runs no commit when no routing question has an answer', async () => {
    const { rt, router, door } = await doorAndPhone();
    await router.propose(door.id, PHONE_FIX);
    // A foreign lock would make any systemAction return busy: a precheck that
    // finds nothing to do never reaches it.
    fs.writeFileSync(path.join(door.dir, '.kl', 'lock'), JSON.stringify({ turnId: 'turn-9', pid: process.ppid, at: new Date().toISOString() }));
    let entered = 0;
    const systemAction = rt.systemAction.bind(rt);
    rt.systemAction = (...args) => { entered += 1; return systemAction(...args); };
    try {
      assert.deepStrictEqual(await router.reconcile(door.id), { applied: [] });
      assert.strictEqual(entered, 0);
    } finally {
      fs.rmSync(path.join(door.dir, '.kl', 'lock'));
    }
  });

  it('holds a non-blocking proposal at the daily question cap and asks after the day rolls over', async () => {
    const { rt, router, door, clock } = await doorAndPhone({ cases: { budgets: { questionsPerDay: 1 } } });
    rt.createQuestion(door.id, { kind: 'question', text: 'Which door color?', urgency: 'low' });
    const held = await router.propose(door.id, PHONE_FIX);
    assert.deepStrictEqual([held.ok, held.held, held.questionId, held.detour.status], [true, true, null, 'held']);
    assert.deepStrictEqual(held.detour.options.map((o) => o.optionId), ['attach-1', 'new', 'decline']);
    assert.deepStrictEqual(router.releaseHeld(door.id), []);
    const blocker = await router.propose(door.id, { summary: 'Get the gate code from the landlord', reason: 'The quote visits need it', blocks: true });
    assert.ok(blocker.questionId, 'a blocking proposal overrides the cap');
    assert.strictEqual(rt.questions(door.id).get(blocker.questionId).urgency, 'high');
    clock.now = new Date('2026-09-24T15:00:00.000Z');
    assert.deepStrictEqual(router.releaseHeld(door.id), ['d-0001']);
    const d = new DetourLog(door.dir).detours().get('d-0001');
    assert.strictEqual(d.status, 'proposed');
    assert.match(rt.questions(door.id).get(d.questionId).text, /^Detour from "Rear door quotes" \(d-0001\)/);
  });

  it('list gives titles and statuses only, and marks vanished cases', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    const gone = await rt.createCase({ title: 'Old errand' });
    rt.addRelation(door.id, { id: gone.id, relation: 'related' });
    fs.rmSync(gone.dir, { recursive: true, force: true });
    const view = router.list(door.id);
    assert.deepStrictEqual(view.detours.map((x) => [x.id, x.status, x.questionId]), [['d-0001', 'attached', p.questionId]]);
    assert.deepStrictEqual(view.related, [
      { caseId: phone.id, title: 'Phone agent maintenance', status: 'active', relation: 'related', detour: 'd-0001' },
      { caseId: gone.id, title: null, status: null, relation: 'related', gone: true }
    ]);
  });
});

describe('DetourRouter: serialised per case, bound to the owner answer, never throwing', () => {
  const NEW_WORK = { summary: 'Book a piano tuner for the living room', reason: 'Unrelated errand' };
  const detourJournal = (dir) => fs.readdirSync(path.join(dir, 'journal'))
    .filter((n) => /-detour\.md$/.test(n))
    .map((n) => fs.readFileSync(path.join(dir, 'journal', n), 'utf8'))
    .join('\n');
  const count = (text, needle) => text.split(needle).length - 1;

  it('resolve new racing reconcile creates exactly one case', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, NEW_WORK);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    const before = rt.listCases().length;
    const [r] = await Promise.all([router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' }), router.reconcile(door.id)]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(rt.listCases().length, before + 1);
    assert.strictEqual(new DetourLog(door.dir).rows().filter((x) => x.type === 'resolution').length, 1);
  });

  it('two resolves of the same answer create exactly one case', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, NEW_WORK);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    const before = rt.listCases().length;
    const [a, b] = await Promise.all([
      router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' }),
      router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' })
    ]);
    assert.strictEqual(rt.listCases().length, before + 1);
    assert.deepStrictEqual([a.ok, b.ok, b.existing, b.linkedCaseId], [true, true, true, a.linkedCaseId]);
  });

  it('attach racing reconcile writes one incoming row, one journal entry and one wake-up', async () => {
    const { rt, router, door, phone } = await doorAndPhone();
    const p = await router.propose(door.id, PHONE_FIX);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    await Promise.all([router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' }), router.reconcile(door.id)]);
    assert.strictEqual(new DetourLog(phone.dir).rows().filter((x) => x.type === 'incoming').length, 1);
    assert.strictEqual(count(detourJournal(phone.dir), '# Incoming detour d-0001'), 1);
    assert.strictEqual(rt.wakeups(phone.id).list().filter((x) => x.kind === 'detours:incoming').length, 1);
  });

  it('refuses a resolve the owner has not answered, and one that differs from the answer', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, NEW_WORK);
    const unanswered = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
    assert.strictEqual(unanswered.ok, false);
    assert.match(unanswered.error, new RegExp(`has not answered routing question ${p.questionId}`));
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'decline' });
    const other = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
    assert.strictEqual(other.ok, false);
    assert.match(other.error, /chose "decline"/);
    assert.strictEqual(new DetourLog(door.dir).rows().some((x) => x.type === 'resolution'), false);
    assert.strictEqual((await router.resolve(door.id, p.detour.id, { optionId: 'decline', by: 'in-app' })).ok, true);
  });

  it('a closed routing question can only be declined', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, NEW_WORK);
    rt.questions(door.id).close(p.questionId, { reason: 'stale', by: 'panel' });
    assert.strictEqual((await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' })).ok, false);
    assert.strictEqual((await router.resolve(door.id, p.detour.id, { optionId: 'decline', by: 'in-app' })).ok, true);
  });

  it('refuses to resolve in a paused source case', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, NEW_WORK);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    rt.setStatus(door.id, 'paused', { kind: 'owner', by: 'owner' });
    const r = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
    assert.deepStrictEqual(r, { ok: false, error: 'Case is paused (owner). Only reading is available.' });
  });

  it('an unknown case id is an error result from every public method', async () => {
    const { router } = await doorAndPhone();
    for (const r of [
      await router.propose('no-such-case', PHONE_FIX),
      await router.resolve('no-such-case', 'd-0001', { optionId: 'decline' })
    ]) {
      assert.strictEqual(r.ok, false);
      assert.ok(r.error);
    }
    const rec = await router.reconcile('no-such-case');
    assert.deepStrictEqual(rec.applied, []);
    assert.ok(rec.error);
    assert.deepStrictEqual(router.releaseHeld('no-such-case'), []);
    assert.deepStrictEqual(router.orientationLines('no-such-case'), []);
    const view = router.list('no-such-case');
    assert.deepStrictEqual([view.detours, view.related], [[], []]);
    assert.ok(view.error);
  });

  it('a git failure while creating the case is an error result and a failed row', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, NEW_WORK);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    const create = rt.store.create.bind(rt.store);
    rt.store.create = async () => { throw new Error('git init failed (simulated)'); };
    try {
      const r = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /git init failed \(simulated\)/);
    } finally {
      rt.store.create = create;
    }
    const d = new DetourLog(door.dir).detours().get(p.detour.id);
    assert.deepStrictEqual([d.status, d.last.targetCaseId], ['failed', null]);
    assert.deepStrictEqual(await router.reconcile(door.id), { applied: [] }, 'a failed detour is not retried on every render');
  });

  it('a failure after the new case exists records it, and the next resolve reuses it', async () => {
    const { rt, router, door } = await doorAndPhone();
    const p = await router.propose(door.id, NEW_WORK);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'new' });
    const before = rt.listCases().length;
    const addRelation = rt.addRelation.bind(rt);
    rt.addRelation = (id, entry) => {
      if (entry.relation === 'spawned') throw new Error('case.yaml write failed (simulated)');
      return addRelation(id, entry);
    };
    let first;
    try {
      first = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
    } finally {
      rt.addRelation = addRelation;
    }
    assert.strictEqual(first.ok, false);
    const d = new DetourLog(door.dir).detours().get(p.detour.id);
    assert.strictEqual(d.status, 'failed');
    assert.ok(d.last.targetCaseId && rt.store.get(d.last.targetCaseId), 'the orphan case is recorded');
    assert.strictEqual(rt.listCases().length, before + 1);
    const second = await router.resolve(door.id, p.detour.id, { optionId: 'new', by: 'in-app' });
    assert.deepStrictEqual([second.ok, second.linkedCaseId], [true, d.last.targetCaseId]);
    assert.strictEqual(rt.listCases().length, before + 1, 'no second case');
    assert.deepStrictEqual(rt.getCase(door.id).related.map((x) => [x.id, x.relation]), [[d.last.targetCaseId, 'spawned']]);
  });
});

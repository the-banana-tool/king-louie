// tests/cases-questions.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FactLedger, LedgerError } = require('../src/cases/ledger');
const { QuestionStore, QuestionError } = require('../src/cases/questions');
const { CaseRecords } = require('../src/cases/records');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function caseDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-questions-'));
  dirs.push(d);
  for (const sub of ['.kl', 'journal']) fs.mkdirSync(path.join(d, sub));
  fs.writeFileSync(path.join(d, 'case.yaml'), 'id: case-lakeside\nslug: lakeside-lot\ntitle: Lakeside lot\nstatus: active\n');
  fs.writeFileSync(path.join(d, 'facts.jsonl'), '');
  return d;
}
const T0 = new Date('2026-09-23T12:00:00.000Z');
const ask = (over = {}) => ({ kind: 'question', text: 'Is the well on the lot shared with the neighbour?', urgency: 'normal', ...over });
const code = (c) => (err) => err instanceof QuestionError && err.code === c;

describe('host-reserved ledger source kinds', () => {
  it('ties question and owner-action sources to provenance user, and user to a host kind', () => {
    const l = new FactLedger(caseDir());
    const base = { stmt: 'Owner said so', subject: 'lot', attr: 'x', value: 1 };
    assert.throws(() => l.assert({ ...base, provenance: 'sourced', source: { kind: 'question', ref: 'q-0001' } }), LedgerError);
    assert.throws(() => l.assert({ ...base, provenance: 'external-agent', source: { kind: 'owner-action', ref: 'grant' } }), LedgerError);
    assert.throws(() => l.assert({ ...base, provenance: 'user', source: { kind: 'url', ref: 'https://records.example.org/1' } }), /host-verified owner source/);
    assert.strictEqual(l.assert({ ...base, provenance: 'user', source: { kind: 'owner-action', ref: 'grant' } }).provenance, 'user');
    assert.strictEqual(l.assert({ ...base, provenance: 'user', source: { kind: 'question', ref: 'q-0001' } }).provenance, 'user');
  });

  it('keeps a requested disclosable: false', () => {
    const l = new FactLedger(caseDir());
    const f = l.assert({ stmt: 's', subject: 'a', attr: 'b', value: 1, source: { kind: 'url', ref: 'https://records.example.org/1' }, disclosable: false });
    assert.strictEqual(f.disclosable, false);
  });
});

describe('QuestionStore.create', () => {
  it('fills the record and numbers ids by replaying the directory', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask());
    assert.strictEqual(q.id, 'q-0001');
    assert.strictEqual(q.caseId, 'case-lakeside');
    assert.strictEqual(q.createdAt, T0.toISOString());
    assert.deepStrictEqual(q.deliveries, []);
    assert.strictEqual(q.answer, null);
    assert.strictEqual(q.closed, null);
    assert.strictEqual(q.defaultOnSilence, 'hold');
    assert.deepStrictEqual(q.payload, { type: 'ask', mcpAnswerable: true });
    assert.deepStrictEqual(q.options, []);
    assert.strictEqual(new QuestionStore(d, { now: () => T0 }).create(ask({ text: 'Who holds the easement?' })).id, 'q-0002');
  });

  it('applies every validation rule', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const bad = [
      ask({ kind: 'poll' }),
      ask({ text: '   ' }),
      ask({ text: 'x'.repeat(2001) }),
      ask({ options: 'a,b' }),
      ask({ options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) }),
      ask({ options: [{ id: 'Bad Id', label: 'x' }] }),
      ask({ options: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }),
      ask({ options: [{ id: 'a', label: '' }] }),
      ask({ options: [{ id: 'a', label: 'x'.repeat(201) }] }),
      ask({ kind: 'briefing', options: [{ id: 'a', label: 'x' }] }),
      ask({ urgency: undefined }),
      ask({ urgency: 'urgent' }),
      ask({ expiresAt: 'next week' }),
      ask({ expiresAt: '2026-09-22T12:00:00Z' }),
      ask({ expiresAt: '2026-10-24T12:00:01Z' }),
      ask({ options: [{ id: 'a', label: 'Yes' }], defaultOnSilence: 'b' }),
      ask({ kind: 'briefing', defaultOnSilence: 'a' }),
      ask({ payload: { type: 7 } }),
      ask({ payload: { mcpAnswerable: 'no' } })
    ];
    for (const record of bad) assert.throws(() => s.create(record), code('INVALID'), JSON.stringify(record).slice(0, 80));
    const ok = s.create(ask({ options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], defaultOnSilence: 'no', expiresAt: '2026-10-23T12:00:00Z', payload: { type: 'direction', mcpAnswerable: false } }));
    assert.strictEqual(ok.defaultOnSilence, 'no');
    assert.strictEqual(ok.expiresAt, '2026-10-23T12:00:00.000Z');
    assert.deepStrictEqual(ok.payload, { type: 'direction', mcpAnswerable: false });
    assert.strictEqual(s.create({ kind: 'approval', text: 'Approve the envelope?', urgency: 'high' }).kind, 'approval');
  });

  it('returns the open duplicate instead of a new record, by text or by payload key', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const a = s.create(ask());
    assert.strictEqual(s.create(ask({ text: '  is the WELL on the lot shared with the neighbour? ' })).id, a.id);
    assert.notStrictEqual(s.create(ask({ kind: 'briefing', urgency: 'low' })).id, a.id);
    const b = s.create(ask({ text: 'Spent 20.1 of 20', payload: { type: 'budget-grant', key: 'budget-grant:usd' } }));
    assert.strictEqual(s.create(ask({ text: 'Spent 20.4 of 20', payload: { type: 'budget-grant', key: 'budget-grant:usd' } })).id, b.id);
    assert.strictEqual(s.findDuplicate(ask()).id, a.id);
  });

  it('refuses ids that are not question ids', () => {
    const s = new QuestionStore(caseDir());
    assert.strictEqual(s.get('../../case'), null);
    assert.throws(() => s.answer('../../case', { text: 'x' }), code('NOT_FOUND'));
  });
});

describe('QuestionStore.answer', () => {
  it('writes exactly one user fact with a question source, the answer, and a journal entry', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ options: [{ id: 'yes', label: 'Shared' }, { id: 'no', label: 'Not shared' }] }));
    const answered = s.answer(q.id, { channel: 'in-app', optionId: 'no' });
    const facts = [...new FactLedger(d).view().facts.values()];
    assert.strictEqual(facts.length, 1);
    const [fact] = facts;
    assert.strictEqual(fact.provenance, 'user');
    assert.deepStrictEqual(fact.source, { kind: 'question', ref: q.id, channel: 'in-app', at: T0.toISOString() });
    assert.strictEqual(fact.subject, 'question');
    assert.strictEqual(fact.attr, q.id);
    assert.strictEqual(fact.value, 'Not shared');
    assert.strictEqual(fact.stmt, 'Owner answered q-0001 ("Is the well on the lot shared with the neighbour?"): Not shared');
    assert.deepStrictEqual(answered.answer, { channel: 'in-app', at: T0.toISOString(), text: null, optionId: 'no', factId: fact.id });
    assert.match(new CaseRecords(d).lastJournal().text, /q-0001 answered via in-app: Not shared \(fact f-0001\)/);
    assert.deepStrictEqual(s.open(), []);
  });

  it('lands the fact on payload.about, supersedes payload.resolves, and honours disclosable and gating.category', () => {
    const d = caseDir();
    const l = new FactLedger(d);
    const u = l.unknown({ stmt: 'Is the well shared?', subject: 'lot', attr: 'well', changes: 'Buyer cost', answerable: 'owner', how: 'Ask' });
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ payload: { about: { subject: 'lot', attr: 'well' }, resolves: u.id, disclosable: false, gating: { category: 'property' } } }));
    s.answer(q.id, { channel: 'in-app', text: 'Shared with the north neighbour' });
    const view = l.view().facts;
    assert.strictEqual(view.get(u.id).status, 'superseded');
    const fact = view.get(view.get(u.id).supersededBy);
    assert.strictEqual(fact.subject, 'lot');
    assert.strictEqual(fact.attr, 'well');
    assert.strictEqual(fact.value, 'Shared with the north neighbour');
    assert.strictEqual(fact.disclosable, false);
    assert.strictEqual(fact.category, 'property');
  });

  it('uses a registered handler to build the fact', () => {
    QuestionStore.registerAnswerHandler('test-color', {
      toFact: (record, answer) => ({ stmt: `Owner picked ${answer.text}`, subject: 'paint', attr: 'color', value: answer.text.toUpperCase() })
    });
    assert.strictEqual(typeof QuestionStore.answerHandler('test-color').toFact, 'function');
    assert.strictEqual(QuestionStore.answerHandler('nope'), null);
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ text: 'Which color?', payload: { type: 'test-color' } }));
    s.answer(q.id, { channel: 'in-app', text: 'green' });
    const [fact] = new FactLedger(d).view().facts.values();
    assert.strictEqual(fact.value, 'GREEN');
    assert.strictEqual(fact.subject, 'paint');
  });

  it('two stores answering the same question write exactly one fact', () => {
    const d = caseDir();
    const q = new QuestionStore(d, { now: () => T0 }).create(ask());
    const desk = new QuestionStore(d, { now: () => T0 });
    const phone = new QuestionStore(d, { now: () => T0 });
    desk.answer(q.id, { channel: 'in-app', text: 'Yes, shared' });
    assert.throws(() => phone.answer(q.id, { channel: 'telegram', text: 'No' }), (err) => (
      err.code === 'ALREADY_ANSWERED'
      && err.message === `q-0001 was already answered via in-app at ${T0.toISOString()}.`
      && err.record.answer.text === 'Yes, shared'
    ));
    assert.strictEqual(new FactLedger(d).view().facts.size, 1);
  });

  it('refuses an empty answer, an unknown option, and answering a briefing', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const q = s.create(ask({ options: [{ id: 'yes', label: 'Yes' }] }));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', text: '  ' }), code('INVALID'));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', optionId: 'maybe' }), code('INVALID'));
    const b = s.create({ kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    assert.throws(() => s.answer(b.id, { channel: 'in-app', text: 'ok' }), code('IS_BRIEFING'));
    assert.strictEqual(s.get(q.id).answer, null, 'a refused answer leaves the question open');
  });

  it('releases the claim when the fact cannot be written', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask({ payload: { resolves: 'f-0404' } }));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', text: 'Yes' }), /f-0404/);
    assert.strictEqual(fs.existsSync(path.join(d, '.kl', 'questions', `${q.id}.claim`)), false);
  });
});

describe('briefings, deliveries, expiry and closing', () => {
  it('acknowledges a briefing without a fact', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const b = s.create({ kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    const acked = s.acknowledge(b.id, { channel: 'in-app' });
    assert.deepStrictEqual(acked.answer, { channel: 'in-app', at: T0.toISOString(), text: null, optionId: null, factId: null });
    assert.strictEqual(new FactLedger(d).view().facts.size, 0);
    assert.throws(() => s.acknowledge(s.create(ask()).id, { channel: 'in-app' }), code('NOT_BRIEFING'));
    assert.throws(() => s.acknowledge(b.id, { channel: 'in-app' }), code('ALREADY_ANSWERED'));
  });

  it('records each delivery once and keeps notes', () => {
    const s = new QuestionStore(caseDir(), { now: () => T0 });
    const q = s.create(ask());
    s.recordDelivery(q.id, { channel: 'in-app', at: T0.toISOString(), deliveryId: 'in-app-q-0001' });
    const r = s.recordDelivery(q.id, { channel: 'in-app', at: T0.toISOString(), deliveryId: 'in-app-q-0001' });
    assert.deepStrictEqual(r.deliveries, [{ channel: 'in-app', at: T0.toISOString(), deliveryId: 'in-app-q-0001' }]);
    assert.deepStrictEqual(s.note(q.id, 'Raise the usd budget first.').notes, [{ at: T0.toISOString(), text: 'Raise the usd budget first.' }]);
  });

  it('expires: hold stays open and overdue, a default option applies without a fact, a briefing lapses', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const exp = '2026-09-24T12:00:00Z';
    const hold = s.create(ask({ expiresAt: exp }));
    const dflt = s.create(ask({ text: 'Relist at the same price?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], defaultOnSilence: 'no', expiresAt: exp }));
    const brief = s.create({ kind: 'briefing', text: 'Open house on Saturday.', urgency: 'low', expiresAt: exp });
    const later = new Date('2026-09-25T00:00:00Z');
    assert.deepStrictEqual(s.expire(new Date('2026-09-24T00:00:00Z')), { expired: [], overdue: [] });
    const r = s.expire(later);
    assert.deepStrictEqual(r, { expired: [dflt.id, brief.id], overdue: [hold.id] });
    assert.strictEqual(s.get(hold.id).answer, null);
    assert.deepStrictEqual(s.get(dflt.id).answer, { channel: 'default', at: later.toISOString(), text: null, optionId: 'no', factId: null });
    assert.strictEqual(s.get(brief.id).answer.channel, 'expired');
    assert.strictEqual(new FactLedger(d).view().facts.size, 0);
    assert.match(new CaseRecords(d).lastJournal().text, /expired: default no applied/);
    assert.throws(() => s.answer(dflt.id, { channel: 'in-app', text: 'Yes' }), code('ALREADY_ANSWERED'), 'expire holds the claim');
  });

  it('closes a record without an answer or a fact, and journals it', () => {
    const d = caseDir();
    const s = new QuestionStore(d, { now: () => T0 });
    const q = s.create(ask());
    const closed = s.close(q.id, { reason: 'resolved in a call', by: 'panel' });
    assert.deepStrictEqual(closed.closed, { at: T0.toISOString(), reason: 'resolved in a call', by: 'panel' });
    assert.strictEqual(closed.answer, null);
    assert.deepStrictEqual(s.open(), []);
    assert.strictEqual(new FactLedger(d).view().facts.size, 0);
    assert.match(new CaseRecords(d).lastJournal().text, /q-0001 closed by panel: resolved in a call/);
    assert.throws(() => s.close(s.create(ask({ text: 'Another?' })).id, { reason: 'x', by: 'robot' }), code('INVALID'));
    assert.throws(() => s.answer(q.id, { channel: 'in-app', text: 'late' }), code('ALREADY_ANSWERED'));
  });
});

describe('answers through the runtime', () => {
  const { CaseRuntime } = require('../src/cases');
  const git = require('../src/cases/git');

  function runtime() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-answers-'));
    dirs.push(root);
    const events = [];
    const rt = new CaseRuntime({
      root,
      now: () => T0,
      getSettings: () => ({ cases: { timeZone: 'UTC' } }),
      host: { notify: (e, p) => events.push([e, p]), interactive: () => true }
    });
    return { rt, events };
  }

  async function activeCase(rt, title = 'Lakeside lot') {
    const info = await rt.createCase({ title, objective: 'Convert the lot to cash' });
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
    rt.completeGating(info.id);
    return rt.getCase(info.id);
  }

  const report = { failureClass: 'dead-end', what: 'County listing', tried: ['Listed on the county site'], why: 'No buyers replied in 60 days', unknowns: [] };

  it('answerQuestion writes the fact, registers a retry wake-up, notifies, commits, and refuses a second answer', async () => {
    const { rt, events } = runtime();
    const c = await activeCase(rt);
    const q = rt.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    const out = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'Yes, with the north lot' });
    assert.strictEqual(out.fact.source.kind, 'question');
    assert.strictEqual(out.question.answer.factId, out.fact.id);
    assert.deepStrictEqual(out.effect, { applied: false });
    const retry = rt.wakeups(c.id).list().find((w) => w.kind === 'retry');
    assert.deepStrictEqual(retry.payload, { key: `answered:${q.id}`, questionId: q.id });
    assert.strictEqual(retry.nextAt, T0.toISOString());
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'questions' && p.questionId === q.id));
    assert.strictEqual(await git.isDirty(c.dir), false, 'systemAction committed the answer');
    await assert.rejects(rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'No' }), (err) => err.code === 'ALREADY_ANSWERED');
    assert.strictEqual(rt.ledger(c.id).query({ subject: 'question' }).length, 1);
  });

  it('recordFailure writes the report, waits for direction, and asks a high direction question', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const f = rt.ledger(c.id).assert({ stmt: 'An auction house takes rural lots', subject: 'market', attr: 'auction', value: 'yes', source: { kind: 'url', ref: 'https://auctions.example.com/rural' } });
    const failure = rt.recordFailure(c.id, { ...report, recommendation: { claims: [{ text: 'Try an auction house', factIds: [f.id] }] }, turnId: 't1' });
    assert.strictEqual(failure.journal, 'journal/2026-09-23-1200-failure.md');
    assert.match(failure.rendered, /^# Failure report — County listing\n\nClass: dead-end\n\nTried:\n- Listed on the county site\n\nWhy: No buyers replied in 60 days\n\nUnknowns:\n- none\n\nRecommendation:\n- Try an auction house \[f-0001\]\n\nWaiting for the owner's direction\.$/);
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref, meta.statusReason.failureClass], ['needs-direction', 'failure', failure.journal, 'dead-end']);
    const q = rt.questions(c.id).get(failure.questionId);
    assert.deepStrictEqual([q.urgency, q.payload.type, q.payload.mcpAnswerable, q.payload.failure], ['high', 'direction', false, failure.journal]);
    const recs = fs.readFileSync(path.join(c.dir, '.kl', 'recommendations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(recs.at(-1).failure, failure.journal);
    assert.strictEqual(rt.ledger(c.id).view().facts.get(f.id).loadBearing, true);
  });

  it('a direction answer resumes the case', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, report);
    const out = await rt.answerQuestion(c.id, failure.questionId, { channel: 'in-app', text: 'Try a land auction instead' });
    assert.deepStrictEqual([out.fact.subject, out.fact.attr], ['direction', '2026-09-23-1200-failure']);
    assert.deepStrictEqual(out.effect, { applied: 'direction' });
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.statusReason.ref], ['active', 'direction', out.fact.id]);
  });

  it('a direction answer while usd is spent leaves the case paused and notes why on the question', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, report);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.budget(c.id).charge('usd', 1);
    const out = await rt.answerQuestion(c.id, failure.questionId, { channel: 'in-app', text: 'Go ahead with the auction' });
    assert.strictEqual(out.effect.applied, false);
    assert.deepStrictEqual([rt.getCase(c.id).status, rt.getCase(c.id).statusReason.kind], ['paused', 'budget']);
    assert.strictEqual(rt.questions(c.id).get(failure.questionId).notes[0].text, 'Raise the usd budget first.');
    assert.ok(rt.questions(c.id).open().some((q) => q.payload.type === 'budget-grant'));
  });

  it('a direction given over budget resumes to active once granted, not needs-direction (F1)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, report);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.budget(c.id).charge('usd', 1);
    const out = await rt.answerQuestion(c.id, failure.questionId, { channel: 'in-app', text: 'Go ahead with the auction' });
    assert.strictEqual(out.effect.applied, false);
    // The direction fact was already applied to the ledger; only the
    // budget stands in the way, so resuming must land on active, not
    // needs-direction (where nothing is open any more — the direction
    // question was already answered and consumed).
    assert.deepStrictEqual(
      [rt.getCase(c.id).status, rt.getCase(c.id).statusReason.kind, rt.getCase(c.id).statusReason.resumeTo],
      ['paused', 'budget', 'active']
    );
    const grantQ = rt.questions(c.id).open().find((q) => q.payload.type === 'budget-grant');
    const grant = await rt.answerQuestion(c.id, grantQ.id, { channel: 'in-app', text: '5 dollars' });
    assert.deepStrictEqual(grant.effect, { applied: 'budget', resumed: true });
    assert.strictEqual(rt.getCase(c.id).status, 'active');
    assert.deepStrictEqual(rt.questions(c.id).open(), []);
  });

  it('a budget-grant answer with a number above spend resumes; a reply without one keeps the case paused', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1.2).crossedNow);
    const first = rt.questions(c.id).open().find((q) => q.payload.type === 'budget-grant');
    const reply = await rt.answerQuestion(c.id, first.id, { channel: 'in-app', text: 'sure, go on' });
    assert.deepStrictEqual([reply.fact.attr, reply.fact.value], ['usd-reply', 'sure, go on']);
    assert.deepStrictEqual(reply.effect, { applied: false, reason: 'no-limit' });
    assert.strictEqual(rt.getCase(c.id).status, 'paused');
    assert.ok(fs.readdirSync(path.join(c.dir, 'journal')).some((n) => /-question(-\d+)?\.md$/.test(n)
      && /no usable usd limit, so the case stays paused/.test(fs.readFileSync(path.join(c.dir, 'journal', n), 'utf8'))));

    const again = rt.onCrossings(c.id, 'usd', [100]);
    const grant = await rt.answerQuestion(c.id, again.id, { channel: 'in-app', text: '2 dollars' });
    assert.deepStrictEqual([grant.fact.subject, grant.fact.attr, grant.fact.value], ['budget', 'usd', 2]);
    assert.deepStrictEqual(grant.effect, { applied: 'budget', resumed: true });
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.budget.usd], ['active', 'budget-grant', 2]);
    assert.deepStrictEqual(rt.budget(c.id).status().usd.grantedBy, [grant.fact.id]);
  });

  it('a question-sourced grant reply below current spend notes the question and re-asks (F2)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1.2).crossedNow);
    const first = rt.questions(c.id).open().find((q) => q.payload.type === 'budget-grant');
    const reply = await rt.answerQuestion(c.id, first.id, { channel: 'in-app', text: '1' });
    assert.deepStrictEqual([reply.fact.subject, reply.fact.attr, reply.fact.value], ['budget', 'usd', 1]);
    assert.deepStrictEqual(reply.effect, { applied: false, note: 'A usd limit must be a number above the current spend.' });
    assert.strictEqual(rt.questions(c.id).get(first.id).notes[0].text, 'A usd limit must be a number above the current spend.');
    assert.strictEqual(rt.getCase(c.id).status, 'paused');
    const fresh = rt.questions(c.id).open().find((q) => q.payload.type === 'budget-grant');
    assert.ok(fresh && fresh.id !== first.id, 'a fresh budget-grant question is open so the owner can try again');
  });

  it('a budget fact quoted from chat changes no limit', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const fact = rt.ledger(c.id).assert({ stmt: 'Owner said ok', subject: 'budget', attr: 'usd', value: 500, provenance: 'user', source: { kind: 'user-message', ref: 't1', quote: 'ok' } });
    assert.deepStrictEqual(rt.applyOwnerFact(c.id, fact), { applied: false, note: "Budget limits change only through the owner's answer or the Grant button." });
    assert.strictEqual(rt.getCase(c.id).budget, undefined);
  });

  it('grantBudget writes an owner-action fact and resumes a budget pause', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1).crossedNow);
    const out = await rt.grantBudget(c.id, 'usd', 5);
    assert.deepStrictEqual([out.fact.provenance, out.fact.source.kind, out.fact.value], ['user', 'owner-action', 5]);
    assert.deepStrictEqual([out.case.status, out.case.budget.usd], ['active', 5]);
    const deadline = await rt.grantBudget(c.id, 'deadline', '2099-12-31');
    assert.strictEqual(deadline.case.budget.deadline, '2099-12-31');
    assert.ok(rt.wakeups(c.id).list().some((w) => w.kind === 'deadline-check'));
  });

  it('acknowledgeBriefing dismisses a briefing without a fact or a wake-up', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const b = rt.createQuestion(c.id, { kind: 'briefing', text: 'The listing went live.', urgency: 'low' });
    const acked = await rt.acknowledgeBriefing(c.id, b.id);
    assert.strictEqual(acked.answer.channel, 'in-app');
    assert.strictEqual(rt.ledger(c.id).query({}).length, 0);
    assert.ok(!rt.wakeups(c.id).list().some((w) => w.kind === 'retry'));
  });

  it('a budget grant on a case the owner paused raises the limit but leaves the case paused with its owner reason', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner' });
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.budget(c.id).charge('usd', 1.5);
    const out = await rt.grantBudget(c.id, 'usd', 5);
    assert.deepStrictEqual([out.fact.subject, out.fact.attr, out.fact.value], ['budget', 'usd', 5]);
    assert.deepStrictEqual(out.effect, { applied: 'budget', resumed: false });
    const meta = rt.getCase(c.id);
    assert.deepStrictEqual([meta.status, meta.statusReason.kind, meta.budget.usd], ['paused', 'owner', 5]);
  });

  it('an "ask" question whose fact happens to look like a budget grant changes no limit (I1)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const q = rt.createQuestion(c.id, {
      kind: 'question',
      text: 'What is the current spend cap?',
      urgency: 'normal',
      payload: { about: { subject: 'budget', attr: 'usd' } }
    });
    assert.strictEqual(q.payload.type, 'ask');
    const out = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: '100' });
    assert.deepStrictEqual(out.effect, { applied: false });
    assert.strictEqual(rt.getCase(c.id).budget, undefined);
  });

  it('an "ask" question whose fact happens to look like a direction does not resume the case (I1)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, report);
    const q = rt.createQuestion(c.id, {
      kind: 'question',
      text: 'Anything else going on?',
      urgency: 'normal',
      payload: { about: { subject: 'direction', attr: path.basename(failure.journal, '.md') } }
    });
    const out = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'Try a land auction instead' });
    assert.deepStrictEqual(out.effect, { applied: false });
    assert.strictEqual(rt.getCase(c.id).status, 'needs-direction');
  });

  it('a usd crossing while needs-direction resumes to needs-direction after a grant (I2)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, report);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1).crossedNow);
    assert.deepStrictEqual([rt.getCase(c.id).status, rt.getCase(c.id).statusReason.kind, rt.getCase(c.id).statusReason.resumeTo], ['paused', 'budget', 'needs-direction']);
    const grant = await rt.grantBudget(c.id, 'usd', 5);
    assert.deepStrictEqual([grant.case.status, grant.effect], ['needs-direction', { applied: 'budget', resumed: true }]);
    const direction = rt.questions(c.id).get(failure.questionId);
    assert.ok(direction && direction.answer === null && !direction.closed, 'the direction question is still open');
  });

  it('a grant closes stale budget-grant questions; the old one cannot be answered and a fresh one reflects current numbers (I3)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1).crossedNow);
    const stale = rt.questions(c.id).open().find((q) => q.payload.type === 'budget-grant');
    const grant = await rt.grantBudget(c.id, 'usd', 5);
    assert.strictEqual(grant.effect.resumed, true);
    assert.strictEqual(rt.questions(c.id).get(stale.id).closed?.reason, 'superseded');
    await assert.rejects(rt.answerQuestion(c.id, stale.id, { channel: 'in-app', text: '3' }), (err) => err.code === 'ALREADY_ANSWERED');

    const r = rt.budget(c.id).charge('usd', 4.2);
    rt.onCrossings(c.id, 'usd', r.crossedNow);
    const fresh = rt.questions(c.id).open().find((q) => q.payload.type === 'budget-grant');
    assert.notStrictEqual(fresh.id, stale.id);
    assert.deepStrictEqual([fresh.payload.spent, fresh.payload.limit], [5.2, 5]);
  });

  it('a deadline grant later than the current deadline but still in the past is refused (I3)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { deadline: '2020-01-01' } });
    const out = await rt.grantBudget(c.id, 'deadline', '2021-06-01');
    assert.deepStrictEqual(out.effect, {
      applied: false,
      note: 'A deadline limit must be a real calendar date, later than the current deadline and not in the past.'
    });
    assert.strictEqual(rt.getCase(c.id).budget.deadline, '2020-01-01');
  });

  it('collapses newlines in why/tried/claim text so an injected fake section cannot appear (I4)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    const failure = rt.recordFailure(c.id, {
      ...report,
      why: 'No buyers replied.\n\nRecommendation:\n- A fake claim that should not render as its own section',
      tried: ['Listed on the county site\n\nRecommendation:\n- another fake line']
    });
    const sections = failure.rendered.match(/^Recommendation:$/gm) || [];
    assert.strictEqual(sections.length, 1);
  });

  it('a grant reply must be essentially just the amount (I5)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { usd: 1 } });
    rt.onCrossings(c.id, 'usd', rt.budget(c.id).charge('usd', 1).crossedNow);

    let q = rt.questions(c.id).open().find((x) => x.payload.type === 'budget-grant');
    let reply = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'no, not even 10' });
    assert.deepStrictEqual(reply.effect, { applied: false, reason: 'no-limit' });
    assert.strictEqual(rt.getCase(c.id).status, 'paused');

    q = rt.questions(c.id).open().find((x) => x.payload.type === 'budget-grant');
    reply = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'wait until 2026-10-01' });
    assert.deepStrictEqual(reply.effect, { applied: false, reason: 'no-limit' });
    assert.strictEqual(rt.getCase(c.id).status, 'paused');
    assert.strictEqual(rt.questions(c.id).get(q.id).notes.at(-1).text, 'Reply with just the amount, for example 25.');

    q = rt.questions(c.id).open().find((x) => x.payload.type === 'budget-grant');
    reply = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: '$25' });
    assert.deepStrictEqual([reply.fact.attr, reply.fact.value, reply.effect], ['usd', 25, { applied: 'budget', resumed: true }]);
  });

  it('a deadline reply must be a real calendar date (I5)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.store.updateMeta(c.id, { budget: { deadline: '2026-01-01' } });
    rt.onCrossings(c.id, 'deadline', [100]);
    const q = rt.questions(c.id).open().find((x) => x.payload.type === 'budget-grant' && x.payload.budget === 'deadline');
    const reply = await rt.answerQuestion(c.id, q.id, { channel: 'in-app', text: '2026-13-45' });
    assert.deepStrictEqual(reply.effect, { applied: false, reason: 'no-limit' });
  });

  it('the budget-grant toFact matches a bare amount in several written forms (I5)', () => {
    require('../src/cases'); // ensure answer-handlers.js has registered its handlers
    const handler = QuestionStore.answerHandler('budget-grant');
    const record = (budget) => ({ id: 'q-0001', payload: { budget } });
    const of = (budget, text) => handler.toFact(record(budget), { text, optionId: null });
    assert.deepStrictEqual([of('usd', '$25').attr, of('usd', '$25').value], ['usd', 25]);
    assert.deepStrictEqual([of('usd', '25 usd').attr, of('usd', '25 usd').value], ['usd', 25]);
    assert.deepStrictEqual([of('usd', '25').attr, of('usd', '25').value], ['usd', 25]);
    assert.strictEqual(of('usd', 'no, not even 10').attr, 'usd-reply');
    assert.strictEqual(of('usd', 'wait until 2026-10-01').attr, 'usd-reply');
    assert.strictEqual(of('deadline', '2026-13-45').attr, 'deadline-reply');
    assert.deepStrictEqual([of('deadline', '2026-10-01').attr, of('deadline', '2026-10-01').value], ['deadline', '2026-10-01']);
    assert.deepStrictEqual([of('turnsPerDay', '10').attr, of('turnsPerDay', '10').value], ['turnsPerDay', 10]);
    assert.strictEqual(of('turnsPerDay', '10.5').attr, 'turnsPerDay-reply');
  });

  it('recordFailure checks the transition before writing anything, leaving no partial state on a refusal (minor fix)', async () => {
    const { rt } = runtime();
    const c = await activeCase(rt);
    rt.setStatus(c.id, 'paused', { kind: 'owner', by: 'owner' });
    const journalBefore = fs.readdirSync(path.join(c.dir, 'journal'));
    assert.throws(() => rt.recordFailure(c.id, report), (err) => err.code === 'BAD_TRANSITION');
    assert.deepStrictEqual(fs.readdirSync(path.join(c.dir, 'journal')), journalBefore);
    assert.strictEqual(fs.existsSync(path.join(c.dir, '.kl', 'recommendations.jsonl')), false);
    assert.strictEqual(rt.getCase(c.id).status, 'paused');
  });
});

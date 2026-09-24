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

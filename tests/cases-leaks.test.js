// tests/cases-leaks.test.js
// Cross-case leak paths (cases stage 5 spec §8, §10): each named test pins
// one way another case's private text could reach this case.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { findDuplicates, OPEN_CASE_STATUSES } = require('../src/cases/gates');
const { LedgerTool } = require('../src/tools/builtin/case-tools');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-leaks-')); dirs.push(d); return d; };

// F5-cross-case: case B holds a financial, non-disclosable fact.
const PRIVATE_STMT = 'Payoff letter for the house loan, good through the 7th';
const PRIVATE_VALUE = '120417';

async function fixture() {
  const rt = new CaseRuntime({ root: tmp() });
  const b = await rt.createCase({ title: 'Household inventory' });
  const fact = rt.ledger(b.id).assert({ stmt: PRIVATE_STMT, subject: 'house-loan', attr: 'payoff', value: Number(PRIVATE_VALUE), category: 'financial', source: { kind: 'document', ref: 'sources/payoff-letter.pdf' } });
  assert.strictEqual(fact.disclosable, false);
  const a = await rt.createCase({ title: 'House sale', objective: 'Sell the house this autumn' });
  return { rt, a, b };
}

const leaks = (value) => {
  const blob = JSON.stringify(value);
  return blob.includes('Payoff letter') || blob.includes(PRIVATE_VALUE) || blob.includes('good through the 7th');
};

describe('cross-case leak paths', () => {
  it('a private fact from case B never appears in any hit text returned to case A', async () => {
    const { rt, a, b } = await fixture();
    const text = 'Need the house loan payoff letter';

    const hits = rt.index.search({ text, subject: 'house-loan', attr: 'payoff', forCaseId: a.id, excludeCaseId: a.id, statuses: OPEN_CASE_STATUSES });
    assert.ok(hits.some((h) => h.caseId === b.id && h.kind === 'fact'), 'the fact is found');
    assert.ok(hits.filter((h) => h.caseId === b.id).every((h) => h.text === null && h.redacted === true));
    assert.strictEqual(leaks(hits), false);

    const cases = rt.index.searchCases({ text: `${text} ${PRIVATE_STMT}`, forCaseId: a.id, excludeCaseId: a.id });
    assert.deepStrictEqual(cases.map((c) => c.caseId), [b.id]);
    assert.strictEqual(leaks(cases), false);

    const rows = findDuplicates({ subject: 'house-loan', attr: 'payoff', text, facts: new Map(), crossCaseHits: hits });
    assert.deepStrictEqual(rows.similar.map((r) => [r.caseTitle, r.stmt]), [['Household inventory', '(private fact in "Household inventory" — open that case to see it)']]);
    assert.strictEqual(leaks(rows), false);

    const turn = await rt.beginTurn(a.id, { turnId: 'turn-1' });
    const out = await LedgerTool.execute({ action: 'unknown', stmt: text, subject: 'house-loan', attr: 'payoff', changes: 'Net proceeds', answerable: 'owner', how: 'Ask for the letter' }, { caseContext: rt.caseContext(turn) });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.similarInOtherCases.map((m) => m.caseTitle), ['Household inventory']);
    assert.strictEqual(leaks(out), false);
    await rt.endTurn(turn, { summary: 'unknown recorded' });
  });

  it('a private fact from case B reaches neither a tool result nor the orientation of case A', async () => {
    const { rt, a, b } = await fixture();
    // Relate A to B so the orientation names B, and a tool call that tries to
    // steer the search at B: the runtime's own case id wins over tool input.
    rt.addRelation(a.id, { id: b.id, relation: 'related', note: 'Same household' });
    // A's own active fact matches the stmt (on another key, so the unknown is
    // not refused as an exact duplicate): excludeCaseId from params must not
    // bring it back as a cross-case hit.
    rt.ledger(a.id).assert({ stmt: 'Need the house loan payoff letter from the bank', subject: 'bank', attr: 'letter', value: 'requested', source: { kind: 'url', ref: 'https://records.example.org/2' } });
    const turn = await rt.beginTurn(a.id, { turnId: 'turn-1' });
    const out = await LedgerTool.execute({
      action: 'unknown', stmt: 'Need the house loan payoff letter', subject: 'house-loan', attr: 'payoff',
      changes: 'Net proceeds', answerable: 'owner', how: 'Ask for the letter',
      forCaseId: b.id, excludeCaseId: 'nothing'
    }, { caseContext: rt.caseContext(turn) });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.similarInOtherCases.map((m) => [m.caseId, m.caseTitle]), [[b.id, 'Household inventory']]);
    assert.ok(!out.similarInOtherCases.some((m) => m.caseId === a.id), "A's own fact is not a cross-case hit");
    assert.ok(out.similarInOtherCases.every((m) => !('score' in m) && !('coverage' in m)), 'no raw index scores reach the model');
    assert.strictEqual(leaks(out.similarInOtherCases), false);
    await rt.endTurn(turn, { summary: 'unknown recorded' });
    const text = rt.orientation(a.id);
    assert.match(text, /related: "Household inventory" \(draft\) — Same household/);
    assert.strictEqual(leaks(text), false);
  });

  it("a one-word probe of case B's private value names no case", async () => {
    const { rt, a } = await fixture();
    const turn = await rt.beginTurn(a.id, { turnId: 'turn-1' });
    const ctx = { caseContext: rt.caseContext(turn) };
    const probe = (stmt, attr) => LedgerTool.execute({ action: 'unknown', stmt, subject: 'probe', attr, changes: 'Nothing', answerable: 'owner', how: 'Ask' }, ctx);
    for (const [stmt, attr] of [[PRIVATE_VALUE, 'right'], ['120418', 'wrong'], [`${PRIVATE_VALUE} zebra`, 'padded']]) {
      const out = await probe(stmt, attr);
      assert.strictEqual(out.ok, true, stmt);
      assert.deepStrictEqual(out.similarInOtherCases, [], stmt);
      assert.strictEqual(out.note, undefined, stmt);
    }
    await rt.endTurn(turn, { summary: 'probes recorded' });
  });

  it('a disclosable fact from case B is shown to case A with its text', async () => {
    const { rt, a, b } = await fixture();
    rt.ledger(b.id).setDisclosable('f-0001', true);
    const hits = rt.index.search({ text: 'house loan payoff letter', forCaseId: a.id, excludeCaseId: a.id, kinds: ['fact'] });
    assert.strictEqual(hits[0].text, `${PRIVATE_STMT} ${PRIVATE_VALUE}`);
  });
});

describe('cross-case leak paths through detours', () => {
  const { DetourRouter } = require('../src/cases/detours/router');
  const { DetourLog } = require('../src/cases/detours/log');

  async function routed() {
    const rt = new CaseRuntime({ root: tmp(), getSettings: () => ({}), host: { interactive: () => true } });
    const door = await rt.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
    rt.brief(door.id).update('why', 'The landlord threatened to keep the deposit', { provenance: 'user' });
    rt.ledger(door.id).assert({ stmt: 'Door budget is capped by the savings account balance of 1834', subject: 'door', attr: 'budget', value: 1834, category: 'financial', source: { kind: 'document', ref: 'sources/bank.pdf' } });
    const phone = await rt.createCase({ title: 'Phone agent maintenance', objective: 'Keep the phone agent answering calls and reporting status' });
    const router = new DetourRouter({ runtime: rt });
    const p = await router.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    return { rt, router, door, phone, p };
  }

  it('incoming row copies only the shown text', async () => {
    const { rt, router, door, phone, p } = await routed();
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    await router.resolve(door.id, p.detour.id, { optionId: 'attach-1', by: 'in-app' });
    const [incoming] = new DetourLog(phone.dir).incoming();
    assert.deepStrictEqual(Object.keys(incoming), ['type', 'id', 'at', 'fromCaseId', 'fromTitle', 'summary', 'reason', 'blocks']);
    const shown = rt.questions(door.id).get(p.questionId).text;
    assert.ok(shown.includes(incoming.summary) && shown.includes(incoming.reason) && shown.includes(incoming.fromTitle));
    const targetFiles = JSON.stringify([
      fs.readFileSync(path.join(phone.dir, '.kl', 'detours.jsonl'), 'utf8'),
      fs.readdirSync(path.join(phone.dir, 'journal')).map((n) => fs.readFileSync(path.join(phone.dir, 'journal', n), 'utf8')),
      fs.readFileSync(path.join(phone.dir, 'case.yaml'), 'utf8')
    ]);
    for (const secret of ['landlord', 'deposit', '1834', 'savings account']) assert.ok(!targetFiles.includes(secret), secret);
  });

  it("the owner's routing answer in words stays in the source case's journal", async () => {
    const readJournal = (dir) => fs.readdirSync(path.join(dir, 'journal')).map((n) => fs.readFileSync(path.join(dir, 'journal', n), 'utf8')).join('\n');
    const words = 'Put it with the phone agent, the landlord keeps calling about the deposit';
    for (const optionId of ['attach-1', 'new']) {
      const { rt, router, door, phone, p } = await routed();
      await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', text: words });
      await router.reconcile(door.id);
      const r = await router.resolve(door.id, p.detour.id, { optionId, by: 'model-mapped', expectStatus: 'awaiting-mapping' });
      assert.strictEqual(r.ok, true, `${optionId}: ${r.error}`);
      const target = optionId === 'new' ? rt.getCase(r.linkedCaseId) : phone;
      const theirs = readJournal(target.dir);
      assert.ok(!theirs.includes('landlord') && !theirs.includes('deposit'), `${optionId}: ${theirs}`);
      assert.ok(theirs.includes(`Routed from the owner's answer in case "Rear door quotes".`), `${optionId}: ${theirs}`);
      assert.ok(readJournal(door.dir).includes(words), `${optionId}: the source journal keeps the words`);
    }
  });

  it('routing answer fact is non-disclosable', async () => {
    const { rt, door, p } = await routed();
    const out = await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    assert.deepStrictEqual([out.fact.provenance, out.fact.disclosable, out.fact.subject, out.fact.attr], ['user', false, 'detour', 'd-0001']);
    assert.strictEqual(out.fact.value, 'Attach to "Phone agent maintenance" (draft)');
    const hits = rt.index.search({ text: 'attach phone agent maintenance', kinds: ['fact'] });
    assert.ok(hits.some((h) => h.caseId === door.id), 'the routing answer fact is indexed');
    assert.ok(hits.filter((h) => h.caseId === door.id).every((h) => h.text === null));
  });

  it('routing question and propose result name other cases by title and status only', async () => {
    const rt = new CaseRuntime({ root: tmp(), getSettings: () => ({}), host: { interactive: () => true } });
    const door = await rt.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
    const phone = await rt.createCase({ title: 'Phone agent maintenance', objective: 'Keep the phone agent answering calls and reporting status' });
    // Phone's private fact: its subject is in the summary, so phone is a candidate through it.
    rt.ledger(phone.id).assert({ stmt: 'Status polling vendor contract costs 4471 through the escrow account', subject: 'status-polling', attr: 'contract', value: 4471, category: 'financial', source: { kind: 'document', ref: 'sources/contract.pdf' } });
    const router = new DetourRouter({ runtime: rt });
    const p = await router.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    const q = rt.questions(door.id).get(p.questionId);
    assert.strictEqual(q.payload.targets['attach-1'], phone.id, 'phone is offered, so its private fact was searched');
    const shown = JSON.stringify([q.text, q.options, p]);
    for (const secret of ['4471', 'escrow', 'vendor contract', 'contract.pdf']) assert.ok(!shown.includes(secret), secret);
    assert.ok(!/"(score|coverage|hits?)"/.test(JSON.stringify(p)), 'no raw index scores or hits in the result');
  });

  it('proposal rows store no candidate titles', async () => {
    const { door, phone } = await routed();
    const [row] = new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal');
    assert.deepStrictEqual(row.candidates.map((c) => Object.keys(c)), [['caseId', 'score', 'optionId']]);
    assert.strictEqual(row.candidates[0].caseId, phone.id);
    assert.ok(!JSON.stringify(row).includes('Phone agent maintenance'));
  });
});

describe('cross-case leak paths through Ask', () => {
  const { AskTool } = require('../src/tools/builtin/case-unattended-tools');

  it('Ask similar across cases returns title only', async () => {
    const rt = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
    const site = await rt.createCase({ title: 'Website redesign', objective: 'Refresh the public website' });
    rt.createQuestion(site.id, { kind: 'question', text: 'Which hosting plan should the new booking site use, the 12 dollar one?', urgency: 'low', options: [{ id: 'a', label: 'Static hosting at 12 dollars' }] });
    const shop = await rt.createCase({ title: 'Shop opening', objective: 'Open the pop-up shop' });
    const turn = await rt.beginTurn(shop.id, { turnId: 'turn-1' });
    const out = await AskTool.execute({ question: 'Which hosting plan should the shop booking site use?' }, { caseContext: rt.caseContext(turn) });
    assert.strictEqual(out.ok, true);
    assert.match(out.note, /A similar question is open in case "Website redesign"\./);
    assert.strictEqual(out.similar, undefined);
    const blob = JSON.stringify(out);
    for (const secret of ['12 dollar', 'Static hosting', 'new booking site']) assert.ok(!blob.includes(secret), secret);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it("a one-word Ask probe of another case's open question names no case", async () => {
    const rt = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
    const site = await rt.createCase({ title: 'Website redesign', objective: 'Refresh the public website' });
    rt.createQuestion(site.id, { kind: 'question', text: 'Is the side gate code still 4471 for the movers?', urgency: 'low' });
    const shop = await rt.createCase({ title: 'Shop opening', objective: 'Open the pop-up shop' });
    const turn = await rt.beginTurn(shop.id, { turnId: 'turn-1' });
    const out = await AskTool.execute({ question: '4471?' }, { caseContext: rt.caseContext(turn) });
    assert.strictEqual(out.ok, true);
    assert.ok(!/Website redesign/.test(JSON.stringify(out)), JSON.stringify(out));
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('cross-case leak paths through the Detour tool', () => {
  const { DetourTool } = require('../src/tools/builtin/detour-tool');

  it('Detour propose and list name other cases by title and status only', async () => {
    const rt = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
    const phone = await rt.createCase({ title: 'Phone agent maintenance', objective: 'Keep the phone agent answering calls and reporting status' });
    // Its subject is in the summary, so phone is a candidate through this private fact.
    rt.ledger(phone.id).assert({ stmt: 'Status polling vendor contract costs 4471 through the escrow account', subject: 'status-polling', attr: 'contract', value: 4471, category: 'financial', source: { kind: 'document', ref: 'sources/contract.pdf' } });
    rt.createQuestion(phone.id, { kind: 'question', text: 'Should the escrow account keep paying the polling vendor?', urgency: 'low' });
    const door = await rt.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
    const turn = await rt.beginTurn(door.id, { turnId: 'turn-1' });
    const opts = { caseContext: rt.caseContext(turn) };
    const p = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling', reason: 'A different project' }, opts);
    assert.strictEqual(p.ok, true);
    assert.ok(p.options.some((o) => o.label === 'Attach to "Phone agent maintenance" (draft)'), 'phone is offered');
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    await rt.detours.reconcile(door.id);
    const list = await DetourTool.execute({ action: 'list' }, opts);
    assert.deepStrictEqual(list.related.map((r) => [r.title, r.status]), [['Phone agent maintenance', 'draft']]);
    const blob = JSON.stringify([p, list]);
    for (const secret of ['4471', 'escrow', 'vendor contract', 'contract.pdf', 'keep paying']) assert.ok(!blob.includes(secret), secret);
    assert.ok(!/"(score|coverage|hits?|text)"/.test(blob), 'no raw index rows or scores in the results');
    await rt.endTurn(turn, { summary: 'x' });
  });
});

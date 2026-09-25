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
    const turn = await rt.beginTurn(a.id, { turnId: 'turn-1' });
    const out = await LedgerTool.execute({
      action: 'unknown', stmt: 'Need the house loan payoff letter', subject: 'house-loan', attr: 'payoff',
      changes: 'Net proceeds', answerable: 'owner', how: 'Ask for the letter',
      forCaseId: b.id, excludeCaseId: 'nothing'
    }, { caseContext: rt.caseContext(turn) });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.similarInOtherCases.map((m) => [m.caseId, m.caseTitle]), [[b.id, 'Household inventory']]);
    assert.ok(out.similarInOtherCases.every((m) => !('score' in m) && !('coverage' in m)), 'no raw index scores reach the model');
    assert.strictEqual(leaks(out.similarInOtherCases), false);
    await rt.endTurn(turn, { summary: 'unknown recorded' });
    const text = rt.orientation(a.id);
    assert.match(text, /related: "Household inventory" \(draft\) — Same household/);
    assert.strictEqual(leaks(text), false);
  });

  it('a disclosable fact from case B is shown to case A with its text', async () => {
    const { rt, a, b } = await fixture();
    rt.ledger(b.id).setDisclosable('f-0001', true);
    const hits = rt.index.search({ text: 'house loan payoff letter', forCaseId: a.id, excludeCaseId: a.id, kinds: ['fact'] });
    assert.strictEqual(hits[0].text, `${PRIVATE_STMT} ${PRIVATE_VALUE}`);
  });
});

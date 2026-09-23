// tests/cases-gates.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { recommendationGate, findDuplicates } = require('../src/cases/gates');

const fact = (id, over = {}) => [id, {
  id, stmt: `stmt ${id}`, subject: 'lot', attr: id, value: 1, provenance: 'sourced',
  status: 'active', loadBearing: false, ...over
}];

describe('recommendationGate', () => {
  const facts = new Map([
    fact('f-0001', { attr: 'acreage' }),
    fact('f-0002', { attr: 'motivation', provenance: 'inferred' }),
    fact('f-0003', { attr: 'old', status: 'superseded' }),
    fact('f-0004', { attr: 'listing-history', provenance: 'sourced', stmt: 'No online listing today' }),
    fact('f-0005', { attr: 'listing-history', provenance: 'unknown', loadBearing: true, stmt: 'Listed before?' })
  ]);

  it('refuses everything while the case is a draft', () => {
    const r = recommendationGate({ status: 'draft', claims: [{ text: 'x', factIds: ['f-0001'] }], facts });
    assert.strictEqual(r.ok, false);
    assert.match(r.failures[0].reason, /gating/i);
  });

  it('passes a claim citing an active sourced fact', () => {
    const r = recommendationGate({ status: 'active', claims: [{ text: 'Price per acre', factIds: ['f-0001'] }], facts });
    assert.deepStrictEqual(r, { ok: true, failures: [] });
  });

  it('refuses uncited, missing, inactive and inferred support', () => {
    const r = recommendationGate({
      status: 'active',
      facts,
      claims: [
        { text: 'a', factIds: [] },
        { text: 'b', factIds: ['f-0099'] },
        { text: 'c', factIds: ['f-0003'] },
        { text: 'd', factIds: ['f-0002'] }
      ]
    });
    assert.strictEqual(r.ok, false);
    const reasons = r.failures.map((f) => `${f.claim}: ${f.reason}`).join('\n');
    assert.match(reasons, /a: .*cites no fact/);
    assert.match(reasons, /b: .*f-0099/);
    assert.match(reasons, /c: .*superseded/);
    assert.match(reasons, /d: .*inferred/);
  });

  it('lets non-load-bearing claims through without citations', () => {
    const r = recommendationGate({ status: 'active', claims: [{ text: 'Context only', factIds: [], loadBearing: false }], facts });
    assert.strictEqual(r.ok, true);
  });

  it('blocks a claim on a subject with an open load-bearing unknown', () => {
    const r = recommendationGate({ status: 'active', claims: [{ text: 'Online is untried; list there', factIds: ['f-0004'] }], facts });
    assert.strictEqual(r.ok, false);
    assert.match(r.failures[0].reason, /f-0005/);
  });

  it('refuses an empty claim list', () => {
    assert.strictEqual(recommendationGate({ status: 'active', claims: [], facts }).ok, false);
  });
});

describe('findDuplicates', () => {
  const here = new Map([
    fact('f-0001', { subject: 'loan', attr: 'payoff', stmt: 'Payoff quote 120,000' }),
    fact('f-0002', { subject: 'lot', attr: 'tap', provenance: 'unknown', stmt: 'Water tap installed?' }),
    fact('f-0003', { subject: 'parcel-12', attr: 'kind', provenance: 'inferred', stmt: 'Parcel 12 is timber' })
  ]);
  const other = {
    caseId: 'c-other', title: 'Household inventory',
    facts: new Map([
      fact('f-0009', { subject: 'house', attr: 'payoff', stmt: 'Mortgage payoff quote for the house good through September' }),
      fact('f-0010', { subject: 'lot', attr: 'tap', status: 'retracted' })
    ])
  };

  it('reports exact matches in the current case, facts and unknowns alike', () => {
    const d = findDuplicates({ subject: 'Loan', attr: 'PAYOFF', text: '', facts: here, otherCases: [] });
    assert.deepStrictEqual(d.exact.map((m) => m.id), ['f-0001']);
    const u = findDuplicates({ subject: 'lot', attr: 'tap', text: '', facts: here, otherCases: [] });
    assert.deepStrictEqual(u.exact.map((m) => m.id), ['f-0002']);
  });

  it('does not count an inference as an exact duplicate', () => {
    const d = findDuplicates({ subject: 'parcel-12', attr: 'kind', text: '', facts: here, otherCases: [] });
    assert.deepStrictEqual(d.exact, []);
  });

  it('reports similar active facts in other cases by subject/attr or wording', () => {
    const bySubject = findDuplicates({ subject: 'house', attr: 'payoff', text: 'x', facts: new Map(), otherCases: [other] });
    assert.deepStrictEqual(bySubject.similar.map((m) => [m.caseId, m.id]), [['c-other', 'f-0009']]);
    const byWords = findDuplicates({ subject: 'property', attr: 'loan-balance', text: 'mortgage payoff quote for the house', facts: new Map(), otherCases: [other] });
    assert.deepStrictEqual(byWords.similar.map((m) => m.id), ['f-0009']);
    assert.strictEqual(byWords.similar[0].caseTitle, 'Household inventory');
  });

  it('ignores inactive facts in other cases', () => {
    const d = findDuplicates({ subject: 'lot', attr: 'tap', text: '', facts: new Map(), otherCases: [other] });
    assert.deepStrictEqual(d.similar, []);
  });
});

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
  // Cross-case index hits (cases stage 5): the index holds active facts only.
  const otherHits = [
    { kind: 'fact', caseId: 'c-other', title: 'Household inventory', id: 'f-0009', subject: 'house', attr: 'payoff', text: 'Mortgage payoff quote for the house good through September', redacted: false, provenance: 'sourced', coverage: 0.2 },
    { kind: 'brief', caseId: 'c-other', title: 'Household inventory', id: 'objective', subject: null, attr: 'objective', text: 'Mortgage payoff quote for the house', redacted: false, provenance: null, coverage: 1 }
  ];

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

  it('reports similar cross-case fact hits by subject/attr or wording', () => {
    const bySubject = findDuplicates({ subject: 'house', attr: 'payoff', text: 'x', facts: new Map(), crossCaseHits: otherHits });
    assert.deepStrictEqual(bySubject.similar.map((m) => [m.caseId, m.id]), [['c-other', 'f-0009']]);
    const byWords = findDuplicates({ subject: 'property', attr: 'loan-balance', text: 'mortgage payoff quote for the house', facts: new Map(), crossCaseHits: otherHits });
    assert.deepStrictEqual(byWords.similar.map((m) => m.id), ['f-0009']);
    assert.strictEqual(byWords.similar[0].caseTitle, 'Household inventory');
  });

  it('ignores hits that are not facts', () => {
    const d = findDuplicates({ subject: 'lot', attr: 'tap', text: 'mortgage payoff quote for the house', facts: new Map(), crossCaseHits: otherHits.slice(1) });
    assert.deepStrictEqual(d.similar, []);
  });
});

describe('stage 5 duplicate gates', () => {
  const gates = require('../src/cases/gates');
  const { findDuplicateQuestion, findDuplicateJob, findSimilarCases, jobSignature, normQuestion } = gates;
  const { TOKENIZER, STOPWORDS, tokenize } = require('../src/cases/tokenize');
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const c3Duplicates = path.join(__dirname, '..', 'src', 'cases', 'executors', 'duplicates.js');

  it('tokenizes with the frozen kl-bm25-v1 rules', () => {
    assert.strictEqual(TOKENIZER, 'kl-bm25-v1');
    assert.strictEqual(STOPWORDS.size, 60);
    assert.deepStrictEqual(tokenize('Café résumés for the Lots, 2 acres; glass 0412-775'), ['cafe', 'resume', 'lot', 'acre', 'glass', '0412', '775']);
  });

  it('is what the stage-3 duplicates module uses once both have merged', { skip: fs.existsSync(c3Duplicates) ? false : 'cases stage 3 has not merged' }, () => {
    const dup = require(c3Duplicates);
    assert.strictEqual(dup.jobSignature, gates.jobSignature);
    assert.strictEqual(dup.findDuplicateJob, gates.findDuplicateJob);
    assert.strictEqual(dup.normIntent, gates.normIntent);
  });

  it('findDuplicates takes cross-case index hits and never shows a redacted fact\'s words', () => {
    const hits = [
      { kind: 'fact', caseId: 'c-b', title: 'Household inventory', id: 'f-0009', subject: 'house-loan', attr: 'payoff', text: null, redacted: true, provenance: 'sourced', coverage: 0 },
      { kind: 'fact', caseId: 'c-c', title: 'Garage sale', id: 'f-0002', subject: 'garage', attr: 'date', text: 'Mortgage payoff quote for the house good through September', redacted: false, provenance: 'sourced', coverage: 0.4 },
      { kind: 'fact', caseId: 'c-d', title: 'Taxes', id: 'f-0003', subject: 'tax', attr: 'year', text: null, redacted: true, provenance: 'user', coverage: 0.75, matched: 3 },
      { kind: 'fact', caseId: 'c-f', title: 'Probe target', id: 'f-0004', subject: 'probe', attr: 'value', text: null, redacted: true, provenance: 'user', coverage: 1, matched: 1 },
      { kind: 'question', caseId: 'c-e', title: 'Other', id: 'q-0001', text: null, redacted: true, coverage: 1 }
    ];
    const d = findDuplicates({ subject: 'House-Loan', attr: 'PAYOFF', text: 'mortgage payoff quote for the house', facts: new Map(), crossCaseHits: hits });
    assert.deepStrictEqual(d.similar.map((m) => [m.caseId, m.id]), [['c-b', 'f-0009'], ['c-c', 'f-0002'], ['c-d', 'f-0003']]);
    assert.strictEqual(d.similar[0].stmt, '(private fact in "Household inventory" — open that case to see it)');
    assert.strictEqual(d.similar[1].stmt, 'Mortgage payoff quote for the house good through September');
    assert.strictEqual(d.similar[2].stmt, '(private fact in "Taxes" — open that case to see it)');
    assert.strictEqual(d.similar[0].caseTitle, 'Household inventory');
  });

  it('normQuestion folds case, width, spacing and trailing punctuation', () => {
    assert.strictEqual(normQuestion('  Is the WELL   shared?!. '), 'is the well shared');
    assert.strictEqual(normQuestion('Ｉｓ the well shared'), 'is the well shared');
  });

  it('normQuestion drops format characters and inner punctuation, so those are exact duplicates', () => {
    assert.strictEqual(normQuestion('Is the side gate code still 4471​?'), 'is the side gate code still 4471');
    assert.strictEqual(normQuestion('Is the side gate code, still 4471?'), 'is the side gate code still 4471');
    const open = [{ id: 'q-0001', text: 'Is the side gate code still 4471?', answer: null, closed: null }];
    for (const text of ['Is the side gate code still 4471​?', 'Is the side gate code, still 4471?', 'is the side­ gate code still 4471']) {
      assert.strictEqual(findDuplicateQuestion({ text, openQuestions: open }).exact?.id, 'q-0001', text);
    }
  });

  it('findDuplicateQuestion: exact open question, similar here with text, answered ones ignored', () => {
    const open = [
      { id: 'q-0012', text: 'Is the well shared with the north lot?', answer: null, closed: null, createdAt: '2026-09-20T10:00:00.000Z' },
      { id: 'q-0013', text: 'Who holds the easement on the lakeside lot?', answer: null, closed: null },
      { id: 'q-0014', text: 'What is the payoff amount?', answer: { text: 'x' }, closed: null }
    ];
    const exact = findDuplicateQuestion({ text: 'is the well shared with the north lot', openQuestions: open });
    assert.strictEqual(exact.exact.id, 'q-0012');
    assert.deepStrictEqual(exact.similar, []);
    const similar = findDuplicateQuestion({ text: 'Who holds the easement on the lot?', openQuestions: open });
    assert.strictEqual(similar.exact, null);
    assert.deepStrictEqual(similar.similar, [{ questionId: 'q-0013', text: 'Who holds the easement on the lakeside lot?' }]);
    const answered = findDuplicateQuestion({ text: 'What is the payoff amount?', openQuestions: open });
    assert.strictEqual(answered.exact, null);
    assert.deepStrictEqual(answered.similar, []);
  });

  it('findDuplicateQuestion lists other cases\' open questions by title and id only', () => {
    const hits = [
      { kind: 'question', caseId: 'c-b', title: 'Website redesign', id: 'q-0003', text: null, redacted: true, attr: 'open', caseStatus: 'active', coverage: 0.8, matched: 4 },
      { kind: 'question', caseId: 'c-f', title: 'Probe target', id: 'q-0009', text: null, redacted: true, attr: 'open', caseStatus: 'active', coverage: 1, matched: 1 },
      { kind: 'question', caseId: 'c-b', title: 'Website redesign', id: 'q-0001', text: null, redacted: true, attr: 'answered', caseStatus: 'active', coverage: 1 },
      { kind: 'question', caseId: 'c-c', title: 'Garage sale', id: 'q-0002', text: null, redacted: true, attr: 'open', caseStatus: 'draft', coverage: 0.2 },
      { kind: 'fact', caseId: 'c-d', title: 'Taxes', id: 'f-0001', text: null, redacted: true, coverage: 1 }
    ];
    const r = findDuplicateQuestion({ text: 'Which hosting plan should the new site use?', openQuestions: [], crossCaseHits: hits });
    assert.deepStrictEqual(r.elsewhere, [{ caseId: 'c-b', caseTitle: 'Website redesign', questionId: 'q-0003', status: 'active' }]);
  });

  it('jobSignature is the SHA-256 of { e, k, r sorted, i normalized } and ignores recipient order', () => {
    const a = jobSignature('phone-agent', { kind: 'call', recipients: ['+15550102', '+15550100'], intent: '  Ask about   the Lot ' });
    const b = jobSignature('phone-agent', { kind: 'call', recipients: ['+15550100', '+15550102'], intent: 'ask about the lot' });
    const expected = crypto.createHash('sha256')
      .update(JSON.stringify({ e: 'phone-agent', k: 'call', r: ['+15550100', '+15550102'], i: 'ask about the lot' }))
      .digest('hex');
    assert.strictEqual(a, b);
    assert.strictEqual(a, expected);
    assert.notStrictEqual(jobSignature('bash', { kind: 'call', recipients: ['+15550100', '+15550102'], intent: 'ask about the lot' }), a);
    assert.strictEqual(jobSignature('web', {}), crypto.createHash('sha256').update('{"e":"web","k":null,"r":[],"i":""}').digest('hex'));
  });

  it('findDuplicateJob honours submitting and ignores terminal states', () => {
    const job = { kind: 'call', recipients: ['+15550100'], intent: 'Ask about the lot' };
    const signature = jobSignature('phone-agent', job);
    const row = (state, over = {}) => ({ jobId: `job-${state}`, executorId: 'phone-agent', signature, state, caseId: 'c-a', intent: job.intent, recipients: job.recipients, ...over });
    for (const state of ['submitting', 'submitted', 'running', 'waiting']) {
      assert.strictEqual(findDuplicateJob({ executorId: 'phone-agent', job, liveJobs: [row(state)] }).jobId, `job-${state}`);
    }
    for (const state of ['done', 'failed', 'cancelled']) {
      assert.strictEqual(findDuplicateJob({ executorId: 'phone-agent', job, liveJobs: [row(state)] }), null);
    }
    assert.strictEqual(findDuplicateJob({ executorId: 'phone-agent', job, liveJobs: [row('running', { executorId: 'browser' })] }), null);
    assert.strictEqual(findDuplicateJob({ executorId: 'phone-agent', job: { ...job, signature }, liveJobs: [row('waiting')] }).state, 'waiting');
    assert.strictEqual(findDuplicateJob({ executorId: 'phone-agent', job: { ...job, intent: 'Something else' }, liveJobs: [row('running')] }), null);
  });

  describe('findSimilarCases', () => {
    const candidates = [
      { caseId: 'c-1', title: 'Website redesign', objective: 'Refresh the public website', status: 'active' },
      { caseId: 'c-2', title: 'Sell the lakeside lot', objective: 'Convert the lot to cash', status: 'draft' },
      { caseId: 'c-3', title: 'Rear door quotes', objective: 'Three written quotes for the rear door', status: 'done' },
      { caseId: 'c-4', title: 'Q', objective: '', status: 'paused' }
    ];

    it('refuses an equal normalized title or objective as exact', () => {
      assert.deepStrictEqual(findSimilarCases({ title: '  website REDESIGN. ', candidates }).exact, [{ caseId: 'c-1', title: 'Website redesign', status: 'active', match: 'exact' }]);
      assert.deepStrictEqual(findSimilarCases({ title: 'Something new', objective: 'Convert the lot to cash', candidates }).exact.map((e) => e.caseId), ['c-2']);
    });

    it('matches a one-token title exactly', () => {
      assert.deepStrictEqual(findSimilarCases({ title: 'q', candidates }).exact.map((e) => e.caseId), ['c-4']);
    });

    it('shows near-identical titles as similar at the 0.6 boundary', () => {
      const r = findSimilarCases({ title: 'Sell lakeside lot', candidates });
      assert.deepStrictEqual(r.exact, []);
      assert.deepStrictEqual(r.similar.map((s) => [s.caseId, s.match]), [['c-2', 'similar']]);
      const redesign = findSimilarCases({ title: 'Redesign the website', candidates });
      assert.deepStrictEqual(redesign.similar.map((s) => s.caseId), ['c-1']);
      // {sell, lakeside, lot, fast, today} vs {sell, lakeside, lot}: exactly 3/5 = 0.6
      assert.deepStrictEqual(findSimilarCases({ title: 'Sell lakeside lot fast today', candidates }).similar.map((s) => [s.caseId, s.score]), [['c-2', 0.6]]);
      // {website, redesign, homepage, copy} vs {website, redesign}: 0.5 < 0.6; with the objective 2/6
      assert.deepStrictEqual(findSimilarCases({ title: 'Website redesign homepage copy', candidates }).similar, []);
      assert.deepStrictEqual(findSimilarCases({ title: 'Website redesign homepage copy', candidates, threshold: 0.5 }).similar.map((s) => s.caseId), ['c-1']);
    });

    it('ignores closed cases', () => {
      const r = findSimilarCases({ title: 'Rear door quotes', candidates });
      assert.deepStrictEqual([r.exact, r.similar], [[], []]);
    });
  });
});

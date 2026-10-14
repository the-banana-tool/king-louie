// tests/cases-verify-status.test.js
// Cases stage 8, Task 3: evidence resolvers and the criterion state computed
// on every read (spec §6.3). Nothing here touches a disk.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeCriterionState, progressView, summaryLine } = require('../src/cases/verify/status');
const {
  ELIGIBLE_PROVENANCE, registerEvidenceResolver, resolveEvidence, registerEvidenceSource, evidenceSources
} = require('../src/cases/verify/evidence');

const H1 = `sha256:${'1'.repeat(64)}`;
const H2 = `sha256:${'2'.repeat(64)}`;
const H3 = `sha256:${'3'.repeat(64)}`;
const HX = `sha256:${'f'.repeat(64)}`;

const fact = (id, extra = {}) => ({
  id, provenance: 'sourced', status: 'active', supersededBy: null, subject: 'lot', attr: id, value: 'yes',
  stmt: `Statement of ${id}`, source: { kind: 'url', ref: 'https://records.example.org/1' }, addedBy: 'turn-1', loadBearing: false, ...extra
});
const ledger = (...list) => new Map(list.map((f) => [f.id, f]));
const record = (n, extra = {}) => ({
  id: `v-${String(n).padStart(4, '0')}`, kind: 'verify', criterion: 'sc-001', criterionHash: H1, evidence: ['f-0042'],
  note: 'Contract signed at 81,000; floor is 75,000.', turnId: 'turn-91c2', model: 'example-provider:example-model',
  at: '2026-10-21T09:14:10.000Z', disagreed: null, ...extra
});
const entry = { id: 'sc-001', hash: H1 };
const resolverFor = (facts) => (id) => resolveEvidence(id, { facts });
const state = (records, facts, newestCheck = null) => computeCriterionState({ entry, records, resolve: resolverFor(facts), newestCheck });

describe('evidence resolvers', () => {
  it('eligible provenance is user, sourced and external-agent', () => {
    assert.deepStrictEqual([...ELIGIBLE_PROVENANCE], ['user', 'sourced', 'external-agent']);
  });

  it('the f- resolver holds for an active eligible fact, with its provenance and source', () => {
    const facts = ledger(fact('f-0042'), fact('f-0043', { provenance: 'user', source: { kind: 'user-message', ref: 'turn-1', quote: 'signed today' } }));
    const r = resolveEvidence('f-0042', { facts });
    assert.deepStrictEqual([r.exists, r.holds, r.reason, r.provenance], [true, true, null, 'sourced']);
    assert.deepStrictEqual(r.source, { kind: 'url', ref: 'https://records.example.org/1' });
    assert.strictEqual(resolveEvidence('f-0043', { facts }).provenance, 'user');
  });

  it('an external-agent fact alone holds', () => {
    const facts = ledger(fact('f-0042', { provenance: 'external-agent', source: { kind: 'executor', ref: 'sources/phone-agent/job-0001.json' } }));
    const r = resolveEvidence('f-0042', { facts });
    assert.deepStrictEqual([r.holds, r.provenance], [true, 'external-agent']);
    assert.strictEqual(state([record(1)], facts).state, 'met');
  });

  // Owner ruling R-C8-N8 (2026-10-14): a user fact whose
  // quote came over an MCP channel (create_case's objective, an MCP answer)
  // is recorded, but nobody checked the quote, so it is never evidence.
  it('a user fact recorded over an MCP channel does not hold; the same fact from the app or a contact channel does', () => {
    const over = (id, channel, extra = {}) => fact(id, { provenance: 'user', source: { kind: 'owner-action', ref: 'create-case', channel, quote: 'Build a shed by spring' }, ...extra });
    const facts = ledger(
      over('f-0042', 'mcp-stdio'), over('f-0043', 'mcp-frontdoor'), over('f-0044', 'mcp-future'),
      over('f-0045', 'in-app-chat'), over('f-0046', 'in-app'), over('f-0047', 'telegram'),
      fact('f-0048', { provenance: 'user', source: { kind: 'question', ref: 'q-0001', channel: 'mcp-stdio', at: '2026-10-21T09:00:00.000Z' } })
    );
    for (const id of ['f-0042', 'f-0043', 'f-0044', 'f-0048']) {
      const r = resolveEvidence(id, { facts });
      assert.deepStrictEqual([r.exists, r.holds, r.reason, r.provenance], [true, false, 'evidence-provenance', 'user'], id);
      assert.strictEqual(r.label, `${id} is the owner's words as an MCP client recorded them, unchecked`);
    }
    for (const id of ['f-0045', 'f-0046', 'f-0047']) assert.strictEqual(resolveEvidence(id, { facts }).holds, true, id);
    assert.strictEqual(state([record(1)], facts).state, 'stale');
    assert.strictEqual(state([record(1, { evidence: ['f-0045'] })], facts).state, 'met');
  });

  it('an inferred and an unknown fact do not', () => {
    const facts = ledger(fact('f-0042', { provenance: 'inferred' }), fact('f-0043', { provenance: 'unknown', value: null, source: null }));
    for (const id of ['f-0042', 'f-0043']) {
      const r = resolveEvidence(id, { facts });
      assert.deepStrictEqual([r.exists, r.holds, r.reason], [true, false, 'evidence-provenance'], id);
      assert.match(r.label, new RegExp(`^${id} `));
    }
    assert.strictEqual(state([record(1)], facts).state, 'stale');
  });

  it('a missing fact is evidence-missing', () => {
    const r = resolveEvidence('f-0099', { facts: ledger(fact('f-0042')) });
    assert.deepStrictEqual([r.exists, r.holds, r.reason], [false, false, 'evidence-missing']);
    // No ledger in the context: nothing holds.
    for (const ctx of [undefined, null, {}, { facts: {} }, { facts: [fact('f-0042')] }]) {
      assert.deepStrictEqual([resolveEvidence('f-0042', ctx).holds, resolveEvidence('f-0042', ctx).reason], [false, 'evidence-missing']);
    }
  });

  it('a superseded or retracted fact is evidence-inactive, with a label naming what happened', () => {
    const facts = ledger(
      fact('f-0033', { status: 'superseded', supersededBy: 'f-0060' }), fact('f-0060'), fact('f-0041', { status: 'retracted' })
    );
    const s = resolveEvidence('f-0033', { facts });
    assert.deepStrictEqual([s.exists, s.holds, s.reason, s.label], [true, false, 'evidence-inactive', 'f-0033 was superseded by f-0060']);
    const r = resolveEvidence('f-0041', { facts });
    assert.deepStrictEqual([r.holds, r.reason, r.label], [false, 'evidence-inactive', 'f-0041 was retracted']);
  });

  it('an eligible fact under an active load-bearing unknown on the same subject.attr does not hold', () => {
    const cited = fact('f-0042', { subject: 'Lot ', attr: ' Price' });
    const unknown = (extra = {}) => fact('f-0050', { provenance: 'unknown', value: null, source: null, subject: 'lot', attr: 'price', loadBearing: true, ...extra });
    const r = resolveEvidence('f-0042', { facts: ledger(cited, unknown()) });
    assert.deepStrictEqual([r.exists, r.holds, r.reason], [true, false, 'evidence-blocked']);
    assert.match(r.label, /f-0042 .*f-0050/);
    assert.ok(!/price|lot/i.test(r.label), 'the label is ids and fixed words only');
    // Not load-bearing, not active, or on another key: it blocks nothing.
    assert.strictEqual(resolveEvidence('f-0042', { facts: ledger(cited, unknown({ loadBearing: false })) }).holds, true);
    assert.strictEqual(resolveEvidence('f-0042', { facts: ledger(cited, unknown({ status: 'superseded', supersededBy: 'f-0061' })) }).holds, true);
    assert.strictEqual(resolveEvidence('f-0042', { facts: ledger(cited, unknown({ attr: 'size' })) }).holds, true);
  });

  it('an id with an unregistered prefix is evidence-missing', () => {
    for (const id of ['x-0001', 'D-001', 'f0042', '', 'f', null, 42, {}]) {
      assert.deepStrictEqual(resolveEvidence(id, { facts: ledger(fact('f-0042')) }), { exists: false, holds: false, reason: 'evidence-missing' }, String(id));
    }
  });

  it('a resolver is picked by the prefix up to the first dash, and one that throws holds nothing', () => {
    const seen = [];
    const remove = registerEvidenceResolver('zz-', (id, ctx) => {
      seen.push([id, ctx]);
      if (id === 'zz-boom') throw new Error('unreadable');
      return { exists: true, holds: true, reason: null, provenance: 'check', label: null };
    });
    try {
      assert.strictEqual(resolveEvidence('zz-0001-a', { n: 1 }).holds, true);
      assert.deepStrictEqual(seen, [['zz-0001-a', { n: 1 }]]);
      assert.deepStrictEqual(resolveEvidence('zz-boom', {}), { exists: false, holds: false, reason: 'evidence-missing' });
    } finally {
      remove();
    }
    assert.strictEqual(resolveEvidence('zz-0001', {}).reason, 'evidence-missing', 'removed again');
    assert.throws(() => registerEvidenceResolver('zz', () => ({})), /prefix/);
    assert.throws(() => registerEvidenceResolver('zz-', 'not a function'), /function/);
  });

  it('evidence sources are registered by name', () => {
    const fn = () => [];
    const remove = registerEvidenceSource('test-source', fn);
    try {
      assert.ok(evidenceSources().some((s) => s.name === 'test-source' && s.fn === fn));
    } finally {
      remove();
    }
    assert.ok(!evidenceSources().some((s) => s.name === 'test-source'));
    assert.throws(() => registerEvidenceSource('', fn));
    assert.throws(() => registerEvidenceSource('x', null));
  });
});

describe('computeCriterionState', () => {
  const good = ledger(fact('f-0042'), fact('f-0051', { provenance: 'user' }));

  it('no record for this criterion and hash is unmet', () => {
    const none = { state: 'unmet', record: null, evidence: [], reasons: [] };
    assert.deepStrictEqual(state([], good), none);
    assert.deepStrictEqual(state(undefined, good), none);
    assert.deepStrictEqual(state([record(1, { criterion: 'sc-002' })], good), none);
  });

  it('a reworded criterion starts over', () => {
    assert.strictEqual(state([record(1, { criterionHash: HX })], good).state, 'unmet');
  });

  it('every cited id holding is met', () => {
    const r = state([record(1, { evidence: ['f-0042', 'f-0051'] })], good);
    assert.strictEqual(r.state, 'met');
    assert.strictEqual(r.record.id, 'v-0001');
    assert.deepStrictEqual(r.evidence.map((e) => [e.id, e.holds, e.provenance]), [['f-0042', true, 'sourced'], ['f-0051', true, 'user']]);
    assert.deepStrictEqual(r.reasons, []);
  });

  it('the newest record for the hash decides', () => {
    const records = [record(1, { evidence: ['f-0099'] }), record(2, { criterion: 'sc-002' }), record(3, { evidence: ['f-0042'] }), record(4, { criterionHash: HX, evidence: ['f-0099'] })];
    const r = state(records, good);
    assert.deepStrictEqual([r.state, r.record.id], ['met', 'v-0003']);
    assert.strictEqual(state([record(3, { evidence: ['f-0042'] }), record(1, { evidence: ['f-0099'] })], good).record.id, 'v-0003', 'by id, not by place in the list');
  });

  it('one id that does not hold makes it stale, with one reason per such id', () => {
    const facts = ledger(fact('f-0042'), fact('f-0033', { status: 'superseded', supersededBy: 'f-0060' }), fact('f-0060'), fact('f-0041', { status: 'retracted' }));
    const r = state([record(1, { evidence: ['f-0042', 'f-0033', 'f-0041', 'f-0099'] })], facts);
    assert.strictEqual(r.state, 'stale');
    assert.deepStrictEqual(r.reasons, ['f-0033 was superseded by f-0060', 'f-0041 was retracted', 'f-0099 is not in the ledger']);
    assert.deepStrictEqual(r.evidence.map((e) => e.holds), [true, false, false, false]);
  });

  it('a record the verify pass later disagreed with is stale', () => {
    const r = state([record(1, { disagreed: { turnId: 'turn-a1b2', at: '2026-10-22T09:00:00.000Z' } })], good);
    assert.strictEqual(r.state, 'stale');
    assert.deepStrictEqual(r.reasons, ['the verify pass of turn-a1b2 no longer agrees']);
    assert.deepStrictEqual(r.evidence.map((e) => [e.id, e.holds]), [['f-0042', true]]);
  });

  it('a record that cites a check is failing when the newest check run failed or timed out', () => {
    const withCheck = [record(1, { evidence: ['f-0042', 'chk-0012'] })];
    const resolve = (id) => (id.startsWith('chk-') ? { exists: true, holds: true, reason: null, provenance: 'check', label: null } : resolveEvidence(id, { facts: good }));
    const run = (newestCheck) => computeCriterionState({ entry, records: withCheck, resolve, newestCheck });
    assert.strictEqual(run({ id: 'chk-0013', result: 'fail' }).state, 'failing');
    assert.strictEqual(run({ id: 'chk-0013', result: 'timeout' }).state, 'failing');
    assert.match(run({ id: 'chk-0013', result: 'fail' }).reasons[0], /chk-0013/);
    assert.strictEqual(run({ id: 'chk-0013', result: 'pass' }).state, 'met');
    assert.strictEqual(run({ id: 'chk-0013', result: 'spawn-failed' }).state, 'met');
    assert.strictEqual(run(null).state, 'met');
    // A record that cites no check is not touched by a failing run.
    assert.strictEqual(computeCriterionState({ entry, records: [record(1)], resolve, newestCheck: { id: 'chk-0013', result: 'fail' } }).state, 'met');
  });

  it('precedence is failing over stale over met', () => {
    const facts = ledger(fact('f-0033', { status: 'superseded', supersededBy: 'f-0060' }), fact('f-0060'));
    const resolve = resolverFor(facts);
    const cited = { evidence: ['f-0033', 'chk-0012'] };
    const failing = { id: 'chk-0013', result: 'fail' };
    // Failing, disagreed and a superseded fact at once.
    const all = [record(1, { ...cited, disagreed: { turnId: 'turn-a1b2', at: 'x' } })];
    assert.strictEqual(computeCriterionState({ entry, records: all, resolve, newestCheck: failing }).state, 'failing');
    assert.strictEqual(computeCriterionState({ entry, records: all, resolve, newestCheck: null }).state, 'stale');
    // Disagreed and every id holding: still stale.
    assert.strictEqual(state([record(1, { evidence: ['f-0060'], disagreed: { turnId: 'turn-a1b2', at: 'x' } })], facts).state, 'stale');
    assert.strictEqual(state([record(1, { evidence: ['f-0060'] })], facts).state, 'met');
  });

  it('a record with no evidence, or no way to resolve it, is never met', () => {
    for (const evidence of [[], undefined, 'f-0042']) {
      const r = state([record(1, { evidence })], good);
      assert.strictEqual(r.state, 'stale', JSON.stringify(evidence));
      assert.deepStrictEqual(r.reasons, ['the record cites no evidence']);
    }
    assert.strictEqual(state([record(1, { evidence: ['f-0042', 7] })], good).state, 'stale');
    assert.strictEqual(computeCriterionState({ entry, records: [record(1)] }).state, 'stale');
    assert.strictEqual(computeCriterionState({ entry, records: [record(1)], resolve: () => { throw new Error('boom'); } }).state, 'stale');
    for (const answer of [undefined, null, true, { holds: 'yes' }, { holds: 1 }]) {
      assert.strictEqual(computeCriterionState({ entry, records: [record(1)], resolve: () => answer }).state, 'stale', JSON.stringify(answer));
    }
  });
});

describe('progressView', () => {
  const scopeView = {
    migrated: true,
    objective: { text: 'Sell the Lakeside lot', hash: HX, state: 'confirmed', origin: 'owner-create', confirmed: { by: 'owner-create' } },
    criteria: [
      { id: 'sc-001', text: 'Signed contract at or above the floor', hash: H1, state: 'confirmed', origin: 'owner-quote', provisional: false },
      { id: 'sc-002', text: 'Closed within the deadline', hash: H2, state: 'confirmed', origin: 'owner-action', provisional: false },
      { id: 'sc-003', text: 'Three written quotes', hash: H3, state: 'confirmed', origin: 'gating-answer', provisional: false },
      { id: 'sc-004', text: 'Closing costs under 2,000 dollars', hash: HX, state: 'proposed', origin: 'model', provisional: false },
      { id: 'sc-005', text: 'A thank-you note to the agent', hash: HX, state: 'proposed', origin: 'legacy', provisional: true }
    ],
    removed: [],
    duplicates: []
  };
  const facts = ledger(fact('f-0042'), fact('f-0051', { provenance: 'user' }), fact('f-0033', { status: 'superseded', supersededBy: 'f-0060' }), fact('f-0060'));
  const file = {
    version: 1,
    nextRecord: 3,
    records: [
      record(1, { evidence: ['f-0042', 'f-0051'] }),
      record(2, { criterion: 'sc-002', criterionHash: H2, evidence: ['f-0033'] }),
      // A record for a proposed criterion counts for nothing.
      record(3, { criterion: 'sc-004', criterionHash: HX, evidence: ['f-0042'] })
    ],
    opinions: {
      'sc-003': { status: 'met', evidence: ['f-0099'], rejected: [{ id: 'f-0099', reason: 'evidence-missing' }], turnId: 'turn-91c2', at: '2026-10-21T09:14:10.000Z' },
      'sc-004': { status: 'met', evidence: ['f-0042'], rejected: [], turnId: 'turn-91c2', at: '2026-10-21T09:14:10.000Z' }
    },
    cache: null
  };
  const view = () => progressView({ scopeView, file, resolve: resolverFor(facts), newestCheck: null });

  it('gives each confirmed row its computed state and each proposed row none', () => {
    const v = view();
    assert.deepStrictEqual(v.criteria.map((c) => [c.id, c.scope, c.state]), [
      ['sc-001', 'confirmed', 'met'], ['sc-002', 'confirmed', 'stale'], ['sc-003', 'confirmed', 'unmet'],
      ['sc-004', 'proposed', null], ['sc-005', 'proposed', null]
    ]);
    assert.deepStrictEqual(v.counts, { confirmed: 3, met: 1, stale: 1, failing: 0, unmet: 1, proposed: 2 });
    assert.strictEqual(v.objective, scopeView.objective);
    const [met, stale, unmet, proposed, legacy] = v.criteria;
    assert.deepStrictEqual([met.text, met.hash, met.origin, met.provisional, met.recordId], ['Signed contract at or above the floor', H1, 'owner-quote', false, 'v-0001']);
    assert.deepStrictEqual(met.evidence.map((e) => [e.id, e.holds, e.provenance, e.label]), [['f-0042', true, 'sourced', null], ['f-0051', true, 'user', null]]);
    assert.deepStrictEqual(stale.reasons, ['f-0033 was superseded by f-0060']);
    assert.deepStrictEqual(stale.evidence.map((e) => [e.id, e.holds, e.label]), [['f-0033', false, 'f-0033 was superseded by f-0060']]);
    assert.deepStrictEqual([unmet.evidence, unmet.reasons, unmet.recordId], [[], [], null]);
    assert.strictEqual(unmet.opinion, file.opinions['sc-003']);
    assert.deepStrictEqual([proposed.evidence, proposed.reasons, proposed.opinion, proposed.recordId], [[], [], null, null], 'a proposed row shows no record and no opinion');
    assert.deepStrictEqual([legacy.origin, legacy.provisional, legacy.state], ['legacy', true, null]);
  });

  it('a cached status is never believed', () => {
    const lying = { ...file, records: [], cache: { at: '2026-10-21T09:14:10.000Z', states: { 'sc-001': 'met', 'sc-002': 'met', 'sc-003': 'met', 'sc-004': 'met' } } };
    const v = progressView({ scopeView, file: lying, resolve: resolverFor(facts), newestCheck: null });
    assert.deepStrictEqual(v.criteria.map((c) => c.state), ['unmet', 'unmet', 'unmet', null, null]);
    assert.deepStrictEqual(v.counts, { confirmed: 3, met: 0, stale: 0, failing: 0, unmet: 3, proposed: 2 });
    // Nor a state written onto a scope row or a record by hand.
    const marked = { ...scopeView, criteria: scopeView.criteria.map((c) => ({ ...c, verification: 'met', met: true })) };
    const w = progressView({ scopeView: marked, file: { ...lying, records: [{ ...record(1, { evidence: ['f-0099'] }), state: 'met' }] }, resolve: resolverFor(facts) });
    assert.deepStrictEqual(w.criteria.map((c) => c.state), ['stale', 'unmet', 'unmet', null, null]);
  });

  it('a case with no stage files reads as nothing confirmed', () => {
    const legacy = { migrated: false, objective: null, criteria: scopeView.criteria.map((c) => ({ ...c, state: 'proposed', origin: 'legacy', provisional: true })), removed: [], duplicates: [] };
    for (const empty of [null, undefined, {}]) {
      const v = progressView({ scopeView: legacy, file: empty, resolve: resolverFor(facts) });
      assert.deepStrictEqual(v.counts, { confirmed: 0, met: 0, stale: 0, failing: 0, unmet: 0, proposed: 5 });
      assert.strictEqual(v.objective, null);
    }
    assert.deepStrictEqual(progressView({ scopeView: null, file: null, resolve: resolverFor(facts) }), {
      objective: null, criteria: [], counts: { confirmed: 0, met: 0, stale: 0, failing: 0, unmet: 0, proposed: 0 }
    });
  });

  it('summaryLine is the one line of the spec', () => {
    const v = view();
    assert.strictEqual(summaryLine(v), '1 of 3 confirmed criteria met · 1 stale · 1 unmet · 2 proposed (not counted)');
    const open = (n) => ({ ready: false, items: [...Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, state: i % 2 ? 'unknown' : 'open' })), { id: 'tree-clean', state: 'n/a' }, { id: 'plan-finished', state: 'ok' }] });
    assert.strictEqual(summaryLine(v, open(4)), '1 of 3 confirmed criteria met · 1 stale · 1 unmet · 2 proposed (not counted) · not ready to close (4 open)');
    assert.strictEqual(summaryLine(v, { ready: true, items: [{ id: 'plan-finished', state: 'ok' }] }), '1 of 3 confirmed criteria met · 1 stale · 1 unmet · 2 proposed (not counted) · ready to close');
    const counts = (c) => ({ counts: { confirmed: 0, met: 0, stale: 0, failing: 0, unmet: 0, proposed: 0, ...c } });
    assert.strictEqual(summaryLine(counts({ proposed: 3 })), '0 of 0 confirmed criteria met · 3 proposed (not counted)');
    assert.strictEqual(summaryLine(counts({})), '0 of 0 confirmed criteria met');
    assert.strictEqual(summaryLine(counts({ confirmed: 4, met: 2, failing: 1, stale: 1 })), '2 of 4 confirmed criteria met · 1 failing · 1 stale');
    assert.strictEqual(summaryLine(null), '0 of 0 confirmed criteria met');
  });
});

// Cases stage 8 (plan Task 16): a run of the check command as evidence.
describe('the chk- evidence resolver', () => {
  const runs = [
    { id: 'chk-0001', result: 'pass', head: 'aaaaaaa1111', dirty: 0 },
    { id: 'chk-0002', result: 'pass', head: 'aaaaaaa1111', dirty: 4 },
    { id: 'chk-0003', result: 'fail', head: 'aaaaaaa1111', dirty: 0 },
    { id: 'chk-0004', result: 'pass', head: 'bbbbbbb2222', dirty: 0 }
  ];
  const at = (head, extra = {}) => ({ checks: runs, snapshot: { stale: false, state: { head }, ...extra } });

  it('holds only for a passing run with a clean tree at the commit the repository is at', () => {
    assert.deepStrictEqual(resolveEvidence('chk-0001', at('aaaaaaa1111')), { exists: true, provenance: 'check', source: null, sourceKind: 'check', holds: true, reason: null, label: null });
    const not = (id, ctx) => { const r = resolveEvidence(id, ctx); return [r.exists, r.holds, r.reason, r.label]; };
    assert.deepStrictEqual(not('chk-0002', at('aaaaaaa1111')), [true, false, 'check-not-current', 'chk-0002 ran with uncommitted changes']);
    assert.deepStrictEqual(not('chk-0003', at('aaaaaaa1111')), [true, false, 'check-not-current', 'chk-0003 did not pass']);
    assert.deepStrictEqual(not('chk-0004', at('aaaaaaa1111')), [true, false, 'check-not-current', 'chk-0004 ran at bbbbbbb; the repository is now at aaaaaaa']);
    assert.deepStrictEqual(not('chk-0001', at('aaaaaaa1111', { stale: true })), [true, false, 'check-not-current', 'chk-0001: the repository state is stale or not known']);
    assert.deepStrictEqual(not('chk-0001', { checks: runs, snapshot: null }), [true, false, 'check-not-current', 'chk-0001: the repository state is stale or not known']);
    assert.deepStrictEqual(not('chk-0009', at('aaaaaaa1111')), [false, false, 'evidence-missing', 'chk-0009 is not a recorded check run']);
    assert.deepStrictEqual(not('chk-0001', { checks: null, snapshot: at('aaaaaaa1111').snapshot }), [false, false, 'evidence-missing', 'chk-0001 is not a recorded check run']);
  });
});

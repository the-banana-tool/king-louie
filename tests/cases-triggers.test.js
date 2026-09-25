// tests/cases-triggers.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { detectTriggers, underminedKeys, emptyBaseline, deepEqual } = require('../src/cases/triggers');

const NOW = new Date('2026-09-23T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const fact = (id, over = {}) => [id, { id, status: 'active', supersededBy: null, ...over }];
const kinds = (ts) => ts.map((t) => t.kind);

function input(over = {}) {
  return {
    source: 'owner',
    now: NOW,
    meta: { lastOwnerTurnAt: hoursAgo(1) },
    facts: new Map(),
    decisions: [],
    budget: null,
    executors: null,
    plan: null,
    playbookChanges: [],
    hookTriggers: [],
    baseline: emptyBaseline(),
    reorientAfterHours: 8,
    ...over
  };
}

describe('detectTriggers', () => {
  it('raises nothing for a quiet case, and every trigger is inert without its input', () => {
    assert.deepStrictEqual(detectTriggers(input()), []);
    assert.deepStrictEqual(detectTriggers({}), []);
  });

  it('time-gap: owner turns only, measured from the last owner turn', () => {
    const gap = detectTriggers(input({ meta: { lastOwnerTurnAt: hoursAgo(9) } }));
    assert.deepStrictEqual(kinds(gap), ['time-gap']);
    assert.strictEqual(gap[0].key, 'time-gap');
    assert.strictEqual(gap[0].blocking, true);
    assert.match(gap[0].detail, /9 hours ago/);
    assert.deepStrictEqual(detectTriggers(input({ source: 'wakeup', meta: { lastOwnerTurnAt: hoursAgo(90) } })), []);
    assert.deepStrictEqual(detectTriggers(input({ meta: { lastOwnerTurnAt: hoursAgo(7.9) } })), []);
    assert.deepStrictEqual(detectTriggers(input({ meta: {} })), []);
    assert.deepStrictEqual(kinds(detectTriggers(input({ meta: { lastOwnerTurnAt: new Date(hoursAgo(9)) } }))), ['time-gap'], 'a YAML Date works too');
  });

  it('time-gap: a lastOwnerTurnAt in the future raises nothing and is logged', () => {
    const lines = [];
    const remove = addSink((r) => lines.push(r.line));
    try {
      assert.deepStrictEqual(detectTriggers(input({ meta: { lastOwnerTurnAt: '2026-09-24T12:00:00Z' } })), []);
    } finally {
      remove();
    }
    assert.ok(lines.some((l) => /in the future/.test(l)), lines.join('\n'));
  });

  it('decision-undermined: once per decision and fact, until baselined', () => {
    const facts = new Map([fact('f-0001', { status: 'superseded', supersededBy: 'f-0003' }), fact('f-0002'), fact('f-0003')]);
    const decisions = [{ id: 'D-001', decision: 'Price per acre off the GIS layer', factIds: ['f-0001', 'f-0002'] }];
    const t = detectTriggers(input({ facts, decisions }));
    assert.deepStrictEqual(t, [{
      kind: 'decision-undermined',
      key: 'D-001:f-0001',
      blocking: true,
      decisionIds: ['D-001'],
      detail: 'D-001 ("Price per acre off the GIS layer") cites f-0001, which is now superseded by f-0003.'
    }]);
    assert.deepStrictEqual(underminedKeys(decisions, facts).map((u) => u.key), ['D-001:f-0001']);
    assert.deepStrictEqual(detectTriggers(input({ facts, decisions, baseline: { ...emptyBaseline(), undermined: ['D-001:f-0001'] } })), []);
  });

  it('executor-change: only for a known, non-stale executor whose material changed (C3 input)', () => {
    const baseline = { ...emptyBaseline(), executorsMaterial: { 'phone-agent': { openJobs: 1 } } };
    const changed = detectTriggers(input({ baseline, executors: { 'phone-agent': { stale: false, material: { openJobs: 2 } } } }));
    assert.deepStrictEqual(kinds(changed), ['executor-change']);
    assert.strictEqual(changed[0].key, 'executor:phone-agent');
    assert.deepStrictEqual(detectTriggers(input({ baseline, executors: { 'phone-agent': { stale: true, material: { openJobs: 5 } } } })), []);
    assert.deepStrictEqual(detectTriggers(input({ baseline, executors: { 'phone-agent': { material: { openJobs: 1 } } } })), []);
    assert.deepStrictEqual(detectTriggers(input({ baseline, executors: { 'web-01': { material: { openJobs: 9 } } } })), [], 'a new executor joins silently');
  });

  it('budget-threshold: 80 and 100 not yet in the baseline', () => {
    const budget = { usd: { spent: 17, limit: 20, crossed: [50, 80] }, turnsPerDay: { spent: 48, limit: 48, crossed: [50, 80, 100] } };
    const baseline = { ...emptyBaseline(), budgetCrossed: { usd: [50], turnsPerDay: [50, 80, 100] } };
    const t = detectTriggers(input({ budget, baseline }));
    assert.deepStrictEqual(t.map((x) => x.key), ['budget:usd:80']);
    assert.match(t[0].detail, /usd budget passed 80 % \(17 of 20\)/);
    const deadline = detectTriggers(input({ budget: { deadline: { at: '2026-11-30', crossed: [50, 80] } } }));
    assert.match(deadline[0].detail, /deadline \(2026-11-30\)/);
  });

  it('message-mid-plan: owner turns while a step is in flight (C3 input), never baselined', () => {
    const plan = { steps: [{ id: 's1', state: 'done' }, { id: 's2', state: 'in-flight' }] };
    assert.deepStrictEqual(kinds(detectTriggers(input({ plan }))), ['message-mid-plan']);
    assert.deepStrictEqual(detectTriggers(input({ plan, source: 'wakeup' })), []);
    assert.deepStrictEqual(detectTriggers(input({ plan: { steps: [{ id: 's1', state: 'pending' }] } })), []);
  });

  it('playbook-update: one per change (C6 input)', () => {
    const t = detectTriggers(input({ playbookChanges: [{ name: 'land-sale', from: 'v1', to: 'v2' }] }));
    assert.deepStrictEqual(t.map((x) => [x.kind, x.key]), [['playbook-update', 'playbook:land-sale:v2']]);
  });

  it('playbook-update: uses the key and detail C6 supplies', () => {
    const t = detectTriggers(input({ playbookChanges: [{ name: 'land-sale', from: '1.2.0', to: '1.2.0', key: 'playbook:land-sale:edited:ab12', detail: 'Playbook land-sale was edited locally.' }] }));
    assert.deepStrictEqual(t.map((x) => [x.key, x.detail]), [['playbook:land-sale:edited:ab12', 'Playbook land-sale was edited locally.']]);
  });

  it('hook triggers: kept unless acknowledged, and blocking unless they say otherwise', () => {
    const hookTriggers = [
      { kind: 'detour', key: 'detour:msg-7', detail: 'The owner changed the subject.' },
      { kind: 'note', key: 'note:1', detail: 'FYI', blocking: false },
      { kind: 'broken' }
    ];
    const t = detectTriggers(input({ hookTriggers }));
    assert.deepStrictEqual(t.map((x) => [x.key, x.blocking]), [['detour:msg-7', true], ['note:1', false]]);
    const acked = detectTriggers(input({ hookTriggers, baseline: { ...emptyBaseline(), acknowledgedKeys: ['detour:msg-7'] } }));
    assert.deepStrictEqual(acked.map((x) => x.key), ['note:1']);
  });

  it('deepEqual compares nested values', () => {
    assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
    assert.ok(!deepEqual([1], { 0: 1 }));
    assert.ok(deepEqual(null, null));
  });
});

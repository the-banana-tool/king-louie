// tests/cases-plan.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseSteps, stepsToTaskGraph, checkPlan, renderPlanCard, PlanStore
} = require('../src/cases/executors/plan');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const OUTBOUND = ['call', 'sms', 'email', 'web-form', 'postal-mail', 'pay', 'sign'];
const BROWSER = {
  id: 'browser', kind: 'tool', available: true, capabilities: ['web-browse', 'web-form', 'web-login'],
  cannot: OUTBOUND.filter((c) => c !== 'web-form'), constraints: {}, cost: {}, latency: 'interactive'
};
const OWNER = { id: 'owner', kind: 'owner', available: true, capabilities: ['any'], cannot: [], constraints: {}, cost: {}, latency: 'async-days' };
const PHONE = {
  id: 'phone-agent', kind: 'external-agent', available: true, capabilities: ['call', 'voicemail'], cannot: ['web-form', 'email', 'sms'],
  constraints: { contactsPerDay: 5, callingWindow: { tz: 'UTC', start: '09:00', end: '17:00', weekdays: [1, 2, 3, 4, 5] } },
  cost: { perJob: 1, perContact: 0.5, perAttempt: 0.25 }, latency: 'async-hours'
};
const MONDAY = new Date('2026-10-26T15:00:00Z');
const step = (over = {}) => ({
  id: 's1', title: 'File nine permit forms', description: 'File the county permit forms', dependsOn: [], priority: 1,
  estimatedComplexity: 'medium', executor: 'owner', capability: 'web-form', serves: 'permit filings', quantity: 9, unit: 'forms', ...over
});
const answered = (id, factId, payload, optionId = 'approve') => ({ id, payload, answer: { channel: 'in-app', optionId, factId } });
const userFact = (id, questionId) => ({ id, provenance: 'user', status: 'active', source: { kind: 'question', ref: questionId } });
const check = (over = {}) => checkPlan({
  steps: [step()], entries: [BROWSER, OWNER, PHONE], brief: {}, facts: new Map(), questions: [],
  budget: {}, globalRemaining: () => null, now: MONDAY, tz: 'UTC', attemptsDefault: 2, ...over
});

describe('parseSteps', () => {
  it('parses JSON text and fills defaults', () => {
    const r = parseSteps(JSON.stringify([{ id: 's1', title: 'Call brokers', executor: 'phone-agent', capability: 'call' }]));
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.steps[0], {
      id: 's1', title: 'Call brokers', description: 'Call brokers', dependsOn: [], priority: 1, estimatedComplexity: 'medium',
      executor: 'phone-agent', capability: 'call', serves: '', quantity: 1, unit: 'items'
    });
    assert.strictEqual(parseSteps(JSON.stringify({ steps: [step()] })).ok, true);
  });

  it('refuses unknown fields, agentId included, and bad values', () => {
    const r = parseSteps(JSON.stringify([{ ...step(), agentId: 'main', unit: 'boxes', quantity: 0 }]));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /step s1 has unknown field "agentId"/);
    assert.match(r.error, /quantity must be a whole number ≥ 1/);
    assert.match(r.error, /unit must be one of items, contacts, forms, pages/);
    assert.match(parseSteps('[').error, /"steps" is not valid JSON/);
    assert.match(parseSteps('[]').error, /non-empty list/);
  });

  it('maps steps to a planner task graph with agentId main', () => {
    const { tasks } = stepsToTaskGraph([step({ dependsOn: [] })]);
    assert.deepStrictEqual([tasks[0].id, tasks[0].agentId, tasks[0].description], ['s1', 'main', 'File the county permit forms']);
  });
});

describe('checkPlan', () => {
  it('estimates a capable step', () => {
    const r = check({ steps: [step({ executor: 'phone-agent', capability: 'call', quantity: 10, unit: 'contacts' })] });
    assert.deepStrictEqual([r.steps[0].check.status, r.steps[0].check.estimateUsd, r.estimateUsd], ['ok', 11, 11]);
    assert.strictEqual(r.steps[0].state, 'pending');
    assert.deepStrictEqual(r.steps[0].jobIds, []);
  });

  it('rewrites an owner step the owner has not agreed to', () => {
    const r = check();
    assert.deepStrictEqual(r.steps[0].executor, 'browser');
    assert.deepStrictEqual(r.steps[0].check, {
      status: 'rewritten', from: 'owner', reasons: ['owner has not consented to web-form'], estimateUsd: 0, days: null, consent: 'none'
    });
    assert.deepStrictEqual(r.consentCapabilities, []);
  });

  it('leaves the owner step needing consent when nothing else can do it', () => {
    const r = check({ entries: [{ ...BROWSER, available: false, reason: 'disabled for this case' }, OWNER, PHONE] });
    assert.deepStrictEqual([r.steps[0].executor, r.steps[0].check.status, r.steps[0].check.consent], ['owner', 'needs-consent', 'required']);
    assert.deepStrictEqual(r.consentCapabilities, ['web-form']);
  });

  it('keeps an owner step backed by the owner\'s plan approval or owner-task answer', () => {
    const planQ = answered('q-0003', 'f-0007', { type: 'plan', consentCapabilities: ['web-form'] });
    const r = check({
      brief: { resources: { ownerLabor: [{ capability: 'web-form', factId: 'f-0007' }] } },
      facts: new Map([['f-0007', userFact('f-0007', 'q-0003')]]),
      questions: [planQ]
    });
    assert.deepStrictEqual([r.steps[0].executor, r.steps[0].check.status, r.steps[0].check.consent], ['owner', 'ok', 'recorded:f-0007']);
    const taskQ = answered('q-0004', 'f-0008', { type: 'owner-task', capability: 'web-form' }, null);
    const t = check({
      brief: { resources: { ownerLabor: [{ capability: 'web-form', factId: 'f-0008' }] } },
      facts: new Map([['f-0008', userFact('f-0008', 'q-0004')]]),
      questions: [taskQ]
    });
    assert.strictEqual(t.steps[0].check.consent, 'recorded:f-0008');
  });

  it('ignores an ownerLabor entry that no owner answer backs', () => {
    const r = check({
      entries: [{ ...BROWSER, available: false, reason: 'disabled for this case' }, OWNER],
      brief: { resources: { ownerLabor: [{ capability: 'web-form', factId: 'f-0009' }] } },
      facts: new Map([['f-0009', { id: 'f-0009', provenance: 'user', status: 'active', source: { kind: 'user-message', ref: 'turn-1' } }]])
    });
    assert.deepStrictEqual(r.warnings, ['ownerLabor entry 1 is not backed by an owner answer; ignored']);
    assert.strictEqual(r.steps[0].check.status, 'needs-consent');
  });

  it('flags contact steps that cannot finish before the deadline', () => {
    const calls = step({ executor: 'phone-agent', capability: 'call', quantity: 30, unit: 'contacts' });
    const r = check({ steps: [calls], brief: { deadline: '2026-10-29' }, budget: { contactsPerDayLimit: 20 }, globalRemaining: () => 5 });
    assert.deepStrictEqual(r.steps[0].check.status, 'flagged');
    assert.deepStrictEqual(r.steps[0].check.reasons, ['needs 6 days at 5/day; 4 available before 2026-10-29']);
    assert.deepStrictEqual(r.steps[0].check.days, { needed: 6, available: 4 });
    assert.strictEqual(check({ steps: [calls] }).steps[0].check.status, 'ok', 'no deadline, feasible');
  });

  it('warns when the estimate exceeds the remaining budget', () => {
    const r = check({ steps: [step({ executor: 'phone-agent', capability: 'call', quantity: 10, unit: 'contacts' })], budget: { remainingUsd: 5 } });
    assert.deepStrictEqual(r.warnings, ['estimate $11.00 exceeds remaining $5.00']);
  });

  it('rewrites only within brief.resources.executors, never to the owner, cheapest first', () => {
    const r = check({ brief: { resources: { executors: ['phone-agent'] } } });
    assert.strictEqual(r.steps[0].check.status, 'needs-consent');
    const pricey = { ...BROWSER, id: 'forms-pro', cost: { perJob: 3 } };
    const unknown = check({ steps: [step({ executor: 'fax-bot' })], entries: [pricey, BROWSER, OWNER] });
    assert.deepStrictEqual([unknown.steps[0].executor, unknown.steps[0].check.reasons], ['browser', ['fax-bot is not a known executor']]);
    const flagged = check({ steps: [step({ executor: 'phone-agent', capability: 'postal-mail' })] });
    assert.deepStrictEqual([flagged.steps[0].check.status, flagged.steps[0].check.reasons], ['flagged', ['phone-agent cannot do postal-mail']]);
  });
});

describe('renderPlanCard', () => {
  it('renders the table, totals and one line per rewrite and warning', () => {
    const r = check({ budget: { remainingUsd: -1 } });
    const card = renderPlanCard({ id: 'plan-002', goal: 'Get the permits', steps: r.steps, estimateUsd: r.estimateUsd, warnings: r.warnings });
    const lines = card.split('\n');
    assert.strictEqual(lines[0], 'Plan plan-002: Get the permits');
    assert.strictEqual(lines[2], '| # | Step | Executor | Capability | Qty | Est. cost | Days (need/avail) | Consent | Check |');
    assert.strictEqual(lines[4], '| s1 | File nine permit forms | browser | web-form | 9 forms | $0.00 | — | none | rewritten |');
    assert.strictEqual(lines[5], '|  | **Total** |  |  |  | $0.00 |  |  |  |');
    assert.ok(card.includes('- s1 rewritten from owner to browser: owner has not consented to web-form'));
    assert.ok(card.includes('- Warning: estimate $0.00 exceeds remaining $-1.00'));
  });
});

describe('PlanStore', () => {
  it('numbers plans, archives superseded ones and closes a finished plan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-plan-'));
    dirs.push(dir);
    const store = new PlanStore(dir);
    assert.strictEqual(store.nextId(), 'plan-001');
    store.write({ id: 'plan-001', status: 'superseded', steps: [] });
    store.archive(store.read());
    store.write({
      id: 'plan-002', status: 'approved',
      steps: [{ id: 's1', state: 'pending', jobIds: [] }, { id: 's2', state: 'cancelled', jobIds: [] }]
    });
    assert.strictEqual(store.nextId(), 'plan-003');
    store.updateStep('s1', { state: 'in-flight', addJob: 'job-0001' });
    assert.deepStrictEqual(store.read().steps[0], { id: 's1', state: 'in-flight', jobIds: ['job-0001'] });
    const done = store.updateStep('s1', { state: 'done', note: 'filed' });
    assert.deepStrictEqual([done.status, done.steps[0].note], ['done', 'filed']);
  });

  it('refuses an unknown state and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-plan-'));
    dirs.push(dir);
    const store = new PlanStore(dir);
    store.write({ id: 'plan-001', status: 'approved', steps: [{ id: 's1', state: 'pending', jobIds: [] }] });
    const r = store.updateStep('s1', { state: 'bogus' });
    assert.deepStrictEqual(r, { ok: false, error: 'step s1: unknown state "bogus"' });
    assert.deepStrictEqual(store.read().steps[0], { id: 's1', state: 'pending', jobIds: [] });
  });

  it('refuses to move a done step to another state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-plan-'));
    dirs.push(dir);
    const store = new PlanStore(dir);
    store.write({ id: 'plan-001', status: 'approved', steps: [{ id: 's1', state: 'done', jobIds: [] }] });
    const r = store.updateStep('s1', { state: 'pending' });
    assert.deepStrictEqual(r, { ok: false, error: 'step s1 is done and cannot move to pending' });
    assert.strictEqual(store.read().steps[0].state, 'done');
  });

  it('refuses a new job on a cancelled step', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-plan-'));
    dirs.push(dir);
    const store = new PlanStore(dir);
    store.write({ id: 'plan-001', status: 'approved', steps: [{ id: 's1', state: 'cancelled', jobIds: [] }] });
    const r = store.updateStep('s1', { addJob: 'job-0002' });
    assert.deepStrictEqual(r, { ok: false, error: 'step s1 is cancelled and cannot take a new job' });
    assert.deepStrictEqual(store.read().steps[0].jobIds, []);
  });

  it('keeps plan.status consistent with its steps in both directions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-plan-'));
    dirs.push(dir);
    const store = new PlanStore(dir);
    store.write({
      id: 'plan-001', status: 'approved',
      steps: [{ id: 's1', state: 'pending', jobIds: [] }, { id: 's2', state: 'cancelled', jobIds: [] }]
    });
    const done = store.updateStep('s1', { state: 'done' });
    assert.strictEqual(done.status, 'done', 'promotes to done once every step is terminal');

    // A plan.json that disagrees with its own steps (e.g. hand-edited) must
    // be corrected back down the next time updateStep touches it.
    store.write({ id: 'plan-001', status: 'done', steps: [{ id: 's1', state: 'done', jobIds: [] }, { id: 's2', state: 'pending', jobIds: [] }] });
    const corrected = store.updateStep('s2', { note: 'still working' });
    assert.strictEqual(corrected.status, 'approved', 'demotes back to approved when a step is no longer terminal');
  });
});

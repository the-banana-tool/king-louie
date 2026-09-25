// tests/cases-plan-executor-tools.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fx = require('./helpers/executor-fixtures');
const { PlanTool, ExecutorTool, registerExecutorTools } = require('../src/tools/builtin/executor-tools');
const { CASE_TOOL_NAMES, CASE_MODE_PROMPT } = require('../src/cases/chat-integration');
const { toolRegistry, initializeTools } = require('../src/tools');

after(fx.cleanup);

async function setup({ gated = true } = {}) {
  const env = fx.setupExecutors();
  const ctl = fx.withFakeAgent(env);
  const meta = gated
    ? await fx.activeCase(env.runtime)
    : await env.runtime.createCase({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
  const { turn, caseContext } = await fx.openTurn(env.runtime, meta.id);
  const acres = env.runtime.ledger(meta.id).assert({
    stmt: 'Lot size is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acres', provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/lot' }
  });
  return { env, ctl, meta, turn, opts: { caseContext }, rt: env.runtime, acres };
}
const STEPS = JSON.stringify([{ id: 's1', title: 'Call three brokers', executor: 'fake-agent', capability: 'call', serves: 'a listing quote', quantity: 3, unit: 'contacts' }]);

describe('registration', () => {
  it('adds Plan and Executor to the case tools, neither needing approval', () => {
    assert.deepStrictEqual(CASE_TOOL_NAMES.slice(-2), ['Plan', 'Executor']);
    initializeTools();
    for (const name of ['Plan', 'Executor']) {
      assert.ok(toolRegistry.get(name), name);
      assert.strictEqual(toolRegistry.get(name).requiresApproval, false);
    }
    const seen = [];
    registerExecutorTools({ register: (t) => seen.push(t.name) });
    assert.deepStrictEqual(seen, ['Plan', 'Executor']);
  });

  it('tells the model how to plan and send', () => {
    assert.match(CASE_MODE_PROMPT, /every step names an executor/);
    assert.match(CASE_MODE_PROMPT, /goes through the Executor tool inside an owner-approved envelope/);
    assert.match(CASE_MODE_PROMPT, /\{\{f-0042\}\}/);
  });
});

describe('Plan tool', () => {
  it('proposes, reads and refuses by status and re-orientation', async () => {
    const s = await setup();
    const r = await PlanTool.execute({ action: 'propose', goal: 'Get a listing quote', summary: 'Ask brokers', steps: STEPS }, s.opts);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.planId, 'plan-001');
    const status = await PlanTool.execute({ action: 'status' }, s.opts);
    assert.deepStrictEqual([status.plan.id, status.plan.status], ['plan-001', 'proposed']);
    s.turn.reorientPending = true;
    assert.match((await PlanTool.execute({ action: 'propose', steps: STEPS }, s.opts)).error, /Re-orientation is required first/);
    s.turn.reorientPending = false;
    const draft = await setup({ gated: false });
    assert.match((await PlanTool.execute({ action: 'propose', steps: STEPS }, draft.opts)).error, /Case is a draft/);
  });

  it('syncs the owner\'s plan answer on the next call', async () => {
    const s = await setup();
    const r = await PlanTool.execute({ action: 'propose', steps: STEPS }, s.opts);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    assert.strictEqual((await PlanTool.execute({ action: 'status' }, s.opts)).plan.status, 'approved');
  });
});

describe('Executor tool', () => {
  it('requests an envelope from JSON text and submits a job under it', async () => {
    const s = await setup();
    const env = await ExecutorTool.execute({
      action: 'envelope', executor: 'fake-agent',
      envelope: JSON.stringify({ intent: 'Ask brokers for a listing quote', recipients: { allow: ['+15550100'] }, facts: [s.acres.id], caps: { usd: 10, contacts: 1, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' } })
    }, s.opts);
    assert.strictEqual(env.ok, true, env.error);
    await s.rt.answerQuestion(s.meta.id, env.questionId, { channel: 'in-app', optionId: 'approve' });
    const sub = await ExecutorTool.execute({
      action: 'submit', executor: 'fake-agent', envelopeId: env.envelopeId,
      payload: JSON.stringify({ recipients: [{ address: '+15550100' }], text: `Hello about the {{${s.acres.id}}} lot.` })
    }, s.opts);
    assert.deepStrictEqual([sub.ok, sub.jobId], [true, 'job-0001']);
    const status = await ExecutorTool.execute({ action: 'status', jobId: 'job-0001' }, s.opts);
    assert.deepStrictEqual([status.ok, status.jobs[0].state], [true, 'running']);
    const cancel = await ExecutorTool.execute({ action: 'cancel', jobId: 'job-0001' }, s.opts);
    assert.deepStrictEqual(cancel, { ok: true, jobId: 'job-0001', state: 'cancelled' });
  });

  it('refuses bad JSON, and reads but never submits in a paused case', async () => {
    const s = await setup();
    assert.match((await ExecutorTool.execute({ action: 'envelope', executor: 'fake-agent', envelope: '{nope' }, s.opts)).error, /"envelope" is not valid JSON/);
    s.rt.setStatus(s.meta.id, 'paused', { kind: 'owner', by: 'owner' });
    assert.strictEqual((await ExecutorTool.execute({ action: 'status' }, s.opts)).ok, true);
    assert.strictEqual((await PlanTool.execute({ action: 'status' }, s.opts)).ok, true);
    assert.match((await ExecutorTool.execute({ action: 'submit', executor: 'fake-agent', payload: '{}' }, s.opts)).error, /Case is paused/);
  });

  it('says so when the host has no executor registry', async () => {
    const s = await setup();
    const bare = { caseContext: { ...s.opts.caseContext, runtime: Object.assign(Object.create(Object.getPrototypeOf(s.rt)), s.rt, { host: {} }) } };
    assert.deepStrictEqual(await ExecutorTool.execute({ action: 'status' }, bare), { ok: false, error: 'Executors are not available in this host.' });
  });

  it('ignores unknown and bypass params instead of letting them change what happens', async () => {
    const s = await setup();
    // caseId is taken only from caseContext: a params.caseId naming another
    // case (or nothing at all) has no effect on which case is touched.
    const propose = await PlanTool.execute({
      action: 'propose', steps: STEPS, caseId: 'some-other-case', force: true, authority: 'signed', expectStatus: 'approved'
    }, s.opts);
    assert.strictEqual(propose.ok, true, propose.error);
    assert.strictEqual(propose.planId, 'plan-001');
    assert.strictEqual((await PlanTool.execute({ action: 'status' }, s.opts)).plan.id, 'plan-001');

    // An "authority" (or force/signedOutcomes/keepReservation/origin/expectStatus)
    // param on the Executor tool is not part of its schema and is not read by
    // the envelope op: the envelope still runs under the executor's own
    // configured authority ('envelope'), never escalated to 'signed'.
    const env = await ExecutorTool.execute({
      action: 'envelope', executor: 'fake-agent', authority: 'signed', force: true, signedOutcomes: [{ decision: 'approve' }], expectStatus: 'active',
      envelope: JSON.stringify({
        intent: 'Ask brokers for a listing quote', recipients: { allow: ['+15550100'] }, facts: [s.acres.id],
        caps: { usd: 10, contacts: 1, attemptsPerContact: 2 }, window: { start: '2026-10-26', end: '2026-10-30' }, authority: 'signed'
      })
    }, s.opts);
    assert.strictEqual(env.ok, true, env.error);
    assert.strictEqual(env.status, 'requested');
    assert.strictEqual(env.note, 'The owner approves it; nothing is sent until then.');

    // A cancel with a stray "keepReservation" param behaves exactly as a
    // plain cancel: nothing is exposed to reinstate a released reservation.
    await s.rt.answerQuestion(s.meta.id, env.questionId, { channel: 'in-app', optionId: 'approve' });
    const sub = await ExecutorTool.execute({
      action: 'submit', executor: 'fake-agent', envelopeId: env.envelopeId,
      payload: JSON.stringify({ recipients: [{ address: '+15550100' }], text: `Hello about the {{${s.acres.id}}} lot.` })
    }, s.opts);
    assert.strictEqual(sub.ok, true, sub.error);
    const cancel = await ExecutorTool.execute({ action: 'cancel', jobId: sub.jobId, keepReservation: true, force: true }, s.opts);
    assert.deepStrictEqual(cancel, { ok: true, jobId: sub.jobId, state: 'cancelled' });
  });
});

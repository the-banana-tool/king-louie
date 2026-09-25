// tests/cases-plan-ops.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const planOps = require('../src/cases/executors/plan-ops');
const { turnStartHook } = require('../src/cases/executors/turn-hook');
const { PlanStore, JobStore } = require('../src/cases/executors');
const { writeJsonAtomic } = require('../src/cases/executors/util');
const { BriefTool } = require('../src/tools/builtin/case-tools');

after(fx.cleanup);

const FORMS = { id: 's1', title: 'File nine permit forms', executor: 'owner', capability: 'web-form', serves: 'permit filings', quantity: 9, unit: 'forms' };
const NOTES = { id: 's2', title: 'Write up the zoning notes', executor: 'files', capability: 'write-files', dependsOn: ['s1'] };

async function setup({ browserDisabled = false } = {}) {
  const env = fx.setupExecutors();
  const meta = await fx.activeCase(env.runtime);
  if (browserDisabled) writeJsonAtomic(path.join(meta.dir, '.kl', 'executors.json'), { browser: { override: { disabled: true } } });
  return { env, meta, reg: env.registry, rt: env.runtime, ctx: { caseId: meta.id, turnId: 'turn-1' } };
}
const propose = (s, steps, over = {}) => planOps.proposePlan(s.reg, s.ctx, { goal: 'Get the permits', summary: 'File the county permits', steps: JSON.stringify(steps), ...over });

describe('Plan propose', () => {
  it('writes the plan, rewrites the owner step and asks the owner to approve', async () => {
    const s = await setup();
    const r = await propose(s, [FORMS, NOTES]);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual([r.planId, r.approvable], ['plan-001', true]);
    assert.deepStrictEqual(r.steps.map((x) => [x.id, x.executor, x.check.status]), [['s1', 'browser', 'rewritten'], ['s2', 'files', 'ok']]);
    const q = s.rt.questions(s.meta.id).get(r.questionId);
    assert.deepStrictEqual([q.kind, q.payload.type, q.payload.planId, q.payload.consentCapabilities, q.options.map((o) => o.id)], ['approval', 'plan', 'plan-001', [], ['approve', 'reject']]);
    assert.ok(q.text.startsWith('Plan plan-001: Get the permits'));
    const plan = new PlanStore(s.meta.dir).read();
    assert.deepStrictEqual([plan.status, plan.questionId], ['proposed', r.questionId]);
    assert.ok(fs.readdirSync(path.join(s.meta.dir, 'journal')).some((n) => n.endsWith('-plan.md')));
    assert.deepStrictEqual(r.suggestions, []);
  });

  it('offers approve-no-owner when a step needs the owner', async () => {
    const s = await setup({ browserDisabled: true });
    const r = await propose(s, [FORMS]);
    assert.strictEqual(r.steps[0].check.status, 'needs-consent');
    const q = s.rt.questions(s.meta.id).get(r.questionId);
    assert.deepStrictEqual([q.options.map((o) => o.id), q.payload.consentCapabilities], [['approve', 'approve-no-owner', 'reject'], ['web-form']]);
  });

  it('shows the owner steps and the consent first in the question', async () => {
    const s = await setup({ browserDisabled: true });
    const r = await propose(s, [FORMS, NOTES]);
    const q = s.rt.questions(s.meta.id).get(r.questionId);
    assert.ok(q.text.startsWith([
      'Steps you would do yourself if you approve:',
      '- s1: File nine permit forms (web-form, 9 forms; needs your consent)',
      'Approving records your consent to: web-form.',
      '',
      'Plan plan-001: Get the permits'
    ].join('\n')), q.text);
  });

  it('refuses a plan too long to show the owner in full, writing nothing', async () => {
    const s = await setup();
    const steps = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`, title: `Write up the zoning notes for parcel number ${i} of the lakeside subdivision`, executor: 'files', capability: 'write-files'
    }));
    assert.deepStrictEqual(await propose(s, steps), { ok: false, error: 'the plan is too long to show the owner in full; split it' });
    assert.strictEqual(new PlanStore(s.meta.dir).read(), null);
    assert.deepStrictEqual(s.rt.questions(s.meta.id).list().filter((q) => q.payload?.type === 'plan'), []);
  });

  it('an answer to a question bound to another plan never approves this one', async () => {
    const s = await setup();
    await propose(s, [FORMS]);
    const other = s.rt.createQuestion(s.meta.id, {
      kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text: 'Plan plan-999', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      payload: { type: 'plan', planId: 'plan-999', consentCapabilities: [], mcpAnswerable: true }
    }, { charge: false });
    const store = new PlanStore(s.meta.dir);
    const plan = store.read();
    plan.questionId = other.id;
    store.write(plan);
    await s.rt.answerQuestion(s.meta.id, other.id, { channel: 'in-app', optionId: 'approve' });
    assert.strictEqual(planOps.syncPlan(s.reg, s.meta.id), null);
    assert.strictEqual(new PlanStore(s.meta.dir).read().status, 'proposed');
  });

  it('records owner labor from the approval, and the next plan honours it', async () => {
    const s = await setup({ browserDisabled: true });
    const r = await propose(s, [FORMS]);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    assert.strictEqual(planOps.syncPlan(s.reg, s.meta.id), 'approved');
    const plan = new PlanStore(s.meta.dir).read();
    const factId = s.rt.questions(s.meta.id).get(r.questionId).answer.factId;
    assert.deepStrictEqual([plan.status, plan.steps[0].check.status, plan.steps[0].check.consent], ['approved', 'ok', `recorded:${factId}`]);
    const labor = s.rt.brief(s.meta.id).read().data.resources.ownerLabor;
    assert.deepStrictEqual(labor.map((e) => [e.planId, e.stepId, e.capability, e.factId]), [['plan-001', 's1', 'web-form', factId]]);
    const again = await propose(s, [FORMS]);
    assert.deepStrictEqual([again.steps[0].executor, again.steps[0].check.status], ['owner', 'ok']);
  });

  it('approve-no-owner cancels the owner steps; reject rejects', async () => {
    const s = await setup({ browserDisabled: true });
    const r = await propose(s, [FORMS, { ...NOTES, dependsOn: [] }]);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve-no-owner' });
    planOps.syncPlan(s.reg, s.meta.id);
    const plan = new PlanStore(s.meta.dir).read();
    assert.deepStrictEqual([plan.status, plan.steps[0].state, plan.steps[1].state], ['approved', 'cancelled', 'pending']);
    const t = await setup();
    const rt = await propose(t, [FORMS]);
    await t.rt.answerQuestion(t.meta.id, rt.questionId, { channel: 'in-app', optionId: 'reject' });
    assert.strictEqual(planOps.syncPlan(t.reg, t.meta.id), 'rejected');
  });

  it('refuses a new plan while steps are in flight, and a cyclic graph', async () => {
    const s = await setup();
    await propose(s, [FORMS]);
    const store = new PlanStore(s.meta.dir);
    const plan = store.read();
    plan.steps[0].state = 'in-flight';
    store.write(plan);
    assert.deepStrictEqual(await propose(s, [FORMS]), { ok: false, error: 'plan-001 has steps in flight (s1); cancel their jobs or wait before proposing a new plan' });
    const t = await setup();
    const cyc = await propose(t, [{ ...FORMS, dependsOn: ['s2'] }, NOTES]);
    assert.deepStrictEqual([cyc.ok, cyc.code], [false, 'CYCLE']);
  });

  it('supersedes the previous plan and closes its question', async () => {
    const s = await setup();
    const first = await propose(s, [FORMS]);
    const second = await propose(s, [NOTES].map((x) => ({ ...x, dependsOn: [] })));
    assert.strictEqual(second.planId, 'plan-002');
    assert.strictEqual(new PlanStore(s.meta.dir).read().supersedes, 'plan-001');
    assert.ok(s.rt.questions(s.meta.id).get(first.questionId).closed);
    assert.ok(fs.existsSync(path.join(s.meta.dir, '.kl', 'plans', 'plan-001.json')));
  });

  it('passes the detour gate once and keeps its note; a refusal is returned', async () => {
    const s = await setup();
    const calls = [];
    s.rt.detourGate = async (id, args) => { calls.push(args); return { ok: true, note: 'Related to the zoning detour.' }; };
    s.rt.playbookSteps = () => [{ title: 'Check the county fee schedule' }];
    const r = await propose(s, [FORMS]);
    assert.deepStrictEqual([calls.length, calls[0].source, calls[0].serves, r.note], [1, 'plan', 'File the county permits\npermit filings', 'Related to the zoning detour.']);
    assert.deepStrictEqual(r.suggestions, [{ title: 'Check the county fee schedule' }]);
    s.rt.detourGate = async () => ({ ok: false, error: 'This serves the other case.' });
    assert.deepStrictEqual(await propose(s, [FORMS]), { ok: false, error: 'This serves the other case.' });
  });

  it('asks nothing for a plan with a flagged step', async () => {
    const s = await setup();
    const r = await propose(s, [{ ...FORMS, executor: 'files', capability: 'postal-mail' }]);
    assert.deepStrictEqual([r.approvable, r.questionId, r.steps[0].check.status], [false, undefined, 'flagged']);
  });
});

describe('Plan complete', () => {
  it('marks a direct step done and closes the plan; job-backed steps are refused', async () => {
    const s = await setup();
    const r = await propose(s, [FORMS, NOTES]);
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    planOps.syncPlan(s.reg, s.meta.id);
    assert.match(planOps.completeStep(s.reg, s.ctx, { stepId: 's1', note: 'done' }).error, /runs on browser; it moves with its jobs/);
    const done = planOps.completeStep(s.reg, s.ctx, { stepId: 's2', note: 'Notes written to notes.md' });
    assert.deepStrictEqual([done.ok, done.step.state, done.planStatus], [true, 'done', 'approved']);
    new PlanStore(s.meta.dir).updateStep('s1', { state: 'done' });
    assert.strictEqual(planOps.planStatus(s.reg, s.ctx).plan.status, 'done');
  });

  it('maps a refused updateStep to a result', async () => {
    const s = await setup();
    const r = await propose(s, [NOTES].map((x) => ({ ...x, dependsOn: [] })));
    await s.rt.answerQuestion(s.meta.id, r.questionId, { channel: 'in-app', optionId: 'approve' });
    planOps.syncPlan(s.reg, s.meta.id);
    const real = PlanStore.prototype.updateStep;
    PlanStore.prototype.updateStep = () => ({ ok: false, error: 'step s2 is done and cannot move to done' });
    try {
      assert.deepStrictEqual(planOps.completeStep(s.reg, s.ctx, { stepId: 's2', note: 'x' }), { ok: false, error: 'step s2 is done and cannot move to done' });
    } finally {
      PlanStore.prototype.updateStep = real;
    }
  });
});

describe('owner labor is host-only (R41)', () => {
  it('forged ownerLabor entry is refused', async () => {
    const s = await setup({ browserDisabled: true });
    const forged = s.rt.ledger(s.meta.id).assert({
      stmt: 'Owner will file the forms', subject: 'owner', attr: 'labor', value: 'web-form', provenance: 'user',
      source: { kind: 'user-message', ref: 'turn-1', quote: 'file the forms' }
    });
    s.rt.brief(s.meta.id).update('resources', { executors: [], ownerLabor: [{ capability: 'web-form', factId: forged.id }] }, { provenance: 'model' });
    const r = await propose(s, [FORMS]);
    assert.deepStrictEqual([r.steps[0].check.status, r.steps[0].executor], ['needs-consent', 'owner']);
    assert.match(r.card, /Warning: ownerLabor entry 1 is not backed by an owner answer; ignored/);

    const { turn, caseContext } = await fx.openTurn(s.rt, s.meta.id);
    const refused = await BriefTool.execute({
      action: 'update', field: 'resources', value: JSON.stringify({ executors: ['browser'], ownerLabor: [{ capability: 'web-form', factId: 'f-0099' }] })
    }, { caseContext });
    assert.deepStrictEqual(refused, { ok: false, error: "ownerLabor is recorded only from the owner's answer to a plan or owner task." });
    const kept = await BriefTool.execute({ action: 'update', field: 'resources', value: JSON.stringify({ executors: ['browser'] }) }, { caseContext });
    assert.strictEqual(kept.ok, true, kept.error);
    assert.deepStrictEqual(s.rt.brief(s.meta.id).read().data.resources.ownerLabor, [{ capability: 'web-form', factId: forged.id }]);
    await s.rt.endTurn(turn, {});
  });
});

describe('turn-start hook', () => {
  it('returns the executor section only when the case uses executors', async () => {
    const s = await setup();
    assert.deepStrictEqual(await turnStartHook(s.reg, { caseId: s.meta.id }), {});
    fx.withFakeAgent(s.env);
    s.rt.brief(s.meta.id).update('resources', { executors: ['fake-agent'], ownerLabor: [] }, { provenance: 'model' });
    await s.reg.adapter('fake-agent');
    const out = await s.reg.turnStartHook({ caseId: s.meta.id });
    assert.strictEqual(out.notes.length, 1);
    assert.match(out.notes[0], /^## Executors\n\n- fake-agent \(external-agent, authority envelope\)/);
    assert.match(out.notes[0], /- fake-agent: Say who you are calling for\./);
    const job = new JobStore(s.meta.dir).create({ caseId: s.meta.id, executor: 'fake-agent', kind: 'external', state: 'submitting' });
    await s.reg.turnStartHook({ caseId: s.meta.id });
    assert.deepStrictEqual([new JobStore(s.meta.dir).get(job.id).state, new JobStore(s.meta.dir).get(job.id).reason], ['failed', 'interrupted']);
  });
});

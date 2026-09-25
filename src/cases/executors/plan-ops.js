// src/cases/executors/plan-ops.js
// Plan flows (cases stage 3 spec §3.4): propose (checks, card, approval
// question), sync the owner's answer (owner labor, R41), complete a direct
// step, and read the plan. Every function returns a result; none throws to a
// tool.
const { createLogger } = require('../../logging');
const { validateTaskGraph, TaskGraphValidationError } = require('../../workflows/task-graph-validator');
const { parseSteps, stepsToTaskGraph, checkPlan, renderPlanCard, PlanStore } = require('./plan');
const { pickTimeZone } = require('./util');

const log = createLogger('executors/plans');
// C2 question text limit: the owner must see every step they approve.
const QUESTION_MAX = 2000;
const TOO_LONG = 'the plan is too long to show the owner in full; split it';

// The owner's own steps and what approving consents to, shown before the card.
function ownerLines(plan) {
  const owner = (plan.steps || []).filter((s) => s.executor === 'owner');
  if (!owner.length) return [];
  const lines = ['Steps you would do yourself if you approve:'];
  for (const s of owner) {
    const consent = s.check?.status === 'needs-consent'
      ? 'needs your consent'
      : `you agreed earlier (${String(s.check?.consent || '').replace(/^recorded:/, '')})`;
    lines.push(`- ${s.id}: ${s.title} (${s.capability}, ${s.quantity} ${s.unit}; ${consent})`);
  }
  if ((plan.consentCapabilities || []).length) lines.push(`Approving records your consent to: ${plan.consentCapabilities.join(', ')}.`);
  return [...lines, ''];
}

function planInputs(reg, caseId) {
  const rt = reg.caseRuntime;
  let brief = {};
  try {
    brief = rt.brief(caseId).read().data || {};
  } catch {
    brief = {};
  }
  const budget = rt.budget(caseId);
  return {
    brief,
    facts: rt.ledger(caseId).view().facts,
    questions: rt.questions(caseId).list(),
    budget: { remainingUsd: budget.remaining('usd'), contactsPerDayLimit: budget.limitFor('contactsPerDay'), deadline: budget.limitFor('deadline') }
  };
}

async function proposePlan(reg, ctx = {}, params = {}) {
  try {
    return await proposePlanUnsafe(reg, ctx, params);
  } catch (err) {
    log.warn(`Proposing a plan for ${ctx?.caseId} failed: ${err.message}`);
    return { ok: false, error: `Proposing the plan failed: ${err.message}` };
  }
}

async function proposePlanUnsafe(reg, { caseId, turnId = null } = {}, params = {}) {
  const rt = reg.caseRuntime;
  const now = reg.now();
  const store = new PlanStore(reg.caseDir(caseId));
  const current = store.read();
  const live = current && ['proposed', 'approved'].includes(current.status);
  if (live) {
    const inFlight = (current.steps || []).filter((s) => s.state === 'in-flight').map((s) => s.id);
    if (inFlight.length) {
      return { ok: false, error: `${current.id} has steps in flight (${inFlight.join(', ')}); cancel their jobs or wait before proposing a new plan` };
    }
  }
  const parsed = parseSteps(params.steps);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    validateTaskGraph(stepsToTaskGraph(parsed.steps));
  } catch (err) {
    if (err instanceof TaskGraphValidationError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
  const summary = String(params.summary || '').trim();
  const goal = String(params.goal || '').trim();
  let note = null;
  if (typeof rt.detourGate === 'function') {
    const serves = [summary, ...parsed.steps.map((s) => s.serves)].filter(Boolean).join('\n');
    const gate = await rt.detourGate(caseId, { source: 'plan', serves, text: summary, turnId });
    if (gate && gate.ok === false) return gate;
    if (gate && gate.note) note = gate.note;
  }
  const inputs = planInputs(reg, caseId);
  const checked = checkPlan({
    steps: parsed.steps, entries: reg.list({ caseId }), brief: inputs.brief, facts: inputs.facts, questions: inputs.questions,
    budget: inputs.budget, globalRemaining: (id) => reg.globalRemaining(id), now, tz: pickTimeZone(reg.casesTimeZone()),
    attemptsDefault: reg.settings().attemptsDefault
  });
  const plan = {
    id: store.nextId(), status: 'proposed', supersedes: live ? current.id : null, questionId: null, goal, summary,
    estimateUsd: checked.estimateUsd, warnings: checked.warnings, consentCapabilities: checked.consentCapabilities,
    createdAt: now.toISOString(), turnId, steps: checked.steps
  };
  const card = renderPlanCard(plan);
  const approvable = !plan.steps.some((s) => s.check.status === 'flagged');
  const questionText = [...ownerLines(plan), card].join('\n');
  // Checked before anything is written: the previous plan stays as it is.
  if (approvable && questionText.length > QUESTION_MAX) return { ok: false, error: TOO_LONG };
  if (current) {
    if (live) {
      current.status = 'superseded';
      if (current.questionId) {
        try {
          rt.questions(caseId).close(current.questionId, { reason: `superseded by ${plan.id}`, by: 'system' });
        } catch {
          // already answered or closed
        }
      }
    }
    store.archive(current);
  }
  if (approvable) {
    const needsConsent = plan.steps.some((s) => s.check.status === 'needs-consent');
    const q = rt.createQuestion(caseId, {
      kind: 'approval', urgency: 'normal', defaultOnSilence: 'hold', text: questionText,
      options: [
        { id: 'approve', label: 'Approve' },
        ...(needsConsent ? [{ id: 'approve-no-owner', label: "Approve, except the owner's steps" }] : []),
        { id: 'reject', label: 'Reject' }
      ],
      payload: { type: 'plan', planId: plan.id, consentCapabilities: plan.consentCapabilities, mcpAnswerable: true }
    }, { charge: false });
    plan.questionId = q && q.id ? q.id : null;
  }
  store.write(plan);
  rt.records(caseId).writeJournal('plan', `${card}\n\nSteps as proposed:\n\n\`\`\`json\n${JSON.stringify(parsed.steps, null, 2)}\n\`\`\``, now);
  const suggestions = typeof rt.playbookSteps === 'function' ? (rt.playbookSteps(caseId) || []) : [];
  return {
    ok: true, planId: plan.id, approvable, card, steps: plan.steps,
    ...(plan.questionId ? { questionId: plan.questionId } : {}), suggestions, ...(note ? { note } : {})
  };
}

// The owner's answer to the plan question. Owner labor (R41) is recorded
// only here, only for the capabilities the question showed the owner.
function syncPlan(reg, caseId) {
  const rt = reg.caseRuntime;
  const store = new PlanStore(reg.caseDir(caseId));
  const plan = store.read();
  if (!plan || plan.status !== 'proposed' || !plan.questionId) return null;
  const q = rt.questions(caseId).get(plan.questionId);
  if (!q || !q.answer || q.payload?.type !== 'plan' || q.payload.planId !== plan.id) return null;
  const shown = Array.isArray(q.payload.consentCapabilities) ? q.payload.consentCapabilities : [];
  const { optionId, factId, at, channel } = q.answer;
  if (optionId === 'approve') {
    plan.status = 'approved';
    for (const s of plan.steps) {
      if (s.check?.status !== 'needs-consent' || !shown.includes(s.capability)) continue;
      rt.brief(caseId).recordOwnerLabor({ planId: plan.id, stepId: s.id, capability: s.capability, title: s.title, factId, at });
      s.check = { ...s.check, status: 'ok', consent: `recorded:${factId}` };
    }
  } else if (optionId === 'approve-no-owner') {
    plan.status = 'approved';
    for (const s of plan.steps) {
      if (s.check?.status !== 'needs-consent') continue;
      s.state = 'cancelled';
      s.reason = 'the owner did not agree to do this step';
    }
  } else if (optionId === 'reject') {
    plan.status = 'rejected';
  } else {
    return null;
  }
  if (plan.status === 'approved' && plan.steps.every((s) => s.state === 'done' || s.state === 'cancelled')) plan.status = 'done';
  store.write(plan);
  rt.records(caseId).writeJournal('plan', `Plan ${plan.id} ${plan.status} by the owner (${channel}, ${q.id}).`, reg.now());
  return plan.status;
}

// Direct executors (bash, files, web) do their work with ordinary tools;
// the model marks those steps done. Job-backed steps move with their jobs.
function completeStep(reg, { caseId } = {}, { stepId, note = '' } = {}) {
  try {
    const store = new PlanStore(reg.caseDir(caseId));
    const plan = store.read();
    if (!plan || plan.status !== 'approved') return { ok: false, error: 'There is no approved plan to complete a step of.' };
    const step = (plan.steps || []).find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `Step ${stepId} is not in ${plan.id}.` };
    const entry = reg.get(step.executor, { caseId });
    if (!entry || !entry.direct) return { ok: false, error: `Step ${stepId} runs on ${step.executor}; it moves with its jobs, not by hand.` };
    if (step.state === 'done' || step.state === 'cancelled') return { ok: false, error: `Step ${stepId} is already ${step.state}.` };
    const next = store.updateStep(stepId, { state: 'done', note: String(note || '') });
    if (!next) return { ok: false, error: 'There is no plan to complete a step of.' };
    if (next.ok === false) return { ok: false, error: next.error };
    reg.caseRuntime.records(caseId).writeJournal('plan', `Step ${stepId} of ${plan.id} done: ${note || 'no note'}.`, reg.now());
    return { ok: true, planId: next.id, planStatus: next.status, step: next.steps.find((s) => s.id === stepId) };
  } catch (err) {
    log.warn(`Completing step ${stepId} in ${caseId} failed: ${err.message}`);
    return { ok: false, error: `Completing step ${stepId} failed: ${err.message}` };
  }
}

function planStatus(reg, { caseId } = {}) {
  try {
    const plan = new PlanStore(reg.caseDir(caseId)).read();
    if (!plan) return { ok: true, plan: null, note: 'No plan yet. Propose one with action "propose".' };
    return { ok: true, plan, card: renderPlanCard(plan) };
  } catch (err) {
    return { ok: false, error: `Reading the plan failed: ${err.message}` };
  }
}

module.exports = { proposePlan, syncPlan, completeStep, planStatus };

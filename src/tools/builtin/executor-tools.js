// src/tools/builtin/executor-tools.js
// The Plan and Executor case tools (cases stage 3 spec §3.4, §3.5). They
// reach the executor registry through the case runtime's host.
const { Tool } = require('../tool-schema');
const { withCase } = require('./case-tools');
const planOps = require('../../cases/executors/plan-ops');
const envelopeOps = require('../../cases/executors/envelope-ops');
const { submitJob } = require('../../cases/executors/submit');
const results = require('../../cases/executors/results');
const jobs = require('../../cases/executors/jobs');
const { parseJsonObject } = require('../../cases/executors/util');

const NO_REGISTRY = Object.freeze({ ok: false, error: 'Executors are not available in this host.' });

function registryOf(ctx) {
  try {
    return ctx.runtime?.host?.getExecutorRegistry?.() || null;
  } catch {
    return null;
  }
}

// Every Plan/Executor call first applies the owner's answers.
function sync(reg, caseId) {
  planOps.syncPlan(reg, caseId);
  envelopeOps.syncEnvelopes(reg, caseId);
}

const PlanTool = new Tool({
  name: 'Plan',
  description: 'Plan the case with executors. propose: steps as JSON text, each { id, title, description, dependsOn, priority, estimatedComplexity, executor, capability, serves, quantity, unit (items|contacts|forms|pages) }. Every step names the executor that does it (see the Executors section) and the capability it uses. Code checks each step: a step the executor cannot do moves to one that can, a step on the owner needs the owner\'s consent, and contact steps must fit the daily caps before the deadline. The owner approves the plan card. status: read the plan. complete: mark a bash/files/web step done with a note; other steps move with their jobs.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['propose', 'status', 'complete'] },
      goal: { type: 'string' },
      summary: { type: 'string' },
      steps: { type: 'string', description: 'For propose: JSON text of the list of steps' },
      stepId: { type: 'string', description: 'For complete' },
      note: { type: 'string', description: 'For complete: what was done' }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, (p) => (p.action === 'status' ? 'Plan.status' : 'Plan'), async (ctx) => {
    const reg = registryOf(ctx);
    if (!reg) return NO_REGISTRY;
    sync(reg, ctx.caseId);
    if (params.action === 'status') return planOps.planStatus(reg, ctx);
    if (params.action === 'complete') return planOps.completeStep(reg, ctx, { stepId: params.stepId, note: params.note });
    if (params.action === 'propose') return planOps.proposePlan(reg, { caseId: ctx.caseId, turnId: ctx.turnId }, params);
    return { ok: false, error: `Unknown action: ${params.action}` };
  }, { params, reoriented: params?.action === 'propose' })
});

const ExecutorTool = new Tool({
  name: 'Executor',
  description: 'Hand work to an executor. envelope: ask the owner to approve an envelope (JSON text { intent, recipients: { allow }, facts, rules, caps: { usd, contacts, attemptsPerContact }, window: { start, end } }); nothing leaves until it is approved. draft: have the draft model write the outbound text (nothing is sent). submit: send one job (payload as JSON text) under an approved envelope; anything outside it comes back as a question to the owner naming only the difference. status: refresh open jobs. results: save the executor\'s records under sources/ and record what it reported. cancel: cancel a job. Quote facts in any text as {{f-0042}}.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['envelope', 'draft', 'submit', 'status', 'results', 'cancel'] },
      executor: { type: 'string' },
      envelopeId: { type: 'string' },
      jobId: { type: 'string' },
      planStepId: { type: 'string' },
      retryOf: { type: 'string', description: 'For submit: the finished job this retries' },
      serves: { type: 'string', description: 'For submit: what this job serves' },
      envelope: { type: 'string', description: 'For envelope: JSON text of the envelope request' },
      payload: { type: 'string', description: 'For submit: JSON text of the job payload' },
      instructions: { type: 'string', description: 'For draft' }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, (p) => `Executor.${p.action}`, async (ctx) => {
    const reg = registryOf(ctx);
    if (!reg) return NO_REGISTRY;
    sync(reg, ctx.caseId);
    const c = { caseId: ctx.caseId, turnId: ctx.turnId, signal: ctx.runtime.turns?.get(ctx.caseId)?.signal || null };
    switch (params.action) {
      case 'envelope': {
        const body = parseJsonObject(params.envelope, 'envelope');
        if (!body.ok) return body;
        return envelopeOps.requestEnvelope(reg, c, { ...body.value, executor: params.executor || body.value.executor });
      }
      case 'draft':
        return results.draftPayload(reg, c, { executor: params.executor, envelopeId: params.envelopeId, instructions: params.instructions });
      case 'submit':
        return submitJob(reg, c, {
          executor: params.executor, envelopeId: params.envelopeId, planStepId: params.planStepId,
          retryOf: params.retryOf, serves: params.serves, payload: params.payload
        });
      case 'status':
        return results.jobStatus(reg, c, { jobId: params.jobId });
      case 'results':
        return results.fetchResults(reg, c, { jobId: params.jobId });
      case 'cancel': {
        if (!params.jobId) return { ok: false, error: 'cancel needs "jobId".' };
        const r = await jobs.cancelJob(reg, ctx.caseId, params.jobId, 'cancelled in the case turn');
        return r.ok ? { ok: true, jobId: r.job.id, state: r.job.state, ...(r.note ? { note: r.note } : {}) } : r;
      }
      default:
        return { ok: false, error: `Unknown action: ${params.action}` };
    }
  }, { params, reoriented: ['envelope', 'submit', 'cancel'].includes(params?.action) })
});

function registerExecutorTools(toolRegistry) {
  toolRegistry.register(PlanTool);
  toolRegistry.register(ExecutorTool);
}

module.exports = { PlanTool, ExecutorTool, registerExecutorTools };

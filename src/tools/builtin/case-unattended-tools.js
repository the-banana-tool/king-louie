// src/tools/builtin/case-unattended-tools.js
// Reorient, Ask and Fail (cases stage 2 spec §3.3, §3.4, §3.9). Like the
// stage-1 case tools they read options.caseContext and refuse by result.
const { Tool } = require('../tool-schema');
const { withCase } = require('./case-tools');
const { recommendationGate } = require('../../cases/gates');
const { FAILURE_CLASSES } = require('../../cases/status');

const ACTIONS = Object.freeze(['continue', 'adjust', 'ask']);
const NEXT = Object.freeze({
  continue: 'Carry on with what the case was doing.',
  adjust: 'Adjust the plan to what changed, then continue.',
  ask: 'Ask the owner with the Ask tool before acting on it.'
});
// Answers about these subjects are written by host code only (Fail's
// direction question, the budget question and the Grant button).
const RESERVED_SUBJECTS = new Set(['budget', 'direction']);

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const norm = (v) => String(v ?? '').trim().toLowerCase();

const ReorientTool = new Tool({
  name: 'Reorient',
  description: 'Acknowledge what changed since the case last looked before you recommend, decide or fail. Required when the orientation says "Re-orientation required". "affects" must list every decision whose cited facts changed. With a budget threshold pending, "note" must say what is left and whether finishing is worth it.',
  parameters: {
    type: 'object',
    properties: {
      changed: { type: 'string', description: 'What changed, in one or two sentences' },
      affects: { type: 'array', items: { type: 'string' }, description: 'Decision ids (D-001…) the change affects' },
      action: { type: 'string', enum: [...ACTIONS] },
      note: { type: 'string', description: 'What you will do about it' }
    },
    required: ['changed', 'action', 'note']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Reorient', async (ctx) => {
    const turn = ctx.runtime.turns.get(ctx.caseId);
    if (!turn || turn.turnId !== ctx.turnId || !turn.reorientPending) {
      return { ok: false, error: 'No re-orientation is pending in this turn.' };
    }
    if (!text(params.changed)) return { ok: false, error: '"changed" is required: say what changed.' };
    if (!ACTIONS.includes(params.action)) return { ok: false, error: '"action" must be continue, adjust or ask.' };
    if (!text(params.note)) return { ok: false, error: '"note" is required.' };
    const affects = Array.isArray(params.affects) ? params.affects.map(String) : [];
    const known = new Set(ctx.runtime.records(ctx.caseId).decisions().map((d) => d.id));
    const unknownIds = affects.filter((a) => !known.has(a));
    if (unknownIds.length) return { ok: false, error: `These are not decision ids in this case: ${unknownIds.join(', ')}.` };
    const pending = (turn.triggers || []).filter((t) => t.blocking);
    const needed = [...new Set(pending.filter((t) => t.kind === 'decision-undermined').flatMap((t) => t.decisionIds || []))];
    const missing = needed.filter((d) => !affects.includes(d));
    if (missing.length) return { ok: false, error: `"affects" must include ${missing.join(', ')}: facts they cite have changed.` };
    if (pending.some((t) => t.kind === 'budget-threshold') && text(params.note).length < 40) {
      return { ok: false, error: 'A budget threshold is pending: the note must say what is left and whether finishing is worth it (at least 40 characters).' };
    }
    const journal = ctx.runtime.recordReorientation(ctx.caseId, turn, {
      changed: text(params.changed), affects, action: params.action, note: text(params.note)
    });
    return { ok: true, journal, next: NEXT[params.action] };
  })
});

const AskTool = new Tool({
  name: 'Ask',
  description: 'Ask the owner a question, or send a briefing. It is delivered to the owner and answered later; the answer arrives as an owner fact. Never assume the answer. Briefings follow the brief\'s materiality: tags in "ignore" are refused, and only tags in "tell" may be above low urgency. "defaultOnSilence" may name an option only if the brief\'s safeDefaults lists it.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The whole message to the owner, self-contained' },
      kind: { type: 'string', enum: ['question', 'briefing'] },
      options: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] },
        description: 'Up to 6 answer buttons; ids are lower-case words'
      },
      urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      expiresAt: { type: 'string', description: 'RFC3339 date-time, at most 30 days out' },
      defaultOnSilence: { type: 'string', description: '"hold" (default), or an option id the brief lists in safeDefaults' },
      resolves: { type: 'string', description: 'An active unknown fact id the answer resolves' },
      about: { type: 'object', properties: { subject: { type: 'string' }, attr: { type: 'string' } }, description: 'Where the answer fact lands' },
      materiality: { type: 'string', description: 'For a briefing: the materiality tag it falls under' }
    },
    required: ['question']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Ask', async (ctx) => {
    const kind = params.kind || 'question';
    if (!['question', 'briefing'].includes(kind)) {
      return { ok: false, error: 'kind must be "question" or "briefing". Approvals are created by the host, not by Ask.' };
    }
    const about = params.about && typeof params.about === 'object' ? params.about : null;
    if (about && RESERVED_SUBJECTS.has(norm(about.subject))) {
      return { ok: false, error: `Answers about "${about.subject}" are recorded by the host. Ask without "about", or use Fail when you need the owner's direction.` };
    }
    let brief = {};
    try {
      brief = ctx.runtime.brief(ctx.caseId).read().data || {};
    } catch {
      brief = {};
    }
    const notes = ['Not answered yet. Do not assume the answer.'];
    let urgency = params.urgency || (kind === 'briefing' ? 'low' : 'normal');
    if (kind === 'briefing') {
      const tag = params.materiality ? norm(params.materiality) : '';
      const ignore = (Array.isArray(brief.materiality?.ignore) ? brief.materiality.ignore : []).map(norm);
      const tell = (Array.isArray(brief.materiality?.tell) ? brief.materiality.tell : []).map(norm);
      if (tag && ignore.includes(tag)) {
        return { ok: false, error: `The brief says not to contact the owner about "${params.materiality}". Journal it instead.` };
      }
      if (urgency !== 'low' && !(tag && tell.includes(tag))) {
        urgency = 'low';
        notes.push(`Urgency lowered to low: "${params.materiality || 'untagged'}" is not in the brief's materiality.tell list.`);
      }
    }
    const defaultOnSilence = params.defaultOnSilence || 'hold';
    if (defaultOnSilence !== 'hold') {
      const option = (Array.isArray(params.options) ? params.options : []).find((o) => o && o.id === defaultOnSilence);
      let fromPlaybooks = [];
      if (typeof ctx.runtime.playbookSafeDefaults === 'function') {
        try {
          fromPlaybooks = ctx.runtime.playbookSafeDefaults(ctx.caseId) || [];
        } catch {
          fromPlaybooks = [];
        }
      }
      const safe = new Set([...(Array.isArray(brief.safeDefaults) ? brief.safeDefaults : []), ...fromPlaybooks].map(norm));
      if (!option || !(safe.has(norm(option.id)) || safe.has(norm(option.label)))) {
        return { ok: false, error: 'Only "hold" is allowed: the brief declares no safe default matching this option.' };
      }
    }
    if (params.resolves) {
      const f = ctx.runtime.ledger(ctx.caseId).view().facts.get(params.resolves);
      if (!f || f.provenance !== 'unknown' || f.status !== 'active') {
        return { ok: false, error: `"resolves" must name an active unknown; ${params.resolves} is not one.` };
      }
    }
    const payload = { type: 'ask', turnId: ctx.turnId };
    if (params.resolves) payload.resolves = params.resolves;
    if (about) payload.about = { subject: String(about.subject || ''), attr: String(about.attr || '') };
    if (kind === 'briefing' && params.materiality) payload.materiality = String(params.materiality);
    const created = ctx.runtime.createQuestion(ctx.caseId, {
      kind,
      text: params.question,
      options: params.options,
      urgency,
      expiresAt: params.expiresAt ?? null,
      defaultOnSilence,
      payload
    }, { charge: kind === 'question' });
    if (created.held) {
      return { ok: false, error: 'The daily question allowance (questionsPerDay) is spent. Record what you need as an unknown and ask again tomorrow.' };
    }
    return {
      ok: true,
      questionId: created.id,
      urgency: created.urgency,
      delivered: Array.isArray(created.deliveries) && created.deliveries.length > 0,
      note: notes.join(' ')
    };
  })
});

const FailTool = new Tool({
  name: 'Fail',
  description: 'Report a dead end and stop. Writes a failure report (what you tried, why it failed, the open unknowns) with at most one recommendation, which must pass the recommendation gate; moves the case to needs-direction and asks the owner how to proceed. Present the returned text as written and do not start another approach.',
  parameters: {
    type: 'object',
    properties: {
      failureClass: { type: 'string', enum: [...FAILURE_CLASSES] },
      what: { type: 'string', description: 'The approach that failed' },
      tried: { type: 'array', items: { type: 'string' }, description: 'What you tried, at least one item' },
      why: { type: 'string', description: 'Why it failed' },
      unknowns: { type: 'array', items: { type: 'string' }, description: 'Unknown fact ids that matter now' },
      recommendation: {
        type: 'object',
        description: 'Optional: the one recommendation',
        properties: {
          claims: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' }, factIds: { type: 'array', items: { type: 'string' } } }, required: ['text', 'factIds'] }
          }
        },
        required: ['claims']
      }
    },
    required: ['failureClass', 'what', 'tried', 'why']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Fail', async (ctx) => {
    if (!FAILURE_CLASSES.includes(params.failureClass)) {
      return { ok: false, error: `failureClass must be one of ${FAILURE_CLASSES.join(', ')}.` };
    }
    if (!text(params.what) || !text(params.why)) return { ok: false, error: '"what" and "why" are required.' };
    const triedRaw = Array.isArray(params.tried) ? params.tried : [];
    if (triedRaw.some((t) => typeof t !== 'string')) return { ok: false, error: '"tried" must be a list of strings.' };
    const tried = triedRaw.map((t) => t.trim()).filter(Boolean);
    if (!tried.length) return { ok: false, error: '"tried" must list at least one thing you tried.' };
    const unknowns = Array.isArray(params.unknowns) ? params.unknowns.map(String) : [];
    const { facts } = ctx.runtime.ledger(ctx.caseId).view();
    const notUnknown = unknowns.filter((id) => {
      const f = facts.get(id);
      return !f || f.provenance !== 'unknown' || f.status !== 'active';
    });
    if (notUnknown.length) return { ok: false, error: `"unknowns" must be unknown fact ids; these are not: ${notUnknown.join(', ')}.` };
    let recommendation = null;
    if (params.recommendation) {
      const claims = Array.isArray(params.recommendation.claims) ? params.recommendation.claims : [];
      const gate = recommendationGate({ status: ctx.runtime.getCase(ctx.caseId).status, claims, facts });
      if (!gate.ok) {
        return {
          ok: false,
          error: 'The recommendation in this failure report was refused by the recommendation gate. Fix it, or send the report without one.',
          failures: gate.failures
        };
      }
      recommendation = { claims };
    }
    const result = ctx.runtime.recordFailure(ctx.caseId, {
      failureClass: params.failureClass,
      what: text(params.what),
      tried,
      why: text(params.why),
      unknowns,
      recommendation,
      turnId: ctx.turnId
    });
    return { ok: true, rendered: result.rendered, instruction: 'Present this as written and stop. Do not start another approach.' };
  }, { params, reoriented: true })
});

function registerCaseUnattendedTools(registry) {
  registry.register(ReorientTool);
  registry.register(AskTool);
  registry.register(FailTool);
}

module.exports = { ReorientTool, AskTool, FailTool, registerCaseUnattendedTools };

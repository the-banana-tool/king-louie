// src/tools/builtin/detour-tool.js
// The Detour case tool (cases stage 5 spec §3.5): propose routing for work
// that does not serve the case's objective, map an owner's answer given in
// words to a routing option, or list the case's detours and related cases.
const { Tool } = require('../tool-schema');
const { withCase } = require('./case-tools');

const ACTIONS = Object.freeze(['propose', 'resolve', 'list']);

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function checkPropose(params) {
  const summary = text(params.summary);
  if (summary.length < 1 || summary.length > 300) return '"summary" must be 1 to 300 characters: the off-objective work in one sentence.';
  if (params.reason !== undefined && (typeof params.reason !== 'string' || params.reason.length > 200)) return '"reason" must be text of at most 200 characters.';
  if (params.serves !== undefined && (typeof params.serves !== 'string' || params.serves.length > 200)) return '"serves" must be text of at most 200 characters.';
  if (params.blocks !== undefined && typeof params.blocks !== 'boolean') return '"blocks" must be true or false.';
  return null;
}

const DetourTool = new Tool({
  name: 'Detour',
  description: 'Route work that does not serve this case\'s objective instead of doing it here. propose: describe the off-objective work ("summary"), why it is off-objective ("reason"), and "blocks": true if this case cannot proceed without it; the owner then picks an existing case, a new case, or dropping it. resolve: only when the owner answered a routing question in words (the orientation says so); give that questionId and the optionId that matches their words. list: this case\'s detours and related cases.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      summary: { type: 'string', description: 'For propose: the off-objective work in one sentence (1 to 300 characters)' },
      reason: { type: 'string', description: 'For propose: why it does not serve the objective (at most 200 characters)' },
      blocks: { type: 'boolean', description: 'For propose: true if this case cannot proceed without it' },
      serves: { type: 'string', description: 'For propose: what the work would serve (at most 200 characters)' },
      questionId: { type: 'string', description: 'For resolve: the routing question the owner answered in words' },
      optionId: { type: 'string', description: 'For resolve: the option that matches the owner\'s words' }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, (p) => `Detour.${p.action}`, async (ctx) => {
    const router = ctx.runtime.detours;
    switch (params.action) {
      case 'propose': {
        const bad = checkPropose(params);
        if (bad) return { ok: false, error: bad };
        const r = await router.propose(ctx.caseId, {
          summary: text(params.summary),
          reason: text(params.reason),
          serves: text(params.serves) || null,
          blocks: params.blocks === true,
          source: 'detour-tool',
          turn: ctx.runtime.turns.get(ctx.caseId) || null
        });
        if (!r.ok) return r;
        return {
          ok: true,
          detourId: r.detour.id,
          questionId: r.questionId,
          status: r.detour.status,
          options: r.detour.options,
          ...(r.existing ? { existing: true } : {}),
          ...(r.held ? { held: true } : {}),
          instruction: 'Tell the owner in one line that the side request is noted and a routing proposal is waiting, then continue with on-case work. Do not do the detour in this case.'
        };
      }
      // Only an owner's answer given in words (awaiting-mapping), and only on
      // the detour whose routing question it is. Never `force`: only IPC
      // may retry a failed detour or skip the similar-case refusal.
      case 'resolve': {
        if (!text(params.questionId) || !text(params.optionId)) return { ok: false, error: 'resolve needs "questionId" and "optionId".' };
        const detour = router.list(ctx.caseId).detours.find((d) => d.questionId === text(params.questionId));
        if (!detour) return { ok: false, error: `${params.questionId} is not a routing question in this case.` };
        if (detour.status !== 'awaiting-mapping') {
          return { ok: false, error: `Detour ${detour.id} is ${detour.status}. resolve is only for an owner's answer given in words.` };
        }
        const r = await router.resolve(ctx.caseId, detour.id, { optionId: text(params.optionId), by: 'model-mapped', expectStatus: 'awaiting-mapping' });
        if (!r.ok) return r;
        return { ok: true, detourId: detour.id, status: r.detour.status, linkedCaseId: r.linkedCaseId };
      }
      case 'list': {
        const { detours, related, error } = router.list(ctx.caseId);
        return error ? { ok: false, error } : { ok: true, detours, related };
      }
      default:
        return { ok: false, error: `Unknown action: ${params.action}. Actions: ${ACTIONS.join(', ')}.` };
    }
  }, { params })
});

function registerDetourTools(registry) {
  registry.register(DetourTool);
}

module.exports = { DetourTool, registerDetourTools };

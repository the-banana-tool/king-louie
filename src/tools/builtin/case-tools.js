// src/tools/builtin/case-tools.js
// The model's only write path into a case (spec §5.6). Every tool reads
// options.caseContext, injected by the chat send path through the tool
// executor's extraToolOptions.
const { Tool } = require('../tool-schema');
const { recommendationGate, findDuplicates, OPEN_CASE_STATUSES } = require('../../cases/gates');
const { requireOwnerQuote } = require('../../cases/chat-integration');
const { caseTypeForField, resolveCaseType } = require('../../cases/case-types');
const { validateRepo, repoInQuote } = require('../../cases/case-types/software-repo');
const { toMs } = require('../../cases/clock');

const NO_CASE = Object.freeze({
  ok: false,
  error: 'This chat is not attached to a case. The owner can attach one from Chat Info → Case.'
});

const SOURCE_KINDS = ['url', 'document', 'call', 'api'];
const VALUE_DESCRIPTION = 'numbers and lists as JSON text';
// Brief fields whose value is text: never parse these, so "2027" stays text.
const BRIEF_TEXT_FIELDS = new Set(['objective', 'why', 'deadline', 'repo']);

// `value` is declared as a string so every provider accepts the schema
// (Gemini needs a type on each property). JSON text for a number, list or
// object is parsed; any other text stays a string. Real numbers and lists
// passed directly are kept as they are.
function parseValue(value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    // A number only when it reads back as the same text: "1.50", "1e5" and
    // long digit strings would otherwise change permanently in the ledger.
    if (typeof parsed === 'number') return String(parsed) === value.trim() ? parsed : value;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* plain text */ }
  return value;
}

// The executor validates top-level types against the schema; `value` must
// still accept real numbers and lists, so it is left out of that check.
function acceptAnyValue(tool) {
  const validate = tool.validateParameters.bind(tool);
  tool.validateParameters = (params = {}) => {
    const { value, ...rest } = params || {};
    return validate(rest);
  };
  return tool;
}

// op is the status-rule op (stage 2 spec §3.1), a string or a function of
// params. reoriented: Decide, Recommend and Fail also need no pending
// re-orientation. Refusals are results, never throws.
async function withCase(options, op, fn, { params = {}, reoriented = false } = {}) {
  const ctx = options?.caseContext;
  if (!ctx || !ctx.runtime || !ctx.caseId) return NO_CASE;
  try {
    const opName = typeof op === 'function' ? op(params || {}) : op;
    const refused = ctx.runtime.assertWritable(ctx.caseId, opName);
    if (refused) return refused;
    if (reoriented) {
      const pending = ctx.runtime.requireReoriented(ctx.caseId);
      if (pending) return pending;
    }
    return await fn(ctx);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// A direction fact ends needs-direction, so its quote must be from this
// turn's message or from a message sent after the failure report.
function staleDirection(ctx, messageIndex) {
  const messages = Array.isArray(ctx.ownerMessages) ? ctx.ownerMessages : [];
  if (messageIndex === messages.length - 1) return null;
  const failedAt = toMs(ctx.runtime.getCase(ctx.caseId).statusReason?.at);
  const saidAt = toMs(Array.isArray(ctx.ownerMessageTimes) ? ctx.ownerMessageTimes[messageIndex] : null);
  if (Number.isFinite(failedAt) && Number.isFinite(saidAt) && saidAt > failedAt) return null;
  return { ok: false, error: 'Direction must come from something the owner said after the failure report.' };
}

const LedgerTool = acceptAnyValue(new Tool({
  name: 'Ledger',
  description: 'Read and write the case fact ledger. assert: a fact with a source (provenance "sourced" with a source object; "user" for what the owner actually said, which requires a "quote" of their own words matching this chat\'s owner messages; or "external-agent" with a source). infer: your own derivation, with basis fact ids. unknown: something not known, with what it changes, who can answer, and how. retract: withdraw a fact. query: list facts. Corrections supersede; nothing is edited in place.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['assert', 'infer', 'unknown', 'retract', 'query'] },
      stmt: { type: 'string', description: 'One-sentence statement of the fact or question' },
      subject: { type: 'string', description: 'What the fact is about, e.g. "lot", "house-loan"' },
      attr: { type: 'string', description: 'Which attribute, e.g. "acreage", "payoff"' },
      value: { type: 'string', description: `The value, if any; ${VALUE_DESCRIPTION}` },
      unit: { type: 'string' },
      provenance: { type: 'string', enum: ['sourced', 'user', 'external-agent'] },
      source: {
        type: 'object',
        description: 'Where the fact comes from. Not used for provenance "user", which is sourced from the quote.',
        properties: {
          kind: { type: 'string', enum: SOURCE_KINDS },
          ref: { type: 'string', description: 'URL, document path, call record, or API name' }
        },
        required: ['kind', 'ref']
      },
      quote: { type: 'string', description: 'Required for assert with provenance "user": a substring (case/whitespace-insensitive) of something the owner actually said in this chat. The fact\'s source is built from this, not from "source".' },
      category: { type: 'string', enum: ['personal', 'financial', 'legal', 'health', 'property', 'ops', 'general'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      supersedes: { type: 'string', description: 'Fact id this corrects or answers' },
      basis: { type: 'array', items: { type: 'string' }, description: 'For infer: fact ids this rests on' },
      changes: { type: 'string', description: 'For unknown: what an answer would change' },
      answerable: { type: 'string', description: 'For unknown: who or what can answer (owner, an executor, a record)' },
      how: { type: 'string', description: 'For unknown: the step that would answer it' },
      loadBearing: { type: 'boolean' },
      id: { type: 'string', description: 'For retract: the fact id' },
      reason: { type: 'string', description: 'For retract: why' },
      filter: {
        type: 'object',
        description: 'For query: all fields optional',
        properties: {
          subject: { type: 'string' },
          attr: { type: 'string' },
          provenance: { type: 'string', enum: ['sourced', 'user', 'external-agent', 'inferred', 'unknown'] },
          status: { type: 'string', enum: ['active', 'superseded', 'retracted', 'any'] },
          text: { type: 'string', description: 'Substring of the statement' }
        }
      }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, (p) => `Ledger.${p.action}`, async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    if (params.value !== undefined) params = { ...params, value: parseValue(params.value) };
    switch (params.action) {
      case 'assert': {
        const input = { ...params, addedBy: ctx.turnId };
        if (input.provenance === 'user') {
          const check = requireOwnerQuote({ quote: input.quote, ownerMessages: ctx.ownerMessages });
          if (!check.ok) return check;
          if (String(input.subject || '').trim().toLowerCase() === 'direction') {
            const stale = staleDirection(ctx, check.messageIndex);
            if (stale) return stale;
          }
          input.source = { kind: 'user-message', ref: ctx.turnId, quote: check.quote, messageIndex: check.messageIndex };
        } else if (input.source?.kind === 'user-message') {
          return { ok: false, error: 'What the owner said is recorded with provenance "user" and a "quote" of their own words, not with a "user-message" source.' };
        } else if (input.source?.kind && !SOURCE_KINDS.includes(input.source.kind)) {
          return { ok: false, error: `Source kind "${input.source.kind}" is reserved for the host.` };
        }
        const fact = ledger.assert(input);
        if (fact.provenance !== 'user') return { ok: true, fact };
        const effect = ctx.runtime.applyOwnerFact(ctx.caseId, fact);
        return {
          ok: true,
          fact,
          ...(effect.applied ? { effect: effect.applied } : {}),
          ...(effect.note ? { note: effect.note } : {}),
          ...(effect.error ? { warning: effect.error } : {})
        };
      }
      case 'infer':
        return {
          ok: true,
          fact: ledger.infer({ ...params, addedBy: ctx.turnId }),
          note: 'Inferred facts cannot support a recommendation or leave the system.'
        };
      case 'unknown': {
        // Other open cases through the index, which redacts their private
        // facts before the hits reach this case (cases stage 5 spec §3.2).
        const crossCaseHits = ctx.runtime.index.search({
          text: params.stmt,
          subject: params.subject,
          attr: params.attr,
          kinds: ['fact'],
          forCaseId: ctx.caseId,
          excludeCaseId: ctx.caseId,
          statuses: OPEN_CASE_STATUSES
        });
        const dups = findDuplicates({
          subject: params.subject,
          attr: params.attr,
          text: params.stmt,
          facts: ledger.view().facts,
          crossCaseHits
        });
        if (dups.exact.length) {
          return {
            ok: false,
            error: `This case already has ${dups.exact.map((m) => m.id).join(', ')} for ${params.subject}.${params.attr}. Use it, or supersede it, instead of recording a new unknown.`,
            matches: dups.exact
          };
        }
        const fact = ledger.unknown({ ...params, addedBy: ctx.turnId });
        return {
          ok: true,
          fact,
          similarInOtherCases: dups.similar,
          ...(dups.similar.length ? { note: 'Other cases hold related facts. Check them before asking the owner.' } : {})
        };
      }
      case 'retract':
        if (!params.id || !params.reason) return { ok: false, error: 'retract needs "id" and "reason".' };
        return { ok: true, fact: ledger.retract(params.id, params.reason) };
      case 'query':
        return { ok: true, facts: ledger.query(params.filter || {}) };
      default:
        return { ok: false, error: `Unknown action: ${params.action}` };
    }
  }, { params })
}));

const BriefTool = acceptAnyValue(new Tool({
  name: 'Brief',
  description: 'Read or update the case brief. "why", "hardConstraints", "alreadyTried", "materiality", "deadline", "safeDefaults" and a software-repo case\'s "repo" can only be set from what the owner said (provenance "user"), which also requires a "quote" of the owner\'s own words matching this chat\'s owner messages. completeGating marks the brief ready; recommendations are refused until then.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'update', 'append', 'completeGating'] },
      field: { type: 'string', enum: ['objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried', 'resources', 'deadline', 'materiality', 'safeDefaults', 'repo'] },
      value: { type: 'string', description: `For update: the new value; ${VALUE_DESCRIPTION}` },
      item: { type: 'string', description: 'For append: one list entry' },
      provenance: { type: 'string', enum: ['user', 'model'] },
      quote: { type: 'string', description: 'Required for the owner-only fields ("why", "hardConstraints", "alreadyTried", "materiality", "deadline", "safeDefaults", "repo") with provenance "user": a substring of something the owner actually said in this chat.' },
      reason: { type: 'string' }
    },
    required: ['action']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, (p) => `Brief.${p.action}`, async (ctx) => {
    const brief = ctx.runtime.brief(ctx.caseId);
    if (params.action === 'read') {
      return { ok: true, brief: brief.read().data, missingForGating: brief.missingForGating() };
    }
    if (params.action === 'completeGating') {
      return { ok: true, status: ctx.runtime.completeGating(ctx.caseId).status };
    }
    if (!params.field) return { ok: false, error: `${params.action} needs "field".` };
    const declaredBy = caseTypeForField(params.field);
    if (declaredBy && declaredBy !== resolveCaseType(ctx.runtime.getCase(ctx.caseId).type).type) {
      return { ok: false, error: `Field "${params.field}" is only for ${declaredBy} cases.` };
    }
    if (params.value !== undefined && !BRIEF_TEXT_FIELDS.has(params.field)) params = { ...params, value: parseValue(params.value) };
    const provenance = params.provenance || 'model';
    let quoteNote = '';
    if (brief.isUserOnly(params.field) && provenance === 'user') {
      const check = requireOwnerQuote({ quote: params.quote, ownerMessages: ctx.ownerMessages });
      if (!check.ok) return check;
      // Ruling T9-repo: the refresh reads whatever `repo` names, so the owner
      // must have said the value itself. Validity first (its error is clearer),
      // then the value as one whole token of the quote AND of the owner's own
      // message: the quote check folds case, so only the message keeps the
      // owner's casing (fix round 2: never a prefix, never a case variant).
      if (params.field === 'repo') {
        const repo = validateRepo(params.value);
        const said = ctx.ownerMessages[check.messageIndex];
        if (!repoInQuote(repo, check.quote) || !repoInQuote(repo, said)) {
          return { ok: false, error: `The owner's quote must contain the repo value itself (${JSON.stringify(repo)}). Ask the owner for the repository path or clone URL.` };
        }
      }
      quoteNote = ` (quote: ${JSON.stringify(check.quote)})`;
    }
    const data = params.action === 'append'
      ? brief.append(params.field, params.item, { provenance })
      : brief.update(params.field, params.value, { provenance });
    ctx.runtime.records(ctx.caseId).writeJournal(
      'brief',
      `Brief ${params.field} ${params.action === 'append' ? 'appended' : 'updated'} (${provenance})${params.reason ? `: ${params.reason}` : ''}${quoteNote}\n\n${JSON.stringify(params.action === 'append' ? params.item : params.value)}`
    );
    return { ok: true, brief: data };
  }, { params })
}));

const DecideTool = new Tool({
  name: 'Decide',
  description: 'Record a decision you made, citing the fact ids it rests on and the alternatives you rejected. Cited facts become load-bearing, so a later correction to any of them flags this decision.',
  parameters: {
    type: 'object',
    properties: {
      decision: { type: 'string' },
      factIds: { type: 'array', items: { type: 'string' } },
      alternatives: { type: 'array', items: { type: 'string' } }
    },
    required: ['decision', 'factIds']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Decide', async (ctx) => {
    const ledger = ctx.runtime.ledger(ctx.caseId);
    const { facts } = ledger.view();
    const bad = params.factIds.filter((id) => facts.get(id)?.status !== 'active');
    if (bad.length) return { ok: false, error: `These fact ids are missing or no longer active: ${bad.join(', ')}.` };
    ledger.markLoadBearing(params.factIds);
    const decision = ctx.runtime.records(ctx.caseId).recordDecision({
      decision: params.decision,
      factIds: params.factIds,
      alternatives: params.alternatives || []
    });
    const inferred = params.factIds.filter((id) => facts.get(id).provenance === 'inferred');
    return {
      ok: true,
      decision,
      ...(inferred.length ? { warning: `This decision rests on inferred facts (${inferred.join(', ')}). Say so when you report it.` } : {})
    };
  }, { reoriented: true })
});

const RecommendTool = new Tool({
  name: 'Recommend',
  description: 'Propose a recommendation to the owner. Each load-bearing claim must cite active sourced or owner-stated fact ids. The gate refuses claims resting on inferences, unknowns, corrected facts, or subjects with open load-bearing unknowns, and refuses everything until the brief gating pass is complete. On success, present the returned text as written.',
  parameters: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            factIds: { type: 'array', items: { type: 'string' } },
            loadBearing: { type: 'boolean' }
          },
          required: ['text', 'factIds']
        }
      },
      unknowns: { type: 'array', items: { type: 'string' }, description: 'Extra unknown fact ids to list before the recommendation' }
    },
    required: ['claims']
  },
  requiresApproval: false,
  execute: (params, options) => withCase(options, 'Recommend', async (ctx) => {
    const meta = ctx.runtime.getCase(ctx.caseId);
    const ledger = ctx.runtime.ledger(ctx.caseId);
    const { facts } = ledger.view();
    const gate = recommendationGate({ status: meta.status, claims: params.claims, facts });
    if (!gate.ok) {
      return {
        ok: false,
        error: 'Recommendation refused by the recommendation gate. Fix the cited facts, or present the open unknowns instead of recommending.',
        failures: gate.failures
      };
    }
    const cited = [...new Set(params.claims.flatMap((c) => c.factIds || []))];
    ledger.markLoadBearing(cited);
    const extra = new Set(params.unknowns || []);
    const open = [...facts.values()].filter((f) => f.provenance === 'unknown' && f.status === 'active' && (f.loadBearing || extra.has(f.id)));
    const rendered = [
      'Open load-bearing unknowns:',
      ...(open.length ? open.map((u) => `- ${u.stmt} (${u.id}; changes: ${u.changes || '—'})`) : ['- none']),
      '',
      'Recommendation:',
      ...params.claims.map((c) => `- ${c.text}${c.factIds?.length ? ` [${c.factIds.join(', ')}]` : ''}`)
    ].join('\n');
    ctx.runtime.records(ctx.caseId).recordRecommendation({
      turnId: ctx.turnId,
      claims: params.claims,
      unknowns: open.map((u) => u.id)
    });
    return { ok: true, rendered, instruction: 'Present this to the owner as written: unknowns first, then the recommendation with its fact ids.' };
  }, { reoriented: true })
});

module.exports = { LedgerTool, BriefTool, DecideTool, RecommendTool, withCase, SOURCE_KINDS };

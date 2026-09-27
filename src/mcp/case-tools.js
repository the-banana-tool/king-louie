// src/mcp/case-tools.js
// MCP case tools (cases stage 7 spec §3.7; program §4.14): list cases, open
// one, read its orientation, answer its open questions. An agent node serves
// them to its own local MCP clients through its FleetToolHandler (stdio, and
// `king-louie-service mcp` through the courier, R24) and, from Task 16, to
// front-door clients through NodeFleetService's cases.<tool> methods.
//
// Every refusal is a ToolError with a fixed sentence per code: no client
// string, case text or runtime error message is echoed back (details go to
// the host log). Case content goes back inside the untrusted wrapper.
const { createLogger } = require('../logging');
const { ToolError } = require('../fleet/tool-definitions');
const { listRecords } = require('../cases/ingest/files');
const { CASE_MCP_TOOLS, STATUS_CHANGING, NEVER_OVER_MCP, untrusted, CASE_TOOL_SCOPE } = require('../cases/mcp-tool-definitions');

const CHANNELS = new Set(['mcp-stdio', 'mcp-frontdoor']);
const RATE_WINDOW_MS = 60 * 1000;

// A ToolError, so FleetToolHandler, the courier and NodeFleetService pass its
// code, message and retry_after to the client as they do for fleet tools.
class CaseToolError extends ToolError {
  constructor(code, message, data = {}) {
    super(code, `${code}: ${message}`, data);
    this.name = 'CaseToolError';
    this.isCaseToolError = true;
  }
}

const fail = (code, message, data) => new CaseToolError(code, message, data);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function validate(tool, args) {
  const schema = tool.inputSchema;
  if (!isObj(args)) throw fail('invalid_params', 'arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw fail('invalid_params', `${tool.name} takes only ${Object.keys(schema.properties).join(', ') || 'no arguments'}`);
  }
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null) throw fail('invalid_params', `"${key}" is required`);
  }
  for (const [key, rule] of Object.entries(schema.properties)) {
    if (args[key] === undefined) continue;
    const v = args[key];
    if (typeof v !== 'string') throw fail('invalid_params', `"${key}" must be a string`);
    if (rule.minLength && v.length < rule.minLength) throw fail('invalid_params', `"${key}" is too short`);
    if (rule.maxLength && v.length > rule.maxLength) throw fail('invalid_params', `"${key}" is longer than ${rule.maxLength} characters`);
    if (rule.pattern && !new RegExp(rule.pattern).test(v)) throw fail('invalid_params', `"${key}" does not match ${rule.pattern}`);
  }
}

// Records are Bash-writable: count defensively.
function pendingProposals(dir) {
  return listRecords(dir).reduce((n, rec) => n + (Array.isArray(rec.proposals) ? rec.proposals.filter((p) => isObj(p) && !isObj(p.review)).length : 0), 0);
}

// Why this channel may not answer `q`, or null.
function notAnswerable(q, channel) {
  const payload = isObj(q.payload) ? q.payload : {};
  if (q.kind === 'approval') return 'approvals are answered only on channels that prove the sender';
  if (q.kind === 'briefing') return 'briefings are acknowledged in the app, not answered';
  if (NEVER_OVER_MCP.has(payload.type)) return 'document reviews are answered in the panel';
  if (payload.mcpAnswerable === false) return 'this question is marked not answerable over MCP';
  if (channel === 'mcp-frontdoor') {
    if (payload.failure) return 'failure reports are answered on the node, not through the front door';
    if (STATUS_CHANGING.has(payload.type)) return 'questions that change the case status are answered on the node';
  }
  return null;
}

function createCaseToolHandler({ getRuntime, channel, audit = null, log = createLogger('mcp/case-tools'), now = () => Date.now(), rateLimit = 30 }) {
  if (!CHANNELS.has(channel)) throw new Error(`channel must be one of ${[...CHANNELS].join(', ')}`);
  const tools = CASE_MCP_TOOLS.map(({ tier, ...def }) => def);
  const byName = new Map(CASE_MCP_TOOLS.map((t) => [t.name, t]));
  const names = new Set(byName.keys());
  const answers = [];

  const currentRuntime = () => {
    try {
      return typeof getRuntime === 'function' ? getRuntime() || null : null;
    } catch {
      return null;
    }
  };
  const runtime = () => {
    const rt = currentRuntime();
    if (!rt) throw fail('cases_unavailable', 'cases are not available on this node');
    return rt;
  };
  const caseOf = (rt, ref) => {
    try {
      return rt.getCase(ref);
    } catch (err) {
      if (err && err.code === 'CASE_NOT_FOUND') throw fail('case_not_found', 'no such case on this node');
      throw err;
    }
  };
  const openQuestions = (rt, id) => (typeof rt.questions === 'function' ? rt.questions(id).open() : []);
  const usdBudget = (rt, id) => {
    if (typeof rt.budget !== 'function') return null;
    const usd = rt.budget(id).status().usd || {};
    return { usd: { spent: usd.spent ?? 0, limit: usd.limit ?? null } };
  };

  function listCases(rt) {
    // Titles and slugs can be model-authored (ruling T12-titles): they go
    // back inside the untrusted wrapper; id and status stay bare.
    return rt.listCases().map((meta) => ({
      id: meta.id,
      type: meta.type,
      status: meta.status,
      created: meta.created,
      openQuestions: openQuestions(rt, meta.id).length,
      pendingProposals: pendingProposals(meta.dir),
      budget: usdBudget(rt, meta.id),
      data: untrusted({ title: meta.title, slug: meta.slug })
    }));
  }

  function openCase(rt, ref) {
    const meta = caseOf(rt, ref);
    const facts = [...rt.ledger(meta.id).view().facts.values()].filter((f) => f.status === 'active');
    let brief = null;
    try {
      brief = rt.brief(meta.id).read().data;
    } catch (err) {
      log.warn(`Reading the brief of ${meta.slug} failed: ${err.message}`);
      brief = { error: 'the brief could not be read' };
    }
    return {
      id: meta.id,
      type: meta.type,
      status: meta.status,
      counts: {
        facts: facts.length,
        loadBearingUnknowns: facts.filter((f) => f.provenance === 'unknown' && f.loadBearing).length,
        sources: listRecords(meta.dir).length,
        pendingProposals: pendingProposals(meta.dir)
      },
      data: untrusted({
        title: meta.title,
        slug: meta.slug,
        brief,
        questions: openQuestions(rt, meta.id).map((q) => ({
          id: q.id,
          kind: q.kind,
          text: q.text,
          options: q.options || [],
          urgency: q.urgency,
          expiresAt: q.expiresAt || null,
          answerableHere: notAnswerable(q, channel) === null
        })),
        lastJournal: rt.records(meta.id).lastJournal()
      })
    };
  }

  // Takes a slot and returns a release for it.
  function takeRateSlot() {
    const t = now();
    while (answers.length && answers[0] <= t - RATE_WINDOW_MS) answers.shift();
    if (answers.length >= rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((answers[0] + RATE_WINDOW_MS - t) / 1000));
      throw fail('rate_limited', `at most ${rateLimit} answers per minute; retry after ${retryAfter}s`, { retry_after: retryAfter });
    }
    answers.push(t);
    return () => {
      const i = answers.indexOf(t);
      if (i !== -1) answers.splice(i, 1);
    };
  }

  async function answerQuestion(rt, args) {
    const hasText = args.text !== undefined;
    const hasOption = args.option_id !== undefined;
    if (hasText === hasOption) throw fail('invalid_params', 'give exactly one of text and option_id');
    const meta = caseOf(rt, args.case);
    if (meta.status === 'done' || meta.status === 'abandoned') throw fail('case_closed', 'the case is done or abandoned');
    const q = rt.questions(meta.id).get(args.question_id);
    if (!q) throw fail('question_not_found', 'no such question in this case');
    if (q.answer || q.closed) throw fail('question_closed', 'the question is already answered or closed');
    const why = notAnswerable(q, channel);
    if (why) throw fail('not_answerable_here', why);
    if (hasOption && !(Array.isArray(q.options) ? q.options : []).some((o) => isObj(o) && o.id === args.option_id)) {
      throw fail('invalid_params', 'option_id is not one of the question\'s options');
    }
    const releaseSlot = takeRateSlot();
    let res;
    try {
      res = await rt.answerQuestion(meta.id, q.id, { channel, text: hasText ? args.text : null, optionId: hasOption ? args.option_id : null });
    } catch (err) {
      const code = err && err.code;
      // A busy case or an answer that does not fit changed nothing: the
      // slot goes back (m4).
      if (code === 'CASE_BUSY' || code === 'INVALID' || code === 'IS_BRIEFING') releaseSlot();
      if (code === 'CASE_BUSY') throw fail('case_busy', 'the case is busy with a turn', { retry_after: 5 });
      if (code === 'ALREADY_ANSWERED') throw fail('question_closed', 'the question was answered meanwhile');
      if (code === 'NOT_FOUND') throw fail('question_not_found', 'no such question in this case');
      if (code === 'INVALID' || code === 'IS_BRIEFING') {
        log.info(`${channel} answer to ${q.id} refused: ${err.message}`);
        throw fail('invalid_params', 'the answer does not fit the question');
      }
      throw err;
    }
    const factId = res?.fact?.id ?? res?.question?.answer?.factId ?? null;
    log.info(`${channel} answered ${q.id} in case ${meta.slug}`);
    if (audit && typeof audit.append === 'function') {
      Promise.resolve()
        .then(() => audit.append({ kind: 'cases.answer_question', data: { channel, caseId: meta.id, questionId: q.id, optionId: hasOption ? args.option_id : null, factId } }))
        .catch((err) => log.warn(`Audit entry for ${q.id} failed: ${err.message}`));
    }
    return { question_id: q.id, answered_at: res?.question?.answer?.at ?? null, fact_id: factId };
  }

  async function call(name, args = {}) {
    const tool = byName.get(name);
    if (!tool) throw fail('unknown_tool', 'no such case tool');
    validate(tool, args || {});
    const rt = runtime();
    try {
      switch (name) {
        case 'list_cases': return listCases(rt);
        case 'open_case': return openCase(rt, args.case);
        case 'get_orientation': return untrusted({ text: rt.orientation(caseOf(rt, args.case).id) });
        default: return await answerQuestion(rt, args);
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      // A runtime failure can name paths and internals: logged, never sent.
      log.warn(`${channel} ${name} failed: ${err && err.message}`);
      throw fail('internal', 'the case tool failed on this node');
    }
  }

  // True when a CaseRuntime is there: the tools are listed only then.
  const available = () => currentRuntime() !== null;

  return { names, tools, call, available };
}

// What F4's router adds to a case tool's arguments (FleetRouter._callExtra):
// its own origin and max_bytes, and, for a case-keyed tool, the client's
// routing argument `machine` (list_cases fans out and takes no machine).
const ROUTER_FIELDS = Object.freeze(['origin', 'max_bytes']);
const ROUTING_FIELDS = Object.freeze([...ROUTER_FIELDS, 'machine']);

// On an agent node with a front-door link: the cases.<tool> methods, each
// behind its own scope (NodeFleetService re-checks the front door's scopes
// and machine pins before the method runs). Only the tools in
// CASE_TOOL_SCOPE are registered: answer_question is withheld pending an
// owner decision (ruling T16-Q2). The handler is its own, on the
// mcp-frontdoor channel (its own rate limit; it repeats every front-door
// refusal). The router's fields are removed; anything else is checked
// against the tool's schema.
function registerNodeCaseMethods(nodeFleetService, { getRuntime, audit = null, log } = {}) {
  const handler = createCaseToolHandler({ getRuntime, channel: 'mcp-frontdoor', audit, ...(log ? { log } : {}) });
  for (const name of handler.names) {
    if (!Object.hasOwn(CASE_TOOL_SCOPE, name)) continue;
    const strip = name === 'list_cases' ? ROUTER_FIELDS : ROUTING_FIELDS;
    nodeFleetService.registerMethod(`cases.${name}`, async (params) => {
      const args = isObj(params) ? { ...params } : {};
      for (const key of strip) delete args[key];
      return handler.call(name, args);
    }, { scope: CASE_TOOL_SCOPE[name] });
  }
  return handler;
}

module.exports = {
  CASE_MCP_TOOLS,
  STATUS_CHANGING,
  NEVER_OVER_MCP,
  CaseToolError,
  createCaseToolHandler,
  untrusted,
  notAnswerable,
  registerNodeCaseMethods
};

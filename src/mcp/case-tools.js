// src/mcp/case-tools.js
// MCP case tools (cases stage 7 spec §3.7; program §4.14): list cases, open
// one, read its orientation, list the open questions and the owner's
// presence, answer a question. An agent node serves them to its own local
// MCP clients through its FleetToolHandler (stdio, and `king-louie-service
// mcp` through the courier, R24) and, from Task 16, to front-door clients
// through NodeFleetService's cases.<tool> methods. King Louie's own chat
// serves the same tools on the in-app channel (management surfaces spec
// §3.1; src/tools/builtin/management-tools.js).
//
// Every refusal is a ToolError with a fixed sentence per code: no client
// string, case text or runtime error message is echoed back (details go to
// the host log). Case content goes back inside the untrusted wrapper.
const { createLogger } = require('../logging');
const { ToolError } = require('../fleet/tool-definitions');
const { listRecords } = require('../cases/ingest/files');
const { CASE_MCP_TOOLS, STATUS_CHANGING, NEVER_OVER_MCP, untrusted, answerClass, CASE_TOOL_SCOPE } = require('../cases/mcp-tool-definitions');
const { fold, wordsInText, ownerQuoteInTurn } = require('../tools/owner-quote');

const CHANNELS = new Set(['mcp-stdio', 'mcp-frontdoor', 'in-app']);
const RATE_WINDOW_MS = 60 * 1000;
// Management surfaces spec §3.1-3.2 and part 1's Global Constraints.
const PRESSED_MESSAGE = "Answer this with the buttons on the question in the case's chat, or on your phone.";
const OWNER_ONLY_MESSAGE = "Only the owner's own message can answer a question.";

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

// A 1-based option number on its own: "option 12" does not name option 1,
// nor do "1.5" or "2,1".
function numberInText(n, text) {
  return new RegExp(`(?<!\\w|\\d[.,])${n}(?!\\w|[.,]\\d)`).test(fold(text));
}

// True when the quote names the option by its label, its id or its 1-based
// position, on word boundaries after the owner-quote fold.
function optionInQuote(quote, option, index) {
  return wordsInText(String(option.label ?? ''), quote)
    || wordsInText(String(option.id ?? ''), quote)
    || numberInText(index + 1, quote);
}

// A payload type goes back bare only when it looks like one (records are
// Bash-writable); anything else is null.
const cleanType = (t) => (typeof t === 'string' && /^[a-z][a-z:-]{0,31}$/.test(t) ? t : null);

// The ladder entry's public part (contact:ladderState's shape), or null.
function ladderOf(state, caseId, questionId) {
  const e = isObj(state) ? state[`${caseId}/${questionId}`] : null;
  if (!isObj(e)) return null;
  return {
    step: e.step ?? null,
    nextAt: e.nextAt ?? null,
    nextChannel: e.nextChannel ?? null,
    expired: e.expired === true,
    exhausted: e.exhausted === true,
    attempts: Array.isArray(e.attempts) ? e.attempts.map((a) => ({ channel: a?.channel ?? null, at: a?.at ?? null, outcome: a?.outcome ?? null })) : []
  };
}

// `getContact` is core.context.getContact (the ladder and presence), or
// null where contact is off: list_questions then gives no ladder state and
// get_presence refuses.
function createCaseToolHandler({ getRuntime, getContact = null, channel, audit = null, log = createLogger('mcp/case-tools'), now = () => Date.now(), rateLimit = 30 }) {
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
  const contact = () => {
    try {
      return typeof getContact === 'function' ? getContact() || null : null;
    } catch {
      return null;
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
          answerableHere: answerClass(q) === 'spoken'
        })),
        lastJournal: rt.records(meta.id).lastJournal()
      })
    };
  }

  // Every open question in the open cases (or in one case), oldest first,
  // with the shared spoken/pressed class. Text, options and titles can be
  // model-authored: they go back inside the untrusted wrapper.
  function listQuestions(rt, ref) {
    const cases = ref === undefined ? rt.listCases() : [caseOf(rt, ref)];
    let ladder = null;
    const c = contact();
    if (c && typeof c.ladderState === 'function') {
      try {
        ladder = c.ladderState();
      } catch (err) {
        log.warn(`Reading the contact ladder failed: ${err && err.message}`);
      }
    }
    const rows = [];
    for (const meta of cases) {
      if (meta.status === 'done' || meta.status === 'abandoned') continue;
      for (const q of openQuestions(rt, meta.id)) {
        const payload = isObj(q.payload) ? q.payload : {};
        rows.push({
          caseId: meta.id,
          questionId: q.id,
          kind: q.kind,
          type: cleanType(payload.type),
          urgency: q.urgency,
          createdAt: q.createdAt || null,
          expiresAt: q.expiresAt || null,
          answer: answerClass(q),
          ladder: ladderOf(ladder, meta.id, q.id),
          data: untrusted({ caseTitle: meta.title, text: q.text, options: Array.isArray(q.options) ? q.options : [] })
        });
      }
    }
    return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  // The presence the ladder uses (contact's presenceStatus), without the
  // ladder lease's host, pid and path.
  function getPresence() {
    const c = contact();
    if (!c || typeof c.presenceStatus !== 'function') throw fail('contact_unavailable', 'contact is not available on this node');
    const s = c.presenceStatus();
    return {
      presentChannel: s.presentChannel ?? null,
      away: s.away === true,
      quiet: s.quiet === true,
      timeZoneSource: s.timeZoneSource ?? null,
      signals: s.signals ?? null,
      ladderRunsHere: s.ladder ? s.ladder.runsHere !== false : null
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

  // The spoken class only (answerClass): a pressed question is refused on
  // every channel, in-app included. `quote` is the owner's words: on the
  // in-app channel it must be in the owner's own message this turn
  // (ownerTurnText, from the executor only); over MCP it is recorded, not
  // checked. An option must be named in the quote; free text is the quote,
  // or words from it. A spoken briefing is acknowledged.
  async function answerQuestion(rt, args, ownerTurnText) {
    const hasText = args.text !== undefined;
    const hasOption = args.option_id !== undefined;
    if (hasText && hasOption) throw fail('invalid_params', 'give text or option_id, not both');
    const quote = args.quote;
    if (!fold(quote)) throw fail('invalid_params', '"quote" must hold the owner\'s words');
    if (channel === 'in-app') {
      if (typeof ownerTurnText !== 'string' || !fold(ownerTurnText)) throw fail('not_owner', OWNER_ONLY_MESSAGE);
      if (!ownerQuoteInTurn(quote, ownerTurnText)) throw fail('quote_not_found', 'the quote is not in the owner\'s message this turn; quote their words exactly');
    }
    const meta = caseOf(rt, args.case);
    if (meta.status === 'done' || meta.status === 'abandoned') throw fail('case_closed', 'the case is done or abandoned');
    const q = rt.questions(meta.id).get(args.question_id);
    if (!q) throw fail('question_not_found', 'no such question in this case');
    if (q.answer || q.closed) throw fail('question_closed', 'the question is already answered or closed');
    if (answerClass(q) === 'pressed') throw fail('not_answerable_here', PRESSED_MESSAGE);
    const briefing = q.kind === 'briefing';
    let text = null;
    if (!briefing) {
      if (hasOption) {
        const options = (Array.isArray(q.options) ? q.options : []).filter(isObj);
        const index = options.findIndex((o) => o.id === args.option_id);
        if (index === -1) throw fail('invalid_params', 'option_id is not one of the question\'s options');
        if (!optionInQuote(quote, options[index], index)) {
          // Labels can be model-authored: listed as data, never in the message.
          throw fail('option_not_in_quote', 'the quote does not name that option by its label, id or number; ask the owner which option they mean', {
            options: untrusted(options.map((o, i) => ({ number: i + 1, id: o.id, label: o.label ?? null })))
          });
        }
      } else if (hasText) {
        if (!wordsInText(args.text, quote)) throw fail('invalid_params', 'text must be words from the quote');
        text = args.text;
      } else {
        text = quote;
      }
    }
    const releaseSlot = takeRateSlot();
    let res;
    try {
      res = briefing
        ? { question: await rt.acknowledgeBriefing(meta.id, q.id, { channel, quote }), fact: null }
        : await rt.answerQuestion(meta.id, q.id, { channel, text, optionId: hasOption ? args.option_id : null, quote });
    } catch (err) {
      const code = err && err.code;
      // A busy case or an answer that does not fit changed nothing: the
      // slot goes back (m4).
      const unfit = code === 'INVALID' || code === 'IS_BRIEFING' || code === 'NOT_BRIEFING';
      if (code === 'CASE_BUSY' || unfit) releaseSlot();
      if (code === 'CASE_BUSY') throw fail('case_busy', 'the case is busy with a turn', { retry_after: 5 });
      if (code === 'ALREADY_ANSWERED') throw fail('question_closed', 'the question was answered meanwhile');
      if (code === 'NOT_FOUND') throw fail('question_not_found', 'no such question in this case');
      if (unfit) {
        log.info(`${channel} answer to ${q.id} refused: ${err.message}`);
        throw fail('invalid_params', 'the answer does not fit the question');
      }
      throw err;
    }
    const factId = res?.fact?.id ?? res?.question?.answer?.factId ?? null;
    log.info(`${channel} ${briefing ? 'acknowledged' : 'answered'} ${q.id} in case ${meta.slug}`);
    if (audit && typeof audit.append === 'function') {
      Promise.resolve()
        .then(() => audit.append({ kind: 'cases.answer_question', data: { channel, caseId: meta.id, questionId: q.id, optionId: hasOption ? args.option_id : null, factId } }))
        .catch((err) => log.warn(`Audit entry for ${q.id} failed: ${err.message}`));
    }
    return {
      question_id: q.id,
      answered_at: res?.question?.answer?.at ?? null,
      fact_id: factId,
      ...(briefing ? { acknowledged: true } : {})
    };
  }

  // `ownerTurnText` is the executor's own field (the chat's in-app tools
  // pass it from their execute context); the MCP surfaces pass none, and it
  // is read only on the in-app channel.
  async function call(name, args = {}, { ownerTurnText = null } = {}) {
    const tool = byName.get(name);
    if (!tool) throw fail('unknown_tool', 'no such case tool');
    validate(tool, args || {});
    const rt = runtime();
    try {
      switch (name) {
        case 'list_cases': return listCases(rt);
        case 'open_case': return openCase(rt, args.case);
        case 'get_orientation': return untrusted({ text: rt.orientation(caseOf(rt, args.case).id) });
        case 'list_questions': return listQuestions(rt, args.case);
        case 'get_presence': return getPresence();
        default: return await answerQuestion(rt, args, ownerTurnText);
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
// routing argument `machine` (list_cases fans out and takes no machine;
// list_questions takes one only when it names it).
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
function registerNodeCaseMethods(nodeFleetService, { getRuntime, getContact = null, audit = null, log } = {}) {
  const handler = createCaseToolHandler({ getRuntime, getContact, channel: 'mcp-frontdoor', audit, ...(log ? { log } : {}) });
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
  answerClass,
  PRESSED_MESSAGE,
  OWNER_ONLY_MESSAGE,
  registerNodeCaseMethods
};

// src/mcp/case-tools.js
// MCP case tools (cases stage 7 spec §3.7; program §4.14): list cases, open
// one, read its orientation, list the open questions and the owner's
// presence, answer a question, set the owner away. An agent node serves
// them to its own local MCP clients through its FleetToolHandler (stdio, and `king-louie-service
// mcp` through the courier, R24) and, from Task 16, to front-door clients
// through NodeFleetService's cases.<tool> methods. King Louie's own chat
// serves the same tools on the in-app-chat channel (management surfaces spec
// §3.1; src/tools/builtin/management-tools.js).
//
// `in-app-chat` is the model relaying the owner's words from the chat. It is
// not `in-app`, the id of the card's buttons and the IPC (a press, with no
// model between): no list that treats a recorded channel as proof of a
// press (APP_ANSWER_CHANNELS in contact.js, PRESS_CHANNELS in the detour
// router) names it.
//
// Every refusal is a ToolError with a fixed sentence per code: no client
// string, case text or runtime error message is echoed back (details go to
// the host log). Case content goes back inside the untrusted wrapper.
const { createLogger } = require('../logging');
const { ToolError } = require('../fleet/tool-definitions');
const { listRecords } = require('../cases/ingest/files');
const { EnvelopeStore, ENVELOPE_STATUSES } = require('../cases/executors/envelope');
const { JobStore, isOpen: jobIsOpen } = require('../cases/executors/job-store');
const { CASE_MCP_TOOLS, STATUS_CHANGING, NEVER_OVER_MCP, untrusted, answerClass, CASE_TOOL_SCOPE } = require('../cases/mcp-tool-definitions');
const { fold, wordsInText, ownerQuoteInTurn } = require('../tools/owner-quote');

const CHAT_CHANNEL = 'in-app-chat';
const CHANNELS = new Set(['mcp-stdio', 'mcp-frontdoor', CHAT_CHANNEL]);
const RATE_WINDOW_MS = 60 * 1000;
// Management surfaces spec §3.1-3.2 and part 1's Global Constraints.
const PRESSED_MESSAGE = "Answer this with the buttons on the question in the case's chat, or on your phone.";
const OWNER_ONLY_MESSAGE = "Only the owner's own message can answer a question.";
const SIMILAR_MESSAGE = 'a similar case is already open, so nothing was created. Open the app to create it anyway.';
// Owner decision Q27 (2026-10-01): a case turn's context feeds that case's
// ledger and executor payloads, and the outbound gate knows only that case's
// private facts, so in a case chat the tools that act on a case see that
// case alone. create_case, set_away and get_presence act on no case.
const OTHER_CASE_MESSAGE = 'In a case chat these tools act only on this case. Use a chat that is not attached to a case, or your phone, to manage other cases.';
const CASE_SCOPED_TOOLS = new Set([
  'list_cases', 'open_case', 'get_orientation', 'list_questions', 'list_envelopes', 'list_playbooks',
  'answer_question', 'revoke_envelope', 'cancel_case_job'
]);
// Owner decision Q28 (2026-10-01): every spoken tool's quote is at least
// three words on every channel, so a bare "yes" or "option 2" lifted from a
// longer message never stands for the owner's request. Words are the
// word-like segments of Intl.Segmenter after the owner-quote fold, so a
// language written without spaces counts too ("取消这个工作吧" is more than
// three). A run of digits with its separators ("1,000.00", "2026-10-05",
// "12:30:45") is one token, and a quote needs at least one word with a
// letter in it: an amount, a date or a time alone is never three words,
// while "go with 2" is.
const MIN_QUOTE_WORDS = 3;
const QUOTE_TOO_SHORT_MESSAGE = "the quote must be at least three of the owner's words; quote more of their message, or ask them to say it in a few words";
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });
const NUMBER_RUN = /[\p{N}][\p{N}.,:/-]*/gu;
function quoteWordCount(quote) {
  const folded = fold(quote);
  const words = [];
  for (const piece of folded.split(NUMBER_RUN)) {
    for (const seg of WORD_SEGMENTER.segment(piece)) if (seg.isWordLike) words.push(seg.segment);
  }
  if (!words.some((w) => /\p{L}/u.test(w))) return 0;
  return words.length + (folded.match(NUMBER_RUN) || []).length;
}
// The registry's refusal when a wake-up holds the case (jobs.js BUSY).
const REGISTRY_BUSY = /busy/i;

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
    if (rule.enum && !rule.enum.includes(v)) throw fail('invalid_params', `"${key}" must be one of ${rule.enum.join(', ')}`);
  }
}

// Records are Bash-writable: count defensively.
function pendingProposals(dir) {
  return listRecords(dir).reduce((n, rec) => n + (Array.isArray(rec.proposals) ? rec.proposals.filter((p) => isObj(p) && !isObj(p.review)).length : 0), 0);
}

// A 1-based option number counts only when it stands alone (the whole
// quote, trailing punctuation ignored: "2", "2.") or is marked ("option 2",
// "number 2", "no. 2", "#2"), or follows a choosing verb and ends its clause
// ("go with 2", "pick 2, thanks"; not "go with 2 weeks"). "wait 1 week",
// "12", "1.5" and "2,1" name nothing (owner decision, 2026-09-30).
function markedNumber(n, quote) {
  const q = fold(quote);
  const bare = q.replace(/[\s.!?,;:]+$/, '');
  if (bare === String(n)) return true;
  if (new RegExp(`(?<!\\w)(?:(?:option|number|no\\.)\\s*#?\\s*|#\\s*)${n}(?!\\w|[.,]\\d)`).test(q)) return true;
  return new RegExp(`(?<!\\w)(?:go with|pick|choose|select)\\s+${n}(?![.,]\\d)(?=\\s*(?:[.!?,;:]|$))`).test(q);
}

// The indexes of the options the quote names: by label on word boundaries
// after the owner-quote fold, or by a marked number. An option's id never
// counts. A label found only inside another named option's label ("Yes" in
// "Yes, later") does not count on its own.
function optionsInQuote(quote, options) {
  const labels = options.map((o) => String(o.label ?? ''));
  const byLabel = labels.map((l) => wordsInText(l, quote));
  const named = [];
  options.forEach((_o, i) => {
    const inLonger = byLabel[i] && labels.some((other, j) => j !== i && byLabel[j] && fold(other) !== fold(labels[i]) && wordsInText(labels[i], other));
    if ((byLabel[i] && !inLonger) || markedNumber(i + 1, quote)) named.push(i);
  });
  return named;
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
// get_presence refuses. `getExecutorRegistry` is core.context's
// (revoke_envelope and cancel_case_job go through it, as the
// case:revokeEnvelope and case:cancelJob IPC do), or null: those two refuse.
function createCaseToolHandler({ getRuntime, getContact = null, getExecutorRegistry = null, channel, audit = null, log = createLogger('mcp/case-tools'), now = () => Date.now(), rateLimit = 30 }) {
  if (!CHANNELS.has(channel)) throw new Error(`channel must be one of ${[...CHANNELS].join(', ')}`);
  const tools = CASE_MCP_TOOLS.map(({ tier, ...def }) => def);
  const byName = new Map(CASE_MCP_TOOLS.map((t) => [t.name, t]));
  const names = new Set(byName.keys());
  const writes = [];

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

  function listCases(rt, scope = null) {
    // Titles and slugs can be model-authored (ruling T12-titles): they go
    // back inside the untrusted wrapper; id and status stay bare.
    return rt.listCases().filter((meta) => scope === null || meta.id === scope).map((meta) => ({
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

  // Takes a slot in the write window (every spoken tool shares it) and
  // returns a release for it.
  function takeRateSlot() {
    const t = now();
    while (writes.length && writes[0] <= t - RATE_WINDOW_MS) writes.shift();
    if (writes.length >= rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((writes[0] + RATE_WINDOW_MS - t) / 1000));
      throw fail('rate_limited', `at most ${rateLimit} case writes per minute; retry after ${retryAfter}s`, { retry_after: retryAfter });
    }
    writes.push(t);
    return () => {
      const i = writes.indexOf(t);
      if (i !== -1) writes.splice(i, 1);
    };
  }

  // Every spoken tool's quote rule (spec §3.2): required, non-blank and at
  // least three words (Q28) on every channel; on the in-app-chat channel it must be in the owner's own
  // message this turn (ownerTurnText, from the executor only); over MCP it
  // is recorded, not checked.
  function checkQuote(quote, ownerTurnText) {
    if (!fold(quote)) throw fail('invalid_params', '"quote" must hold the owner\'s words');
    if (quoteWordCount(quote) < MIN_QUOTE_WORDS) throw fail('quote_too_short', QUOTE_TOO_SHORT_MESSAGE);
    if (channel === CHAT_CHANNEL) {
      if (typeof ownerTurnText !== 'string' || !fold(ownerTurnText)) throw fail('not_owner', OWNER_ONLY_MESSAGE);
      if (!ownerQuoteInTurn(quote, ownerTurnText)) throw fail('quote_not_found', 'the quote is not in the owner\'s message this turn; quote their words exactly');
    }
  }

  const auditEntry = (kind, data, what) => {
    if (!audit || typeof audit.append !== 'function') return;
    Promise.resolve()
      .then(() => audit.append({ kind, data: { channel, ...data } }))
      .catch((err) => log.warn(`Audit entry for ${what} failed: ${err.message}`));
  };

  const registry = () => {
    let r = null;
    try {
      r = typeof getExecutorRegistry === 'function' ? getExecutorRegistry() || null : null;
    } catch {
      r = null;
    }
    if (!r) throw fail('executors_unavailable', 'executors are not available on this node');
    return r;
  };

  // The case's envelopes (case:envelopes' list). Envelope files are
  // Bash-writable: id and status go back bare only when they look like
  // one; the whole envelope is case content, wrapped.
  function listEnvelopes(rt, ref) {
    const meta = caseOf(rt, ref);
    return new EnvelopeStore(meta.dir).list().filter(isObj).map((env) => ({
      id: typeof env.id === 'string' && /^env-\d{2,}$/.test(env.id) ? env.id : null,
      status: ENVELOPE_STATUSES.includes(env.status) ? env.status : null,
      data: untrusted(env)
    }));
  }

  // The case's playbooks (case:playbooks' summary). Playbook text is data.
  function listPlaybooks(rt, ref) {
    const meta = caseOf(rt, ref);
    if (!rt.playbooks || typeof rt.playbooks.summary !== 'function') throw fail('playbooks_unavailable', 'playbooks are not available on this node');
    return untrusted(rt.playbooks.summary(meta.id));
  }

  // create_case: the case the app's case:create makes (no playbooks, no
  // chat), never with force. The objective must be words from the quote on
  // every channel; the quote itself is checked in-app only. The objective is
  // recorded as the owner's (CaseRuntime.recordOwnerObjective).
  // In a case chat (caseScope set) a similar-case refusal names no other
  // case: the list of other cases' ids, titles and statuses would reach the
  // case turn's context (Q27), so only the message goes back.
  async function createCase(rt, args, ownerTurnText, caseScope = null) {
    checkQuote(args.quote, ownerTurnText);
    if (!fold(args.title)) throw fail('invalid_params', '"title" must not be blank');
    if (!wordsInText(args.objective, args.quote)) throw fail('objective_not_in_quote', 'the objective must be the owner\'s words from the quote');
    const releaseSlot = takeRateSlot();
    let info;
    try {
      info = await rt.createCase({ title: args.title.trim(), type: args.type || 'general', objective: args.objective });
    } catch (err) {
      releaseSlot();
      if (err && err.code === 'SIMILAR_CASES') {
        const similar = (Array.isArray(err.similar) ? err.similar : []).map((c) => ({ caseId: c.caseId, title: c.title, status: c.status, match: c.match }));
        if (caseScope !== null) throw fail('similar_cases', SIMILAR_MESSAGE);
        throw fail('similar_cases', SIMILAR_MESSAGE, { similar: untrusted(similar) });
      }
      if (err && err.code === 'UNKNOWN_CASE_TYPE') throw fail('invalid_params', 'no such case type');
      throw err;
    }
    let factId = null;
    try {
      factId = (await rt.recordOwnerObjective(info.id, { objective: args.objective, quote: args.quote, channel })).id;
    } catch (err) {
      // The case exists: it is reported, with a note that the objective
      // was not recorded as the owner's.
      log.warn(`${channel} create_case: recording the owner's objective in ${info.slug} failed: ${err && err.message}`);
    }
    log.info(`${channel} created case ${info.slug}`);
    auditEntry('cases.create_case', { caseId: info.id, factId }, info.slug);
    return {
      case_id: info.id,
      status: info.status,
      type: info.type,
      fact_id: factId,
      ...(factId ? {} : { note: 'the case was created, but the owner\'s objective could not be recorded as a fact' }),
      data: untrusted({ title: info.title, slug: info.slug })
    };
  }

  const busyOrInternal = (what, meta, why) => {
    if (REGISTRY_BUSY.test(String(why))) return fail('case_busy', 'the case is busy with a turn', { retry_after: 5 });
    log.warn(`${channel} ${what} in ${meta.slug} failed: ${why}`);
    return fail('internal', 'the case tool failed on this node');
  };

  // revoke_envelope: IPC case:revokeEnvelope's path (the registry's
  // revokeEnvelope, in systemAction), with the quote in the reason.
  async function revokeEnvelope(rt, args, ownerTurnText) {
    checkQuote(args.quote, ownerTurnText);
    const meta = caseOf(rt, args.case);
    const reg = registry();
    if (!isObj(new EnvelopeStore(meta.dir).get(args.envelope))) throw fail('envelope_not_found', 'no such envelope in this case');
    const releaseSlot = takeRateSlot();
    const r = await reg.revokeEnvelope(meta.id, args.envelope, `revoked by the owner (${channel}): ${JSON.stringify(args.quote)}`);
    if (!r || !r.ok) {
      releaseSlot();
      throw busyOrInternal(`revoke_envelope ${args.envelope}`, meta, r && r.error);
    }
    log.info(`${channel} revoked ${args.envelope} in case ${meta.slug}`);
    auditEntry('cases.revoke_envelope', { caseId: meta.id, envelopeId: args.envelope }, args.envelope);
    return { envelope: args.envelope, status: 'revoked', cancelled_jobs: Array.isArray(r.cancelled) ? r.cancelled : [] };
  }

  // cancel_case_job: IPC case:cancelJob's path (the registry's cancelJob,
  // in systemAction), with the quote in the reason.
  async function cancelCaseJob(rt, args, ownerTurnText) {
    checkQuote(args.quote, ownerTurnText);
    const meta = caseOf(rt, args.case);
    const reg = registry();
    const job = new JobStore(meta.dir).get(args.job);
    if (!isObj(job)) throw fail('job_not_found', 'no such job in this case');
    if (!jobIsOpen(job.state)) throw fail('job_closed', 'the job is already finished or cancelled');
    const releaseSlot = takeRateSlot();
    const r = await reg.cancelJob(meta.id, args.job, `cancelled by the owner (${channel}): ${JSON.stringify(args.quote)}`);
    if (!r || !r.ok) {
      releaseSlot();
      const why = String(r && r.error);
      if (REGISTRY_BUSY.test(why)) throw busyOrInternal(`cancel_case_job ${args.job}`, meta, why);
      // Settled by a poll meanwhile.
      log.info(`${channel} cancel_case_job ${args.job} in ${meta.slug} refused: ${why}`);
      throw fail('job_closed', 'the job is already finished or cancelled');
    }
    log.info(`${channel} cancelled ${args.job} in case ${meta.slug}`);
    auditEntry('cases.cancel_case_job', { caseId: meta.id, jobId: args.job }, args.job);
    return { job: args.job, state: r.job && typeof r.job.state === 'string' ? r.job.state : 'cancelled' };
  }

  // set_away: the away field alone (contact's setAway), through the same
  // validation as setPolicy (validatePolicy). The rest of the stored policy
  // is never read back and rewritten, so no default is frozen into the
  // settings and a Settings > Contact save meanwhile is not undone. The
  // policy is data-dir settings on the desktop and in service mode alike
  // (only the owner and addresses are admin-only).
  async function setAway(args, ownerTurnText) {
    checkQuote(args.quote, ownerTurnText);
    const off = args.mode === 'off';
    if (off && args.until !== undefined) throw fail('invalid_params', 'off takes no "until"');
    if (!off) {
      if (args.until === undefined) throw fail('invalid_params', `"until" is required with ${args.mode}`);
      const t = Date.parse(args.until);
      if (!Number.isFinite(t)) throw fail('invalid_params', '"until" is not a date-time');
      if (t <= now()) throw fail('invalid_params', '"until" must be in the future');
    }
    const c = contact();
    if (!c || typeof c.setAway !== 'function') throw fail('contact_unavailable', 'contact is not available on this node');
    const releaseSlot = takeRateSlot();
    const r = c.setAway(off ? null : { mode: args.mode, until: args.until });
    if (!r || !r.ok) {
      releaseSlot();
      log.warn(`${channel} set_away refused by the contact policy: ${r && r.error}`);
      throw fail('invalid_params', 'the contact policy refused that away setting');
    }
    const away = isObj(r.away) ? { mode: r.away.mode, until: r.away.until } : null;
    log.info(`${channel} set away ${away ? `${away.mode} until ${away.until}` : 'off'}`);
    auditEntry('cases.set_away', { mode: args.mode, until: away ? away.until : null }, 'set_away');
    return { away };
  }

  // The spoken class only (answerClass): a pressed question is refused on
  // every channel, in-app-chat included. `quote` is the owner's words: on the
  // in-app-chat channel it must be in the owner's own message this turn
  // (ownerTurnText, from the executor only); over MCP it is recorded, not
  // checked. An option must be named in the quote; free text is the quote,
  // or words from it. A spoken briefing is acknowledged.
  async function answerQuestion(rt, args, ownerTurnText) {
    const hasText = args.text !== undefined;
    const hasOption = args.option_id !== undefined;
    if (hasText && hasOption) throw fail('invalid_params', 'give text or option_id, not both');
    const quote = args.quote;
    checkQuote(quote, ownerTurnText);
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
        const named = optionsInQuote(quote, options);
        // Labels can be model-authored: listed as data, never in the message.
        const listed = () => ({ options: untrusted(options.map((o, i) => ({ number: i + 1, id: o.id, label: o.label ?? null }))) });
        if (named.length > 1) {
          throw fail('option_ambiguous', 'the quote names more than one option; ask the owner which one they mean', listed());
        }
        if (named[0] !== index) {
          throw fail('option_not_in_quote', 'the quote does not name that option by its label or number; ask the owner which option they mean', listed());
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
    auditEntry('cases.answer_question', { caseId: meta.id, questionId: q.id, optionId: hasOption ? args.option_id : null, factId }, q.id);
    return {
      question_id: q.id,
      answered_at: res?.question?.answer?.at ?? null,
      fact_id: factId,
      ...(briefing ? { acknowledged: true } : {})
    };
  }

  // In a case chat (Q27) a case the call names must be the chat's own. An
  // unknown one is refused the same way, so the refusal tells nothing about
  // the other cases.
  function checkScope(rt, ref, scope) {
    let meta = null;
    try {
      meta = rt.getCase(ref);
    } catch (err) {
      if (!(err && err.code === 'CASE_NOT_FOUND')) throw err;
    }
    if (!meta || meta.id !== scope) throw fail('other_case', OTHER_CASE_MESSAGE);
  }

  // `ownerTurnText` is the executor's own field (the chat's in-app tools
  // pass it from their execute context); the MCP surfaces pass none, and it
  // is read only on the in-app-chat channel. `caseScope` is a case chat's
  // case id, from the host's case context (the chat's tools pass it from
  // their execute context; never a tool argument): the case-scoped tools
  // then act on that case alone (Q27). The MCP surfaces pass none.
  async function call(name, args = {}, { ownerTurnText = null, caseScope = null } = {}) {
    const tool = byName.get(name);
    if (!tool) throw fail('unknown_tool', 'no such case tool');
    validate(tool, args || {});
    // A scope that is not a case id fails closed.
    if (caseScope !== null && (typeof caseScope !== 'string' || !caseScope)) throw fail('other_case', OTHER_CASE_MESSAGE);
    const scope = CASE_SCOPED_TOOLS.has(name) ? caseScope : null;
    const rt = runtime();
    try {
      if (scope !== null && args.case !== undefined) checkScope(rt, args.case, scope);
      switch (name) {
        case 'list_cases': return listCases(rt, scope);
        case 'open_case': return openCase(rt, args.case);
        case 'get_orientation': return untrusted({ text: rt.orientation(caseOf(rt, args.case).id) });
        case 'list_questions': return listQuestions(rt, args.case ?? scope ?? undefined);
        case 'get_presence': return getPresence();
        case 'list_envelopes': return listEnvelopes(rt, args.case);
        case 'list_playbooks': return listPlaybooks(rt, args.case);
        case 'create_case': return await createCase(rt, args, ownerTurnText, caseScope);
        case 'revoke_envelope': return await revokeEnvelope(rt, args, ownerTurnText);
        case 'cancel_case_job': return await cancelCaseJob(rt, args, ownerTurnText);
        case 'answer_question': return await answerQuestion(rt, args, ownerTurnText);
        case 'set_away': return await setAway(args, ownerTurnText);
        default: throw fail('unknown_tool', 'no such case tool');
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
// CASE_TOOL_SCOPE are registered (cases:read; answer_question and set_away
// under cases:answer; create_case, revoke_envelope and cancel_case_job under
// cases:manage: management surfaces spec §3.3). The handler is its own, on
// the mcp-frontdoor channel (its own rate limit, shared by every front-door
// client; the per-grant limit is the front door's; it repeats every
// front-door refusal). The router's fields are removed; anything else is checked
// against the tool's schema.
function registerNodeCaseMethods(nodeFleetService, { getRuntime, getContact = null, getExecutorRegistry = null, audit = null, log } = {}) {
  const handler = createCaseToolHandler({ getRuntime, getContact, getExecutorRegistry, channel: 'mcp-frontdoor', audit, ...(log ? { log } : {}) });
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
  CHAT_CHANNEL,
  createCaseToolHandler,
  untrusted,
  answerClass,
  PRESSED_MESSAGE,
  OWNER_ONLY_MESSAGE,
  OTHER_CASE_MESSAGE,
  CASE_SCOPED_TOOLS,
  QUOTE_TOO_SHORT_MESSAGE,
  quoteWordCount,
  registerNodeCaseMethods
};

// src/cases/chat-attach.js
// Owner decision Q29 (2026-10-12; management surfaces spec §3.1): a chat that
// holds management-tool results about a case other than the one it is being
// attached to cannot be attached to a case. A chat with no case reads every
// case through those tools; attached afterwards, its stored results would
// reach that case's turns through the tail, recall and SearchHistory /
// ReadHistory, and from there the case's ledger and executor payloads, past
// an outbound gate that knows only that case's private facts (Q27). The
// owner starts a new chat for the case.
//
// The rule reads only what the send path stores for a tool call
// (chat-handlers.js): a `toolUse` row (toolName, parameters) before the call
// and a `toolResult` row (toolName, result) after it. Neither records the
// call's case scope and nothing pairs a result with its call, so the rule
// never pairs them, and whatever it cannot tell it refuses:
//
// - list_cases, list_questions, create_case: the result itself names its
//   cases. Every case id in it must be the target's; a result that is not
//   the tool's own shape, or a refusal that carries data (create_case's
//   `similar` list), blocks.
// - Every other case tool but get_presence and set_away (which carry no case
//   data): the result does not name its case, so every stored call must name
//   the target by its id (a slug can be used again by a later case), and
//   there must be a call row for every result that carries anything.
// - A child run has these tools too and its reply comes back as prose.
//   SpawnAgent's result lists the tools the child used: one that could carry
//   case data, or start a run of its own, blocks. TaskStatus,
//   sessions_history and RemoteDispatch return another run's text with no
//   such list, so any text from them blocks.
//
// A refusal with nothing in it (`ok: false` or `success: false`, no `data`)
// carries no case data and never blocks.
const { CASE_MCP_TOOLS } = require('./mcp-tool-definitions');

const SAW_OTHER_CASES_MESSAGE = 'This chat has looked at other cases, so it cannot be attached to a case. Start a new chat for the case.';
const UNVERIFIABLE_MESSAGE = 'This chat holds the reply of another agent run that could read other cases, so it cannot be attached to a case. Start a new chat for the case.';
const CHAT_BUSY_MESSAGE = 'A reply is still running in this chat. Attach the case when it has finished.';

// A new case tool carries case data until it is listed here.
const NO_CASE_DATA = Object.freeze(['get_presence', 'set_away']);
const CASE_DATA_TOOLS = Object.freeze(CASE_MCP_TOOLS.map((t) => t.name).filter((name) => !NO_CASE_DATA.includes(name)));
// The case ids a result of these names, or null when it is not their shape.
const RESULT_CASE_IDS = Object.freeze({
  list_cases: (value) => (Array.isArray(value) ? value.map((row) => (isObj(row) ? row.id : null)) : null),
  list_questions: (value) => (Array.isArray(value) ? value.map((row) => (isObj(row) ? row.caseId : null)) : null),
  create_case: (value) => (isObj(value) ? [value.case_id] : null)
});
const CHILD_RUN_TOOL = 'SpawnAgent';
// Another run's text, with no record of the tools that run used.
const OTHER_RUN_TEXT = Object.freeze({
  TaskStatus: (r) => r.ok === true && r.result == null && r.output == null && (r.tasks === undefined || (Array.isArray(r.tasks) && r.tasks.length === 0)),
  sessions_history: () => false,
  RemoteDispatch: () => false
});
// What a child may have used without its reply being in doubt: anything but
// a tool that carries case data or returns another run's text.
const CHILD_BLOCKING_TOOLS = Object.freeze([...CASE_DATA_TOOLS, CHILD_RUN_TOOL, 'BackgroundTask', 'sessions_spawn', ...Object.keys(OTHER_RUN_TEXT)]);

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const isId = (v) => typeof v === 'string' && v.length > 0;

// A refusal with nothing in it: the tool's own ({ ok: false, error, code })
// or the executor's ({ success: false, error }), with no data.
const isBareFailure = (r) => isObj(r) && (r.ok === false || r.success === false) && r.data === undefined && r.similar === undefined && r.result === undefined;

class ChatAttachRefusedError extends Error {
  constructor(reason = 'other-cases', at = null) {
    super(reason === 'unverifiable' ? UNVERIFIABLE_MESSAGE : SAW_OTHER_CASES_MESSAGE);
    this.name = 'ChatAttachRefusedError';
    this.code = 'CHAT_SAW_OTHER_CASES';
    this.reason = reason === 'unverifiable' ? 'unverifiable' : 'other-cases';
    this.at = at;
  }
}

class ChatBusyError extends Error {
  constructor() {
    super(CHAT_BUSY_MESSAGE);
    this.name = 'ChatBusyError';
    this.code = 'CHAT_BUSY';
  }
}

// The first row that keeps a chat with these messages from being attached to
// case `caseId` ({ reason, toolName, seq }), or null. `caseId` null is a case
// that does not exist yet: any case's data blocks.
function attachBlock(messages, caseId = null) {
  const block = (reason, m) => ({ reason, toolName: (m && typeof m.toolName === 'string' && m.toolName) || null, seq: (m && m.seq) ?? null });
  if (!Array.isArray(messages)) return block('other-cases', null);
  const target = isId(caseId) ? caseId : null;
  const isTarget = (id) => target !== null && id === target;
  // Per keyed tool: calls stored, results that carry something, and the
  // first such result (named when it has no call).
  const keyed = new Map();
  const count = (name) => {
    if (!keyed.has(name)) keyed.set(name, { uses: 0, results: 0, first: null });
    return keyed.get(name);
  };
  for (const m of messages) {
    if (!isObj(m) || (m.sender !== 'toolUse' && m.sender !== 'toolResult')) continue;
    const name = m.toolName;
    const r = m.result;
    if (CASE_DATA_TOOLS.includes(name)) {
      const idsOf = RESULT_CASE_IDS[name];
      if (m.sender === 'toolUse') {
        if (idsOf) continue;
        if (!isObj(m.parameters) || !isTarget(m.parameters.case)) return block('other-cases', m);
        count(name).uses += 1;
        continue;
      }
      if (isBareFailure(r)) continue;
      if (idsOf) {
        const ids = isObj(r) && r.ok === true ? idsOf(r.result) : null;
        if (!ids || !ids.every(isTarget)) return block('other-cases', m);
        continue;
      }
      const c = count(name);
      c.results += 1;
      if (!c.first) c.first = m;
      continue;
    }
    if (m.sender !== 'toolResult' || isBareFailure(r)) continue;
    if (name === CHILD_RUN_TOOL) {
      const used = isObj(r) ? r.toolsUsed : null;
      if (!Array.isArray(used) || !used.every((t) => typeof t === 'string' && !CHILD_BLOCKING_TOOLS.includes(t))) return block('unverifiable', m);
      continue;
    }
    if (Object.hasOwn(OTHER_RUN_TEXT, name) && !(isObj(r) && OTHER_RUN_TEXT[name](r))) return block('unverifiable', m);
  }
  for (const c of keyed.values()) {
    if (c.results > c.uses) return block('other-cases', c.first);
  }
  return null;
}

// Throws ChatAttachRefusedError when `chat` (with its messages) may not be
// attached to case `caseId` (null: a case about to be created).
function assertChatAttachable(chat, caseId = null) {
  const found = attachBlock(chat ? chat.messages : null, caseId);
  if (found) throw new ChatAttachRefusedError(found.reason, { toolName: found.toolName, seq: found.seq });
}

module.exports = {
  attachBlock, assertChatAttachable, ChatAttachRefusedError, ChatBusyError,
  CASE_DATA_TOOLS, NO_CASE_DATA, SAW_OTHER_CASES_MESSAGE, UNVERIFIABLE_MESSAGE, CHAT_BUSY_MESSAGE
};

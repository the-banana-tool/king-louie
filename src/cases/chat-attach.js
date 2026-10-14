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
//
// History stage H4 (owner rulings R-H4-1, R-H4-7, 2026-10-13) adds two
// refusals, checked before Q29:
//
// - An imported chat (`source` set, or the case-export mark) is never given
//   a case: its `user` rows are a file's, not the owner's verified messages.
// - A chat that has ever recalled from another chat is never given a case
//   (`recalledOtherChats`): what it read would reach the case's turns
//   through the tail and recall. It reads what the send path stores: a
//   reply's recall provenance (`context.recalledChats`) and the results of
//   SearchHistory and ReadHistory. A result that is not the tool's own shape
//   blocks. A turn that failed stores no reply, and a truncation removes
//   rows, so the chat also carries a mark (`recalledOtherChatsAt`,
//   HistoryStore#markRecalledOtherChats) set before another chat's text
//   reaches a model and never cleared; the mark alone refuses
//   (`recallMarked`). What neither sees is text the owner pasted in.
const { CASE_MCP_TOOLS } = require('./mcp-tool-definitions');

const SAW_OTHER_CASES_MESSAGE = 'This chat has looked at other cases, so it cannot be attached to a case. Start a new chat for the case.';
const UNVERIFIABLE_MESSAGE = 'This chat holds the reply of another agent run that could read other cases, so it cannot be attached to a case. Start a new chat for the case.';
const CHAT_BUSY_MESSAGE = 'A reply is still running in this chat. Attach the case when it has finished.';
const RECALLED_OTHER_CHATS_MESSAGE = 'This chat has read other chats, so it cannot be attached to a case. Start a new chat for the case.';
const IMPORTED_CHAT_MESSAGE = 'An imported chat cannot be attached to a case; its messages are not verified as the owner\'s.';
const PRIVATE_CASE_REQUIRED_MESSAGE = 'This chat is private and the case is not. Make the case private too, or attach the chat to a private case.';

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

class ChatRecalledOtherChatsError extends Error {
  constructor(at = null) {
    super(RECALLED_OTHER_CHATS_MESSAGE);
    this.name = 'ChatRecalledOtherChatsError';
    this.code = 'CHAT_RECALLED_OTHER_CHATS';
    this.at = at;
  }
}

class ImportedChatError extends Error {
  constructor() {
    super(IMPORTED_CHAT_MESSAGE);
    this.name = 'ImportedChatError';
    this.code = 'IMPORTED_CHAT';
  }
}

// Local inference L1 (spec 2026-10-13 §8.2, R-LI-23): a private chat is
// given only a private case, or one the owner makes private in the same
// action. Checked after every other refusal.
class PrivateCaseRequiredError extends Error {
  constructor() {
    super(PRIVATE_CASE_REQUIRED_MESSAGE);
    this.name = 'PrivateCaseRequiredError';
    this.code = 'PRIVATE_CASE_REQUIRED';
  }
}

// Whether a stored history-tool result shows another chat's text, by the
// tools' own result shapes (src/tools/builtin/history-tools.js). Anything
// that is not that shape counts as another chat's.
const HISTORY_RESULT_FROM_OTHER_CHAT = Object.freeze({
  // { ok: true, excerpts: [{ seq, header, text, chatId?, chatTitle? }] }:
  // an excerpt names its chat only when it is not this one.
  SearchHistory: (r, chatId) => !(isObj(r) && r.ok === true && Array.isArray(r.excerpts)
    && r.excerpts.every((e) => isObj(e) && (e.chatId === undefined || e.chatId === chatId) && e.chatTitle === undefined)),
  // { ok: true, chatId, ... }: the chat that was read.
  ReadHistory: (r, chatId) => !(isObj(r) && r.ok === true && isId(r.chatId) && r.chatId === chatId)
});

// Whether the chat carries the recall mark. Any value but a missing one
// counts: the store writes a time, and anything else there is not a reason
// to attach.
function recallMarked(chat) {
  return isObj(chat) && chat.recalledOtherChatsAt !== undefined && chat.recalledOtherChatsAt !== null;
}

// The first row that shows the chat `chatId` has read another chat
// ({ seq, toolName }), or null: a reply whose recall provenance names other
// chats, or a SearchHistory / ReadHistory result from one. A bare failure
// never blocks.
function recalledOtherChats(messages, chatId) {
  const at = (m, toolName = null) => ({ seq: (m && m.seq) ?? null, toolName });
  if (!Array.isArray(messages)) return at(null);
  const own = isId(chatId) ? chatId : null;
  for (const m of messages) {
    if (!isObj(m)) continue;
    if (m.sender === 'assistant') {
      const named = isObj(m.context) ? m.context.recalledChats : undefined;
      if (named === undefined || named === null || (Array.isArray(named) && named.length === 0)) continue;
      return at(m);
    }
    if (m.sender !== 'toolResult' || !Object.hasOwn(HISTORY_RESULT_FROM_OTHER_CHAT, m.toolName)) continue;
    if (isBareFailure(m.result)) continue;
    if (HISTORY_RESULT_FROM_OTHER_CHAT[m.toolName](m.result, own)) return at(m, m.toolName);
  }
  return null;
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

// Throws when `chat` (with its messages) may not be attached to case
// `caseId` (null: a case about to be created): ImportedChatError,
// ChatRecalledOtherChatsError, then Q29's ChatAttachRefusedError. No `force`
// lifts any of them. Then, given the marks (local inference L1): a private
// chat and a case that is not private is PrivateCaseRequiredError unless
// `makeCasePrivate` is exactly true (the caller then marks the case). A
// case about to be created is created private, so it never refuses.
function assertChatAttachable(chat, caseId = null, { chatPrivate = false, casePrivate = false, makeCasePrivate = false } = {}) {
  if (chat && (chat.source || chat.importedFromCase === true)) throw new ImportedChatError();
  if (recallMarked(chat)) throw new ChatRecalledOtherChatsError({ seq: null, toolName: null });
  // No message list to read is Q29's refusal, below.
  const read = chat && Array.isArray(chat.messages) ? recalledOtherChats(chat.messages, chat.id) : null;
  if (read) throw new ChatRecalledOtherChatsError(read);
  const found = attachBlock(chat ? chat.messages : null, caseId);
  if (found) throw new ChatAttachRefusedError(found.reason, { toolName: found.toolName, seq: found.seq });
  if (caseId && chatPrivate === true && casePrivate !== true && makeCasePrivate !== true) throw new PrivateCaseRequiredError();
}

module.exports = {
  attachBlock, assertChatAttachable, ChatAttachRefusedError, ChatBusyError, PrivateCaseRequiredError, PRIVATE_CASE_REQUIRED_MESSAGE,
  recalledOtherChats, recallMarked, ChatRecalledOtherChatsError, ImportedChatError,
  CASE_DATA_TOOLS, NO_CASE_DATA, SAW_OTHER_CASES_MESSAGE, UNVERIFIABLE_MESSAGE, CHAT_BUSY_MESSAGE,
  RECALLED_OTHER_CHATS_MESSAGE, IMPORTED_CHAT_MESSAGE
};

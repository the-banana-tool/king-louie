// src/ipc/case-handlers.js
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { bridgeOriginFor } = require('../history/bridge-origin');
const { assertChatAttachable, ChatBusyError } = require('../cases/chat-attach');
const { isLocalDesktopEvent } = require('../core/origin');
const { ownerObjective } = require('./case-progress-handlers');
const { createLogger } = require('../logging');

const log = createLogger('ipc/cases');

const summarize = (c) => ({
  id: c.id, slug: c.slug, title: c.title, type: c.type, status: c.status, created: c.created, dir: c.dir
});

// A Telegram/Discord bridge chat (F5) can carry messages from a remote
// sender stamped sender: 'user'. Giving it a case would let those messages
// satisfy the quote-verified owner-message check (chat-handlers.js), so a
// case is never attached to one, nor created for one.
class BridgeChatError extends Error {
  constructor(origin) {
    super(`A ${origin} chat cannot be attached to a case; its messages are not verified as the owner's.`);
    this.name = 'BridgeChatError';
    this.code = 'BRIDGE_CHAT';
  }
}
const assertNotBridgeChat = (chat) => {
  const origin = bridgeOriginFor(chat);
  if (origin) throw new BridgeChatError(origin);
};

// Why a chat was not given a case; case:create answers these after the case
// exists with "The case was created, but this chat was not attached to it."
const ATTACH_REFUSALS = Object.freeze(['CHAT_SAW_OTHER_CASES', 'CHAT_BUSY', 'BRIDGE_CHAT', 'CHAT_RECALLED_OTHER_CHATS', 'IMPORTED_CHAT']);

function registerCaseHandlers(ipcMain, context = {}) {
  const chatById = (chatId) => context.getChat(chatId, { messages: true });
  // The renderer replaces its chat with what attach returns, so it keeps
  // the messages.
  const patchChat = (chatId, patch = {}) => context.updateChat(chatId, patch);

  const runtime = () => {
    const rt = typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null;
    if (!rt) throw new Error('Cases are not available in this host.');
    return rt;
  };

  // Owner decision Q29 (2026-10-12): a chat that holds management-tool
  // results about a case other than `caseId` is never given it
  // (src/cases/chat-attach.js); `caseId` null is a case about to be created.
  // The same call refuses an imported chat (IMPORTED_CHAT) and a chat that
  // has read other chats (CHAT_RECALLED_OTHER_CHATS; history stage H4,
  // rulings R-H4-1 and R-H4-7), before Q29.
  // A turn still running in the chat (one that began with no case, so its
  // tools read every case) would store its results after the check, so the
  // attach waits for it. Throws ChatAttachRefusedError or ChatBusyError.
  // Nothing is awaited between this check and the write in `attach`.
  // The bridge rule comes first, for case:attach and case:create alike
  // (owner decision 2026-10-12: case:create skipped it).
  const assertAttachable = (chat, caseId) => {
    assertNotBridgeChat(chat);
    if (typeof context.isChatRunning === 'function' && context.isChatRunning(chat.id)) throw new ChatBusyError();
    assertChatAttachable(chat, caseId);
  };

  // The one place a chat is given a case (case:attach, and case:create with
  // a chat). Taking the case away is never refused. Naming the case the
  // chat already has is refused only for a bridge chat.
  const attach = (chatId, caseId) => {
    const chat = chatById(chatId);
    if (!chat) throw new Error('Chat not found.');
    if (caseId) assertNotBridgeChat(chat);
    if (caseId && chat.caseId !== caseId) assertAttachable(chat, caseId);
    const now = new Date().toISOString();
    return patchChat(chatId, { caseId: caseId || null, updatedAt: now });
  };

  ipcMain.handle(IPC.CASE_LIST, wrapHandler(IPC.CASE_LIST, async () => (
    { ok: true, cases: runtime().listCases().map(summarize) }
  )));

  ipcMain.handle(IPC.CASE_CREATE, wrapHandler(IPC.CASE_CREATE, async (event, payload) => {
    // A non-object payload (null, an array) counts as {} and gets the fixed
    // title error below, never a destructuring TypeError.
    const form = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    let { type } = form;
    const { title, chatId, force, playbooks, acceptBudgetRaises } = form;
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'A case needs a title.' };
    if (type !== undefined && (typeof type !== 'string' || !type.trim())) return { ok: false, error: 'type must be a non-empty string.' };
    // Cases stage 8 (owner ruling 2026-10-13): the form's Objective field.
    // What the owner typed, trimmed and held to the rules of an objective
    // the owner rewrites in the panel; nothing else in the form says whose
    // it is.
    let objective = '';
    if (form.objective !== undefined) {
      const typed = ownerObjective(form.objective);
      if (typed.problem) return { ok: false, error: `objective must be a non-empty string. ${typed.problem}` };
      objective = typed.value;
    }
    if (force !== undefined && typeof force !== 'boolean') return { ok: false, error: 'force must be true or false.' };
    const chatBefore = chatId ? chatById(chatId) : null;
    if (chatId && !chatBefore) return { ok: false, error: 'Chat not found.' };
    // The bridge rule and Q29: checked before anything is fetched or
    // created, and before the similar-case refusal, so no case is created
    // for a chat that would then be refused and the owner is never asked to
    // force such a create. `force` lifts neither.
    if (chatBefore) assertAttachable(chatBefore, null);
    // Cases stage 6: the owner's chosen playbooks are checked, fetched and
    // validated before the case exists; any failure refuses the create. The
    // type comes from the playbooks when the form gives none.
    const playbookIpc = require('./playbook-handlers');
    const withPlaybooks = await playbookIpc.preparePlaybooksForCreate(context, { playbooks, type, acceptBudgetRaises });
    if (!withPlaybooks.ok) return withPlaybooks;
    if (!type && withPlaybooks.type) type = withPlaybooks.type;
    let info;
    try {
      // Cases stage 8: an objective typed in the form is the owner's, and
      // confirmed from the start. The form is the app's own window (or a
      // paired desktop's): an event the host did not mark never confirms one.
      const ownForm = isLocalDesktopEvent(event);
      if (objective && !ownForm) log.warn('case:create: the event is not the local desktop\'s; the objective is recorded as proposed.');
      info = await runtime().createCase({
        title: title.trim(), type: type || 'general', objective, force: force === true, ...(objective && ownForm ? { objectiveBy: 'owner' } : {})
      });
    } catch (err) {
      // Cases stage 5: a similar open case needs the owner's confirmation (force).
      if (err && err.code === 'SIMILAR_CASES') return { ok: false, error: err.message, code: 'SIMILAR_CASES', similar: err.similar };
      if (err && err.code === 'UNKNOWN_CASE_TYPE') return { ok: false, error: err.message, code: err.code };
      throw err;
    }
    // The chat is attached before the playbooks: their gating questions are
    // posted to the case's chat (management surfaces §3.4), and with no chat
    // carrying the caseId yet each would create a stray one.
    // `attach` checks the chat again as it is now. A refusal here (a turn
    // began in the chat while the case was being created) leaves the case
    // created and the chat without it; the reply says both.
    let chat = null;
    try {
      chat = chatId ? attach(chatId, info.id) : null;
    } catch (err) {
      if (err && ATTACH_REFUSALS.includes(err.code)) {
        return { ok: false, error: `The case was created, but this chat was not attached to it. ${err.message}`, code: err.code, case: summarize(info) };
      }
      throw err;
    }
    const attached = await playbookIpc.attachPlaybooksAfterCreate(context, info.id, withPlaybooks, { acceptBudgetRaises: acceptBudgetRaises === true });
    // The reply carries the chat as it is now, with the questions posted to it.
    return { ok: true, case: summarize(info), chat: chat && attached.playbooks ? chatById(chatId) : chat, ...attached };
  }));

  ipcMain.handle(IPC.CASE_ATTACH, wrapHandler(IPC.CASE_ATTACH, async (_event, { chatId, caseId } = {}) => {
    if (caseId) {
      // An unknown case is refused first; `attach` then applies the bridge
      // rule (assertNotBridgeChat) and Q29.
      runtime().getCase(caseId);
    }
    return { ok: true, chat: attach(chatId, caseId) };
  }));

  ipcMain.handle(IPC.CASE_ORIENTATION, wrapHandler(IPC.CASE_ORIENTATION, async (_event, { caseId } = {}) => (
    { ok: true, text: runtime().orientation(caseId) }
  )));

  ipcMain.handle(IPC.CASE_RUNNING_TURN, wrapHandler(IPC.CASE_RUNNING_TURN, async (_event, { caseId } = {}) => {
    const turn = runtime().runningTurn(caseId);
    return { ok: true, running: Boolean(turn), source: turn ? turn.source : null };
  }));

  ipcMain.handle(IPC.CASE_SET_DISCLOSABLE, wrapHandler(IPC.CASE_SET_DISCLOSABLE, async (_event, { caseId, factId, disclosable } = {}) => {
    if (typeof disclosable !== 'boolean') return { ok: false, error: 'disclosable must be true or false.' };
    return { ok: true, fact: runtime().ledger(caseId).setDisclosable(factId, disclosable) };
  }));
}

module.exports = { registerCaseHandlers };

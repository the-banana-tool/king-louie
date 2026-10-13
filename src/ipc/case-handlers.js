// src/ipc/case-handlers.js
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const TelegramBridge = require('../channels/telegram-bridge');
const DiscordChannel = require('../channels/discord-bridge');
const { assertChatAttachable, ChatBusyError } = require('../cases/chat-attach');

const summarize = (c) => ({
  id: c.id, slug: c.slug, title: c.title, type: c.type, status: c.status, created: c.created, dir: c.dir
});

// F5 re-review: a chat from before the origin tag existed has none, and
// the bridges' chat-id maps are in-memory only, so it is never re-tagged
// by create-core.js's startup migration alone — CASE_ATTACH refuses by
// title prefix too, as a second, redundant check that needs no tag at
// all. A chat the owner has since renamed no longer matches either
// check and cannot be caught here (see final-fix-report.md).
const LEGACY_BRIDGE_TITLE_PREFIXES = [TelegramBridge.CHAT_TITLE_PREFIX, DiscordChannel.CHAT_TITLE_PREFIX];
const bridgeOriginFor = (chat) => {
  if (chat?.origin) return chat.origin;
  if (typeof chat?.title === 'string' && LEGACY_BRIDGE_TITLE_PREFIXES.some((p) => chat.title.startsWith(p))) {
    return chat.title.startsWith(TelegramBridge.CHAT_TITLE_PREFIX) ? 'telegram' : 'discord';
  }
  return null;
};

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
  // A turn still running in the chat (one that began with no case, so its
  // tools read every case) would store its results after the check, so the
  // attach waits for it. Throws ChatAttachRefusedError or ChatBusyError.
  // Nothing is awaited between this check and the write in `attach`.
  const assertAttachable = (chat, caseId) => {
    if (typeof context.isChatRunning === 'function' && context.isChatRunning(chat.id)) throw new ChatBusyError();
    assertChatAttachable(chat, caseId);
  };

  // The one place a chat is given a case (case:attach, and case:create with
  // a chat). Taking the case away, or naming the case the chat already has,
  // is never refused.
  const attach = (chatId, caseId) => {
    const chat = chatById(chatId);
    if (!chat) throw new Error('Chat not found.');
    if (caseId && chat.caseId !== caseId) assertAttachable(chat, caseId);
    const now = new Date().toISOString();
    return patchChat(chatId, { caseId: caseId || null, updatedAt: now });
  };

  ipcMain.handle(IPC.CASE_LIST, wrapHandler(IPC.CASE_LIST, async () => (
    { ok: true, cases: runtime().listCases().map(summarize) }
  )));

  ipcMain.handle(IPC.CASE_CREATE, wrapHandler(IPC.CASE_CREATE, async (_event, payload) => {
    // A non-object payload (null, an array) counts as {} and gets the fixed
    // title error below, never a destructuring TypeError.
    const form = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    let { type } = form;
    const { title, objective, chatId, force, playbooks, acceptBudgetRaises } = form;
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'A case needs a title.' };
    if (type !== undefined && (typeof type !== 'string' || !type.trim())) return { ok: false, error: 'type must be a non-empty string.' };
    if (objective !== undefined && (typeof objective !== 'string' || !objective.trim())) return { ok: false, error: 'objective must be a non-empty string.' };
    if (force !== undefined && typeof force !== 'boolean') return { ok: false, error: 'force must be true or false.' };
    const chatBefore = chatId ? chatById(chatId) : null;
    if (chatId && !chatBefore) return { ok: false, error: 'Chat not found.' };
    // Q29: checked before anything is fetched or created, and before the
    // similar-case refusal, so the owner is never asked to force a create
    // whose attach would be refused. `force` does not lift it.
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
      info = await runtime().createCase({ title: title.trim(), type: type || 'general', objective: objective || '', force: force === true });
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
      if (err && (err.code === 'CHAT_SAW_OTHER_CASES' || err.code === 'CHAT_BUSY')) {
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
      runtime().getCase(caseId);
      // A Telegram/Discord bridge chat (F5) can carry messages from a
      // remote sender stamped sender: 'user'. Attaching a case would let
      // those messages satisfy the quote-verified owner-message check
      // (chat-handlers.js), so a case may never be attached to one.
      const chat = chatById(chatId);
      const origin = bridgeOriginFor(chat);
      if (origin) throw new Error(`A ${origin} chat cannot be attached to a case; its messages are not verified as the owner's.`);
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

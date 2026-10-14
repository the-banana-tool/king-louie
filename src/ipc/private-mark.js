// src/ipc/private-mark.js
// chat:markPrivate and case:markPrivate (local inference spec 2026-10-13
// §8.1, §8.2, §8.7, §13.2; R-LI-10, R-LI-23). The owner's press, in two
// steps: without `confirm: true` the reply is the confirmation's facts
// (src/models/private-facts.js) and nothing is marked; with it, the chat or
// the case is marked, one way. Only an event the host marked as the local
// desktop's (the app's own window, or a paired desktop through the bridge
// dispatcher) is accepted; a tool, a management tool, MCP or a channel never
// reaches these. A request to clear a mark is PRIVATE_ONE_WAY.
//
// Order on confirm: a bridge chat is refused (PRIVATE_BRIDGE_CHAT: its text
// passes through the bridge's servers, and its voice reply may go to
// ElevenLabs), then a chat with a turn running (PRIVATE_CHAT_BUSY), then the
// mark: a case chat marks its case and every chat of it.
const { isLocalDesktopEvent } = require('../core/origin');
const { bridgeOriginFor } = require('../history/bridge-origin');
const { egressPolicy } = require('../models/egress');
const { privateFacts } = require('../models/private-facts');
const { createLogger } = require('../logging');

const log = createLogger('ipc/private-mark');

const refusal = (code, error) => ({ ok: false, code, error });
const NOT_WINDOW = () => refusal('NOT_LOCAL_WINDOW', 'A chat or a case is made private only from the King Louie window.');
const ONE_WAY = () => refusal('PRIVATE_ONE_WAY', 'A private mark cannot be removed. Start a new chat instead.');
const BRIDGE = () => refusal('PRIVATE_BRIDGE_CHAT', 'A Telegram or Discord chat cannot be made private: its messages pass through that service.');
const BUSY = () => refusal('PRIVATE_CHAT_BUSY', 'A reply is still running in this chat. Make it private when it has finished.');

// The checks every call makes, before anything is read. → a refusal or null.
function precheck(event, payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'private') && payload.private !== true) return ONE_WAY();
  if (!isLocalDesktopEvent(event)) return NOT_WINDOW();
  return null;
}

function createPrivateMark(context = {}) {
  const store = () => {
    const s = typeof context.getHistoryStore === 'function' ? context.getHistoryStore() : null;
    if (!s) throw new Error('Chat history is not available in this host.');
    return s;
  };
  const runtime = () => (typeof context.getCaseRuntime === 'function' ? context.getCaseRuntime() : null);
  const running = (chatId) => typeof context.isChatRunning === 'function' && context.isChatRunning(chatId) === true;
  const settings = () => (typeof context.getSettings === 'function' ? context.getSettings() || {} : {});
  const embedderStatus = () => {
    try {
      const host = typeof context.getEmbedderHost === 'function' ? context.getEmbedderHost() : null;
      return host && typeof host.status === 'function' ? host.status() : null;
    } catch {
      return null;
    }
  };
  // The snapshot as it would be under the mark: what the confirmation says
  // will be refused or skipped.
  const trialModels = ({ chatId = null, caseId = null }) => {
    if (typeof context.snapshotModels !== 'function') return null;
    const egress = egressPolicy({ reason: caseId ? 'private-case' : 'private-chat', chatId: chatId || null, caseId: caseId || null });
    try {
      return context.snapshotModels({ chatId, caseId, egress });
    } catch (err) {
      log.warn(`The models under the mark could not be read: ${err.message}`);
      return null;
    }
  };
  const facts = ({ chatId = null, caseId = null }) => privateFacts({
    store: store(),
    chatId,
    caseId,
    turnModels: trialModels({ chatId, caseId }),
    voiceSettings: typeof context.getVoiceSettings === 'function' ? context.getVoiceSettings() : (settings().voice || null),
    embedderStatus: embedderStatus(),
    bridgeOriginFor
  });
  const caseChats = (caseId) => store().chatRefs().filter((r) => r && r.caseId === caseId);
  const notify = (event, chatId) => {
    const sender = event && event.sender;
    if (sender && typeof sender.send === 'function' && !(typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
      sender.send('chat:updated', { chatId });
    }
  };

  async function markChat(event, payload = {}) {
    const refused = precheck(event, payload);
    if (refused) return refused;
    const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
    const chat = chatId && typeof context.getChat === 'function' ? context.getChat(chatId, { messages: false }) : null;
    if (!chat) return refusal('NOT_FOUND', 'Chat not found.');
    const caseId = chat.caseId || null;
    if (payload.confirm !== true) return { ok: true, confirm: false, untrustedText: true, facts: facts({ chatId, caseId }) };
    if (bridgeOriginFor(chat)) return BRIDGE();
    const chats = caseId ? caseChats(caseId) : [];
    const caseTurn = caseId && runtime() && typeof runtime().runningTurn === 'function' ? runtime().runningTurn(caseId) : null;
    if (running(chatId) || chats.some((r) => running(r.id)) || caseTurn) return BUSY();
    let marked;
    if (caseId) {
      // R-LI-23: one mark, on the case; its chats follow.
      const rt = runtime();
      if (!rt) throw new Error('Cases are not available in this host.');
      const before = rt.isPrivate(caseId);
      await rt.markPrivate(caseId);
      if (store().isPrivate(chatId) !== true) store().markPrivate(chatId);
      marked = !before;
      for (const r of caseChats(caseId)) notify(event, r.id);
    } else {
      marked = store().markPrivate(chatId).marked === true;
      notify(event, chatId);
    }
    log.info(`chat ${chatId} is private${caseId ? ` with case ${caseId}` : ''}`);
    return { ok: true, marked, chat: context.getChat(chatId, { messages: false }) };
  }

  async function markCase(event, payload = {}) {
    const refused = precheck(event, payload);
    if (refused) return refused;
    const rt = runtime();
    if (!rt) throw new Error('Cases are not available in this host.');
    const caseId = typeof payload.caseId === 'string' ? payload.caseId : '';
    const meta = rt.getCase(caseId);
    if (payload.confirm !== true) return { ok: true, confirm: false, untrustedText: true, facts: facts({ caseId: meta.id }) };
    const chats = caseChats(meta.id);
    if (chats.some((r) => bridgeOriginFor(r))) return BRIDGE();
    if ((typeof rt.runningTurn === 'function' && rt.runningTurn(meta.id)) || chats.some((r) => running(r.id))) return BUSY();
    const before = rt.isPrivate(meta.id);
    await rt.markPrivate(meta.id);
    for (const r of chats) {
      if (store().isPrivate(r.id) !== true) store().markPrivate(r.id);
      notify(event, r.id);
    }
    log.info(`case ${meta.id} is private`);
    return { ok: true, marked: !before, caseId: meta.id };
  }

  return { markChat, markCase };
}

module.exports = { createPrivateMark };

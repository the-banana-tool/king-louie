// src/cases/case-nudge.js
// The case nudge (recall spec §9, stage H4; owner ruling R-H4-5): a chat
// with no case that has grown long is offered a case, once, by a status
// message with a button. Nothing is said to the model: the row is a
// `status` message, which the tail never holds and the chunker never
// indexes, and no prompt text is added anywhere.
//
// The offer is made only when the chat could be attached (the checks
// case:attach and case:create make, CHAT_BUSY apart). The chat is marked
// (`caseNudgedAt`) whether or not it is offered, so the check runs once.
const { attachBlock: defaultAttachBlock, recalledOtherChats: defaultRecalledOtherChats } = require('./chat-attach');

const NUDGE_TEXT = 'This chat is getting long. If it is about a task with decisions worth keeping, you can turn it into a case.';
const NUDGE_ACTION = 'convertToCase';

const isCount = (v) => Number.isInteger(v) && v >= 0;

function nudgeDue({ chat, userMessageCount, threshold } = {}) {
  if (!chat || typeof chat !== 'object' || chat.caseId || chat.caseNudgedAt) return false;
  if (!isCount(threshold) || threshold === 0 || !isCount(userMessageCount)) return false;
  return userMessageCount >= threshold;
}

// Whether a chat with these messages could be given a case. `bridgeOriginFor`
// is passed in (src/history/bridge-origin.js loads the channel bridges);
// without it, or when a check throws, there is no offer.
function canOfferCase({
  chat, messages, bridgeOriginFor, attachBlock = defaultAttachBlock, recalledOtherChats = defaultRecalledOtherChats
} = {}) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(messages)) return false;
  if (typeof bridgeOriginFor !== 'function' || typeof attachBlock !== 'function' || typeof recalledOtherChats !== 'function') return false;
  try {
    if (chat.caseId) return false;
    if (bridgeOriginFor(chat)) return false;
    if (chat.source || chat.importedFromCase === true) return false;
    if (recalledOtherChats(messages, chat.id)) return false;
    if (attachBlock(messages, null)) return false;
    return true;
  } catch {
    return false;
  }
}

// The send path's step after a finished reply. Returns the chat with the
// status row when one was appended, else null. Never throws: a failure is
// logged and the turn stands.
function offerCaseNudge({
  chatId, store, threshold, getChat, updateChat, appendMessageToChat, bridgeOriginFor,
  now = () => new Date().toISOString(), log = null
} = {}) {
  const warn = (step, err) => {
    if (log && typeof log.warn === 'function') log.warn(`Case nudge skipped (${step}): ${err && err.message ? err.message : err}`);
  };
  if (!store || typeof store.userMessageCount !== 'function') return null;

  let step = 'count';
  try {
    // A function is read here, so a settings read that fails is logged too.
    const after = typeof threshold === 'function' ? threshold() : threshold;
    if (!isCount(after) || after === 0) return null;
    const chat = getChat(chatId, { messages: false });
    if (!nudgeDue({ chat, userMessageCount: store.userMessageCount(chatId), threshold: after })) return null;

    step = 'mark';
    if (!updateChat(chatId, { caseNudgedAt: now() }, { messages: false })) return null;

    step = 'check';
    const full = getChat(chatId, { messages: true });
    if (!full || !canOfferCase({ chat: full, messages: full.messages, bridgeOriginFor })) return null;

    step = 'append';
    return appendMessageToChat(chatId, 'status', NUDGE_TEXT, { meta: { action: NUDGE_ACTION } }) || null;
  } catch (err) {
    warn(step, err);
    return null;
  }
}

module.exports = { NUDGE_TEXT, NUDGE_ACTION, nudgeDue, canOfferCase, offerCaseNudge };

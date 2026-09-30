// src/cases/question-chat.js
// A case's question arrives as a message in the case's chat (management
// surfaces spec §3.4). The message is an ordinary assistant row: its text is
// a plain rendering (the model sees it in the tail, recall can find it) and
// its `question` metadata names the record. The renderer draws the card
// from the question store, never from the message.
const { answerClass } = require('./mcp-tool-definitions');

const PRESSED_NOTE = 'Answer with the buttons on this question, or on your phone.';
const SPOKEN_NOTE = 'Reply below.';

const activityOf = (chat) => {
  const t = Date.parse(chat?.lastMessageAt ?? chat?.updatedAt ?? '');
  return Number.isFinite(t) ? t : 0;
};

// The case's most recently active chat: newest last message, falling back
// to updatedAt for a chat with no messages. Null when the case has none.
function pickCaseChat(chats, caseId) {
  let best = null;
  for (const chat of chats || []) {
    if (!chat || !caseId || chat.caseId !== caseId) continue;
    if (!best || activityOf(chat) > activityOf(best)) best = chat;
  }
  return best;
}

function chatHasQuestion(chats, chatId, questionId) {
  return chats.getMessages(chatId).some((m) => m?.question?.questionId === questionId);
}

function questionMessageText(meta, rec) {
  const label = rec.kind === 'briefing' ? 'Briefing' : (rec.kind === 'approval' ? 'Approval' : 'Question');
  const lines = [`${meta.title}: ${label} ${rec.id}`, '', rec.text];
  const options = Array.isArray(rec.options) ? rec.options : [];
  if (options.length) {
    lines.push('');
    options.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
  }
  lines.push('', answerClass(rec) === 'pressed' ? PRESSED_NOTE : SPOKEN_NOTE);
  return lines.join('\n');
}

// Appends the question's message to the case's newest chat, creating a
// chat (the case's title, its caseId) when the case has none. `chats` is
// the core's chat facade plus createId. Throws on a store failure; the
// caller logs it, since delivery must never fail question creation.
//
// `onlyIfMissing` (a duplicate of an open question, asked again): posts
// only when the chosen chat holds no message for the record, say because a
// resend or an edit truncated the chat past it; returns null otherwise.
function postQuestionToChat({ chats, meta, rec, now = () => new Date(), onlyIfMissing = false }) {
  let chat = pickCaseChat(chats.listChats({ messages: false }), meta.id);
  if (onlyIfMissing && chat && chatHasQuestion(chats, chat.id, rec.id)) return null;
  let created = false;
  if (!chat) {
    const at = now().toISOString();
    chat = chats.createChat({ id: chats.createId(), title: meta.title, caseId: meta.id, createdAt: at, updatedAt: at, messages: [] });
    if (!chat) throw new Error('the chat could not be created');
    created = true;
  }
  const appended = chats.appendMessageToChat(chat.id, 'assistant', questionMessageText(meta, rec), {
    question: { caseId: meta.id, questionId: rec.id }
  }, { returnChat: false });
  if (!appended) throw new Error(`chat ${chat.id} is gone`);
  return { chatId: chat.id, created, message: { ...appended.message, seq: appended.seq } };
}

module.exports = { pickCaseChat, chatHasQuestion, questionMessageText, postQuestionToChat };

// src/history/bridge-origin.js
// Whether a chat is a Telegram or Discord bridge chat (F5). Such a chat can
// carry a remote sender's messages stamped sender: 'user', so it is never
// given a case (case-handlers.js) and never reads another chat (the history
// scope policy, stage H4).
//
// F5 re-review: a chat from before the origin tag existed has none, and the
// bridges' chat-id maps are in-memory only, so it is never re-tagged by
// create-core.js's startup migration alone. The title prefix is a second,
// redundant check that needs no tag at all. A chat the owner has since
// renamed no longer matches either check and cannot be caught here.
//
// Takes a chat, a chat's list metadata or a HistoryStore#chatRefs() row:
// only `origin` and `title` are read.
const TelegramBridge = require('../channels/telegram-bridge');
const DiscordChannel = require('../channels/discord-bridge');

const LEGACY_BRIDGE_TITLE_PREFIXES = Object.freeze([TelegramBridge.CHAT_TITLE_PREFIX, DiscordChannel.CHAT_TITLE_PREFIX]);

const bridgeOriginFor = (chat) => {
  if (chat?.origin) return chat.origin;
  if (typeof chat?.title === 'string' && LEGACY_BRIDGE_TITLE_PREFIXES.some((p) => chat.title.startsWith(p))) {
    return chat.title.startsWith(TelegramBridge.CHAT_TITLE_PREFIX) ? 'telegram' : 'discord';
  }
  return null;
};

module.exports = { bridgeOriginFor, LEGACY_BRIDGE_TITLE_PREFIXES };

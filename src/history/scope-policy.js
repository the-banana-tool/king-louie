// src/history/scope-policy.js
// The scope policy the app runs on (recall spec §6.3, stage H4; owner
// rulings R-H4-1, R-H4-2, R-H4-7 of 2026-10-13). resolveScope (scope.js)
// asks it what a chat's stored scope may not do; it reads only the refs of
// HistoryStore#chatRefs() and keeps nothing.
//
//   R-H4-1  A chat with a caseId reads itself only, and is in no other
//           chat's scope, linked or not. A case turn's context feeds that
//           case's ledger and executor payloads, and the outbound gate knows
//           only that case's private facts.
//   R-H4-2  A King Louie export of a case chat (importedFromCase) is kept
//           out of every other chat's scope like a case chat, and (new
//           question N3) reads itself only.
//   R-H4-7  A bridge chat (Telegram, Discord) reads itself only and is left
//           out of 'all'; the owner may link it explicitly, and a chat that
//           links it reads it under 'linked' and under 'all'.
//   R-LI-11 A private chat (local inference spec 2026-10-13 §8.3) is in no
//           chat's scope unless the reader is private too, and an explicit
//           link does not lift that: the reader's next model call could go
//           to a hosted model. A private reader reads an ordinary chat under
//           its stored scope (the text then stays on the owner's hardware).
//           Only a mark that is exactly false is "not private"; a reader is
//           private only by an exact true.
//
// The first rule that matches a chat wins, in that order; the private rule
// is checked after the other three. An imported chat with no case mark is
// an ordinary chat here: it may read and be read.
const PINS = Object.freeze({
  'case-chat': Object.freeze({ scope: 'chat', reason: 'case-chat' }),
  'imported-case-chat': Object.freeze({ scope: 'chat', reason: 'imported-case-chat' }),
  'bridge-chat': Object.freeze({ scope: 'chat', reason: 'bridge-chat' })
});

function createScopePolicy({ bridgeOriginFor } = {}) {
  if (typeof bridgeOriginFor !== 'function') throw new TypeError('createScopePolicy needs bridgeOriginFor.');
  // Which rule a chat falls under, or null. A ref that is not an object is
  // treated as a case chat: nothing reads it and it reads nothing.
  const kindOf = (ref) => {
    if (!ref || typeof ref !== 'object') return 'case-chat';
    if (ref.caseId) return 'case-chat';
    if (ref.importedFromCase) return 'imported-case-chat';
    if (bridgeOriginFor(ref)) return 'bridge-chat';
    return null;
  };
  return Object.freeze({
    pinnedTo(readerRef) {
      const kind = kindOf(readerRef);
      return kind ? PINS[kind] : null;
    },
    canRead(readerRef, sourceRef, { explicit = false } = {}) {
      const kind = kindOf(sourceRef);
      if (kind && !(kind === 'bridge-chat' && explicit === true)) return kind;
      if (sourceRef.private !== false && !(readerRef && typeof readerRef === 'object' && readerRef.private === true)) return 'private-chat';
      return true;
    }
  });
}

module.exports = { createScopePolicy };

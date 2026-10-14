// src/history/scope.js
// Which chats a turn may read (recall spec §6.3, stage H4). One pure function
// over what the store holds now: the chat's stored scope, its links and a
// policy. The ContextBuilder, SearchHistory, ReadHistory and the history IPC
// all ask here, and nothing keeps the answer: a chat deleted, given a case or
// unlinked since the last turn is gone from the next one.
//
// A scope is widened only by what is stored (the owner's own action in the
// app). `requested`, a tool's scope argument, can only narrow it.
const SCOPES = Object.freeze(['chat', 'linked', 'all']);

const isScope = (value) => typeof value === 'string' && SCOPES.includes(value);
const rank = (scope) => (isScope(scope) ? SCOPES.indexOf(scope) : 0);

// The narrower of two scopes; anything that is not a scope counts as 'chat'.
function narrowest(a, b) {
  return SCOPES[Math.min(rank(a), rank(b))];
}

// A policy says what the stored scope may not do:
//   pinnedTo(readerRef) → null, or { scope, reason } capping the chat's scope;
//   canRead(readerRef, sourceRef, { explicit }) → true, or a reason string
//   (refused). explicit is true for a chat the owner linked to the reader
//   (under 'linked' and under 'all' alike: owner ruling of 2026-10-13),
//   false for one that is in scope only because the scope is 'all'.
// The refs are HistoryStore#chatRefs() rows.

// No restriction: unit tests and LongHaul. The app never runs on it.
const OPEN_POLICY = Object.freeze({ pinnedTo: () => null, canRead: () => true });

// Every chat reads itself only, whatever is stored.
const CLOSED_REASON = 'no-policy';
const CLOSED_POLICY = Object.freeze({
  pinnedTo: () => ({ scope: 'chat', reason: CLOSED_REASON }),
  canRead: () => CLOSED_REASON
});

const REFUSED = 'refused';

function alone(chatId) {
  return { stored: 'chat', effective: 'chat', chatIds: [chatId], titles: new Map(), refs: [], pinned: null, excluded: [] };
}

function resolveScope({ store, chatId, requested = null, policy = OPEN_POLICY } = {}) {
  const id = String(chatId || '');
  if (!store || !id || store.linkable !== true || typeof store.chatRef !== 'function') return alone(id);
  const reader = store.chatRef(id);
  if (!reader) return alone(id);
  const rules = policy && typeof policy.pinnedTo === 'function' && typeof policy.canRead === 'function' ? policy : CLOSED_POLICY;

  const stored = store.getHistoryScope(id);
  const pin = rules.pinnedTo(reader);
  // A pin that names no scope pins to the chat.
  const pinned = pin && typeof pin === 'object'
    ? { scope: isScope(pin.scope) ? pin.scope : 'chat', reason: typeof pin.reason === 'string' && pin.reason ? pin.reason : REFUSED }
    : null;
  let effective = stored;
  if (pinned) effective = narrowest(effective, pinned.scope);
  if (isScope(requested)) effective = narrowest(effective, requested);

  const refs = [reader];
  const excluded = [];
  // Only an exact `true` allows.
  const verdict = (source, explicit) => {
    const answer = rules.canRead(reader, source, { explicit });
    if (answer === true) return true;
    return typeof answer === 'string' && answer ? answer : REFUSED;
  };
  if (effective === 'linked') {
    for (const linkedId of store.getLinks(id)) {
      const source = store.chatRef(linkedId);
      if (!source || source.id === id) continue;
      const answer = verdict(source, true);
      if (answer === true) refs.push(source);
      else excluded.push({ chatId: source.id, reason: answer });
    }
  } else if (effective === 'all') {
    // The chat's own links are explicit here too, so a chat a policy allows
    // only when linked (a bridge chat) is read under 'all' once it is linked.
    // A refused chat is left out silently, linked or not.
    const linked = new Set(store.getLinks(id));
    for (const source of store.chatRefs()) {
      if (source.id !== id && verdict(source, linked.has(source.id)) === true) refs.push(source);
    }
  }
  return {
    stored,
    effective,
    chatIds: refs.map((ref) => ref.id),
    titles: new Map(refs.map((ref) => [ref.id, ref.title])),
    refs,
    pinned,
    excluded
  };
}

module.exports = { SCOPES, narrowest, resolveScope, OPEN_POLICY, CLOSED_POLICY };

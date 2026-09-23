// Shared policy helpers for the inbound chat bridges.
//
// Two rules live here because Telegram and Discord must not drift apart:
//   1. An unknown sender is told once — and only once — how to get added, so the
//      refusal is discoverable without giving a stranger a message pump.
//   2. An approval prompt never goes back to the principal that asked for the
//      tool. The approver has to be a surface the owner configured; if there
//      isn't one, the approval is denied rather than self-served.

const DEFAULT_NOTICE_CAPACITY = 256;

// Remembers who has already been told, with a hard cap: a flood of fresh ids
// evicts the oldest entries instead of growing without bound. Eviction can only
// cost a duplicate notice later, never an extra one now.
class NoticeLimiter {
  constructor(capacity = DEFAULT_NOTICE_CAPACITY) {
    this.capacity = Math.max(1, Number(capacity) || DEFAULT_NOTICE_CAPACITY);
    this.seen = new Set();
  }

  get size() {
    return this.seen.size;
  }

  // True the first time a key is seen, false afterwards.
  shouldNotify(key) {
    const id = String(key || '');
    if (!id) return false;
    if (this.seen.has(id)) return false;
    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.values().next().value;
      this.seen.delete(oldest);
    }
    this.seen.add(id);
    return true;
  }

  clear() {
    this.seen.clear();
  }
}

// Whether a slash command names this bot as its target.
//
// Telegram disambiguates commands in a shared room with a `/cmd@botusername`
// suffix, which is the only positive signal a group message carries about
// which of the bots present a command was meant for. Matched case-insensitively
// because Telegram usernames are, and only against a username we actually know:
// before getMe resolves there is nothing to compare, and an unverifiable target
// is not a target. Discord text commands have no equivalent, so its bridge
// passes no text here and relies on a mention or a DM instead.
function commandTargetsBot(text, botUsername) {
  const me = String(botUsername || '').trim();
  if (!me) return false;
  const firstToken = String(text || '').trim().split(/\s+/)[0] || '';
  const suffix = firstToken.match(/^\/[^\s@]+@([A-Za-z0-9_]+)$/);
  return Boolean(suffix) && suffix[1].toLowerCase() === me.toLowerCase();
}

// Whether an inbound message actually addresses the bot, as opposed to merely
// arriving where the bot can see it.
//
// The refusal notice names the sender id and the group id, so it may only go to
// someone who spoke to the bot: in a shared room every other member's ordinary
// chatter would otherwise be answered with their own id published into a room
// the owner does not control. `requireMention` is no help here — it is off by
// default, so on the first run after a deny-by-default upgrade every member of
// the group gets named. A one-to-one chat is addressed to the bot by
// construction.
//
// A *bare* `/command` is not proof either. Group chats routinely carry several
// bots, and `/weather berlin` aimed at one of the others would otherwise have
// King Louie answer with that member's id. Only a command that names this bot
// counts — hence `isTargetedCommand` rather than the old `isCommand`; a caller
// that has not been updated passes `undefined` and so fails closed, which is
// the right way round. When in doubt, stay silent: the refusal is still
// recorded for the owner, only the reply into the room is withheld.
function addressesBot({ isGroup, wasMentioned, isTargetedCommand, isReplyToBot } = {}) {
  if (!isGroup) return true;
  return Boolean(wasMentioned || isTargetedCommand || isReplyToBot);
}

// Decides where an approval prompt may be sent.
// Returns { target } when there is a legitimate approver, or { reason } when
// the caller must deny.
function resolveApprovalTarget({ ownerTarget, originTarget } = {}) {
  const owner = String(ownerTarget == null ? '' : ownerTarget).trim();
  const origin = String(originTarget == null ? '' : originTarget).trim();

  if (!owner) {
    return { target: null, reason: 'no owner approval surface is configured' };
  }
  if (owner === origin) {
    return { target: null, reason: 'the requesting chat is the only approval surface' };
  }
  return { target: owner, reason: null };
}

// Decides whether a button press may resolve a pending approval.
//
// `resolveApprovalTarget` above answers "where may the prompt go"; it says
// nothing about *who* pressed. Comparing destinations alone is not an actor
// check: the owner's approval surface is usually a chat or channel with more
// than one member — and the requester may well be one of them — so a requester
// who can see the owner's room could press their own Approve button and
// self-serve the tool the approval gate exists to stop.
//
// Three things must hold, and each fails closed on missing information:
//   - the press names an actor (Telegram `callback_query.from`, Discord
//     `interaction.user`); an anonymous press proves nothing;
//   - the pending approval remembers which principal asked, and the actor is
//     not that principal;
//   - the actor is a principal the owner allowlisted *by user id*. Group
//     membership is not enough: `AllowlistManager.isAllowed` passes anyone in
//     an allowlisted group, which would make every member of the owner's room
//     an approver.
function judgeApprovalPress({ actorId, requesterId, actorAllowed } = {}) {
  const actor = String(actorId == null ? '' : actorId).trim();
  const requester = String(requesterId == null ? '' : requesterId).trim();

  if (!actor) return { ok: false, reason: 'the press carried no user id' };
  if (!requester) return { ok: false, reason: 'the requesting principal was not recorded' };
  if (actor === requester) return { ok: false, reason: `user ${actor} may not approve their own request` };
  if (!actorAllowed) return { ok: false, reason: `user ${actor} is not allowlisted on this channel` };
  return { ok: true, reason: null };
}

module.exports = {
  NoticeLimiter,
  resolveApprovalTarget,
  judgeApprovalPress,
  addressesBot,
  commandTargetsBot,
  DEFAULT_NOTICE_CAPACITY
};

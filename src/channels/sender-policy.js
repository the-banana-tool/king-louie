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

module.exports = { NoticeLimiter, resolveApprovalTarget, DEFAULT_NOTICE_CAPACITY };

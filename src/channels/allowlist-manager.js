// How many distinct refused senders are remembered for the owner's settings
// pane. Small on purpose: this is "who just knocked", not an audit log.
const DEFAULT_REFUSAL_CAPACITY = 20;

class AllowlistManager {
  constructor(store, options = {}) {
    this.store = store;
    this.storeKey = options.storeKey || 'channelAllowlists';
    this.refusalCapacity = Math.max(1, Number(options.refusalCapacity) || DEFAULT_REFUSAL_CAPACITY);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    // Recent refusals live in memory and are deliberately never written to
    // the store: a stranger messaging in a loop must not be able to grow a
    // file on disk, and the only reader (the owner's channel settings pane)
    // runs in the same process as the bridge that recorded them. Headless
    // operators read the same ids out of the service log instead.
    this.recentRefusals = new Map();
    // Ordering tiebreak: Date.now() has millisecond resolution, so a burst of
    // refusals all carry the same timestamp. This keeps "newest first" exact.
    this.refusalSeq = 0;
  }

  _refusalKey(channel, senderId, groupId) {
    return `${channel}\u0000${groupId == null ? '' : String(groupId)}\u0000${senderId == null ? '' : String(senderId)}`;
  }

  // Remembers that a sender was turned away, so the owner can allowlist them
  // without going hunting for the id. Bounded: a flood of fresh ids evicts
  // the oldest entries instead of growing without limit.
  recordRefusal(channel, senderId, groupId = null) {
    const sender = String(senderId == null ? '' : senderId).trim();
    const group = groupId == null || String(groupId).trim() === '' ? null : String(groupId).trim();
    if (!sender && !group) return null;

    const key = this._refusalKey(channel, sender, group);
    const at = this.now();
    this.refusalSeq += 1;
    const existing = this.recentRefusals.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = at;
      existing.seq = this.refusalSeq;
      return existing;
    }
    if (this.recentRefusals.size >= this.refusalCapacity) {
      const oldest = this.recentRefusals.keys().next().value;
      this.recentRefusals.delete(oldest);
    }
    const entry = { channel, senderId: sender || null, groupId: group, count: 1, firstSeen: at, lastSeen: at, seq: this.refusalSeq };
    this.recentRefusals.set(key, entry);
    return entry;
  }

  // Newest first, so the sender who just knocked is at the top.
  listRecentRefusals(channel) {
    const out = [];
    for (const entry of this.recentRefusals.values()) {
      if (entry.channel === channel) out.push({ ...entry });
    }
    return out.sort((a, b) => (b.lastSeen - a.lastSeen) || (b.seq - a.seq));
  }

  // Called after an id is allowlisted so the "who just knocked" prompt clears.
  forgetRefusals(channel, { senderId = null, groupId = null } = {}) {
    const sender = senderId == null ? null : String(senderId).trim();
    const group = groupId == null ? null : String(groupId).trim();
    for (const [key, entry] of this.recentRefusals) {
      if (entry.channel !== channel) continue;
      if (sender && entry.senderId === sender) { this.recentRefusals.delete(key); continue; }
      if (group && entry.groupId === group) this.recentRefusals.delete(key);
    }
  }

  getPolicy(channel) {
    const policies = this.store?.get?.(this.storeKey, {}) || {};
    const current = policies[channel] || {};
    return {
      // A channel nobody has configured denies. Anyone who finds the bot's
      // handle would otherwise be able to drive the agent.
      default: current.default === 'allow' ? 'allow' : 'deny',
      users: Array.isArray(current.users) ? current.users.map((id) => String(id)) : [],
      groups: Array.isArray(current.groups) ? current.groups.map((id) => String(id)) : []
    };
  }

  setPolicy(channel, policy = {}) {
    const currentAll = this.store?.get?.(this.storeKey, {}) || {};
    const next = {
      ...currentAll,
      [channel]: {
        // Only an explicit 'allow' opens the channel up; anything else — including
        // a policy object that just carries a user list — stays closed.
        default: policy.default === 'allow' ? 'allow' : 'deny',
        users: Array.isArray(policy.users) ? Array.from(new Set(policy.users.map((id) => String(id)))) : [],
        groups: Array.isArray(policy.groups) ? Array.from(new Set(policy.groups.map((id) => String(id)))) : []
      }
    };
    this.store?.set?.(this.storeKey, next);
    return this.getPolicy(channel);
  }

  isAllowed(channel, senderId, groupId = null) {
    const policy = this.getPolicy(channel);
    if (policy.default === 'allow') {
      return true;
    }

    const sender = String(senderId || '');
    const group = groupId == null ? '' : String(groupId);
    if (sender && policy.users.includes(sender)) {
      return true;
    }
    if (group && policy.groups.includes(group)) {
      return true;
    }
    this.recordRefusal(channel, sender, group || null);
    return false;
  }

  addUser(channel, userId) {
    const policy = this.getPolicy(channel);
    const user = String(userId || '').trim();
    if (!user) return policy;
    if (!policy.users.includes(user)) {
      policy.users.push(user);
      this.setPolicy(channel, policy);
    }
    this.forgetRefusals(channel, { senderId: user });
    return this.getPolicy(channel);
  }

  removeUser(channel, userId) {
    const policy = this.getPolicy(channel);
    const user = String(userId || '').trim();
    policy.users = policy.users.filter((id) => id !== user);
    return this.setPolicy(channel, policy);
  }

  addGroup(channel, groupId) {
    const policy = this.getPolicy(channel);
    const group = String(groupId || '').trim();
    if (!group) return policy;
    if (!policy.groups.includes(group)) {
      policy.groups.push(group);
      this.setPolicy(channel, policy);
    }
    this.forgetRefusals(channel, { groupId: group });
    return this.getPolicy(channel);
  }

  removeGroup(channel, groupId) {
    const policy = this.getPolicy(channel);
    const group = String(groupId || '').trim();
    policy.groups = policy.groups.filter((id) => id !== group);
    return this.setPolicy(channel, policy);
  }
}

module.exports = AllowlistManager;
module.exports.DEFAULT_REFUSAL_CAPACITY = DEFAULT_REFUSAL_CAPACITY;

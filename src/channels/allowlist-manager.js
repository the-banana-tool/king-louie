class AllowlistManager {
  constructor(store, options = {}) {
    this.store = store;
    this.storeKey = options.storeKey || 'channelAllowlists';
  }

  getPolicy(channel) {
    const policies = this.store?.get?.(this.storeKey, {}) || {};
    const current = policies[channel] || {};
    return {
      default: current.default === 'deny' ? 'deny' : 'allow',
      users: Array.isArray(current.users) ? current.users.map((id) => String(id)) : [],
      groups: Array.isArray(current.groups) ? current.groups.map((id) => String(id)) : []
    };
  }

  setPolicy(channel, policy = {}) {
    const currentAll = this.store?.get?.(this.storeKey, {}) || {};
    const next = {
      ...currentAll,
      [channel]: {
        default: policy.default === 'deny' ? 'deny' : 'allow',
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

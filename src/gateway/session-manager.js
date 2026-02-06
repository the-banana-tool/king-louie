class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.bindings = [];
  }

  buildSessionKey(agentId, channel = 'desktop', peer = null) {
    if (!peer) {
      return `agent:${agentId}:main`;
    }

    return `agent:${agentId}:${channel}:${peer}`;
  }

  getOrCreateSession(sessionKey, agentId, metadata = {}) {
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, {
        key: sessionKey,
        agentId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: { ...metadata }
      });
    }

    const session = this.sessions.get(sessionKey);
    if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
      session.metadata = {
        ...(session.metadata || {}),
        ...metadata
      };
      session.updatedAt = Date.now();
    }

    return session;
  }

  addMessage(sessionKey, message) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${sessionKey}`);
    }

    session.messages.push({
      ...message,
      timestamp: Date.now()
    });
    session.updatedAt = Date.now();
  }

  getHistory(sessionKey, limit = 50) {
    const session = this.sessions.get(sessionKey);
    if (!session) return [];

    return session.messages.slice(-Math.max(1, limit));
  }

  clearSession(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session) return false;

    session.messages = [];
    session.updatedAt = Date.now();
    return true;
  }

  removeSession(sessionKey) {
    return this.sessions.delete(sessionKey);
  }

  listSessions(filter = {}) {
    const sessions = Array.from(this.sessions.values());

    if (filter.agentId) {
      return sessions.filter((session) => session.agentId === filter.agentId);
    }

    return sessions;
  }

  resolveSession(labelOrKey, agentId = null) {
    if (!labelOrKey) return null;

    if (this.sessions.has(labelOrKey)) {
      const session = this.sessions.get(labelOrKey);
      if (!agentId || session.agentId === agentId) return session;
      return null;
    }

    for (const session of this.sessions.values()) {
      if (session?.metadata?.label === labelOrKey) {
        if (!agentId || session.agentId === agentId) {
          return session;
        }
      }
    }

    return null;
  }

  addBinding(binding = {}) {
    this.bindings.push({ ...binding });
  }

  resolveAgentRoute(channel, accountId, peerId) {
    const candidates = this.bindings.filter((binding) => {
      const match = binding.match || {};
      const channelOk = !match.channel || match.channel === channel;
      const accountOk = !match.accountId || match.accountId === accountId;

      const peer = match.peer || null;
      const peerOk = !peer || !peer.id || peer.id === peerId;
      return channelOk && accountOk && peerOk;
    });

    if (!candidates.length) return 'main';

    candidates.sort((a, b) => {
      const aScore = Number(Boolean(a?.match?.peer?.id)) + Number(Boolean(a?.match?.accountId));
      const bScore = Number(Boolean(b?.match?.peer?.id)) + Number(Boolean(b?.match?.accountId));
      return bScore - aScore;
    });

    return candidates[0].agentId || 'main';
  }
}

module.exports = SessionManager;
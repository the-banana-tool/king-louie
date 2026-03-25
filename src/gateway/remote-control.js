class RemoteControl {
  constructor(gatewayServer, sessionManager, agentExecutor, options = {}) {
    this.gateway = gatewayServer;
    this.sessionManager = sessionManager;
    this.agentExecutor = agentExecutor;
    this.getAgent =
      typeof options.getAgent === 'function'
        ? options.getAgent
        : () => null;

    this.registerMethods();
  }

  registerMethods() {
    this.gateway.registerMethod('agent.execute', this.executeAgent.bind(this));
    this.gateway.registerMethod('agent.wait', this.waitForAgent.bind(this));
    this.gateway.registerMethod('agent.abort', this.abortAgent.bind(this));

    this.gateway.registerMethod('sessions.list', this.listSessions.bind(this));
    this.gateway.registerMethod('sessions.resolve', this.resolveSession.bind(this));
    this.gateway.registerMethod('chat.history', this.getChatHistory.bind(this));

    this.gateway.registerMethod('system.health', this.getHealth.bind(this));
    this.gateway.registerMethod('system.status', this.getStatus.bind(this));
  }

  async executeAgent(params = {}) {
    const {
      message,
      sessionKey,
      agentId = 'main',
      channel = 'desktop'
    } = params;

    if (!message || typeof message !== 'string') {
      throw new Error('`message` is required');
    }

    const resolvedSessionKey = sessionKey || this.sessionManager.buildSessionKey(agentId, channel);
    const session = this.sessionManager.getOrCreateSession(resolvedSessionKey, agentId);

    this.sessionManager.addMessage(session.key, {
      role: 'user',
      content: message,
      source: 'remote-control'
    });

    const agent = this.getAgent(session.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }

    const result = await this.agentExecutor.execute(agent, message, {
      sessionKey: session.key
    });

    this.sessionManager.addMessage(session.key, {
      role: 'assistant',
      content: result.content || '',
      source: 'remote-control'
    });

    return {
      status: 'completed',
      sessionKey: session.key,
      reply: result.content || '',
      result
    };
  }

  async waitForAgent(params = {}) {
    return {
      status: 'completed',
      runId: params.runId || null
    };
  }

  async abortAgent(params = {}) {
    return {
      status: 'aborted',
      runId: params.runId || null
    };
  }

  async listSessions(params = {}) {
    return {
      sessions: this.sessionManager.listSessions(params)
    };
  }

  async resolveSession(params = {}) {
    const session = this.sessionManager.resolveSession(
      params.sessionKey || params.label,
      params.agentId
    );

    if (!session) {
      throw new Error('Session not found');
    }

    return {
      key: session.key,
      agentId: session.agentId
    };
  }

  async getChatHistory(params = {}) {
    const messages = this.sessionManager.getHistory(params.sessionKey, params.limit || 50);
    return { messages };
  }

  async getHealth() {
    return {
      status: 'healthy',
      timestamp: Date.now(),
      sessions: this.sessionManager.listSessions().length
    };
  }

  async getStatus() {
    return {
      gateway: {
        connections: this.gateway.connections.size,
        host: this.gateway.host,
        port: this.gateway.port
      },
      sessions: {
        total: this.sessionManager.listSessions().length
      }
    };
  }
}

module.exports = RemoteControl;
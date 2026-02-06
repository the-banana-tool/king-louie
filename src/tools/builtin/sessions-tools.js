const { Tool } = require('../tool-schema');

class SessionsListTool extends Tool {
  constructor(sessionManager) {
    super({
      name: 'sessions_list',
      description: 'List all active agent sessions',
      parameters: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Optional agent filter'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of sessions to return',
            minimum: 1,
            maximum: 500
          }
        }
      },
      requiresApproval: false,
      execute: async () => ({ sessions: [] })
    });

    this.sessionManager = sessionManager;
    this.execute = this.run.bind(this);
  }

  async run(params = {}) {
    const limit = Number(params.limit || 50);
    const sessions = this.sessionManager.listSessions(params);

    return {
      sessions: sessions.slice(0, limit).map((session) => ({
        key: session.key,
        agentId: session.agentId,
        label: session?.metadata?.label,
        messageCount: session.messages.length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }))
    };
  }
}

class SessionsHistoryTool extends Tool {
  constructor(sessionManager) {
    super({
      name: 'sessions_history',
      description: 'Get conversation history for a session',
      parameters: {
        type: 'object',
        properties: {
          sessionKey: {
            type: 'string',
            description: 'Session key or label'
          },
          limit: {
            type: 'number',
            description: 'Maximum message count',
            minimum: 1,
            maximum: 1000
          }
        },
        required: ['sessionKey']
      },
      requiresApproval: false,
      execute: async () => ({ messages: [] })
    });

    this.sessionManager = sessionManager;
    this.execute = this.run.bind(this);
  }

  async run(params = {}) {
    const session = this.sessionManager.resolveSession(params.sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionKey}`);
    }

    const messages = this.sessionManager.getHistory(session.key, params.limit || 50);
    return {
      sessionKey: session.key,
      agentId: session.agentId,
      messages
    };
  }
}

class SessionsSpawnTool extends Tool {
  constructor(sessionManager) {
    super({
      name: 'sessions_spawn',
      description: 'Spawn a new session for an agent',
      parameters: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent ID for the session'
          },
          label: {
            type: 'string',
            description: 'Optional label for session lookup'
          },
          message: {
            type: 'string',
            description: 'Initial message'
          }
        },
        required: ['agentId', 'message']
      },
      requiresApproval: false,
      execute: async () => ({ status: 'spawned' })
    });

    this.sessionManager = sessionManager;
    this.execute = this.run.bind(this);
  }

  async run(params = {}, context = {}) {
    const peer = `spawn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const sessionKey = this.sessionManager.buildSessionKey(params.agentId, 'spawned', peer);
    const session = this.sessionManager.getOrCreateSession(sessionKey, params.agentId, {
      label: params.label,
      spawnedBy: context.sessionKey || 'system'
    });

    this.sessionManager.addMessage(session.key, {
      role: 'user',
      content: params.message,
      from: context.sessionKey || 'system'
    });

    return {
      status: 'spawned',
      sessionKey: session.key,
      agentId: params.agentId,
      label: params.label || null
    };
  }
}

module.exports = {
  SessionsListTool,
  SessionsHistoryTool,
  SessionsSpawnTool
};
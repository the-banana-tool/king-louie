const { Tool } = require('../tool-schema');

class MessageTool extends Tool {
  constructor(gatewayServer, sessionManager) {
    super({
      name: 'message',
      description: 'Send messages to agent sessions (send, reply, broadcast).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['send', 'reply', 'broadcast'],
            description: 'Message action'
          },
          target: {
            type: 'string',
            description: 'Target session key or label'
          },
          message: {
            type: 'string',
            description: 'Message content'
          },
          timeoutSeconds: {
            type: 'number',
            description: 'Optional timeout for responses',
            minimum: 0,
            maximum: 300
          },
          media: {
            type: 'string',
            description: 'Optional media URL/path'
          },
          metadata: {
            type: 'object',
            description: 'Optional message metadata'
          }
        },
        required: ['action', 'message']
      },
      requiresApproval: false,
      execute: async () => ({ status: 'ok' })
    });

    this.gateway = gatewayServer;
    this.sessionManager = sessionManager;
    this.execute = this.run.bind(this);
  }

  async run(params = {}, context = {}) {
    const { action, target, message, timeoutSeconds = 30, media, metadata } = params;

    switch (action) {
      case 'send':
        return this.handleSend(target, message, timeoutSeconds, media, metadata, context);
      case 'reply':
        return this.handleSend(target, message, 0, media, metadata, context);
      case 'broadcast':
        return this.handleBroadcast(message, media, metadata, context);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async handleSend(target, message, timeoutSeconds, media, metadata, context) {
    const session = this.sessionManager.resolveSession(target) || this.sessionManager.getOrCreateSession(
      String(target || ''),
      'main'
    );

    this.sessionManager.addMessage(session.key, {
      role: 'user',
      content: message,
      from: context.sessionKey || 'unknown',
      media,
      metadata
    });

    const runId = `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.gateway.sendToAgent(session.agentId, session.key, {
      runId,
      message,
      media,
      metadata,
      from: context.sessionKey || 'unknown'
    });

    if (timeoutSeconds > 0) {
      return {
        status: 'accepted',
        runId,
        sessionKey: session.key,
        timeoutSeconds
      };
    }

    return {
      status: 'ok',
      runId,
      sessionKey: session.key
    };
  }

  async handleBroadcast(message, media, metadata, context) {
    this.gateway.broadcast('agent:broadcast', {
      message,
      media,
      metadata,
      from: context.sessionKey || 'unknown',
      timestamp: Date.now()
    });

    return {
      status: 'ok',
      action: 'broadcast'
    };
  }
}

module.exports = MessageTool;
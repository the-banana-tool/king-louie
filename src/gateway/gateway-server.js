const { EventEmitter } = require('events');
const WebSocket = require('ws');

class GatewayServer extends EventEmitter {
  constructor(config = {}) {
    super();
    this.port = config.port || (process.env.KL_TEST_MODE ? 0 : 18789);
    this.host = config.host || '127.0.0.1';
    this.connections = new Map();
    this.messageHandlers = new Map();
    this.nextConnectionId = 0;
    this.wss = null;
  }

  async start() {
    if (this.wss) return;

    this.wss = new WebSocket.Server({
      host: this.host,
      port: this.port
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    await new Promise((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });

    // Update port to the actual bound port (important when using port 0)
    if (this.wss.address()) {
      this.port = this.wss.address().port;
    }
  }

  async stop() {
    if (!this.wss) return;

    for (const ws of this.connections.values()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();

    await new Promise((resolve) => this.wss.close(resolve));
    this.wss = null;
  }

  handleConnection(ws) {
    const connectionId = `conn-${++this.nextConnectionId}`;
    this.connections.set(connectionId, ws);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        await this.routeMessage(connectionId, message);
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: 'error',
            error: error.message
          })
        );
      }
    });

    ws.on('close', () => {
      this.connections.delete(connectionId);
    });
  }

  async routeMessage(connectionId, message) {
    const handler = this.messageHandlers.get(message.method);
    if (!handler) {
      throw new Error(`Unknown method: ${message.method}`);
    }

    const result = await handler(message.params || {}, connectionId);

    const ws = this.connections.get(connectionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'response',
          id: message.id,
          result
        })
      );
    }
  }

  registerMethod(method, handler) {
    this.messageHandlers.set(method, handler);
  }

  async sendToAgent(agentId, sessionKey, message) {
    this.emit('agent:message', {
      agentId,
      sessionKey,
      message
    });
  }

  broadcast(event, data) {
    const message = JSON.stringify({
      type: 'event',
      event,
      data
    });

    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}

module.exports = GatewayServer;
const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');

// Literal loopback addresses only: 'localhost' is resolved by the OS resolver
// (hosts file, DNS) and so is not guaranteed to be loopback.
const LOOPBACK = new Set(['127.0.0.1', '::1']);

class GatewayServer extends EventEmitter {
  constructor(config = {}) {
    super();
    // config.port may legitimately be 0 (bind an ephemeral port), so check
    // for undefined/null explicitly rather than falling back on falsy 0.
    this.port = config.port != null ? config.port : (process.env.KL_TEST_MODE ? 0 : 18789);
    this.host = config.host || '127.0.0.1';
    this.authToken = config.authToken || null;
    this.connections = new Map();
    this.messageHandlers = new Map();
    this.nextConnectionId = 0;
    this.wss = null;
  }

  async start() {
    if (this.wss) return;

    if (!this.authToken) throw new Error('GatewayServer requires an authToken');
    if (!LOOPBACK.has(this.host)) throw new Error('GatewayServer only binds to loopback');
    const expected = crypto.createHash('sha256').update(this.authToken).digest();

    this.wss = new WebSocket.Server({
      host: this.host,
      port: this.port,
      verifyClient: ({ req }, done) => {
        if (req.headers.origin) return done(false, 403, 'Forbidden');
        const header = String(req.headers.authorization || '');
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(presented).digest(), expected);
        return ok ? done(true) : done(false, 401, 'Unauthorized');
      }
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    try {
      await new Promise((resolve, reject) => {
        this.wss.once('listening', resolve);
        this.wss.once('error', reject);
      });
    } catch (err) {
      // A failed bind leaves no listener to stop; forget it so stop() and a
      // later start() don't act on a dead server.
      this.wss = null;
      throw err;
    }

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
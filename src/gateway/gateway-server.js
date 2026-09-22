const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const { publishGatewayToken, revokeGatewayToken } = require('./gateway-token');
const { createLogger } = require('../logging');

const log = createLogger('gateway-server');

// Literal loopback addresses only: 'localhost' is resolved by the OS resolver
// (hosts file, DNS) and so is not guaranteed to be loopback.
const LOOPBACK = new Set(['127.0.0.1', '::1']);

// The gateway protocol carries chat turns, not bulk data. `ws` defaults to
// 100 MB, which is a lot of memory to hand a single frame.
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 64;
// Node's default is 60s; a loopback client has no excuse for taking that long
// to finish its request headers.
const HEADERS_TIMEOUT_MS = 10000;

class GatewayServer extends EventEmitter {
  constructor(config = {}) {
    super();
    // config.port may legitimately be 0 (bind an ephemeral port), so check
    // for undefined/null explicitly rather than falling back on falsy 0.
    this.port = config.port != null ? config.port : (process.env.KL_TEST_MODE ? 0 : 18789);
    this.host = config.host || '127.0.0.1';
    this.authToken = config.authToken || null;
    this.maxConnections = config.maxConnections != null ? config.maxConnections : MAX_CONNECTIONS;
    // Where the plaintext bearer token is published for local clients — written
    // only after the listener binds, removed when it stops.
    this.tokenFileDir = config.tokenFileDir || null;
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
      maxPayload: MAX_PAYLOAD_BYTES,
      verifyClient: ({ req }, done) => {
        // Presence, not truthiness: an empty `Origin:` is still a browser-shaped
        // header and must not slip through the check.
        if ('origin' in req.headers) return done(false, 403, 'Forbidden');
        const header = String(req.headers.authorization || '');
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(presented).digest(), expected);
        if (!ok) return done(false, 401, 'Unauthorized');
        // Capped after the token check, so an unauthenticated peer can neither
        // learn the cap nor flood the log with refusals.
        if (this.connections.size >= this.maxConnections) {
          log.warn(`refused connection: ${this.connections.size} already open`);
          return done(false, 503, 'Too many connections');
        }
        return done(true);
      }
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // `start()`'s once('error', reject) only covers the bind. A later server
    // error must not reach the process as an unhandled 'error' event.
    this.wss.on('error', (err) => {
      log.error(`gateway server error: ${err.message}`);
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

    const httpServer = this.wss._server;
    if (httpServer) {
      httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
      httpServer.on('clientError', (err, socket) => {
        log.debug(`gateway client error before upgrade: ${err.message}`);
        try { socket.destroy(); } catch { /* already gone */ }
      });
    }

    if (this.tokenFileDir) {
      publishGatewayToken(this.tokenFileDir, this.authToken);
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

    if (this.tokenFileDir) {
      revokeGatewayToken(this.tokenFileDir);
    }
  }

  handleConnection(ws) {
    const connectionId = `conn-${++this.nextConnectionId}`;
    this.connections.set(connectionId, ws);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        await this.routeMessage(connectionId, message);
      } catch (error) {
        this.safeSend(ws, {
          type: 'error',
          error: error.message
        });
      }
    });

    // A malformed frame makes `ws` emit 'error' on this socket. Without a
    // listener that is an unhandled 'error' event, which takes the whole
    // process down — the Electron main process, or the service. Drop the one
    // connection instead.
    ws.on('error', (err) => {
      log.warn(`gateway connection ${connectionId} error: ${err.message}`);
      this.connections.delete(connectionId);
      try { ws.terminate(); } catch { /* already gone */ }
    });

    ws.on('close', () => {
      this.connections.delete(connectionId);
    });
  }

  safeSend(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      log.warn(`gateway send failed: ${error.message}`);
      return false;
    }
  }

  async routeMessage(connectionId, message) {
    const handler = this.messageHandlers.get(message.method);
    if (!handler) {
      throw new Error(`Unknown method: ${message.method}`);
    }

    const result = await handler(message.params || {}, connectionId);

    this.safeSend(this.connections.get(connectionId), {
      type: 'response',
      id: message.id,
      result
    });
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
    for (const ws of this.connections.values()) {
      this.safeSend(ws, { type: 'event', event, data });
    }
  }
}

module.exports = GatewayServer;
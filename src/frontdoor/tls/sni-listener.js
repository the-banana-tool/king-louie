// The front door's one public listener (fleet stage 4 §3.2). It reads the
// ClientHello before answering, then wraps the socket in the TLS setup its
// name needs: the web certificate for mcp. (never asking for a client
// certificate), the ACME challenge for acme-tls/1, and the self-signed mesh
// identity for mesh. with a client certificate required and checked against
// the pinned node set before anything reads from the socket. Any other name,
// or none, is closed.
//
// Every connection is tracked from accept to close, in arrival order, with
// its stage: 'hello' (peeking), 'handshake' (TLS in progress) or 'open'
// (handed to a consumer). At the per-IP or overall cap the OLDEST socket
// still before its handshake is evicted instead of refusing the newcomer
// (Ruling T6-cap, after the owner's F7 rule: a valid peer is never locked
// out by sockets someone else holds open). Open sockets are never evicted:
// they finished a handshake, and on mesh. they are pinned nodes. When every
// slot is open, the newcomer is refused.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { peekClientHello } = require('./client-hello');
const { peerCertFingerprint } = require('../../mesh/mesh-transport');

const log = createLogger('frontdoor/sni');

const DEFAULT_LIMITS = Object.freeze({ maxSockets: 1024, perIp: 32, helloBytes: 16384, helloTimeoutMs: 5000, handshakeMs: 10000, firstRequestMs: 60000 });
const ACME_ALPN = 'acme-tls/1';

class SniListener extends EventEmitter {
  constructor({ host, port, domain, mcpContext, meshContext, isPinnedNodeCert, isProbeCert, acmeChallenge, onMcpSocket, onMeshSocket,
    onUnknownNodeKey = () => {}, limits = {} } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.mcpHost = `mcp.${String(domain).toLowerCase()}`;
    this.meshHost = `mesh.${String(domain).toLowerCase()}`;
    this.mcpContext = mcpContext;
    this.meshContext = meshContext;
    this.isPinnedNodeCert = isPinnedNodeCert;
    this.isProbeCert = isProbeCert;
    this.acmeChallenge = acmeChallenge;
    this.onMcpSocket = onMcpSocket;
    this.onMeshSocket = onMeshSocket;
    this.onUnknownNodeKey = onUnknownNodeKey;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.server = null;
    this.sockets = new Map(); // raw socket → { ip, stage, tls }, in arrival order
    this.perIp = new Map();
  }

  async start() {
    const server = net.createServer((socket) => this._accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(new Error(`cannot bind ${this.host}:${this.port}: ${err.message}`));
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    server.on('error', (err) => log.error(`listener error: ${err.message}`));
    this.server = server;
    log.info(`listening on ${this.host}:${this.address().port} for ${this.mcpHost} and ${this.meshHost}`);
  }

  address() {
    return this.server ? this.server.address() : null;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    const closed = new Promise((resolve) => server.close(() => resolve()));
    for (const socket of [...this.sockets.keys()]) this._drop(socket);
    await closed;
  }

  // Counted from here until the raw socket closes or is dropped, whichever
  // comes first; both paths go through _untrack, which counts down once.
  _track(socket, ip) {
    this.sockets.set(socket, { ip, stage: 'hello', tls: null });
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    socket.once('close', () => this._untrack(socket));
  }

  _untrack(socket) {
    const entry = this.sockets.get(socket);
    if (!entry) return;
    this.sockets.delete(socket);
    const left = (this.perIp.get(entry.ip) || 1) - 1;
    if (left > 0) this.perIp.set(entry.ip, left);
    else this.perIp.delete(entry.ip);
  }

  _drop(socket) {
    const entry = this.sockets.get(socket);
    this._untrack(socket);
    if (entry && entry.tls) entry.tls.destroy();
    socket.destroy();
  }

  // Evicts the oldest socket (from `ip`, or from anywhere when null) that
  // has not finished its handshake. False when there is none.
  _evictOldest(ip) {
    for (const [socket, entry] of this.sockets) {
      if (entry.stage === 'open' || (ip !== null && entry.ip !== ip)) continue;
      log.warn(`evicting the oldest connection still before its handshake${ip !== null ? ` from ${ip}` : ''}: too many are open`);
      this._drop(socket);
      return true;
    }
    return false;
  }

  _admit(ip) {
    if ((this.perIp.get(ip) || 0) >= this.limits.perIp && !this._evictOldest(ip)) return false;
    if (this.sockets.size >= this.limits.maxSockets && !this._evictOldest(null)) return false;
    return true;
  }

  async _accept(socket) {
    const ip = socket.remoteAddress || 'unknown';
    // The raw socket has an 'error' listener from its first tick to its
    // last: the peek's own listener comes and goes, and after the TLS wrap
    // the raw socket still exists underneath.
    socket.on('error', (err) => {
      log.debug(`connection from ${ip}: ${err.message}`);
      this._drop(socket);
    });
    if (!this._admit(ip)) {
      log.warn(`refusing a connection from ${ip}: every slot holds an open connection`);
      socket.destroy();
      return;
    }
    this._track(socket, ip);
    let hello;
    try {
      ({ hello } = await peekClientHello(socket, { maxBytes: this.limits.helloBytes, timeoutMs: this.limits.helloTimeoutMs }));
    } catch (err) {
      log.debug(`dropping a connection from ${ip}: ${err.message}`);
      this._drop(socket);
      return;
    }
    // Everything from here through _wrap (which attaches the TLS socket's
    // error handler) runs in the tick the peek resolved in.
    if (socket.destroyed || !this.sockets.has(socket)) {
      this._drop(socket);
      return;
    }
    try {
      this._route(socket, ip, hello);
    } catch (err) {
      log.warn(`dropping a connection from ${ip} for ${hello.serverName}: ${err.message}`);
      this._drop(socket);
    }
  }

  // hello.serverName is already lower-cased LDH (client-hello.js); names
  // match exactly, never by suffix or prefix.
  _route(socket, ip, hello) {
    const name = hello.serverName;
    if (name === this.mcpHost) {
      if (hello.alpn.includes(ACME_ALPN)) {
        const challenge = this.acmeChallenge(name);
        if (challenge) {
          this._wrap(socket, { secureContext: challenge, ALPNProtocols: [ACME_ALPN] }, (s) => s.end());
          return;
        }
      }
      const context = this.mcpContext();
      if (!context) {
        log.debug(`no ${this.mcpHost} certificate yet; closing a connection from ${ip}`);
        this._drop(socket);
        return;
      }
      this._wrap(socket, { secureContext: context, ALPNProtocols: ['http/1.1'], requestCert: false }, (s) => this._handOver(socket, s, this.onMcpSocket));
      return;
    }
    if (name === this.meshHost && this.meshContext) {
      this._wrap(socket, { secureContext: this.meshContext, ALPNProtocols: ['http/1.1'], requestCert: true, rejectUnauthorized: false }, (s) => {
        // 'secure' fires after the handshake and before anything reads.
        const fp = peerCertFingerprint(s);
        if (fp && this._yes(this.isProbeCert, fp)) {
          s.end();
          return;
        }
        if (!fp || !this._yes(this.isPinnedNodeCert, fp)) {
          try {
            this.onUnknownNodeKey({ fingerprint: fp, ip });
          } catch (err) {
            log.warn(`onUnknownNodeKey failed: ${err.message}`);
          }
          this._drop(socket);
          return;
        }
        this._handOver(socket, s, this.onMeshSocket);
      });
      return;
    }
    log.debug(`closing a connection from ${ip} for ${name === null ? 'no name' : `unknown name ${name}`}`);
    this._drop(socket);
  }

  // Only `=== true` admits; a throw is a no.
  _yes(check, fp) {
    try {
      return check(fp) === true;
    } catch (err) {
      log.warn(`certificate check failed: ${err.message}`);
      return false;
    }
  }

  _wrap(socket, options, onSecure) {
    const entry = this.sockets.get(socket);
    const s = new tls.TLSSocket(socket, { isServer: true, ...options });
    entry.tls = s;
    entry.stage = 'handshake';
    s.on('error', (err) => {
      log.debug(`TLS connection from ${entry.ip}: ${err.message}`);
      this._drop(socket);
    });
    const handshake = setTimeout(() => this._drop(socket), this.limits.handshakeMs);
    s.once('secure', () => {
      clearTimeout(handshake);
      if (!this.sockets.has(socket)) return; // evicted or stopped meanwhile
      onSecure(s);
    });
    s.once('close', () => {
      clearTimeout(handshake);
      this._drop(socket);
    });
    // Not socket.resume(): the TLS wrap owns the socket's handle now, reads
    // the unshifted ClientHello from the socket's buffer itself, and starts
    // reading on its own.
  }

  // The consumer's HTTP server reads from here on. A connection that sends
  // nothing within firstRequestMs is closed. Measured with bytesRead, not a
  // 'data' listener: http.Server consumes the TLS handle directly, so
  // 'data' never fires there, and a listener would also switch the stream
  // to flowing before the consumer is attached.
  _handOver(socket, s, consumer) {
    this.sockets.get(socket).stage = 'open';
    const before = s.bytesRead;
    const idle = setTimeout(() => {
      if (s.bytesRead === before) this._drop(socket);
    }, this.limits.firstRequestMs);
    s.once('close', () => clearTimeout(idle));
    consumer(s);
  }
}

module.exports = { SniListener, DEFAULT_LIMITS };

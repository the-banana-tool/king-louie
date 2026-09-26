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
// (handed to a consumer). The caps follow the owner's F7 rule (a valid peer
// is never locked out by sockets someone else holds open; Rulings T6-cap
// and T16-cap):
// - per IP, keyed by the IPv4 address or the IPv6 /64 (a v4-mapped address
//   counts as its IPv4 address), every tracked socket counts;
// - overall, every socket counts against maxSockets except a pinned node
//   handed to the mesh;
// - established mcp. sockets may hold at most maxSockets - handshakeReserve
//   slots, so the reserve always has room for sockets before their
//   handshake and a node can always reach its pin check;
// - at either cap the OLDEST socket still before its handshake is evicted
//   instead of refusing the newcomer. Open sockets are never evicted; when
//   an IP's every slot is open, its newcomer is refused.
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { peekClientHello } = require('./client-hello');
const { peerCertFingerprint } = require('../../mesh/mesh-transport');

const log = createLogger('frontdoor/sni');

const DEFAULT_LIMITS = Object.freeze({ maxSockets: 1024, perIp: 32, helloBytes: 16384, helloTimeoutMs: 5000, handshakeMs: 10000, firstRequestMs: 60000, handshakeReserve: 64 });
const ACME_ALPN = 'acme-tls/1';
// A peer that got end() (probe, ACME) but keeps its side open is dropped.
const END_GRACE_MS = 1000;
// Evictions and refusals are summed and logged at most once a minute.
const CAP_LOG_INTERVAL_MS = 60000;

// The per-IP counting key: an IPv4 address as is (also when v4-mapped), an
// IPv6 address as its /64 — one host usually holds a whole /64.
function ipKey(address) {
  if (typeof address !== 'string' || address === '') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];
  if (!address.includes(':')) return address;
  const bare = address.split('%')[0].toLowerCase();
  const halves = bare.split('::');
  if (halves.length > 2) return bare;
  const groups = (part) => {
    if (!part) return [];
    const out = part.split(':');
    const last = out[out.length - 1];
    if (last.includes('.')) {
      const o = last.split('.').map(Number);
      out.splice(-1, 1, ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return bare;
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

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
    this.reserve = Math.max(0, Math.min(this.limits.handshakeReserve, this.limits.maxSockets - 1));
    this.server = null;
    this._starting = null;
    this.sockets = new Map(); // raw socket → { key, address, stage, tls, counted }, in arrival order
    this.perIp = new Map(); // ipKey → tracked sockets
    this.counted = 0; // sockets counting against maxSockets
    this.openMcp = 0; // established mcp. sockets
    this._capLog = { at: 0, evicted: 0, refused: 0, latest: null };
  }

  async start() {
    if (this.server || this._starting) throw new Error('SniListener already started');
    this._starting = this._listen();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _listen() {
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

  // Waits for a start() in progress, so a stop() that races it still closes
  // what it opened.
  async stop() {
    if (this._starting) await this._starting.catch(() => {});
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    const closed = new Promise((resolve) => server.close(() => resolve()));
    for (const socket of [...this.sockets.keys()]) this._drop(socket);
    this._flushCapLog();
    await closed;
  }

  // Counted from here until the raw socket closes or is dropped, whichever
  // comes first; both paths go through _untrack, which counts down once.
  _track(socket, key, address) {
    this.sockets.set(socket, { key, address, stage: 'hello', tls: null, counted: true, mcp: false });
    this.perIp.set(key, (this.perIp.get(key) || 0) + 1);
    this.counted += 1;
    socket.once('close', () => this._untrack(socket));
  }

  _untrack(socket) {
    const entry = this.sockets.get(socket);
    if (!entry) return;
    this.sockets.delete(socket);
    if (entry.counted) this.counted -= 1;
    if (entry.mcp) this.openMcp -= 1;
    const left = (this.perIp.get(entry.key) || 1) - 1;
    if (left > 0) this.perIp.set(entry.key, left);
    else this.perIp.delete(entry.key);
  }

  _drop(socket) {
    const entry = this.sockets.get(socket);
    this._untrack(socket);
    if (entry && entry.tls) entry.tls.destroy();
    socket.destroy();
  }

  _noteCap(kind, address) {
    const c = this._capLog;
    c[kind] += 1;
    c.latest = address;
    if (Date.now() - c.at >= CAP_LOG_INTERVAL_MS) this._flushCapLog();
  }

  _flushCapLog() {
    const c = this._capLog;
    if (c.evicted === 0 && c.refused === 0) return;
    log.warn(`connection caps: ${c.evicted} evicted before their handshake, ${c.refused} refused (latest from ${c.latest})`);
    this._capLog = { at: Date.now(), evicted: 0, refused: 0, latest: null };
  }

  // Evicts the oldest socket (with `key`, or any when null) that has not
  // finished its handshake. False when there is none.
  _evictOldest(key) {
    for (const [socket, entry] of this.sockets) {
      if (entry.stage === 'open' || (key !== null && entry.key !== key)) continue;
      this._noteCap('evicted', entry.address);
      this._drop(socket);
      return true;
    }
    return false;
  }

  _admit(key) {
    if ((this.perIp.get(key) || 0) >= this.limits.perIp && !this._evictOldest(key)) return false;
    if (this.counted >= this.limits.maxSockets && !this._evictOldest(null)) return false;
    return true;
  }

  async _accept(socket) {
    const address = socket.remoteAddress || 'unknown';
    const key = ipKey(address);
    // The raw socket has an 'error' listener from its first tick to its
    // last: the peek's own listener comes and goes, and after the TLS wrap
    // the raw socket still exists underneath.
    socket.on('error', (err) => {
      log.debug(`connection from ${address}: ${err.message}`);
      this._drop(socket);
    });
    if (!this._admit(key)) {
      this._noteCap('refused', address);
      socket.destroy();
      return;
    }
    this._track(socket, key, address);
    let hello;
    try {
      ({ hello } = await peekClientHello(socket, { maxBytes: this.limits.helloBytes, timeoutMs: this.limits.helloTimeoutMs }));
    } catch (err) {
      log.debug(`dropping a connection from ${address}: ${err.message}`);
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
      this._route(socket, address, hello);
    } catch (err) {
      log.warn(`dropping a connection from ${address} for ${hello.serverName}: ${err.message}`);
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
          this._wrap(socket, { secureContext: challenge, ALPNProtocols: [ACME_ALPN] }, (s) => this._endAndDrop(socket, s));
          return;
        }
      }
      const context = this.mcpContext();
      if (!context) {
        log.debug(`no ${this.mcpHost} certificate yet; closing a connection from ${ip}`);
        this._drop(socket);
        return;
      }
      this._wrap(socket, { secureContext: context, ALPNProtocols: ['http/1.1'], requestCert: false }, (s) => {
        // Established mcp. sockets never take the handshake reserve.
        if (this.openMcp >= this.limits.maxSockets - this.reserve) {
          this._noteCap('refused', ip);
          this._drop(socket);
          return;
        }
        const entry = this.sockets.get(socket);
        entry.mcp = true;
        this.openMcp += 1;
        this._handOver(socket, s, this.onMcpSocket);
      });
      return;
    }
    if (name === this.meshHost && this.meshContext) {
      this._wrap(socket, { secureContext: this.meshContext, ALPNProtocols: ['http/1.1'], requestCert: true, rejectUnauthorized: false }, (s) => {
        // 'secure' fires after the handshake and before anything reads.
        const fp = peerCertFingerprint(s);
        if (fp && this._yes(this.isProbeCert, fp)) {
          this._endAndDrop(socket, s);
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
        // A pinned node no longer counts against maxSockets (it stays in
        // the per-IP count and in tracking, so stop() still closes it).
        const entry = this.sockets.get(socket);
        entry.counted = false;
        this.counted -= 1;
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

  _endAndDrop(socket, s) {
    s.end();
    setTimeout(() => this._drop(socket), END_GRACE_MS).unref();
  }

  _wrap(socket, options, onSecure) {
    const entry = this.sockets.get(socket);
    const s = new tls.TLSSocket(socket, { isServer: true, ...options });
    s.disableRenegotiation();
    entry.tls = s;
    entry.stage = 'handshake';
    s.on('error', (err) => {
      log.debug(`TLS connection from ${entry.address}: ${err.message}`);
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

module.exports = { SniListener, DEFAULT_LIMITS, ipKey };
